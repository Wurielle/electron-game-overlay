# Owned-runtime late D3D11 overlay proof

This separate controlled fixture exercises the production owned-runtime bootstrap
ABI. It preserves the corrected prototype caller's strict graphics lifetime and
state checks, and the controller's actual foreground pixel/input checks. It does
not include prototype source or alter the historical prototype runs.

The host completes at least 60 successful raw native Presents before loading the
supplied ReShade and private add-on. It requires the exported data capability
`ElectronGameOverlayOwnedLateD3D11AbiV1` to equal one, resolves
`ElectronGameOverlayInitializeOwnedLateD3D11V1` and
`ElectronGameOverlayQueryOwnedLateD3D11V1`, and calls the initializer with
`nullptr`. No device, context, swapchain, HWND, callback or configuration path is
passed to bootstrap. Query uses only a fixed-layout 104-byte diagnostics POD.
The caller accepts no `--config` argument.

The runner creates a unique external owned stage containing copied runtime and
add-on bytes, `ReShade.ini`, the normal `.electron-game-overlay-run.json` record,
and `electron-game-overlay-owned-runtime-v1.marker`. That marker contains exactly
the ASCII bytes `ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1` followed by one LF,
without a BOM. The owned bootstrap resolves its own configuration within that
stage. No game-directory files or existing official installation are changed.
After clean final runtime retirement, the proof also requires zero generated
per-chain INIs and the staged `ReShade.ini` template's exact original hash.

Run only when the desktop test owner has allocated the GUI/input lane:

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/owned-late-d3d11-overlay-proof.ps1 `
  -RuntimePath C:/absolute/path/to/ReShade64.dll `
  -AddonPath C:/absolute/path/to/electron_game_overlay.addon64 `
  -Architecture x64
```

Use `-Architecture Win32` with matching x86 files. The optional `-SdkDist` and
`-ElectronPath` select exact producer artifacts; defaults use the workspace dist
and Electron. `-SkipBuild` reuses this fixture's existing Release caller only.
The runner builds this standalone host, never an owned ReShade/native production
target. `-GpuReadback` requests bounded diagnostic samples but does not substitute
for required foreground desktop pixels.

The existing private SDK scene producer publishes only into this stage. The
controller requires red target pixels before and after a real resize, synthetic
Windows SendInput delivery to the transported DOM, native suppression while
intercepting, native keyboard delivery after release, and continuity of the
authenticated connection. The host requires zero sampled pipeline-state
mismatches, one adoption, one successful resize, no quarantines/render failures,
and exactly one final notifier retirement before its own device/context release.
It neither restores state to hide a runtime defect nor weakens final retirement.

Evidence under `build/late-d3d11-owned/owned-overlay-proof-*` includes exact
runtime/add-on/caller/source/producer/SDK hashes and both native and producer
reports. This is a deliberate late self-load test. It does not exercise the
process observer or native injection selection; `automaticDiscoveryProven` and
`automaticProcessAttachmentProven` remain false even when its controlled case
passes. Input remains labeled synthetic, separate from a physical-key gate.

These initial files have source/PowerShell parser checks only. No execution or
production acceptance is claimed until a coordinated run records its evidence.
