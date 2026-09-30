import { LIMITS } from './limits';

/** A model vertex: [x, y, z, reachesCeiling] in tile units; x east, y north, z up. */
export type MVert = [number, number, number, number];
export interface ModelTri {
  p: [MVert, MVert, MVert];
  uv: [[number, number], [number, number], [number, number]] | null;
  /** Palette index for untextured faces. */
  pal: number;
  /** Texture slot, or -1 for a flat colour. */
  tex: number;
}
export interface Model { tris: ModelTri[] }

/** Colour slot -> palette index, per model (Underworld Adventures' table). */
export const MODEL_COLS: number[][] = [[0x8F], [0x93], [0x8F], [0x8C], [0x21, 0x1B], [0xC6, 0xCC], [0xC6, 0xCC], [0xC6, 0xCC], [0x88, 0x23, 0x56], [0x8C], [0x8C], [0xB9, 0xBA, 0xBC], [0xCA], [0x8D], [0x8F], [0x8F],
  [0x1B], [0x1B], [0x1B], [0xCB], [0x1B], [0x1B], [0x1B], [0x21, 0x02, 0x04], [0x8E, 0xCA], [0x8E, 0xCA], [0x8C], [0x8C, 0xCB], [0x8F], [0x31, 0xC6, 0x52, 0x4D], [0xCC, 0x02], [0x15, 0x35]];

/** Signature of the model offset table in UW2.EXE (0x54cf0 in the GOG build). */
export const MODEL_SIGNATURE = [0xd4, 0x64, 0xaa, 0x59] as const;

export function findModelTable(exe: Uint8Array): number {
  for (let i = 0; i + 4 <= exe.length; i++) if (exe[i] === 0xd4 && exe[i + 1] === 0x64 && exe[i + 2] === 0xaa && exe[i + 3] === 0x59) return i;
  return -1;
}

/**
 * UW2.EXE's 32 builtin 3D models. The offset table is found by its signature; model data sits at table+0x9a; each
 * model starts 10 bytes past its offset. Node format per Underworld Adventures' ModelDecoder; 8.8 fixed point.
 * Reads past the executable give zero (which ends a node list). The walk is capped by LIMITS (ops, depth, triangles)
 * because sort nodes branch and a hostile table could otherwise recurse exponentially.
 */
export function readModels(exe: Uint8Array): Model[] | null {
  const tab = findModelTable(exe);
  if (tab < 0) return null;
  const base = tab + 0x9a;
  const r16 = (o: number) => (exe[o] ?? 0) | ((exe[o + 1] ?? 0) << 8);
  const fx = (o: number) => { const v = r16(o); return (v & 0x8000 ? v - 65536 : v) / 256; };
  const out: Model[] = [];
  for (let n = 0; n < 32; n++) {
    const V: (MVert | undefined)[] = [], tris: ModelTri[] = [];
    let depth = 0, ops = 0;
    const col = (off: number) => { const k = (off - 0x2680) >> 1, t = MODEL_COLS[n]!; return k >= 0 && k < t.length ? t[k]! : 0; };
    const face = (vs: number[], uv: [number, number][] | null, pal: number, tex: number) => {
      const q = vs.map(k => V[k]);
      if (q.some(v => !v)) return;
      for (let i = 1; i + 1 < q.length && tris.length < LIMITS.maxModelTris; i++)
        tris.push({ p: [q[0]!, q[i]!, q[i + 1]!], uv: uv ? [uv[0]!, uv[i]!, uv[i + 1]!] : null, pal, tex });
    };
    const off = (v: MVert | undefined, axis: number, d: number): MVert => { const r: MVert = v ? [v[0], v[1], v[2], v[3]] : [0, 0, 0, 0]; r[axis]! += d; return r; };
    const node = (p: number, pal: number): void => {
      if (++depth > LIMITS.maxModelDepth) { depth--; return; }
      for (let guard = 0; guard < 4000; guard++) {
        if (++ops > LIMITS.maxModelOps || tris.length >= LIMITS.maxModelTris) break;
        const c = r16(p); p += 2;
        switch (c) {
          case 0x00: depth--; return;
          case 0x78: p += 10; break;
          case 0x4a: p += 6; break;
          case 0xba: { const pl = col(r16(p)), u = r16(p + 2); p += 4; node(p - ((-u) & 0xffff), pl); break; }
          case 0x7a: V[r16(p + 6) >> 3] = [fx(p), fx(p + 2), fx(p + 4), 0]; p += 8; break;
          case 0x82: { const nv = r16(p), v0 = r16(p + 2); p += 4; for (let i = 0; i < nv; i++) { V[(v0 + i) & 0xffff] = [fx(p), fx(p + 2), fx(p + 4), 0]; p += 6; } break; }
          case 0x86: case 0x88: case 0x8a: V[r16(p + 4) >> 3] = off(V[r16(p) >> 3], c === 0x86 ? 0 : c === 0x8a ? 1 : 2, fx(p + 2)); p += 6; break;
          case 0x90: case 0x92: case 0x94: {
            const a = fx(p), b = fx(p + 2); let v: MVert = V[r16(p + 4) >> 3] ?? [0, 0, 0, 0];
            v = c === 0x90 ? off(off(v, 0, a), 2, b) : c === 0x92 ? off(off(v, 0, a), 1, b) : off(off(v, 1, a), 2, b);
            V[r16(p + 6) >> 3] = v; p += 8; break;
          }
          case 0x8c: { const s = V[r16(p) >> 3] ?? [0, 0, 0, 0]; V[r16(p + 4) >> 3] = [s[0], s[1], 4, 1]; p += 6; break; } // reaches the ceiling
          case 0x58: p += 14; break;
          case 0x64: case 0x66: case 0x68: p += 6; break;
          case 0x5e: case 0x60: case 0x62: p += 10; break;
          case 0x7e: { const nv = r16(p); p += 2; const vs: number[] = []; for (let i = 0; i < nv; i++) { vs.push(r16(p) >> 3); p += 2; } face(vs, null, pal, -1); break; }
          case 0xa8: case 0xb4: case 0xce: {
            let t = -1; if (c === 0xa8) { t = r16(p); p += 2; }
            const nv = r16(p); p += 2; const vs: number[] = [], uv: [number, number][] = [];
            for (let i = 0; i < nv; i++) { vs.push(r16(p) >> 3); uv.push([r16(p + 2) / 65535, r16(p + 4) / 65535]); p += 6; }
            face(vs, uv, pal, t); break;
          }
          case 0xa0: case 0xd2: {
            let t = -1; if (c === 0xa0) { t = r16(p); p += 2; }
            face([exe[p] ?? 0, exe[p + 1] ?? 0, exe[p + 2] ?? 0, exe[p + 3] ?? 0], [[0, 0], [1, 0], [1, 1], [0, 1]], pal, t); p += 4; break;
          }
          case 0x06: case 0x0c: case 0x0e: case 0x10: {
            if (c === 0x06) p += 4; // arbitrary sort plane carries one more normal/distance pair
            p += 8; const l = r16(p) + p + 2, rr = r16(p + 2) + p + 4; p += 4; node(l, pal); node(rr, pal); break;
          }
          case 0x14: pal = col(r16(p + 2)); p += 6; break;
          case 0xbc: pal = col(r16(p)); p += 4; break;
          case 0xbe: pal = col(r16(p + 2)); p += 4; break;
          case 0xd4: { const nv = r16(p); pal = col(r16(p + 2)); p += 4 + nv * 3 + (nv & 1); break; } // gouraud: ignored
          case 0xd6: case 0x40: case 0x44: break;
          case 0x16: pal = col(r16(p + 2)); p += 6; break;
          case 0x12: case 0x2e: case 0xb2: p += 2; break;
          default: depth--; return; // unknown node: keep what we have
        }
      }
      depth--;
    };
    node(base + r16(tab + n * 2) + 10, 0);
    out.push({ tris });
  }
  return out;
}
