# Real Steam control and owned-hook scope

The owned foreign-Present fixture passed 64 cases on generation 32: actual
production SDK-first raw hooks, independent pre-existing and later renderer
detours, the proxy-factory skip, tracked original-chain identity, real native
Present/Present1 forwarding, device/IUnknown identity and GPU red/green readback.
It includes the observed Overwatch legacy RGBA8/discard/video-device path and
modern flip controls. It does not execute Valve's factory wrapper, enabling
decisions, rendering/frame-sharing path or gameoverlayui consumption, nor the
full authenticated feature-engine scene. It does not reproduce the actual
Overwatch no-frames failure and does not justify a coexistence behavior change.

The matched Overwatch generation-31 logs already select LoadLibrary. Steam
tracks the original main swapchain seen in the nested proxy/raw Present records.
The first factory warning is followed by successful later tracking. All 18
resource-release timestamps align with game SetFullscreenState(FALSE) calls.
The remaining gap is whether actual Steam Present/render callbacks execute and
produce shared frames on the relevant visible game path.

The existing installed Steam PAGER app provides a bounded real-Steam control
without changing Steam settings, shortcuts, game files or installing another
game. Root observed a Steam launch toast with Izabela closed; the paired UI log
connects to PAGER and lacks the Overwatch-style no-rendered-frame warnings for
the observation period. This establishes a visible toast, not successful opening
of the full Steam menu. Compare a fresh PAGER lifetime under the SDK using the
same Steam launch, token context, visible toast/menu criteria and observation
period, preserving exact PID/birth and matching Steam/native logs. This is PAGER
coexistence evidence; it cannot be relabeled Overwatch acceptance.

A local native fixture merely given Steam environment variables is insufficient.
Valve documents automatic overlay hooking for Steam-launched games, and
SteamAPI_Init before graphics-device creation for a development executable.
An owned native real-Steam test would therefore need an approved Steam launch
association or a proper Steamworks API/redistributable integration and valid app
context. No such integration is currently part of these fixture paths. Do not
copy a game's binaries, replace its executable, alter a user's shortcut/settings,
or load the Steam renderer DLL manually to manufacture this control.

Official references: [Steam Overlay](https://partner.steamgames.com/doc/features/overlay)
and [Steamworks API initialization](https://partner.steamgames.com/doc/sdk/api#initialization_and_shutdown).
Valve also documents that initialization can fail when the application and Steam
client run under different user/access contexts. A high producer with a medium
Steam-launched target must be distinguished from elevating that game itself.
