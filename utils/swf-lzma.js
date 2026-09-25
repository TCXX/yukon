/**
 * Minimal LZMA decoder for LZMA-compressed (ZWS) SWFs, which browsers can't inflate natively.
 * Follows the reference decoder in the LZMA SDK (LzmaSpec.cpp).
 */

const PROB_INIT = 1024
const STATES = 12
const POS_STATES_MAX = 16
const LEN_TO_POS_STATES = 4
const END_POS_MODEL_INDEX = 14
const FULL_DISTANCES = 128
const ALIGN_BITS = 4
const MATCH_MIN_LEN = 2

const probs = size => new Uint16Array(size).fill(PROB_INIT)

class RangeDecoder {

    constructor(data, pos) {
        this.data = data
        this.pos = pos + 1 // first byte is always 0
        this.range = 0xffffffff
        this.code = 0

        for (let i = 0; i < 4; i++) {
            this.code = (this.code * 256 + this.data[this.pos++]) >>> 0
        }
    }

    normalize() {
        if (this.range < 0x1000000) {
            this.range = (this.range * 256) >>> 0
            this.code = (this.code * 256 + (this.data[this.pos++] || 0)) >>> 0
        }
    }

    bit(p, i) {
        const prob = p[i]
        const bound = (this.range >>> 11) * prob
        let bit

        if (this.code < bound) {
            this.range = bound
            p[i] = prob + ((2048 - prob) >> 5)
            bit = 0
        } else {
            this.code -= bound
            this.range -= bound
            p[i] = prob - (prob >> 5)
            bit = 1
        }

        this.normalize()

        return bit
    }

    direct(count) {
        let value = 0

        for (let i = 0; i < count; i++) {
            this.range >>>= 1
            let bit = 0

            if (this.code >= this.range) {
                this.code -= this.range
                bit = 1
            }

            value = value * 2 + bit
            this.normalize()
        }

        return value
    }

    tree(p, bits, offset = 0) {
        let m = 1

        for (let i = 0; i < bits; i++) {
            m = (m << 1) + this.bit(p, offset + m)
        }

        return m - (1 << bits)
    }

    reverseTree(p, bits, offset = 0) {
        let m = 1, symbol = 0

        for (let i = 0; i < bits; i++) {
            const bit = this.bit(p, offset + m)
            m = (m << 1) + bit
            symbol |= bit << i
        }

        return symbol
    }

}

class LenDecoder {

    constructor() {
        this.choice = probs(2)
        this.low = probs(POS_STATES_MAX << 3)
        this.mid = probs(POS_STATES_MAX << 3)
        this.high = probs(256)
    }

    decode(rc, posState) {
        if (!rc.bit(this.choice, 0)) return rc.tree(this.low, 3, posState << 3)
        if (!rc.bit(this.choice, 1)) return 8 + rc.tree(this.mid, 3, posState << 3)

        return 16 + rc.tree(this.high, 8)
    }

}

/**
 * Decodes raw LZMA data: `props` is the 5 byte properties header, `size` the uncompressed size.
 */
export function lzmaDecode(props, data, pos, size) {
    let d = props[0]
    const lc = d % 9
    d = (d / 9) | 0
    const lp = d % 5
    const pb = (d / 5) | 0

    const out = new Uint8Array(size)
    const rc = new RangeDecoder(data, pos)

    const literals = probs(0x300 << (lc + lp))
    const isMatch = probs(STATES << 4)
    const isRep = probs(STATES)
    const isRepG0 = probs(STATES)
    const isRepG1 = probs(STATES)
    const isRepG2 = probs(STATES)
    const isRep0Long = probs(STATES << 4)
    const posSlots = probs(LEN_TO_POS_STATES << 6)
    const posDecoders = probs(1 + FULL_DISTANCES - END_POS_MODEL_INDEX)
    const align = probs(1 << ALIGN_BITS)
    const lenDecoder = new LenDecoder()
    const repLenDecoder = new LenDecoder()

    const pbMask = (1 << pb) - 1
    const lpMask = (1 << lp) - 1

    let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0
    let n = 0

    const distance = len => {
        const lenState = Math.min(len, LEN_TO_POS_STATES - 1)
        const slot = rc.tree(posSlots, 6, lenState << 6)

        if (slot < 4) return slot

        const bits = (slot >> 1) - 1
        let dist = (2 | (slot & 1)) * 2 ** bits

        if (slot < END_POS_MODEL_INDEX) {
            return dist + rc.reverseTree(posDecoders, bits, dist - slot)
        }

        dist += rc.direct(bits - ALIGN_BITS) * 2 ** ALIGN_BITS

        return dist + rc.reverseTree(align, ALIGN_BITS)
    }

    while (n < size) {
        const posState = n & pbMask

        if (!rc.bit(isMatch, (state << 4) + posState)) {
            const prev = n ? out[n - 1] : 0
            const base = 0x300 * (((n & lpMask) << lc) + (prev >> (8 - lc)))
            let symbol = 1

            if (state >= 7) {
                let matchByte = out[n - rep0 - 1]

                while (symbol < 0x100) {
                    const matchBit = (matchByte >> 7) & 1
                    matchByte <<= 1
                    const bit = rc.bit(literals, base + ((1 + matchBit) << 8) + symbol)
                    symbol = (symbol << 1) | bit

                    if (matchBit !== bit) break
                }
            }

            while (symbol < 0x100) {
                symbol = (symbol << 1) | rc.bit(literals, base + symbol)
            }

            out[n++] = symbol - 0x100
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6

            continue
        }

        let len

        if (rc.bit(isRep, state)) {
            if (!rc.bit(isRepG0, state)) {
                if (!rc.bit(isRep0Long, (state << 4) + posState)) { // short rep: a single byte
                    state = state < 7 ? 9 : 11
                    out[n] = out[n - rep0 - 1]
                    n++

                    continue
                }
            } else {
                let dist

                if (!rc.bit(isRepG1, state)) {
                    dist = rep1
                } else {
                    if (!rc.bit(isRepG2, state)) {
                        dist = rep2
                    } else {
                        dist = rep3
                        rep3 = rep2
                    }

                    rep2 = rep1
                }

                rep1 = rep0
                rep0 = dist
            }

            len = repLenDecoder.decode(rc, posState)
            state = state < 7 ? 8 : 11
        } else {
            rep3 = rep2
            rep2 = rep1
            rep1 = rep0
            len = lenDecoder.decode(rc, posState)
            state = state < 7 ? 7 : 10
            rep0 = distance(len)

            if (rep0 === 0xffffffff) break // end marker
        }

        if (rep0 >= n) {
            throw new Error('Corrupt LZMA data')
        }

        for (let end = Math.min(n + len + MATCH_MIN_LEN, size); n < end; n++) {
            out[n] = out[n - rep0 - 1]
        }
    }

    return out
}
