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

Three additional child lifetimes cover explicit first-host snapshot loading.
The DLL is absent initially. A target-resident loader wrapper accepts only its
exact `stage/preloaded-addons/<strict leaf>` path, and the fake bootstrap requires
the snapshot's activation to have accepted the stage parent before it runs. The
test rejects any ordinary staged engine, duplicate successful load, premature
bootstrap or unload. Busy gate values 1, 2 and 3 must each reject without loading;
only the fixture then resets its fake gate to 0 for an independent retry. This
does not authorize production code to reopen an uncertain registration gate.
A separate explicit loader failure must reopen only its own failed claim before
one successful retry.

The seven-case x64 and Win32 run each passed 615 assertions without skips. The
member/runtime copied-code sizes were 2,121/482 bytes on x64 and 1,392/368 on Win32,
all below the 4,096-byte bound. The earlier four-case, 352-assertion evidence is
retained with its own source hashes and earlier copied-code sizes.

Run artifacts use a short, uniquely created child of the repository's regular
`build` directory. An initial Win32 attempt using the longer CMake build directory
failed with `ERROR_FILENAME_EXCED_RANGE` at a 252-character snapshot path; its log
is retained. Shortening only the fixture run root preserved the required leaf,
snapshot structure and all acceptance checks. This is not evidence of production
SDK path-budget coverage.

Run from the repository root with a Windows MSVC generator:

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/preloaded-injector-loader-race -B build/first-host-preload-loader-race/x64 -A x64 -DINJECTOR_SOURCE_FILE=C:/absolute/path/to/candidate/tools/injector.cpp
cmake --build build/first-host-preload-loader-race/x64 --config Release
ctest --test-dir build/first-host-preload-loader-race/x64 -C Release --output-on-failure
```

Use `-A Win32` and a separate build directory for the 32-bit case. The default
build ID is an inert fixture identity; it does not identify a production native
engine. `-DADDON_BUILD_ID=<32 uppercase hex digits>` can replace it consistently
for both stub and controller.

This verifies the copied loader, initializing-module race and snapshot-before-
bootstrap ordering with inert host exports. It does not exercise the injector CLI,
authoritative host claims, full fallback loop, SDK authentication, production
ownership-marker/path admission, add-on callback registration, rendering, input,
actual external `AddonPath` scanning, or game acceptance. Those remain separate
tests.
