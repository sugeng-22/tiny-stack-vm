// Tiny stack VM for make.fun's tiny-stack-vm-01 (ISA: the kit's generator/subject/ISA.md).
// Runs every program in the input directory; writes the bytes it wrote plus its exit code
// (a trap's code when it traps) to the output directory. Each program is decoded once into
// flat arrays indexed by pc — opcode, immediate, next pc — one entry per byte address, so
// a jump landing mid-instruction behaves exactly as the spec says; the run loop then never
// re-decodes and allocates nothing per step.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const STEP_MAX = 1_000_000, OUT_MAX = 65_536;

// Per-opcode facts by opcode byte: immediate length (-1: not an opcode), pops, pushes.
const IMM = new Int8Array(256).fill(-1), POP = new Uint8Array(256), PSH = new Uint8Array(256);
for (const [o, i, p, s] of [
  [0x00, 0, 0, 0], [0x01, 1, 0, 1], [0x02, 4, 0, 1], [0x03, 0, 1, 0], [0x04, 0, 1, 2],
  [0x05, 0, 2, 2], [0x06, 0, 2, 3], [0x07, 0, 3, 3], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1], [0x41, 0, 2, 0],
  [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1], [0x53, 0, 1, 0],
]) { IMM[o] = i; POP[o] = p; PSH[o] = s; }
for (let o = 0x10; o <= 0x22; o++) { // arithmetic / logic / compare block: no immediate, one result
  if (o === 0x1f) continue;
  IMM[o] = 0; POP[o] = o === 0x17 || o === 0x1b ? 1 : 2; PSH[o] = 1;
}

// Machine state, allocated once and reused for every instance.
const stack = new Int32Array(256), calls = new Int32Array(64), mem = new Int32Array(256);
const obuf = new Uint8Array(OUT_MAX), digits = new Uint8Array(12);
let olen = 0;

// Runs one program on its input; returns the exit code (0-255) and leaves the program's
// output in obuf[0..olen). Output written before a trap is kept, as the ISA specifies.
function run(prog, input) {
  const n = prog.length;
  // ops[p]: opcode at p; -1 = no such opcode (trap 5); -2 = immediate cut off (trap 9).
  const ops = new Int16Array(n), arg = new Int32Array(n), nxt = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    const b = prog[p], im = IMM[b];
    if (im < 0) { ops[p] = -1; continue; }
    if (p + im >= n) { ops[p] = -2; continue; }
    ops[p] = b;
    nxt[p] = p + 1 + im;
    if (im === 1) arg[p] = (prog[p + 1] << 24) >> 24;
    else if (im === 4) arg[p] = prog[p + 1] | (prog[p + 2] << 8) | (prog[p + 3] << 16) | (prog[p + 4] << 24);
    else if (im === 2) {
      const u = prog[p + 1] | (prog[p + 2] << 8);
      arg[p] = b === 0x33 ? u : (u << 16) >> 16; // CALL's immediate is unsigned; jumps are signed
    }
  }

  mem.fill(0);
  olen = 0;
  let sp = 0, csp = 0, pc = 0, steps = 0, ip = 0;
  const ilen = input.length;

  for (;;) {
    if (steps === STEP_MAX) return 10;
    if (pc < 0 || pc >= n) return 9;
    const op = ops[pc];
    if (op < 0) return op === -1 ? 5 : 9;
    steps++;
    if (sp < POP[op]) return 2;
    if (sp - POP[op] + PSH[op] > 256) return 3;
    const a1 = arg[pc], nx = nxt[pc];
    pc = nx;
    switch (op) {
      case 0x00: return 0; // HALT
      case 0x01: case 0x02: stack[sp++] = a1; break; // PUSH8 / PUSH32
      case 0x03: sp--; break; // POP
      case 0x04: stack[sp] = stack[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = stack[sp - 1]; stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = t; break; } // SWAP
      case 0x06: stack[sp] = stack[sp - 2]; sp++; break; // OVER
      case 0x07: { // ROT: ( a b c -- b c a )
        const t = stack[sp - 3];
        stack[sp - 3] = stack[sp - 2]; stack[sp - 2] = stack[sp - 1]; stack[sp - 1] = t; break;
      }
      case 0x17: stack[sp - 1] = -stack[sp - 1] | 0; break; // NEG (wraps)
      case 0x1b: stack[sp - 1] = ~stack[sp - 1]; break; // NOT
      case 0x30: pc = nx + a1; break; // JMP
      case 0x31: if (stack[--sp] === 0) pc = nx + a1; break; // JZ
      case 0x32: if (stack[--sp] !== 0) pc = nx + a1; break; // JNZ
      case 0x33: if (csp === 64) return 7; calls[csp++] = nx; pc = a1; break; // CALL
      case 0x34: if (csp === 0) return 8; pc = calls[--csp]; break; // RET
      case 0x40: { // LOAD
        const ad = stack[sp - 1];
        if (ad < 0 || ad > 255) return 6;
        stack[sp - 1] = mem[ad]; break;
      }
      case 0x41: { // STORE: ( v addr -- )
        const ad = stack[sp - 1];
        if (ad < 0 || ad > 255) return 6;
        mem[ad] = stack[sp - 2]; sp -= 2; break;
      }
      case 0x50: { // PRINT: decimal ASCII, '-' when negative, no padding or newline
        const v = stack[--sp], neg = v < 0;
        let m = neg ? -v : v, d = 0; // m is a double, so -(INT_MIN) stays exact
        if (m === 0) digits[d++] = 48;
        while (m > 0) { digits[d++] = 48 + (m % 10); m = Math.floor(m / 10); }
        if (olen + d + (neg ? 1 : 0) > OUT_MAX) return 11; // a trapped PRINT writes nothing
        if (neg) obuf[olen++] = 45;
        while (d > 0) obuf[olen++] = digits[--d];
        break;
      }
      case 0x51: if (olen >= OUT_MAX) return 11; obuf[olen++] = stack[--sp] & 255; break; // PUTC
      case 0x52: stack[sp++] = ip < ilen ? input[ip++] : -1; break; // IN
      case 0x53: return stack[--sp] & 255; // EXIT
      default: { // binary operators 0x10..0x22: ( a b -- r ), b on top
        const b = stack[sp - 1], a = stack[sp - 2];
        let r;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break;
          case 0x13: if (b === 0) return 4; r = (a / b) | 0; break;
          case 0x14: if (b === 0) return 4; r = b === -1 ? 0 : (a % b) | 0; break;
          case 0x15: if (b === 0) return 4; r = Math.floor((a >>> 0) / (b >>> 0)) | 0; break;
          case 0x16: if (b === 0) return 4; r = ((a >>> 0) % (b >>> 0)) | 0; break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;
          case 0x1d: r = a >> (b & 31); break;
          case 0x1e: r = (a >>> (b & 31)) | 0; break;
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // 0x22 LTU
        }
        stack[sp - 2] = r;
        sp--;
      }
    }
  }
}

for (const id of readdirSync(IN).sort()) {
  const exit = run(readFileSync(join(IN, id, 'program.bin')), readFileSync(join(IN, id, 'input.bin')));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'stdout.bin'), obuf.subarray(0, olen));
  writeFileSync(join(OUT, id, 'exit.txt'), exit + '\n');
}
