# Registered preload injector policy fixture

This Windows console fixture compiles the supplied candidate injector source
directly, with its entry point renamed and never called. It performs no remote
thread creation, DLL loading, target injection, graphics initialization, desktop
input, or game execution.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/preloaded-injector-policy `
  -B build/preloaded-injector-policy/x64 -A x64 `
  -DINJECTOR_SOURCE_FILE=C:/absolute/path/to/tools/injector.cpp
cmake --build build/preloaded-injector-policy/x64 --config Release
ctest --test-dir build/preloaded-injector-policy/x64 -C Release --output-on-failure
```

Use a separate `Win32` directory with `-A Win32` for x86. The executable prints
one JSON record on success. Configuring this fixture records no execution pass;
the exact source must be frozen, built, and run independently on both target
architectures.

The policy checks cover strict architecture-specific registered filenames,
build-ID and SHA-prefix binding, target-derived disabled-name rules, immutable
regular-file hashing, and authoritative process-token privilege checks. The
filename contains only the first eight SHA-256 bytes; full native file equality
remains a separate validation requirement. Self-token results are compared with
independent Windows token queries, so an elevated test runner must be rejected
rather than incorrectly treated as an ordinary user.

The fixture executable also exports data-only runtime/member markers. Actual
Windows module/export inspection must distinguish a completed adapter from an
unauthenticated dormant member, and an explicit zero adapter word must remain
zero despite a ready member. A source-bound configure guard checks that the
foreign-host loading predicate admits the completed adapter. No initializer is
called. The reparse-file case requires an actual symbolic link; it fails rather
than silently skipping if the test account lacks symlink capability.

The first-host selector cases use dummy native bytes in an exclusively created
local stage and a stable shared add-on directory outside that stage. They cover
the exact owned markers and JSON grammar, effective base/runtime binding,
canonical ordinary/extended AddonPath spelling, full candidate hash, required
regular files, held file/directory guards, concurrent independent publication,
unrelated add-on files, target-game directory rejection, real shared/stage
ancestor junctions and a real reparse leaf.
The selector inherits PE/BID/ABI identity from equality with an independently
validated staged DLL; these dummy-byte tests establish the selector boundary,
not that separate production PE validation. No fixture invokes the new
first-host disk-load branch or grants it on an existing host.

These cases do not establish remote activation, dormant scanner behavior,
mixed-version transport isolation, hook recovery, rendering, input, or existing
installation preservation. Those need their separate controlled integration
and DX demo cases.

Compatibility scope: the new injector admits a completed baseline adapter via
`AdapterReadyV1 == 1` without changing the authenticated-member meaning of
`ReadyV1`. An older injector that requires member readiness can time out on a
manually configured stock-only host while every preloaded app is offline and
dormant. The current SDK enables preloading only for the latest project-owned
hosts; their existing gate/adapter-readiness path supports older SDK joins.
This fixture does not turn dormant preloading into authenticated readiness or
claim universal older-injector support on manually configured stock hosts.

The [first-host console evidence](evidence.first-host.windows-console-20261102.json)
records nine cases and 716 assertions passing on each architecture against the
exact `FA53B7BC…` injector source, including real junction/symlink rejection and
the strict owned-run marker grammar. The initial 269-character fixture file
setup failure is retained there and is separate from production behavior. The
earlier [preload-only milestone](evidence.windows-console-20261101.json) retains
its original seven-case `EDFF9D0B…` source and binary hashes.
