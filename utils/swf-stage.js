/**
 * Browser port of utils/swf-extract.py.
 *
 * Rebuilds a code-dependent AS3 SWF in memory so Ruffle can display a single
 * scene or library element from it, without writing derived files to disk.
 */

import { lzmaDecode } from './swf-lzma.js'

const END = 0
const SHOW_FRAME = 1
const DEFINE_SHAPE = 2
const PLACE_OBJECT = 4
const REMOVE_OBJECT = 5
const DEFINE_TEXT = 11
const DO_ACTION = 12
const START_SOUND = 15
const SOUND_STREAM_HEAD = 18
const SOUND_STREAM_BLOCK = 19
const DEFINE_SHAPE_2 = 22
const PLACE_OBJECT_2 = 26
const REMOVE_OBJECT_2 = 28
const DEFINE_SHAPE_3 = 32
const DEFINE_TEXT_2 = 33
const DEFINE_BUTTON_2 = 34
const DEFINE_EDIT_TEXT = 37
const DEFINE_SPRITE = 39
const FRAME_LABEL = 43
const SOUND_STREAM_HEAD_2 = 45
const DEFINE_MORPH_SHAPE = 46
const PLACE_OBJECT_3 = 70
const DO_ABC_LEGACY = 72
const SYMBOL_CLASS = 76
const DO_ABC = 82
const DEFINE_SHAPE_4 = 83
const DEFINE_MORPH_SHAPE_2 = 84
const DEFINE_SCENE_AND_FRAME_LABEL_DATA = 86
const START_SOUND_2 = 89

const CODE = new Set([DO_ABC, DO_ABC_LEGACY, SYMBOL_CLASS, DO_ACTION])

// Main timeline tags that are dropped when showing a library element on its own
const TIMELINE = new Set([
    SHOW_FRAME, END, PLACE_OBJECT, PLACE_OBJECT_2, PLACE_OBJECT_3, REMOVE_OBJECT, REMOVE_OBJECT_2,
    FRAME_LABEL, START_SOUND, START_SOUND_2, SOUND_STREAM_HEAD, SOUND_STREAM_HEAD_2, SOUND_STREAM_BLOCK,
    DEFINE_SCENE_AND_FRAME_LABEL_DATA
])

// Tags whose payload is: character id, then RECT bounds
const RECT_TAGS = new Set([
    DEFINE_SHAPE, DEFINE_SHAPE_2, DEFINE_SHAPE_3, DEFINE_SHAPE_4,
    DEFINE_TEXT, DEFINE_TEXT_2, DEFINE_EDIT_TEXT,
    DEFINE_MORPH_SHAPE, DEFINE_MORPH_SHAPE_2
])

// Tags that define a character, with its id first
const DEFINE_TAGS = new Set([2, 6, 7, 10, 11, 14, 20, 21, 22, 32, 33, 34, 35, 36, 37, 39, 46, 48, 60, 75, 83, 84, 87, 90, 91])

// Instance names of layers the game code hides at runtime: walk maps, depth sorting and trigger areas
const HIDDEN_LAYERS = /^(obstruction|overlap|triggers_mc|block_mc)$/

const u16 = (data, pos) => data[pos] | (data[pos + 1] << 8)
const u32 = (data, pos) => (data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24)) >>> 0

class BitReader {

    constructor(data, pos = 0) {
        this.data = data
        this.bit = pos * 8
    }

    ubits(n) {
        let value = 0

        for (let i = 0; i < n; i++) {
            const byte = this.data[this.bit >> 3]
            value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1)
            this.bit++
        }

        return value
    }

    sbits(n) {
        const value = this.ubits(n)

        return n && value >= 2 ** (n - 1) ? value - 2 ** n : value
    }

    get pos() {
        return (this.bit + 7) >> 3
    }

}

function readRect(data, pos = 0) {
    const r = new BitReader(data, pos)
    const n = r.ubits(5)
    const rect = [r.sbits(n), r.sbits(n), r.sbits(n), r.sbits(n)] // xmin, xmax, ymin, ymax (twips)

    return [rect, r.pos]
}

function readMatrix(data, pos) {
    const r = new BitReader(data, pos)
    let a = 1, d = 1, b = 0, c = 0

    if (r.ubits(1)) {
        const n = r.ubits(5)
        a = r.sbits(n) / 65536
        d = r.sbits(n) / 65536
    }

    if (r.ubits(1)) {
        const n = r.ubits(5)
        b = r.sbits(n) / 65536
        c = r.sbits(n) / 65536
    }

    const n = r.ubits(5)
    const tx = r.sbits(n)
    const ty = r.sbits(n)

    return [[a, b, c, d, tx, ty], r.pos]
}

function skipCxformWithAlpha(data, pos) {
    const r = new BitReader(data, pos)
    const hasAdd = r.ubits(1), hasMult = r.ubits(1)
    const n = r.ubits(4)
    r.ubits(n * 4 * (hasAdd + hasMult))

    return r.pos
}

function transformRect([xmin, xmax, ymin, ymax], [a, b, c, d, tx, ty]) {
    const xs = [], ys = []

    for (const [x, y] of [[xmin, ymin], [xmax, ymin], [xmin, ymax], [xmax, ymax]]) {
        xs.push(a * x + c * y + tx)
        ys.push(b * x + d * y + ty)
    }

    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
}

function union(a, b) {
    if (!a) return b
    if (!b) return a

    return [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])]
}

function* iterTags(body, p) {
    while (p < body.length) {
        const codeLen = u16(body, p)
        const code = codeLen >> 6
        let length = codeLen & 0x3f
        const start = p
        p += 2

        if (length === 0x3f) {
            length = u32(body, p)
            p += 4
        }

        yield { code, payload: body.subarray(p, p + length), raw: body.subarray(start, p + length) }
        p += length

        if (code === END) break
    }
}

function readString(data, pos) {
    const end = data.indexOf(0, pos)

    return [new TextDecoder().decode(data.subarray(pos, end)), end + 1]
}

function readEncodedU32(data, pos) {
    let value = 0

    for (let i = 0; i < 5; i++) {
        const byte = data[pos++]
        value += (byte & 0x7f) * 2 ** (7 * i)

        if (!(byte & 0x80)) break
    }

    return [value, pos]
}

async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))

    return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function readSwf(buffer) {
    const data = new Uint8Array(buffer)
    const sig = String.fromCharCode(...data.subarray(0, 3))
    let body

    if (sig === 'CWS') {
        body = await inflate(data.subarray(8))
    } else if (sig === 'ZWS') {
        // 4 bytes compressed length, 5 bytes LZMA properties, then raw LZMA data
        body = lzmaDecode(data.subarray(12, 17), data, 17, u32(data, 4) - 8)
    } else if (sig === 'FWS') {
        body = data.subarray(8)
    } else {
        throw new Error(`Unsupported SWF signature: ${sig}`)
    }

    const [stage, rectEnd] = readRect(body)
    const header = body.subarray(0, rectEnd + 4) // rect + frame rate + frame count
    const tags = [...iterTags(body, rectEnd + 4)]

    return { version: data[3], header, stage, frameCount: u16(header, rectEnd + 2), tags }
}

export function symbolClasses(tags) {
    const classes = []

    for (const { code, payload } of tags) {
        if (code !== SYMBOL_CLASS) continue

        let q = 2

        for (let i = 0; i < u16(payload, 0); i++) {
            const id = u16(payload, q)
            const [name, next] = readString(payload, q + 2)
            classes.push({ id, name })
            q = next
        }
    }

    return classes
}

export function scenes(swf) {
    const tag = swf.tags.find(t => t.code === DEFINE_SCENE_AND_FRAME_LABEL_DATA)

    if (!tag) {
        return [{ name: 'Scene 1', start: 0, end: swf.frameCount }]
    }

    const list = []
    let [count, q] = readEncodedU32(tag.payload, 0)

    for (let i = 0; i < count; i++) {
        let offset, name
        ;[offset, q] = readEncodedU32(tag.payload, q)
        ;[name, q] = readString(tag.payload, q)
        list.push({ name, start: offset })
    }

    list.forEach((scene, i) => scene.end = i + 1 < list.length ? list[i + 1].start : swf.frameCount)

    return list
}

/** Fields of a PlaceObject2/3 tag. `idPos` is where the character id sits in the payload. */
function parsePlace(code, payload) {
    const flags = payload[0]
    const place = { flags, depth: 0, id: null, idPos: null, matrix: null, name: null }
    let q

    if (code === PLACE_OBJECT_2) {
        place.depth = u16(payload, 1)
        q = 3
    } else {
        const flags2 = payload[1]
        place.depth = u16(payload, 2)
        q = 4

        if (flags2 & 0x08 || (flags2 & 0x10 && flags & 0x02)) { // HasClassName
            q = payload.indexOf(0, q) + 1
        }
    }

    if (flags & 0x02) {
        place.id = u16(payload, q)
        place.idPos = q
        q += 2
    }

    if (flags & 0x04) {
        [place.matrix, q] = readMatrix(payload, q)
    }

    if (flags & 0x08) q = skipCxformWithAlpha(payload, q)
    if (flags & 0x10) q += 2 // ratio

    if (flags & 0x20) {
        [place.name] = readString(payload, q)
    }

    return place
}

/** Computes the visual bounds (in twips) of library characters. */
export class Bounds {

    constructor(tags) {
        this.defs = new Map()
        this.cache = new Map()

        for (const { code, payload } of tags) {
            if (RECT_TAGS.has(code) || code === DEFINE_SPRITE || code === DEFINE_BUTTON_2) {
                this.defs.set(u16(payload, 0), { code, payload })
            }
        }
    }

    get(id) {
        if (this.cache.has(id)) return this.cache.get(id)

        this.cache.set(id, null) // guard against recursion

        const { code, payload } = this.defs.get(id) || {}
        let bounds = null

        if (RECT_TAGS.has(code)) {
            [bounds] = readRect(payload, 2)
        } else if (code === DEFINE_SPRITE) {
            bounds = this.sprite(payload)
        } else if (code === DEFINE_BUTTON_2) {
            bounds = this.button(payload)
        }

        this.cache.set(id, bounds)

        return bounds
    }

    /** Union of what is on the display list at each frame, so removed objects don't count. */
    sprite(payload) {
        let bounds = null
        const depths = new Map()

        const showFrame = () => {
            for (const [id, matrix] of depths.values()) {
                const child = id ? this.get(id) : null

                if (child) {
                    bounds = union(bounds, transformRect(child, matrix))
                }
            }
        }

        for (const { code, payload: tag } of iterTags(payload, 4)) {
            if (code === SHOW_FRAME) {
                showFrame()
            } else if (code === REMOVE_OBJECT) {
                depths.delete(u16(tag, 2))
            } else if (code === REMOVE_OBJECT_2) {
                depths.delete(u16(tag, 0))
            } else if (code === PLACE_OBJECT_2 || code === PLACE_OBJECT_3) {
                const { depth, id, matrix } = parsePlace(code, tag)

                const prev = depths.get(depth) || [null, [1, 0, 0, 1, 0, 0]]
                depths.set(depth, [id || prev[0], matrix || prev[1]])
            }
        }

        showFrame()

        return bounds
    }

    button(payload) {
        let bounds = null
        let q = 5 // id, flags, action offset

        while (payload[q]) {
            const flags = payload[q]
            const id = u16(payload, q + 1)
            let matrix
            ;[matrix, q] = readMatrix(payload, q + 5)
            q = skipCxformWithAlpha(payload, q)

            if (flags & 0x07) { // visible in up/over/down
                const child = this.get(id)

                if (child) {
                    bounds = union(bounds, transformRect(child, matrix))
                }
            }

            if (flags & 0x10) break // filter list - too complex to skip, stop here

            if (flags & 0x20) q++
        }

        return bounds
    }

}

class BitWriter {

    constructor() {
        this.bits = []
    }

    write(value, n) {
        for (let i = n - 1; i >= 0; i--) {
            this.bits.push(Math.floor(value / 2 ** i) & 1)
        }
    }

    writeSigned(values) {
        const n = Math.max(...values.map(v => Math.abs(v).toString(2).length + 1))

        this.write(n, 5)

        for (const v of values) {
            this.write(v < 0 ? 2 ** n + v : v, n)
        }
    }

    bytes() {
        const out = new Uint8Array(Math.ceil(this.bits.length / 8))
        this.bits.forEach((bit, i) => out[i >> 3] |= bit << (7 - (i & 7)))

        return out
    }

}

function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let q = 0

    for (const part of parts) {
        out.set(part, q)
        q += part.length
    }

    return out
}

function encodeTag(code, payload) {
    if (payload.length < 0x3f) {
        return concat([new Uint8Array([(code << 6) | payload.length, code >> 2]), payload])
    }

    const head = new Uint8Array(6)
    const view = new DataView(head.buffer)
    view.setUint16(0, (code << 6) | 0x3f, true)
    view.setUint32(2, payload.length, true)

    return concat([head, payload])
}

/** Scale + translate MATRIX record, tx/ty in pixels. */
function encodeMatrix(tx, ty, scale = 1) {
    const w = new BitWriter()

    if (scale !== 1) {
        const s = Math.round(scale * 65536)
        w.write(1, 1)
        w.writeSigned([s, s])
    } else {
        w.write(0, 1)
    }

    w.write(0, 1) // no rotate
    w.writeSigned([Math.round(tx * 20), Math.round(ty * 20)])

    return w.bytes()
}

function encodeRect(width, height) {
    const w = new BitWriter()
    w.writeSigned([0, Math.round(width * 20), 0, Math.round(height * 20)])

    return w.bytes()
}

function place(depth, id, tx, ty, scale = 1) {
    const head = new Uint8Array([0x06, depth & 0xff, depth >> 8, id & 0xff, id >> 8]) // HasCharacter | HasMatrix

    return encodeTag(PLACE_OBJECT_2, concat([head, encodeMatrix(tx, ty, scale)]))
}

function writeSwf(version, rect, frameRate, frameCount, body) {
    const header = concat([rect, frameRate, new Uint8Array([frameCount & 0xff, frameCount >> 8])])
    const out = concat([header, ...body, encodeTag(END, new Uint8Array())])
    const swf = new Uint8Array(out.length + 8)

    swf.set([0x46, 0x57, 0x53, version]) // FWS
    new DataView(swf.buffer).setUint32(4, swf.length, true)
    swf.set(out, 8)

    return swf
}

/** Next unused character id. */
function nextId(tags) {
    return Math.max(0, ...tags.filter(t => DEFINE_TAGS.has(t.code)).map(t => u16(t.payload, 0))) + 1
}

/** Points placements of hidden layers (see HIDDEN_LAYERS) at `empty`, in a timeline starting at `pos`. */
function hideInTimeline(data, pos, empty) {
    const hidden = new Set() // depths
    let count = 0

    for (const { code, payload } of iterTags(data, pos)) {
        if (code === REMOVE_OBJECT) hidden.delete(u16(payload, 2))
        if (code === REMOVE_OBJECT_2) hidden.delete(u16(payload, 0))
        if (code !== PLACE_OBJECT_2 && code !== PLACE_OBJECT_3) continue

        const place = parsePlace(code, payload)

        if (place.name !== null) {
            HIDDEN_LAYERS.test(place.name) ? hidden.add(place.depth) : hidden.delete(place.depth)
        }

        if (place.idPos !== null && hidden.has(place.depth)) {
            payload[place.idPos] = empty & 0xff
            payload[place.idPos + 1] = empty >> 8
            count++
        }
    }

    return count
}

/**
 * Swaps layers the game hides at runtime (collision maps and the like, which are only visible
 * because the code is stripped) for an empty sprite, in the main timeline and every sprite.
 */
export function hideLayers(swf) {
    const empty = nextId(swf.tags)
    const body = concat(swf.tags.map(t => t.raw)) // a copy, patched in place

    let count = hideInTimeline(body, 0, empty)

    for (const { code, payload } of iterTags(body, 0)) {
        if (code === DEFINE_SPRITE) count += hideInTimeline(payload, 4, empty)
    }

    if (!count) return swf

    const emptySprite = encodeTag(DEFINE_SPRITE, spritePayload(empty, 1, [encodeTag(SHOW_FRAME, new Uint8Array()), encodeTag(END, new Uint8Array())]))

    return { ...swf, tags: [...iterTags(emptySprite, 0), ...iterTags(body, 0)], hiddenLayers: count }
}

function frameRate(swf) {
    return swf.header.subarray(swf.header.length - 4, swf.header.length - 2)
}

function libraryTags(swf) {
    return swf.tags.filter(t => !CODE.has(t.code) && !TIMELINE.has(t.code)).map(t => t.raw)
}

/** A single scene of the main timeline, with the code stripped out. */
export function buildScene(swf, { start, end }) {
    const body = []
    let frame = 0

    for (const { code, raw } of swf.tags) {
        if (CODE.has(code) || code === END || code === DEFINE_SCENE_AND_FRAME_LABEL_DATA) continue

        if (code === SHOW_FRAME) {
            // Frames before the scene collapse into its first frame, so the display list is correct
            if (frame >= start) body.push(raw)
            if (++frame >= end) break

            continue
        }

        body.push(raw)
    }

    const rect = swf.header.subarray(0, swf.header.length - 4)

    return writeSwf(swf.version, rect, frameRate(swf), end - start, body)
}

function spritePayload(id, frameCount, tags) {
    return concat([new Uint8Array([id & 0xff, id >> 8, frameCount & 0xff, frameCount >> 8]), ...tags])
}

function spriteDef(swf, id) {
    return swf.tags.find(t => t.code === DEFINE_SPRITE && u16(t.payload, 0) === id)
}

/** Frame count and frame labels of a library element (1 frame for anything that isn't a sprite). */
export function frames(swf, id) {
    const tag = spriteDef(swf, id)

    if (!tag) return { count: 1, labels: [] }

    const labels = []
    let frame = 0

    for (const { code, payload } of iterTags(tag.payload, 4)) {
        if (code === SHOW_FRAME) frame++
        if (code === FRAME_LABEL) labels.push({ frame, name: readString(payload, 0)[0] })
    }

    return { count: u16(tag.payload, 2), labels }
}

/**
 * Library tags plus helpers to freeze sprites on a single frame. With the code stripped
 * every sprite loops, so pages of a catalog (frames the code would gotoAndStop on) flash by.
 */
class Library {

    constructor(swf) {
        this.swf = swf
        this.tags = libraryTags(swf)
        this.bounds = new Bounds(swf.tags)
        this.nextId = Math.max(nextId(swf.tags), ...symbolClasses(swf.tags).map(s => s.id + 1))
    }

    /** Returns a character id showing `id` stopped on `frame`, or `id` itself when it has one frame. */
    freeze(id, frame) {
        const tag = spriteDef(this.swf, id)

        if (!tag || u16(tag.payload, 2) < 2) return id

        const body = []
        let current = 0

        for (const { code, raw } of iterTags(tag.payload, 4)) {
            if (code === END) break

            if (code === SHOW_FRAME) {
                // Earlier frames collapse into the chosen one, so the display list is correct
                if (current++ < frame) continue

                break
            }

            body.push(raw)
        }

        const frozen = this.nextId++
        const payload = spritePayload(frozen, 1, [...body, encodeTag(SHOW_FRAME, new Uint8Array()), encodeTag(END, new Uint8Array())])

        this.tags.push(encodeTag(DEFINE_SPRITE, payload))
        this.bounds.defs.set(frozen, { code: DEFINE_SPRITE, payload })

        return frozen
    }

    /** One character on a stage sized to fit it. */
    single(id, padding = 10) {
        const [xmin, xmax, ymin, ymax] = this.bounds.get(id) || this.swf.stage
        const width = (xmax - xmin) / 20 + padding * 2
        const height = (ymax - ymin) / 20 + padding * 2

        const body = [...this.tags, place(1, id, padding - xmin / 20, padding - ymin / 20), encodeTag(SHOW_FRAME, new Uint8Array())]

        return writeSwf(this.swf.version, encodeRect(width, height), frameRate(this.swf), 1, body)
    }

    /**
     * Characters laid out in a grid, in the given order. Returns the SWF with the stage size and
     * the cell of each character (in pixels), whose `index` is its position in `ids`.
     */
    grid(ids, padding = 10) {
        const items = ids.map((id, index) => ({ id, index, rect: this.bounds.get(id) })).filter(item => item.rect)

        const cellWidth = this.swf.stage[1] / 20 / 2
        const cellHeight = this.swf.stage[3] / 20 / 2
        const columns = Math.max(1, Math.ceil(Math.sqrt(items.length)))
        const rows = Math.max(1, Math.ceil(items.length / columns))

        const cells = items.map(({ index }, i) => ({
            index,
            x: i % columns * cellWidth,
            y: Math.floor(i / columns) * cellHeight,
            width: cellWidth,
            height: cellHeight
        }))

        const placements = items.map(({ id, rect: [xmin, xmax, ymin, ymax] }, i) => {
            const width = (xmax - xmin) / 20, height = (ymax - ymin) / 20
            const scale = Math.min(1, (cellWidth - padding * 2) / Math.max(width, 1), (cellHeight - padding * 2) / Math.max(height, 1))
            const col = i % columns, row = Math.floor(i / columns)

            // Centre the character inside its cell
            const x = col * cellWidth + (cellWidth - width * scale) / 2 - xmin / 20 * scale
            const y = row * cellHeight + (cellHeight - height * scale) / 2 - ymin / 20 * scale

            return place(i + 1, id, x, y, scale)
        })

        const body = [...this.tags, ...placements, encodeTag(SHOW_FRAME, new Uint8Array())]

        const width = columns * cellWidth, height = rows * cellHeight

        return { data: writeSwf(this.swf.version, encodeRect(width, height), frameRate(this.swf), 1, body), width, height, cells }
    }

}

/** One library element: playing, or stopped on a single frame. */
export function buildElement(swf, id, frame = null) {
    const library = new Library(swf)

    return library.single(frame === null ? id : library.freeze(id, frame))
}

/** Every frame of an element side by side, e.g. all the pages of a catalog. Cells have the `frame` they show. */
export function buildFrames(swf, id) {
    const library = new Library(swf)
    const { count } = frames(swf, id)

    const grid = library.grid(Array.from({ length: count }, (_, frame) => library.freeze(id, frame)))

    grid.cells.forEach(cell => cell.frame = cell.index)

    return grid
}

/** Every exported element laid out in a grid, largest first, each stopped on its first frame. Cells have the element's `id` and `name`. */
export function buildAll(swf) {
    const library = new Library(swf)
    const area = ([xmin, xmax, ymin, ymax]) => (xmax - xmin) * (ymax - ymin)

    // Skip the document class (id 0)
    const symbols = symbolClasses(swf.tags)
        .filter(s => s.id !== 0 && library.bounds.get(s.id))
        .sort((a, b) => area(library.bounds.get(b.id)) - area(library.bounds.get(a.id)))

    const grid = library.grid(symbols.map(s => library.freeze(s.id, 0)))

    grid.cells.forEach(cell => Object.assign(cell, symbols[cell.index]))

    return grid
}
