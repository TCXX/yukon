"""
Rebuild a code-dependent AS3 SWF into a standalone one that Ruffle can display.

Strips the ActionScript (DoABC / SymbolClass) and places library symbols
directly on the main timeline.

Usage:
    python3 utils/swf-extract.py <input.swf> --list
    python3 utils/swf-extract.py <input.swf> <output.swf> [symbol_id|ClassName] [x] [y]
    python3 utils/swf-extract.py <input.swf> <output.swf> --all [columns] [cell_width] [cell_height]
    python3 utils/swf-extract.py --config assets/swf/swf.json

Config mode rebuilds every output listed in the JSON file. Source and output
paths are relative to the config file, so original SWFs are left untouched:

    [{ "source": "original.swf", "label": "...", "outputs": [
        { "file": "original-view.swf", "label": "...", "symbol": "ClassName", "x": 0, "y": 0 },
        { "file": "original-all.swf", "label": "...", "all": true, "columns": 4 }
    ]}]
"""

import json
import math
import os
import struct
import sys
import zlib


END = 0
SHOW_FRAME = 1
DEFINE_SHAPE = 2
DEFINE_TEXT = 11
DEFINE_SHAPE_2 = 22
PLACE_OBJECT_2 = 26
DEFINE_SHAPE_3 = 32
DEFINE_TEXT_2 = 33
DEFINE_BUTTON_2 = 34
DEFINE_EDIT_TEXT = 37
DEFINE_SPRITE = 39
DEFINE_MORPH_SHAPE = 46
PLACE_OBJECT_3 = 70
DO_ABC_LEGACY = 72
SYMBOL_CLASS = 76
DO_ABC = 82
DEFINE_SHAPE_4 = 83
DEFINE_MORPH_SHAPE_2 = 84

STRIPPED = {DO_ABC, DO_ABC_LEGACY, SYMBOL_CLASS, SHOW_FRAME, END}

# Tags whose payload is: character id, then RECT bounds
RECT_TAGS = {
    DEFINE_SHAPE, DEFINE_SHAPE_2, DEFINE_SHAPE_3, DEFINE_SHAPE_4,
    DEFINE_TEXT, DEFINE_TEXT_2, DEFINE_EDIT_TEXT,
    DEFINE_MORPH_SHAPE, DEFINE_MORPH_SHAPE_2
}


class BitReader:

    def __init__(self, data, pos=0):
        self.data = data
        self.bit = pos * 8

    def ubits(self, n):
        value = 0

        for _ in range(n):
            byte = self.data[self.bit >> 3]
            value = (value << 1) | ((byte >> (7 - (self.bit & 7))) & 1)
            self.bit += 1

        return value

    def sbits(self, n):
        value = self.ubits(n)

        if n and value & (1 << (n - 1)):
            value -= 1 << n

        return value

    def align(self):
        self.bit = (self.bit + 7) & ~7

    @property
    def pos(self):
        return (self.bit + 7) >> 3


def read_rect(data, pos=0):
    r = BitReader(data, pos)
    n = r.ubits(5)
    rect = [r.sbits(n) for _ in range(4)]  # xmin, xmax, ymin, ymax (twips)

    return rect, r.pos


def read_matrix(data, pos):
    r = BitReader(data, pos)
    a, d, b, c = 1.0, 1.0, 0.0, 0.0

    if r.ubits(1):
        n = r.ubits(5)
        a, d = r.sbits(n) / 65536, r.sbits(n) / 65536

    if r.ubits(1):
        n = r.ubits(5)
        b, c = r.sbits(n) / 65536, r.sbits(n) / 65536

    n = r.ubits(5)
    tx, ty = r.sbits(n), r.sbits(n)

    return (a, b, c, d, tx, ty), r.pos


def skip_cxform_with_alpha(data, pos):
    r = BitReader(data, pos)
    has_add, has_mult = r.ubits(1), r.ubits(1)
    n = r.ubits(4)
    r.ubits(n * 4 * (has_add + has_mult))

    return r.pos


def transform_rect(rect, matrix):
    xmin, xmax, ymin, ymax = rect
    a, b, c, d, tx, ty = matrix

    xs, ys = [], []

    for x, y in ((xmin, ymin), (xmax, ymin), (xmin, ymax), (xmax, ymax)):
        xs.append(a * x + c * y + tx)
        ys.append(b * x + d * y + ty)

    return [min(xs), max(xs), min(ys), max(ys)]


def union(a, b):
    if a is None:
        return b
    if b is None:
        return a

    return [min(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3])]


def iter_tags(body, p):
    while p < len(body):
        code_len = struct.unpack('<H', body[p:p + 2])[0]
        code, length = code_len >> 6, code_len & 0x3f
        start = p
        p += 2

        if length == 0x3f:
            length = struct.unpack('<I', body[p:p + 4])[0]
            p += 4

        yield code, body[p:p + length], body[start:p + length]
        p += length

        if code == END:
            break


def read_swf(path):
    data = open(path, 'rb').read()
    sig, version = data[:3], data[3]

    if sig == b'CWS':
        body = zlib.decompress(data[8:])
    elif sig == b'FWS':
        body = data[8:]
    else:
        raise SystemExit(f'Unsupported SWF signature: {sig!r}')

    _, rect_end = read_rect(body)
    header = body[:rect_end + 4]  # rect + frame rate + frame count

    return version, header, list(iter_tags(body, rect_end + 4))


def symbol_classes(tags):
    classes = {}

    for code, payload, _ in tags:
        if code != SYMBOL_CLASS:
            continue

        count = struct.unpack('<H', payload[:2])[0]
        q = 2

        for _ in range(count):
            char_id = struct.unpack('<H', payload[q:q + 2])[0]
            q += 2
            end = payload.index(b'\0', q)
            classes[payload[q:end].decode()] = char_id
            q = end + 1

    return classes


def parse_place(code, payload):
    """Returns (character id or None, matrix or None) for a PlaceObject2/3 tag."""
    if code == PLACE_OBJECT_2:
        flags, q = payload[0], 3
    else:
        flags, flags2, q = payload[0], payload[1], 4

        if flags2 & 0x08 or (flags2 & 0x10 and flags & 0x02):  # HasClassName
            q = payload.index(b'\0', q) + 1

    char_id = matrix = None

    if flags & 0x02:
        char_id = struct.unpack('<H', payload[q:q + 2])[0]
        q += 2

    if flags & 0x04:
        matrix, q = read_matrix(payload, q)

    return char_id, matrix


class Bounds:
    """Computes the visual bounds (in twips) of library characters."""

    def __init__(self, tags):
        self.defs = {}
        self.cache = {}

        for code, payload, _ in tags:
            if code in RECT_TAGS or code in (DEFINE_SPRITE, DEFINE_BUTTON_2):
                self.defs[struct.unpack('<H', payload[:2])[0]] = (code, payload)

    def get(self, char_id):
        if char_id in self.cache:
            return self.cache[char_id]

        self.cache[char_id] = None  # guard against recursion
        code, payload = self.defs.get(char_id, (None, None))

        if code in RECT_TAGS:
            bounds = read_rect(payload, 2)[0]
        elif code == DEFINE_SPRITE:
            bounds = self.sprite(payload)
        elif code == DEFINE_BUTTON_2:
            bounds = self.button(payload)
        else:
            bounds = None

        self.cache[char_id] = bounds

        return bounds

    def sprite(self, payload):
        bounds = None
        depths = {}

        for code, tag, _ in iter_tags(payload, 4):
            if code not in (PLACE_OBJECT_2, PLACE_OBJECT_3):
                continue

            depth = struct.unpack('<H', tag[1:3] if code == PLACE_OBJECT_2 else tag[2:4])[0]
            char_id, matrix = parse_place(code, tag)

            prev_char, prev_matrix = depths.get(depth, (None, (1, 0, 0, 1, 0, 0)))
            char_id = char_id or prev_char
            matrix = matrix or prev_matrix
            depths[depth] = (char_id, matrix)

            child = self.get(char_id) if char_id else None

            if child:
                bounds = union(bounds, transform_rect(child, matrix))

        return bounds

    def button(self, payload):
        bounds = None
        q = 5  # id, flags, action offset

        while payload[q]:
            flags = payload[q]
            char_id = struct.unpack('<H', payload[q + 1:q + 3])[0]
            matrix, q = read_matrix(payload, q + 5)
            q = skip_cxform_with_alpha(payload, q)

            if flags & 0x07:  # visible in up/over/down
                child = self.get(char_id)

                if child:
                    bounds = union(bounds, transform_rect(child, matrix))

            if flags & 0x10:  # filter list - too complex to skip, stop here
                break

            if flags & 0x20:
                q += 1

        return bounds


def encode_tag(code, payload):
    if len(payload) < 0x3f:
        return struct.pack('<H', (code << 6) | len(payload)) + payload

    return struct.pack('<HI', (code << 6) | 0x3f, len(payload)) + payload


def encode_sbits(values):
    nbits = max(max(abs(v).bit_length() for v in values) + 1, 1)

    return nbits, ''.join(format(v & ((1 << nbits) - 1), f'0{nbits}b') for v in values)


def to_bytes(bits):
    bits += '0' * (-len(bits) % 8)

    return bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))


def encode_matrix(tx, ty, scale=1.0):
    """Scale + translate MATRIX record, tx/ty in pixels."""
    bits = ''

    if scale != 1.0:
        s = int(round(scale * 65536))
        nbits, values = encode_sbits([s, s])
        bits += '1' + format(nbits, '05b') + values
    else:
        bits += '0'

    bits += '0'  # no rotate

    nbits, values = encode_sbits([int(round(tx * 20)), int(round(ty * 20))])
    bits += format(nbits, '05b') + values

    return to_bytes(bits)


def encode_rect(width, height):
    nbits, values = encode_sbits([0, int(width * 20), 0, int(height * 20)])

    return to_bytes(format(nbits, '05b') + values)


def place(depth, char_id, tx, ty, scale=1.0):
    payload = struct.pack('<BHH', 0x06, depth, char_id) + encode_matrix(tx, ty, scale)  # HasCharacter | HasMatrix

    return encode_tag(PLACE_OBJECT_2, payload)


def write_swf(path, version, header, tags, placements):
    out = bytearray(header)
    out[-2:] = struct.pack('<H', 1)  # single frame

    for code, _, raw in tags:
        if code not in STRIPPED:
            out += raw

    out += b''.join(placements)
    out += encode_tag(SHOW_FRAME, b'')
    out += encode_tag(END, b'')

    swf = b'FWS' + bytes([version]) + struct.pack('<I', len(out) + 8) + out
    open(path, 'wb').write(swf)


def resolve(classes, target):
    if target.isdigit():
        return int(target)

    return next(v for k, v in classes.items() if k == target or k.endswith('.' + target))


def extract_all(src, dst, columns=None, cell_width=None, cell_height=None):
    version, header, tags = read_swf(src)
    classes = symbol_classes(tags)
    bounds = Bounds(tags)

    # Skip the document class (id 0), sort largest first so the main maps lead
    symbols = [(name, char_id, bounds.get(char_id)) for name, char_id in classes.items() if char_id != 0]
    symbols = [s for s in symbols if s[2]]
    symbols.sort(key=lambda s: -(s[2][1] - s[2][0]) * (s[2][3] - s[2][2]))

    stage, _ = read_rect(header)
    cell_width = cell_width or stage[1] / 20 / 2
    cell_height = cell_height or stage[3] / 20 / 2
    columns = columns or math.ceil(math.sqrt(len(symbols)))
    rows = math.ceil(len(symbols) / columns)
    padding = 10

    placements = []

    for i, (name, char_id, (xmin, xmax, ymin, ymax)) in enumerate(symbols):
        width, height = (xmax - xmin) / 20, (ymax - ymin) / 20
        scale = min(1.0, (cell_width - padding * 2) / max(width, 1), (cell_height - padding * 2) / max(height, 1))

        col, row = i % columns, i // columns

        # Centre the symbol inside its cell
        x = col * cell_width + (cell_width - width * scale) / 2 - xmin / 20 * scale
        y = row * cell_height + (cell_height - height * scale) / 2 - ymin / 20 * scale

        placements.append(place(i + 1, char_id, x, y, scale))
        print(f'[{row},{col}] {char_id:>4} {name} ({width:.0f}x{height:.0f}, scale {scale:.2f})')

    header = bytearray(encode_rect(columns * cell_width, rows * cell_height) + header[-4:])
    write_swf(dst, version, header, tags, placements)

    print(f'Wrote {dst} with {len(symbols)} symbols ({columns}x{rows} grid)')


def extract_symbol(src, dst, target=None, x=0, y=0):
    version, header, tags = read_swf(src)
    classes = symbol_classes(tags)

    # Default to the first exported symbol that isn't the document class
    target = resolve(classes, str(target)) if target is not None else next(v for v in classes.values() if v != 0)

    write_swf(dst, version, header, tags, [place(1, target, x, y)])

    print(f'Wrote {dst} with symbol {target}')


def build_config(path):
    base = os.path.dirname(os.path.abspath(path))

    for entry in json.load(open(path, encoding='utf-8')):
        src = os.path.join(base, entry['source'])

        for output in entry.get('outputs', []):
            dst = os.path.join(base, output['file'])

            if output.get('all'):
                extract_all(src, dst, output.get('columns'), output.get('cell_width'), output.get('cell_height'))
            else:
                extract_symbol(src, dst, output.get('symbol'), output.get('x', 0), output.get('y', 0))


def main():
    args = sys.argv[1:]

    if len(args) == 2 and args[0] == '--config':
        return build_config(args[1])

    if len(args) < 2:
        raise SystemExit(__doc__)

    if args[1] == '--list':
        _, _, tags = read_swf(args[0])

        for name, char_id in symbol_classes(tags).items():
            print(char_id, name)
        return

    src, dst = args[0], args[1]

    if len(args) > 2 and args[2] == '--all':
        extra = [float(a) for a in args[3:]]
        columns = int(extra[0]) if extra else None

        return extract_all(src, dst, columns, *extra[1:3])

    target = args[2] if len(args) > 2 else None
    x = float(args[3]) if len(args) > 3 else 0
    y = float(args[4]) if len(args) > 4 else 0

    extract_symbol(src, dst, target, x, y)


if __name__ == '__main__':
    main()
