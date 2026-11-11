# D3D11 composition resource identity

Run `scripts/test-cases/d3d11-composition-resource-identity.ps1` with `-Architecture
x64` or `x86`. Optionally supply an unchanged generation-28 `-BaselineRuntime`;
the gate requires that DLL to reproduce the first-buffer mismatch. This is a
console/offscreen native regression, separate from game and consumer acceptance.

Generation 28 returns a proxy from D3D11 device creation, but the first DXGI
composition back buffer returns its original device from `GetDevice`. ANGLE's
texture-import boundary compares that pointer directly with its renderer device.
Creating an ordinary texture happens to install the existing resource hook and
masks the failure, making the defect sensitive to startup order.

The production correction installs the existing D3D11 resource identity hook in
`DXGISwapChain::GetBuffer` before exposing the buffer to the caller. It retains
the existing video-support/Media Foundation exception and leaves unwrapped
devices unwrapped. It adds no application names, privilege rules or sandbox
changes and does not disable any graphics hook.

The gate checks the first buffer before application texture creation, both
buffer indices, `ID3D11Resource` and `IUnknown` queries, resize and balanced device
references. It also runs video-support and WARP controls. It creates no HWND,
calls no `Present`, sends no input, and copies no runtime distribution. Builds
and tiny owned configuration/log stages use fixed reusable workspace paths.

This fixture proves the native pointer boundary. PAGER, Chromium rendering,
actual elevated consumers and overlay features require separate acceptance.
