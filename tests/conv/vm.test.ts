import { describe, expect, it } from 'vitest';
import { ConvVM, type ConvHost } from '../../src/conv/vm';
import { seededRng } from '../../src/core/rng';
import { asmProgram, call, menu, store } from '../helpers/asm';

// Regression fixtures for the conversation VM: each pins a behaviour that was established by running the real programs
// (docs/FORMATS.md, CONVERSATIONS, marks the points where the published spec is wrong).

function run(src: string[], fns: string[] = [], strings: string[] = [], host: ConvHost = {}) {
  const said: string[] = [];
  const vm = new ConvVM(asmProgram(src, { fns }), strings, { say: t => said.push(t), ...host });
  const state = vm.run();
  return { vm, state, said };
}
/** Leaves the top of stack in private global 40 and exits. */
const keep = ['PUSHI 40', 'SWAP', 'STO', 'EXIT_OP'];

describe('ConvVM arithmetic and branches', () => {
  it('SUB, DIV and MOD compute b op a (a on top)', () => {
    expect(run(['PUSHI 10', 'PUSHI 3', 'OPSUB', ...keep]).vm.mem[40]).toBe(7);
    expect(run(['PUSHI 10', 'PUSHI 3', 'OPDIV', ...keep]).vm.mem[40]).toBe(3);
    expect(run(['PUSHI 10', 'PUSHI 3', 'OPMOD', ...keep]).vm.mem[40]).toBe(1);
    expect(run(['PUSHI 10', 'PUSHI 0', 'OPDIV', ...keep]).vm.mem[40]).toBe(0);
    expect(run(['PUSHI 2', 'PUSHI 5', 'TSTLT', ...keep]).vm.mem[40]).toBe(1);
  });
  it('arithmetic wraps to 16 bits', () => {
    expect(run(['PUSHI 32767', 'PUSHI 1', 'OPADD', ...keep]).vm.mem[40]).toBe(-32768);
  });
  it('relative branches land on branch address + 1 + offset', () => {
    // PUSHI 0 (0-1), BEQ yes (2-3), PUSHI 1 (4-5), PUSHI 40 (6-7), SWAP, STO, EXIT_OP, yes: (11)
    const r = run(['PUSHI 0', 'BEQ yes', 'PUSHI 1', ...keep, 'yes:', 'PUSHI 2', ...keep]);
    expect(r.vm.cv.code[3]).toBe(11 - (2 + 1)); // a "+2" convention would land on PUSHI 2's operand
    expect(r.vm.mem[40]).toBe(2);
    const back = run(['PUSHI 5', 'loop:', 'PUSHI 1', 'OPSUB', 'PUSHI 40', 'SWAP', 'STO', 'PUSHI 40', 'FETCHM', 'PUSHI 40', 'FETCHM', 'BNE loop', 'EXIT_OP']);
    expect(back.state).toBe('done');
    expect(back.vm.mem[40]).toBe(0);
  });
  it('STO takes the value on top and the address below; OFFSET is 1-based with the base on top', () => {
    const r = run([...store(45, 11), ...store(46, 22), 'PUSHI 2', 'PUSHI 45', 'OFFSET', 'FETCHM', ...keep]);
    expect(r.vm.mem[40]).toBe(22);
  });
  it('RET with nothing on the stack ends the program', () => {
    expect(run(['RET']).state).toBe('done');
  });
  it('a program that never ends is stopped as runaway', () => {
    const r = run(['loop:', 'BRA loop']);
    expect(r.state).toBe('error');
    expect(r.vm.err).toMatch(/runaway/);
  });
  it('errors are reported, not thrown', () => {
    expect(run(['POP']).vm.err).toMatch(/underflow/);
    expect(run(['PUSHI -5', 'FETCHM']).vm.err).toMatch(/bad address/);
    expect(run([], []).vm.err).toMatch(/pc out of range/);
  });
});

describe('ConvVM builtins and calling convention', () => {
  it('passes argument pointers with arg 1 at sp-1: set_quest(value, index)', () => {
    const vm = new ConvVM(asmProgram([...store(50, 5), ...store(51, 9), ...call('set_quest', [51, 50]), 'EXIT_OP'], { fns: ['set_quest'] }), [], {});
    vm.quests = [];
    expect(vm.run()).toBe('done');
    expect(vm.quests[5]).toBe(9);
  });
  it('babl_menu answers the 1-based position; babl_fmenu the chosen string id, filtered by flags', () => {
    const strings = ['zero', 'one', 'two', 'three'];
    const m = run([...store(40, 1), ...store(41, 3), ...store(42, 0), ...menu('babl_menu', [40]), 'PUSH_REG', 'PUSHI 45', 'SWAP', 'STO', 'EXIT_OP'], ['babl_menu'], strings);
    expect(m.state).toBe('menu');
    expect(m.vm.menu).toEqual([{ text: 'one', value: 1 }, { text: 'three', value: 2 }]);
    m.vm.answer(2);
    expect(m.vm.mem[45]).toBe(2);
    const f = run([...store(40, 1), ...store(41, 2), ...store(42, 3), ...store(43, 0), ...store(50, 1), ...store(51, 0), ...store(52, 1),
      ...menu('babl_fmenu', [40, 50]), 'PUSH_REG', 'PUSHI 45', 'SWAP', 'STO', 'EXIT_OP'], ['babl_fmenu'], strings);
    expect(f.vm.menu).toEqual([{ text: 'one', value: 1 }, { text: 'three', value: 3 }]);
    f.vm.answer(3);
    expect(f.vm.mem[45]).toBe(3);
  });
  it('babl_ask yields for typed text, which comes back as a runtime string; contains(typed, keyword)', () => {
    const strings = ['', 'slug'];
    const r = run(['PUSHI 0', 'CALLI babl_ask', 'POP', 'PUSH_REG', 'PUSHI 45', 'SWAP', 'STO', ...store(46, 1), ...call('contains', [45, 46]), 'PUSH_REG', ...keep], ['babl_ask', 'contains'], strings);
    expect(r.state).toBe('ask');
    expect(r.vm.answer('Slugs are gross')).toBe('done');
    expect(r.vm.str(r.vm.mem[45]!)).toBe('Slugs are gross');
    expect(r.vm.mem[40]).toBe(1);
  });
  it('sex(female string, male string) picks by the Avatar', () => {
    const src = [...store(50, 7), ...store(51, 8), ...call('sex', [50, 51]), 'PUSH_REG', ...keep];
    expect(run(src, ['sex'], [], { female: () => true }).vm.mem[40]).toBe(7);
    expect(run(src, ['sex'], [], { female: () => false }).vm.mem[40]).toBe(8);
  });
  it('x_clock(value | >0x100 = read, clock)', () => {
    const vm = new ConvVM(asmProgram([...store(50, 12), ...store(51, 3), ...call('x_clock', [50, 51]), ...store(50, 0x101), ...call('x_clock', [50, 51]), 'PUSH_REG', ...keep], { fns: ['x_clock'] }), [], {});
    vm.clocks = [];
    vm.run();
    expect(vm.clocks[3]).toBe(12);
    expect(vm.mem[40]).toBe(12);
  });
  it('random is deterministic under a seeded RNG', () => {
    const src = [...store(50, 100), ...call('random', [50]), 'PUSH_REG', ...keep];
    const a = run(src, ['random'], [], { rng: seededRng(42) }).vm.mem[40];
    const b = run(src, ['random'], [], { rng: seededRng(42) }).vm.mem[40];
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(100);
  });
  it('pause yields "more" and resumes on any answer', () => {
    const r = run(['PUSHI 0', 'CALLI pause', 'POP', 'PUSHI 0', 'SAY_OP', 'EXIT_OP'], ['pause'], ['after']);
    expect(r.state).toBe('more');
    expect(r.vm.answer(0)).toBe('done');
    expect(r.said).toEqual(['after']);
  });
  it('unknown builtins go to the host with values and pointers', () => {
    const seen: unknown[] = [];
    run([...store(50, 4), ...store(51, 6), ...call('gronk_door', [50, 51]), 'EXIT_OP'], ['gronk_door'], [], { fn: (n, v, p) => { seen.push(n, v, p); return 1; } });
    expect(seen).toEqual(['gronk_door', [4, 6], [50, 51]]);
  });
});

describe('ConvVM text', () => {
  it('expands @GS/@GI/@SI with an index and C<n>', () => {
    const vm = new ConvVM(asmProgram(['EXIT_OP']), ['x', 'a', 'b', 'c'], {});
    vm.mem[70] = 1; vm.mem[71] = 2; vm.mem[72] = 3; vm.mem[10] = 2; vm.mem[20] = 99; vm.mem[vm.bp + 1] = 7;
    // @GS70GI10: the string at global 70 + global10 - 1 (= mem[71]); @GS70C3: element 3 (= mem[72]); @SI1: local 1
    expect(vm.expand('@GS70GI10 / @GS70C3 / @GI20 / @SI1 / @GS70')).toBe('b / c / 99 / 7 / a');
  });
  it('keeps \\1 ... \\0 markers for words the player speaks', () => {
    const r = run(['PUSHI 0', 'SAY_OP', 'EXIT_OP'], [], ['\\1xyzzy\\0']);
    expect(r.said).toEqual(['\\1xyzzy\\0']);
  });
  it('Felix (slot 8) regression: the same SAY twice without a reply ends the talk', () => {
    // the shipped program loops forever on one line: 0xd55: SAY; JMP 0xd55
    const r = run(['loop:', 'PUSHI 0', 'SAY_OP', 'JMP loop'], [], ['I am Felix.']);
    expect(r.state).toBe('done');
    expect(r.said).toEqual(['I am Felix.']);
    expect(r.vm.note).toMatch(/same line again/);
  });
  it('a reply between two runs of the same SAY does not end the talk', () => {
    const r = run(['loop:', 'PUSHI 0', 'SAY_OP', ...store(40, 1), ...store(41, 0), ...menu('babl_menu', [40]), 'JMP loop'], ['babl_menu'], ['Again?']);
    expect(r.state).toBe('menu');
    expect(r.vm.answer(1)).toBe('menu');
    expect(r.said).toEqual(['Again?', 'Again?']);
  });
});
