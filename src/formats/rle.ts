/**
 * Generic UW run-length decoder (4-bit words for .GR, 5-bit for critters). Returns palette-mapped pixels, 0 = transparent.
 * Records alternate repeat / run; a count is one word, or 0 then two words, or 0,0 then three words, always combined
 * with << 4 even for 5-bit words (getting this wrong garbles ~20% of creature frames). Reads past the buffer give zero;
 * every record consumes at least one of `words` and output is capped at w*h, so decoding always terminates.
 */
export function rleDecode(buf: Uint8Array, p: number, words: number, w: number, h: number, bits: number, map: ArrayLike<number>): Uint8Array {
  const px = new Uint8Array(w * h);
  let bitpos = 0, left = words;
  const word = (): number => {
    left--;
    let v = 0;
    for (let k = 0; k < bits; k++) {
      const byte = buf[p + (bitpos >> 3)] ?? 0;
      v = (v << 1) | ((byte >> (7 - (bitpos & 7))) & 1);
      bitpos++;
    }
    return v;
  };
  const cnt = (): number => {
    let c = word();
    if (c === 0) { c = (word() << 4) | word(); if (c === 0) c = (((word() << 4) | word()) << 4) | word(); }
    return c;
  };
  let o = 0, state = 0, count = 0, rep = 0;
  const max = w * h;
  while (o < max && left > 0) {
    if (state === 0) { count = cnt(); if (count === 1) state = 2; else if (count === 2) rep = cnt() - 1; else state = 1; }
    else if (state === 1) { const v = map[word()] ?? 0; for (let k = 0; k < count && o < max; k++) px[o++] = v; if (rep > 0) { rep--; state = 0; } else state = 2; }
    else { count = cnt(); for (let k = 0; k < count && o < max; k++) px[o++] = map[word()] ?? 0; state = 0; }
  }
  return px;
}
