# D3D11 composition back-buffer identity

Generation 29 corrects a native device-identity mismatch at the first DXGI
composition back-buffer import. It changes the owned ReShade host; the EGO
feature add-on implementation, build ID, cooperative ABI and elevated private
authorization capability remain unchanged. The injector and package continue to
require exact native artifact hashes. Existing ReShade installations are not
rewritten or replaced to obtain this correction.

## Evidence and correction

The coordinating consumer chat reproduced PAGER's WebGL failure with unchanged
SDK candidate 1.0.1-alpha.2026111005. The failing early-hook run used Electron
35.7.2/Chromium 134 and ANGLE D3D11. Chromium reported a texture/device mismatch
before the later renderer-child injection attempt. A medium trial missed device
creation and timed out, so those trials do not establish elevation as the cause.
No child-name exclusion, privilege change or consumer workaround follows from
that evidence.

ANGLE compares the device obtained through a texture's `GetDevice` directly to
its renderer device. See the upstream
[Renderer11 implementation](https://chromium.googlesource.com/angle/angle/+/refs/heads/main/src/libANGLE/renderer/d3d/d3d11/Renderer11.cpp).
Pinned ReShade already has a resource `GetDevice` hook for this compatibility
requirement, including its Media Foundation video-support exception.

An owned console/offscreen fixture proves the missing boundary independently:
generation 28 returns the wrapped device from device creation, but the first
composition back buffer returns the original device. Creating an ordinary
texture afterward installs the resource hook and masks that mismatch. This
explains why catching early device creation can fail while a later attachment
does not exercise the same boundary; neither path is a substitute for consumer
acceptance.

The new patch installs the existing resource hook in `DXGISwapChain::GetBuffer`
before exposing a D3D11 buffer through any supported resource interface. It
preserves the hook's existing device selection and reference accounting. Video
devices still use the existing original-device exception; unwrapped WARP devices
remain unwrapped. D3D10/D3D12 paths are unchanged. No application names, sandbox
settings, graphics disabling or global driver/security changes are introduced.

## Native and offline validation

Use the dedicated launcher:

```powershell
libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-composition-resource-identity.ps1 -Architecture x64
libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-composition-resource-identity.ps1 -Architecture x86
```

Supply `-BaselineRuntime` with the matching unchanged generation-28 DLL to retain
the exact failing control. On each architecture the gate checks clean hardware,
corrected wrapped hardware, the video-support exception, unwrapped WARP and the
old mismatch. It covers the first back buffer before application texture
creation, both buffer indices, resource/IUnknown queries, resize and balanced
device references. The fixture creates no HWND, performs no Present and sends no
input. Runtime bytes are loaded from the supplied path; no distribution copy is
created per run. Builds and tiny owned stages use fixed reusable workspace paths.

The ordered build stack verifies the complete native source inventory and exact
pre/post hashes before atomically publishing its one changed ReShade source
file. Repeated x64/x86 configuration peels and reapplies that terminal patch.
Generation-29 SDK distribution validation requires its compiled implementation
pin and exact ReShade patch digest on both architectures; missing or substituted
metadata cannot promote an older runtime.

These checks prove the native pointer boundary and package identity. PAGER and
the supplemental Chromium fixture, actual administrator operation, rendered
overlay pixels, first-key focus, cursors, scrolling, scaling and multi-app
behavior remain the coordinating chat's separate acceptance work. No physical-key
or real-game acceptance is inferred from this console gate.

## Separate Steam compatibility investigation

The reported Steam Overwatch failure has not been reproduced locally because
that game is not installed. Upstream ReShade documents a factory hook-order
constraint with Steam. An owned console model can expose that ordering risk,
but does not establish actual Steam or Overwatch acceptance. No speculative
Steam production change is included in this identity correction. The retained
consumer logs and actual Steam renderer hook-skip evidence belong to that
separate investigation.
