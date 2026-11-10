# Bounded callback-chain snapshot fixtures

The native console gate compiles the exact header extracted from the pinned
production patch. An owned foreign DLL, the pinned MinHook implementation and
saved private-code trampolines form an actual callback chain. Both Present forms
retain their arguments/HRESULT and exactly one foreign/native call per invocation.
The 17-record budget, reference count, GetLastError, inaccessible code reads,
exhausted guards and unavailable log sink are checked separately from any game.

Run `scripts/test-cases/bounded-compatibility-snapshot.ps1 -Architecture x64`
or `x86`. Run `scripts/test-cases/compatibility-snapshot-source-cache.ps1` for the
isolated production CMake migration checks. Both reuse fixed build/data paths.
No actual Steam, target injection, graphics device, window or input is used.

See `doc/bounded-compatibility-snapshot.md` for field roles, lock boundaries and
the deliberately limited meaning of entry-jump observations.
