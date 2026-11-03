# Stock INI canonicalization console regression

This fixture uses the exact supplied pinned `ini_file.cpp` without loading a
ReShade DLL or creating graphics, input, injection, or game objects. It never
modifies its source template. All writes go to a fresh, explicitly named owned
build directory, and every snapshot is created with `CREATE_NEW`.

The canonical source ends with a CRLF blank section separator. The fixture removes
only that final separator from a copy to reproduce the former 207-byte template.
It sets the already-present global `OVERLAY/TutorialProgress=4`, then saves through
the actual stock cache/CRT path. The first result must match the complete source
bytes exactly. A cache clear/reload and identical setter/save must produce those
same bytes again. This preserves strict template hash checks in runtime tests.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/ini-canonicalization `
  -B build/ini-canonicalization/x64 -A x64 `
  -DRESHADE_SOURCE_DIR=C:/absolute/path/to/pinned/reshade-src
cmake --build build/ini-canonicalization/x64 --config Release
# The final stage directory must not exist; its owned build parent must exist.
& build/ini-canonicalization/x64/Release/ini_canonicalization_probe.exe `
  C:/absolute/repo/libs/electron-game-overlay-runtime/config/ReShade.ini `
  C:/absolute/repo/build/ini-canonicalization/run-unique
```

Never supply a game directory. There is no recursive cleanup or source-template
write. The stage retains the source/legacy/first-save/second-save binary snapshots
and its JSON report. `evidence.windows-console-20261101.json` records the observed
207-byte `2A3BD...` legacy template becoming the 209-byte `A4BEEB...` canonical
template by appending only bytes `[13,10]`, then remaining byte-identical on the
second save. This is serializer regression evidence, not overlay acceptance.
