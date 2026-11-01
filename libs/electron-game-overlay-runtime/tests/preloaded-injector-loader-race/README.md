# Copied preloaded-member loader initialization race

This console fixture compiles the candidate injector source and copies its actual
`participant_loading_thread` bytes into a retained, fixture-created child process.
It creates no windows and loads no ReShade or production EGO add-on.

An inert add-on DLL holds its `DllMain` on an owned event while its exported
`NAME` still has the generic initial value. The controller requires the OS module
snapshot to expose that exact DLL, reads the generic name and unfinished flag,
then runs the candidate's immutable-file/BID/ABI preflight. The copied thread must
wait until DLL initialization is released before checking the final unique name
and invoking activation with the explicit private staged directory.

Four independent child lifetimes cover successful activation, an incorrect final
name (no activation), explicit `ERROR_ALREADY_ASSIGNED` (85), and an ordinary
access-denied error. Target-resident traps prove the preloaded branch calls neither
`LoadLibrary` nor `FreeLibrary`. Each child must exit normally through its owned
stop event; emergency cleanup can terminate only the process returned by this
fixture's own `CreateProcess` call.

The recorded x64 and Win32 run each passed four cases and 352 assertions without
skips. The member/runtime copied-code sizes were 1,906/482 bytes on x64 and
1,248/368 on Win32, all below the 4,096-byte bound.

Run from the repository root with a Windows MSVC generator:

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/preloaded-injector-loader-race -B build/preloaded-injector-loader-race/x64 -A x64 -DINJECTOR_SOURCE_FILE=C:/absolute/path/to/candidate/tools/injector.cpp
cmake --build build/preloaded-injector-loader-race/x64 --config Release
ctest --test-dir build/preloaded-injector-loader-race/x64 -C Release --output-on-failure
```

Use `-A Win32` and a separate build directory for the 32-bit case. The default
build ID is an inert fixture identity; it does not identify a production native
engine. `-DADDON_BUILD_ID=<32 uppercase hex digits>` can replace it consistently
for both stub and controller.

This verifies the copied loader and the initializing-module race. It does not
exercise the injector CLI, host claims, full fallback loop, SDK authentication,
production ownership-marker validation, add-on callback registration, rendering,
input, actual external `AddonPath` scanning, or game acceptance. Those remain
separate tests.
