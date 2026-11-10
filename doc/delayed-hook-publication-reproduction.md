# Concurrent delayed-hook publication reproduction

The actual normal-permission PAGER 1011 failure (PID 56144, birth
134388135197380645) loaded ReShade and registered its add-on, but no authenticated
runtime/surface followed. The graphics-loading thread's delayed D3D11 scan was
skipped; another thread began installing those hooks 196 ms later. Initial hook
registration still reported D3D11 absent. This suggested a call could enter the
native D3D11 export before hook publication. The failure itself has no ETL.

An ordinary positive PAGER trace (PID 63256, birth 134388148188384461) validates
passive device-event/stack collection: the logged ReShade device detour is
followed by native core creation on the same thread, with ReShade and ANGLE in
the stack. It does not reproduce or fix the failed lifetime.

## Owned causal fixture

`tests/delayed-hook-publication` executes the **unchanged sealed 1012 ReShade
host** in fresh owned processes. It verifies the source vector and runtime hash.
A test-only Win32 API barrier pauses the real host scan on a separate thread
while its actual delayed-path mutex is held; it does not access private mutex
layout, replace the scan implementation, or change production locking. A second
thread executes real LoadLibrary and hardware D3D11 creation. Public ReShade
device callbacks and actual GPU readback establish whether ReShade observed
that successful device. No window, user game, Steam code, input, consumer retry,
fixed delay, reinjection or production DLL edit is involved.

| Case | First real device | After held scan returns |
| --- | --- | --- |
| Serialized scan/load | ReShade proxy, one init-device callback | Second device observed; both destroy callbacks |
| Contended scan/load | Native usable device, zero init-device callbacks; native D3D11 LoadLibrary scan skip logged | Another thread installs D3D11 hooks; second device through the same cached function pointer observed; first device remains native |

Three real green texture readbacks run in each process, including the original
device after late publication. The contended executable returns **3** and its
report retains `gatePassed:false`. The internal diagnostic option
`--expect-reproduction` only lets automation collect the known failure; it does
not turn the runtime boundary into a passing acceptance test. Each case has its
own launcher under `scripts/test-cases`.

## Consequence and remaining boundary

This demonstrates that the observed skip/deferred-install ordering can lose
ReShade's automatic device observation and cannot retroactively wrap an existing
device. It makes a separate loader-publication investigation concrete. It still
does not prove that this mechanism caused the untraced actual PAGER failure,
nor establish actual scene/input, Steam overlay or physical-key acceptance.
Candidate 1012 remains scoped to the separate tooltip correction and immutable.

A future production proposal must preserve the upstream deadlock-avoidance
reason for the try-lock. Simply blocking on that mutex, adding sleeps/retries,
or scheduling a later rescan is not established as a safe correction: nested
loads / DLL loader-lock contexts need explicit liveness coverage, and a later
scan cannot observe a device that has already bypassed the detour. Review the
per-library publication boundary and add reentrant/DllMain and independent-loader
controls before changing locking. A blocking design would also need a revised
fixture handshake, because this causal fixture intentionally holds publication
until the missed first device completes.
