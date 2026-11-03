# Ordinary shared-directory add-on fixtures

These test-only DLLs use stock ReShade's public add-on API and have no EGO ABI or
private engine. The acceptance controller copies them into an isolated shared
directory under the repository's build root. One initializes successfully; the
other records its exact target PID/creation time and deliberately returns false
from `AddonInit`. A rejected unrelated add-on must not block the selected EGO
participant or replace the one ReShade host.

Configure this project separately for x64 and Win32, supplying
`RESHADE_INCLUDE_DIRECTORY` from the candidate's pinned ReShade checkout. The
resulting `shared_addon_sentinel.dll` and `shared_addon_reject.dll` are acceptance
assets only and are never distributed in the SDK.
