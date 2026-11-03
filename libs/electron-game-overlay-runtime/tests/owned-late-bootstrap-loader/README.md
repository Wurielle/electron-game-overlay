# Inert owned-host activation loader fixture

This console fixture tests the native loader seam using inert DLLs. It does not
load real ReShade, create graphics, register callbacks, validate the real owned
stage marker, or establish overlay/game acceptance. Every target and injector
is an owned child with a unique fixture path; cleanup uses retained process
objects and never executable-name matching.

The fake owned host exports the owned capability, host ABI, add-on gate, and
activation function. It has no automatic initialization worker. Its first
member must load under gate 1, and the injector must publish gate 2 before
calling the member initializer and then the owned activation function. The
activation record requires an initialized member and gate 2 or 3. It models
manager completion by publishing gate 3, without a callback vector.

The separate cases cover simultaneous first/member attachment with one host,
recovery from a registered adapter without a feature participant, CLOSED gate
recovery with completed adapter readiness, timeout with ambiguous CLOSED
readiness, malformed capability rejection on default and member-only paths,
absence of activation on a cap-absent host, and explicit activation failure
without a second host. The cap-absent host contains a trap activation function
that must never be called. Its stub runtime and INI hashes must remain equal.

The simultaneous-start case requires exactly one original four-field
`injected-runtime` result and one nine-field `participant-addon` result,
regardless of which app completes first. Both bind the same exact PID and
executable. The first result has no add-on/module path fields; its completed
member/bootstrap work is proved independently by target module counts and the
member/activation records. Later joins retain the nine-field result and exact
host/private-member paths. These result assertions do not weaken the existing
gate, member count, activation order or failure checks.

The reserved marker is staged with its production byte contract so the test
layout is representative. The inert fake host does not read it; marker/path
safety requires separate real-host tests. Likewise, an adapter-ready variable
models completed registration but does not exercise a real callback vector.

Run after the exact injector source and package build ID are frozen:

```powershell
& libs/electron-game-overlay-runtime/scripts/test-cases/owned-late-bootstrap-loader.ps1 `
  -InjectorPath <new-built-injector.exe> `
  -InjectorSourcePath <exact-source-used-for-that-build.cpp> `
  -Architecture x64 `
  -AddonBuildId <exact-32-digit-build-ID>
```

Repeat with `-Architecture Win32` and its matched injector. Evidence records
both injector-byte and normalized-source hashes. Source compilation alone is
not a passing execution claim. The CLOSED-unready case intentionally spends
the injector's bounded wait (currently 15 seconds).

The test-local result assertions can also run without creating processes or
loading a DLL:

```powershell
& libs/electron-game-overlay-runtime/tests/owned-late-bootstrap-loader/result-contract.test.ps1
```
