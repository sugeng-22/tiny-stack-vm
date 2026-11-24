# Tiny Stack VM

An original interpreter for make.fun's tiny stack ISA, written from the ISA spec in the
competition kit. `main.ts` (Node 22, zero dependencies) predecodes each program into typed
arrays indexed by pc, then runs it in a tight switch loop: wrapping 32-bit arithmetic, a
256-value stack, 256 words of memory, calls, input/output, and all ten traps.
