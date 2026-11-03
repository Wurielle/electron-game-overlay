# Cooperative add-on loader acceptance

This native Windows gate uses only newly compiled, owned console targets and
inert marker DLLs. The host DLL is a fixture exporting the identity/readiness
symbols needed to exercise injection ownership; it is not ReShade. This proves
loader/claim behavior, not game graphics, input, or SDK feature acceptance.

Run each architecture with its freshly built production injector and exact
current add-on build ID:

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/cooperative-addon-loader.ps1 `
    -InjectorPath C:/path/to/x64/inject.exe `
    -Architecture x64 `
    -AddonBuildId A8E9DA12477741B9979D9B1B51994EF3
```

Use `-Architecture Win32` with the x86 injector. CMake and the Visual Studio
2022 C++ tools must be installed. Generated fixture binaries, stages, stdout,
stderr and evidence are retained under `build/cooperative-addon-loader`.
The guard unit compiles the production session-query helpers directly from the
canonical patched source under `build/electron-game-overlay-runtime/_deps`.
Pass `-InjectorSourcePath` when testing a different exact patched source tree.

The gate verifies simultaneous first callers result in exactly one original
host and separate member DLLs, including the same module basename in different
stage directories. A third explicit `--addon-only` caller attaches its own
member without changing the host or its effective target base path. The
target-owned host claim survives injector exit and disappears after exact
target termination.

A matching instance, mismatched process creation time, and stale ABI-compatible
member build ID exercise the actual native validation. The creator-crash case
holds an owned inert host inside its DLL load, kills only its injector child,
then proves another caller retains the pinned ownership rather than injecting
a second host. A separate target containing only a pinned empty claim likewise
cannot receive a replacement runtime after the bounded wait expires.

The failed-member cases reject eight distinct staged modules from an explicit
initializer return. Each reports the additive unload-safety query as exactly
one, is detached, and does not increase the three admitted inert modules.
A repeated load of an existing inert module proves cleanup releases only the
reference acquired by that load. A zero query and an absent query retain their
modules. These fixtures verify loader decisions; they do not establish the
production engine's callback/publication/PIN safety predicate.

The session guard unit queries the actual current process token, accepts the
same retained process token, and rejects an invalid target handle. A pure policy
check rejects differing session IDs. It never creates sessions or changes token
security state; an actual second Windows session is not exercised by this gate.

All DLLs and configuration files are created in fresh fixture directories.
Only fixture-owned children are terminated. This does not mutate an existing
game/ReShade installation and is separate from the real-game E2E gates.

Both canonical Release injectors passed on 2026-11-01. The portable
[evidence record](evidence-2026-11-01.json) binds those assertions to their
binary/source hashes. Full machine-local logs remain in the ignored build
directory. These are separately staged copies of inert fixtures, not actual
independently released SDK packages. Attachment across Windows sessions is
unsupported and rejected before ownership/mutation. An actual second-session
process rejection run was not performed; the OS query/failure and mismatch
policy branches were tested as described above.

The [failed-member cleanup evidence](evidence-failed-member-cleanup-2026-11-01.json)
records separate private Release authoring builds for both architectures. Their
inert payload validation used the generation-11 build ID; that is not a final
packaged result after mapped add-on implementation changes.
