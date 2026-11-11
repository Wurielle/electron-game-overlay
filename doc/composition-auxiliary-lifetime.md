# Auxiliary layered-bit lifetime

Candidate 1011 / generation 34 is not accepted. Its owned popup renderer/input
pair passed, but actual PAGER high Close-hover still reset the runtime when a
caption tooltip dropped WS_EX_LAYERED. The independent inventory records the
same HWND/thread/owner/style first at extended style 0x80088, then at 0x88.
The native binding record shows that unlayered window becoming a second
candidate while the main HWND/thread/token remain valid. Normal startup also
has a separate pre-runtime failure under investigation; neither failure is
reclassified as security interference or a consumer workaround.

Generation 35 preserves the existing presentation predicate and remembers only
an already-excluded layered/topmost popup tool **without NOACTIVATE**. The host
owns a bounded table and a separate window-property token. A later observation
may retain that exclusion only for the same exact HWND lifetime, PID, thread,
owner, full style and extended style with just LAYERED masked out. Destruction
or property/token loss prevents inheritance; any other observed shape change
revokes it. Caption/APPWINDOW changes remain presentation candidates.

This does not classify a previously unseen 0x88 tool as auxiliary: an interactive
tool with identical flags stays a candidate, including as the sole presenter.
It does not retain removal of NOACTIVATE. There are no class/title/game-name,
foreground, size or timing preferences, window messages, or activation probes.
The 256-entry table reclaims dead/invalidated lifetimes. If full, token creation
fails or a shape/lifetime changes concurrently, no new remembered exclusion is
granted. An unseen unlayered auxiliary can therefore still be ambiguous; actual
PAGER must demonstrate that its layered lifetime was observed before transition.

The normal uniqueness, existing binding lifetime/token, nonmigration and reset
checks remain. The valid-HWND path, private transport, configuration ownership
and target-exit rules are unchanged. Native feature add-on and manager sources
are unchanged, so their build ID does not roll merely for a ReShade-host patch.
Generation 35 and the new patch pin must match in both native architectures and
the SDK/package manifest.

## Paired graphics fixture

Use the new paired source snapshot and the dedicated
`d3d11-composition-popup-lifetime.ps1` launcher, or the existing controlled host:

```text
--composition-swapchain --noninteractive-tool-popup
```

The popup is real, same-process, unowned, offscreen and visible before the first
application Present. Its visible style is 0x94800000; initial extended style is
0x80088, with NOACTIVATE absent. Initial display and all commands use no
activation and fail if the foreground changes. The atomic sibling state file
remains `electron-game-overlay-tool-popup-state.json`; it additionally reports
`layered` and `command`. Initial command is `initial`, transition zero.

The six-command root renderer/input sequence is:

| Sibling request file | Expected command | Visible | Extended style |
| --- | --- | --- | --- |
| electron-game-overlay-tool-popup-unlayered.request | unlayered | true | 0x88 |
| electron-game-overlay-tool-popup-layered.request | layered | true | 0x80088 |
| electron-game-overlay-tool-popup-hide.request | hide | false | 0x80088 |
| electron-game-overlay-tool-popup-show.request | show | true | 0x80088 |
| electron-game-overlay-tool-popup-hide.request | hide | false | 0x80088 |
| electron-game-overlay-tool-popup-show.request | show | true | 0x80088 |

Each fresh acknowledgement increments the transition, preserves popup/main HWND
and foreground and reports actual style bits. Concurrent requests, failures or
more than 16 total transitions fail the controlled fixture. There are no timer
toggles or automatic retries. Layered commands preserve existing visibility.
Require the same surface identity, rendering/interception and renderer text,
then actual native glyph/pixel proof, OS first-key/reopen, pointer/wheel/cursor
isolation and authoritative-exit cleanup. OS SendInput is not a physical-key gate.

The offscreen native suite compares exact generation-34 and generation-35
headers, including known-auxiliary transitions and an unseen unlayered genuine
peer. Retained older gates use frozen inputs and keep their historical scope.
Actual PAGER normal/high Close-hover and the full real-renderer regression matrix
remain separate acceptance work. Preserve all 1011/1010/1009 artifacts.
