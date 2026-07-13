[CmdletBinding()]
param()

throw @"
This historical hudhook real-client case was retired when the hudhook launcher
and payloads were removed from the production SDK. The launcher remains as the
catalog entry for that recorded case; use the current D3D12 SDK gate instead:
  .\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk.ps1
"@
