# Controlled D3D11 presentation evidence

`scripts/test-cases/d3d11-presentation-diagnostic.ps1` runs the existing strict
calibration test with both its optional three-pixel GPU readback and the
controlled host's presentation evidence enabled. It does not change expected
pixels, timing limits, swap-chain configuration, or rendering/input policy.

The child-inherited environment value
`ELECTRON_GAME_OVERLAY_CONTROLLED_PRESENT_DIAGNOSTIC=1` enables this evidence only
in `d3d11_overlay_test_host.exe`. Other values leave the ordinary `Present(1, 0)`
path unchanged and perform no additional DXGI queries or presentation timing.
The launcher restores its caller's previous environment value on exit.

The controlled host creates `electron-game-overlay-present-v1.log` beside its
own copied executable using `CREATE_NEW`; it never overwrites an existing file.
Lines are also published through the existing stdout/debug-marker channel.
There are at most 64 lines per primary/secondary surface, ordinarily one per
second. A change in the actual `Present` HRESULT can consume the next bounded
sample immediately. No extra images, pixels or screenshots are collected.

`EGO_CONTROLLED_PRESENT_V1` retains exact PID/TID, swap-chain and HWND identity,
UTC FILETIME, monotonic tick count, QPC bracketing the actual `Present`, exact
`Present` HRESULT (including `DXGI_STATUS_OCCLUDED`), `GetDesc` result/configuration,
`GetLastPresentCount` result/count, and `GetDeviceRemovedReason`. An unsupported
query retains its HRESULT; its value must not be treated as valid evidence.

An `S_OK` presentation return or an increasing last-present count establishes an
API boundary, not that DWM displayed those particular pixels. The explicit
`scope=api-return-not-display-proof` label preserves that limit. Keep this
controlled-host evidence separate from actual-game acceptance.
