# Preloaded add-on filename policy console fixture

This portable C++17 fixture tests the exact supplied
`ego_preloaded_addon.hpp`. It requires no Windows API, ReShade runtime, native
production build, graphics target, Electron app, or game. It establishes the
filename dormancy policy only; native loading, late activation, session route
isolation, rendering and input remain separate integration checks.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/preloaded-addon-policy `
  -B build/preloaded-addon-policy/x64 -A x64 `
  -DPRELOADED_ADDON_HEADER=C:/absolute/path/to/ego_preloaded_addon.hpp
cmake --build build/preloaded-addon-policy/x64 --config Release
ctest --test-dir build/preloaded-addon-policy/x64 -C Release --output-on-failure
```

Use a separate `Win32` directory and `-A Win32` for x86. Other C++17 toolchains
can configure without a Visual Studio architecture flag. The executable prints
one JSON success record or returns a nonzero status with a failure message.

The five cases cover both architectures, exact public names of
`Electron Game Overlay Runtime <full leaf>`, case-insensitive
native build IDs, malformed reserved fields and prefixes, expected-build-ID
validation, unaffected ordinary names and unique app/hash registrations. Names
with a case variant of `ego-preload-` fail closed so Windows case aliases cannot
change a preloaded DLL into an automatically active ordinary member. A valid
filename is a dormancy marker, not file-content authentication.

No execution result is recorded by adding this fixture; it must be built and
run against the exact candidate header to establish a pass.
