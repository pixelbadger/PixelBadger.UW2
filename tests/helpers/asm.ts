import { writeConv, type ConvImport } from '../../src/formats/conv';
import { readConv, type ConvProgram } from '../../src/formats';

// A tiny assembler for conversation bytecode, so VM tests read like the disassembly in docs/FORMATS.md.
//   asm(['PUSHI 3', 'SAY_OP', 'label:', 'BEQ label', 'CALLI babl_menu', 'EXIT_OP'], { fns: ['babl_menu'] })
// Relative branches (BEQ/BNE/BRA) take a label and are encoded as target - (address + 1), as UW2 does.

const OPS: Record<string, number> = {
  NOP: 0x00, OPADD: 0x01, OPMUL: 0x02, OPSUB: 0x03, OPDIV: 0x04, OPMOD: 0x05, OPOR: 0x06, OPAND: 0x07, OPNOT: 0x08, TSTGT: 0x09, TSTGE: 0x0a,
  TSTLT: 0x0b, TSTLE: 0x0c, TSTEQ: 0x0d, TSTNE: 0x0e, JMP: 0x0f, BEQ: 0x10, BNE: 0x11, BRA: 0x12, CALL: 0x13, CALLI: 0x14, RET: 0x15,
  PUSHI: 0x16, PUSHI_EFF: 0x17, POP: 0x18, SWAP: 0x19, PUSHBP: 0x1a, POPBP: 0x1b, SPTOBP: 0x1c, BPTOSP: 0x1d, ADDSP: 0x1e, FETCHM: 0x1f,
  STO: 0x20, OFFSET: 0x21, START: 0x22, SAVE_REG: 0x23, PUSH_REG: 0x24, STRCMP: 0x25, EXIT_OP: 0x26, SAY_OP: 0x27, RESPOND_OP: 0x28, OPNEG: 0x29,
};
const IMM = new Set(['JMP', 'BEQ', 'BNE', 'BRA', 'CALL', 'CALLI', 'PUSHI', 'PUSHI_EFF']);
const REL = new Set(['BEQ', 'BNE', 'BRA']);

export interface AsmOpts { fns?: string[]; G?: number; strBlock?: number }

export function assemble(src: string[], opts: AsmOpts = {}): number[] {
  const fns = opts.fns ?? [];
  const lines = src.flatMap(l => l.split(';')).map(l => l.trim()).filter(Boolean);
  const labels = new Map<string, number>();
  let pc = 0;
  for (const l of lines) {
    if (l.endsWith(':')) { labels.set(l.slice(0, -1), pc); continue; }
    pc += IMM.has(l.split(/\s+/)[0]!) ? 2 : 1;
  }
  const out: number[] = [];
  for (const l of lines) {
    if (l.endsWith(':')) continue;
    const [op, arg] = l.split(/\s+/) as [string, string | undefined];
    const code = OPS[op];
    if (code === undefined) throw new Error('unknown op ' + op);
    const at = out.length;
    out.push(code);
    if (!IMM.has(op)) continue;
    let v: number;
    if (op === 'CALLI') { v = fns.indexOf(arg!); if (v < 0) throw new Error('unknown builtin ' + arg); }
    else if (labels.has(arg!)) v = REL.has(op) ? labels.get(arg!)! - (at + 1) : labels.get(arg!)!;
    else v = Number(arg);
    out.push(v & 0xffff);
  }
  return out;
}

/** Assembles to a CNV.ARK block and reads it back through the real parser. */
export function asmProgram(src: string[], opts: AsmOpts = {}): ConvProgram {
  const fns = opts.fns ?? [];
  const imports: ConvImport[] = fns.map((name, id) => ({ name, id, kind: 'fn', ret: 0 }));
  const block = writeConv({ strBlock: opts.strBlock ?? 0x0e01, G: opts.G ?? 64, imports, code: assemble(src, opts) });
  return readConv(block)!;
}

/** Stores value v at address a (STO takes the value on top, the address below). */
export const store = (a: number, v: number) => [`PUSHI ${a}`, `PUSHI ${v}`, 'STO'];
/** Calls builtin fn with argument pointers (arg 1 first); pops them afterwards like the compiler does. */
export const call = (fn: string, ptrs: number[]) => [...[...ptrs].reverse().map(p => `PUSHI ${p}`), `PUSHI ${ptrs.length}`, `CALLI ${fn}`, ...ptrs.map(() => 'POP'), 'POP'];
/** Calls a menu builtin, which pushes a false argument count of 0. */
export const menu = (fn: 'babl_menu' | 'babl_fmenu', ptrs: number[]) => [...[...ptrs].reverse().map(p => `PUSHI ${p}`), 'PUSHI 0', `CALLI ${fn}`, ...ptrs.map(() => 'POP'), 'POP'];
