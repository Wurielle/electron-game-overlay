//! Pure input routing for ordered Electron overlay windows.
//!
//! The native hook is responsible for supplying Win32 messages and converting
//! wheel coordinates from screen space to game-client space. This module owns
//! the stateful decisions: effective interception, Electron focus, pointer
//! capture, coordinate localization, and outbound ordering.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(test)]
pub const WM_INPUT: u32 = 0x00ff;
pub const WM_SETFOCUS: u32 = 0x0007;
pub const WM_KILLFOCUS: u32 = 0x0008;
pub const WM_ACTIVATEAPP: u32 = 0x001c;
pub const WM_CANCELMODE: u32 = 0x001f;
pub const WM_KEYDOWN: u32 = 0x0100;
pub const WM_KEYUP: u32 = 0x0101;
pub const WM_CHAR: u32 = 0x0102;
pub const WM_SYSKEYDOWN: u32 = 0x0104;
pub const WM_SYSKEYUP: u32 = 0x0105;
pub const WM_SYSCHAR: u32 = 0x0106;
pub const WM_UNICHAR: u32 = 0x0109;
pub const WM_MOUSEMOVE: u32 = 0x0200;
pub const WM_LBUTTONDOWN: u32 = 0x0201;
pub const WM_LBUTTONUP: u32 = 0x0202;
pub const WM_LBUTTONDBLCLK: u32 = 0x0203;
pub const WM_RBUTTONDOWN: u32 = 0x0204;
pub const WM_RBUTTONUP: u32 = 0x0205;
pub const WM_RBUTTONDBLCLK: u32 = 0x0206;
pub const WM_MBUTTONDOWN: u32 = 0x0207;
pub const WM_MBUTTONUP: u32 = 0x0208;
pub const WM_MBUTTONDBLCLK: u32 = 0x0209;
pub const WM_MOUSEWHEEL: u32 = 0x020a;
#[cfg(test)]
pub const WM_XBUTTONDOWN: u32 = 0x020b;
#[cfg(test)]
pub const WM_XBUTTONUP: u32 = 0x020c;
#[cfg(test)]
pub const WM_XBUTTONDBLCLK: u32 = 0x020d;
pub const WM_MOUSEHWHEEL: u32 = 0x020e;
pub const WM_CAPTURECHANGED: u32 = 0x0215;

const LEFT_BUTTON: u8 = 1 << 0;
const RIGHT_BUTTON: u8 = 1 << 1;
const MIDDLE_BUTTON: u8 = 1 << 2;

const MK_LBUTTON: u32 = 0x0001;
const MK_RBUTTON: u32 = 0x0002;
const MK_MBUTTON: u32 = 0x0010;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputPoint {
    pub x: i32,
    pub y: i32,
}

impl InputPoint {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl InputRect {
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Uses Win32-style half-open bounds: the left/top edges are included and
    /// the right/bottom edges are excluded.
    pub fn contains(self, point: InputPoint) -> bool {
        if self.width <= 0 || self.height <= 0 {
            return false;
        }

        let x = i64::from(point.x);
        let y = i64::from(point.y);
        let left = i64::from(self.x);
        let top = i64::from(self.y);
        let right = left + i64::from(self.width);
        let bottom = top + i64::from(self.height);

        x >= left && x < right && y >= top && y < bottom
    }

    pub fn to_local(self, point: InputPoint) -> InputPoint {
        InputPoint {
            x: saturating_i64_to_i32(i64::from(point.x) - i64::from(self.x)),
            y: saturating_i64_to_i32(i64::from(point.y) - i64::from(self.y)),
        }
    }

    pub fn is_valid(self) -> bool {
        self.width > 0 && self.height > 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AlphaFrame {
    width: u32,
    height: u32,
    rgba: Arc<[u8]>,
}

/// Caption geometry advertised by the Electron SDK, in window-local pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputCaption {
    pub left: i32,
    pub right: i32,
    pub top: i32,
    pub height: i32,
}

impl InputCaption {
    fn contains(self, window_rect: InputRect, point: InputPoint) -> bool {
        if self.left < 0
            || self.right < 0
            || self.top < 0
            || self.height <= 0
            || !window_rect.is_valid()
        {
            return false;
        }

        let local = window_rect.to_local(point);
        let x = i64::from(local.x);
        let y = i64::from(local.y);
        let left = i64::from(self.left);
        let right = i64::from(window_rect.width) - i64::from(self.right);
        let top = i64::from(self.top);
        let bottom = top + i64::from(self.height);
        let window_bottom = i64::from(window_rect.height);
        left < right
            && top < bottom
            && bottom <= window_bottom
            && x >= left
            && x < right
            && y >= top
            && y < bottom
    }
}

/// One routable Electron overlay window. Windows are stored back-to-front;
/// the last matching window receives uncaptured pointer input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputWindow {
    pub window_id: u32,
    pub rect: InputRect,
    caption: Option<InputCaption>,
    scale_factor_micros: Option<u32>,
    placement_epoch: u64,
    alpha_frame: Option<AlphaFrame>,
}

impl InputWindow {
    pub const fn new(window_id: u32, rect: InputRect) -> Self {
        Self {
            window_id,
            rect,
            caption: None,
            scale_factor_micros: None,
            placement_epoch: 0,
            alpha_frame: None,
        }
    }

    pub fn with_caption(mut self, caption: Option<InputCaption>) -> Self {
        self.caption = caption;
        self
    }

    pub fn with_scale_factor_micros(mut self, scale_factor_micros: Option<u32>) -> Self {
        self.scale_factor_micros = scale_factor_micros;
        self
    }

    pub fn with_placement_epoch(mut self, placement_epoch: u64) -> Self {
        self.placement_epoch = placement_epoch;
        self
    }

    /// Adds optional RGBA pixels for alpha-aware hit testing. Invalid or
    /// incomplete pixel data deliberately falls back to rectangle hit testing.
    pub fn with_alpha_frame(mut self, width: u32, height: u32, rgba: Arc<[u8]>) -> Self {
        self.set_alpha_frame(width, height, rgba);
        self
    }

    pub fn set_alpha_frame(&mut self, width: u32, height: u32, rgba: Arc<[u8]>) {
        self.alpha_frame = Some(AlphaFrame {
            width,
            height,
            rgba,
        });
    }

    pub fn clear_alpha_frame(&mut self) {
        self.alpha_frame = None;
    }

    fn hit_test(&self, point: InputPoint) -> bool {
        if !self.rect.contains(point) {
            return false;
        }

        let Some(frame) = &self.alpha_frame else {
            return true;
        };
        if frame.width == 0 || frame.height == 0 {
            return true;
        }
        let expected_length = (frame.width as usize)
            .checked_mul(frame.height as usize)
            .and_then(|pixels| pixels.checked_mul(4));
        if expected_length != Some(frame.rgba.len()) {
            return true;
        }

        let local = self.rect.to_local(point);
        let pixel_x = (u64::try_from(local.x).unwrap_or_default() * u64::from(frame.width)
            / u64::try_from(self.rect.width).unwrap_or(1))
        .min(u64::from(frame.width - 1));
        let pixel_y = (u64::try_from(local.y).unwrap_or_default() * u64::from(frame.height)
            / u64::try_from(self.rect.height).unwrap_or(1))
        .min(u64::from(frame.height - 1));
        let alpha_index = ((pixel_y * u64::from(frame.width) + pixel_x) * 4 + 3) as usize;
        frame.rgba[alpha_index] != 0
    }

    fn caption_hit_test(&self, point: InputPoint) -> bool {
        self.caption
            .is_some_and(|caption| caption.contains(self.rect, point))
    }
}

/// Compatibility name retained for the completed one-window bridge/tests.
#[cfg(test)]
pub type SelectedWindow = InputWindow;

/// One compositor-local caption placement produced by the input router.
///
/// `placement_epoch` identifies the exact registration/external-bounds state,
/// while `drag_session` and `sequence` prevent delayed coalesced work from
/// overtaking a newer pointer sample or cancellation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DragMoveIntent {
    pub window_id: u32,
    pub placement_epoch: u64,
    pub drag_session: u64,
    pub sequence: u64,
    pub x: i32,
    pub y: i32,
    pub terminal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutboundMessage {
    InputIntercept {
        intercepting: bool,
    },
    WindowFocused {
        focus_window_id: u32,
    },
    Input {
        window_id: u32,
        msg: u32,
        wparam: u32,
        lparam: u32,
    },
    TaggedInput {
        window_id: u32,
        msg: u32,
        wparam: u32,
        lparam: u32,
        scale_factor_micros: u32,
    },
}

impl OutboundMessage {
    fn input_for(window: &InputWindow, msg: u32, wparam: u32, lparam: u32) -> Self {
        window.scale_factor_micros.map_or(
            Self::Input {
                window_id: window.window_id,
                msg,
                wparam,
                lparam,
            },
            |scale_factor_micros| Self::TaggedInput {
                window_id: window.window_id,
                msg,
                wparam,
                lparam,
                scale_factor_micros,
            },
        )
    }

    pub(crate) fn input_fields(&self) -> Option<(u32, u32, u32, u32, Option<u32>)> {
        match *self {
            Self::Input {
                window_id,
                msg,
                wparam,
                lparam,
            } => Some((window_id, msg, wparam, lparam, None)),
            Self::TaggedInput {
                window_id,
                msg,
                wparam,
                lparam,
                scale_factor_micros,
            } => Some((window_id, msg, wparam, lparam, Some(scale_factor_micros))),
            _ => None,
        }
    }
}

/// FIFO outbound storage with lossless control/input ordering. Only a mouse
/// move at the tail may be replaced; a focus, button, key, character, wheel,
/// release, or interception acknowledgement is always an ordering barrier.
#[derive(Debug, Default)]
pub struct OutboundQueue {
    messages: VecDeque<OutboundMessage>,
}

impl OutboundQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, message: OutboundMessage) {
        if let Some((window_id, WM_MOUSEMOVE, _, _, _)) = message.input_fields() {
            if self.messages.back().is_some_and(|pending| {
                matches!(
                    pending.input_fields(),
                    Some((pending_window_id, WM_MOUSEMOVE, _, _, _))
                        if pending_window_id == window_id
                )
            }) {
                *self
                    .messages
                    .back_mut()
                    .expect("the pending mouse move was just matched") = message;
                return;
            }
        }

        self.messages.push_back(message);
    }

    pub fn extend(&mut self, messages: impl IntoIterator<Item = OutboundMessage>) {
        for message in messages {
            self.push(message);
        }
    }

    pub fn pop_front(&mut self) -> Option<OutboundMessage> {
        self.messages.pop_front()
    }

    /// Restores an unsent message ahead of later concurrently queued work.
    pub fn push_front(&mut self, message: OutboundMessage) {
        self.messages.push_front(message);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.messages.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn clear(&mut self) {
        self.messages.clear();
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputRouterState {
    pub requested_interception: bool,
    pub effective_interception: bool,
    pub target_focused: bool,
    pub window_count: usize,
    pub topmost_window_id: Option<u32>,
    /// Compatibility alias for `topmost_window_id`.
    pub selected_window_id: Option<u32>,
    pub focused_window_id: Option<u32>,
    pub captured_window_id: Option<u32>,
    pub pointer_captured: bool,
}

/// Lock-free interception flags for render/filter callbacks. State mutations
/// still belong to `InputRouter`; these atomics are its read-only fast path.
#[derive(Debug, Default)]
pub struct AtomicInterceptionState {
    requested: AtomicBool,
    desired: AtomicBool,
    effective: AtomicBool,
}

impl AtomicInterceptionState {
    #[cfg(test)]
    pub fn requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }

    pub fn desired(&self) -> bool {
        self.desired.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub fn effective(&self) -> bool {
        self.effective.load(Ordering::Acquire)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ActiveCaptionDrag {
    window_id: u32,
    placement_epoch: u64,
    drag_session: u64,
    anchor: InputPoint,
    original_origin: InputPoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DragValidation {
    window_id: u32,
    placement_epoch: u64,
    drag_session: u64,
    latest_sequence: u64,
}

#[derive(Debug)]
pub struct InputRouter {
    requested_interception: bool,
    desired_interception: bool,
    effective_interception: bool,
    target_focused: bool,
    /// Ordered back-to-front. The final hit window is visually topmost.
    windows: Vec<InputWindow>,
    focused_window_id: Option<u32>,
    captured_window_id: Option<u32>,
    captured_buttons: u8,
    last_captured_point: Option<InputPoint>,
    pending_raise_window_id: Option<u32>,
    active_caption_drag: Option<ActiveCaptionDrag>,
    /// Buttons whose down transition was consumed by a caption gesture. This
    /// survives native/lifecycle cancellation until the matching physical up,
    /// preventing a page from observing an unmatched move or release.
    caption_owned_buttons: u8,
    drag_validation: Option<DragValidation>,
    pending_drag_move: Option<DragMoveIntent>,
    next_drag_session: u64,
    next_drag_sequence: u64,
    acknowledgement_pending: bool,
    atomic_interception: Arc<AtomicInterceptionState>,
}

impl Default for InputRouter {
    fn default() -> Self {
        Self {
            requested_interception: false,
            desired_interception: false,
            effective_interception: false,
            // Fail open until hudhook observes the target as the foreground
            // window (or receives an explicit focus/activation message).
            target_focused: false,
            windows: Vec::new(),
            focused_window_id: None,
            captured_window_id: None,
            captured_buttons: 0,
            last_captured_point: None,
            pending_raise_window_id: None,
            active_caption_drag: None,
            caption_owned_buttons: 0,
            drag_validation: None,
            pending_drag_move: None,
            next_drag_session: 0,
            next_drag_sequence: 0,
            acknowledgement_pending: false,
            atomic_interception: Arc::new(AtomicInterceptionState::default()),
        }
    }
}

impl InputRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> InputRouterState {
        let topmost_window_id = self.topmost_window_id();
        InputRouterState {
            requested_interception: self.requested_interception,
            effective_interception: self.effective_interception,
            target_focused: self.target_focused,
            window_count: self.window_count(),
            topmost_window_id,
            selected_window_id: topmost_window_id,
            focused_window_id: self.focused_window_id,
            captured_window_id: self.captured_window_id,
            pointer_captured: self.captured_buttons != 0,
        }
    }

    pub fn atomic_interception_state(&self) -> Arc<AtomicInterceptionState> {
        Arc::clone(&self.atomic_interception)
    }

    #[cfg(test)]
    pub fn requested_interception(&self) -> bool {
        self.requested_interception
    }

    #[cfg(test)]
    pub fn effective_interception(&self) -> bool {
        self.effective_interception
    }

    #[cfg(test)]
    pub fn windows(&self) -> &[InputWindow] {
        &self.windows
    }

    pub fn window_count(&self) -> usize {
        self.windows.len()
    }

    pub fn topmost_window(&self) -> Option<&InputWindow> {
        self.windows.last()
    }

    pub fn topmost_window_id(&self) -> Option<u32> {
        self.topmost_window().map(|window| window.window_id)
    }

    /// Returns the click-to-front request produced by the most recent pointer
    /// down. The bridge serializes this request with lifecycle traffic before
    /// applying it to both the input and render stacks.
    pub fn take_pending_raise(&mut self) -> Option<u32> {
        self.pending_raise_window_id.take()
    }

    /// Returns the latest compositor-local caption placement. Adjacent pointer
    /// samples overwrite this slot before the bridge thread observes them.
    pub fn take_pending_drag_move(&mut self) -> Option<DragMoveIntent> {
        self.pending_drag_move.take()
    }

    /// Applies a bridge-thread placement only if it is still the newest sample
    /// from the exact registration/external-bounds epoch that began the drag.
    pub fn apply_drag_move(&mut self, intent: DragMoveIntent) -> bool {
        let Some(validation) = self.drag_validation else {
            return false;
        };
        if validation.window_id != intent.window_id
            || validation.placement_epoch != intent.placement_epoch
            || validation.drag_session != intent.drag_session
            || validation.latest_sequence != intent.sequence
        {
            return false;
        }

        let Some(window) = self.windows.iter_mut().find(|window| {
            window.window_id == intent.window_id && window.placement_epoch == intent.placement_epoch
        }) else {
            return false;
        };
        window.rect.x = intent.x;
        window.rect.y = intent.y;
        if intent.terminal {
            self.drag_validation = None;
        }
        true
    }

    #[cfg(test)]
    pub fn selected_window(&self) -> Option<SelectedWindow> {
        self.topmost_window().cloned()
    }

    #[cfg(test)]
    pub fn focused_window_id(&self) -> Option<u32> {
        self.focused_window_id
    }

    #[cfg(test)]
    pub fn has_pointer_capture(&self) -> bool {
        self.captured_buttons != 0
    }

    /// Replaces the ordered window stack while preserving focus and capture
    /// for windows that remain live. Invalid windows are omitted, and the last
    /// occurrence of a duplicate id wins at its final stack position.
    pub fn replace_windows(&mut self, windows: Vec<InputWindow>) -> Vec<OutboundMessage> {
        let windows = normalize_windows(windows);
        let mut outbound = Vec::new();

        let drag_remains_live = self
            .active_caption_drag
            .map(|drag| (drag.window_id, drag.placement_epoch))
            .or_else(|| {
                self.drag_validation
                    .map(|drag| (drag.window_id, drag.placement_epoch))
            })
            .is_none_or(|(window_id, placement_epoch)| {
                contains_window_epoch(&windows, window_id, placement_epoch)
            });
        if !drag_remains_live {
            outbound.extend(self.cancel_pointer_capture());
        }

        if self
            .captured_window_id
            .is_some_and(|window_id| !contains_window(&windows, window_id))
        {
            outbound.extend(self.cancel_pointer_capture());
        }
        if self
            .focused_window_id
            .is_some_and(|window_id| !contains_window(&windows, window_id))
        {
            self.clear_electron_focus(&mut outbound);
        }
        if self
            .pending_raise_window_id
            .is_some_and(|window_id| !contains_window(&windows, window_id))
        {
            self.pending_raise_window_id = None;
        }

        self.windows = windows;
        self.recompute_desired_interception(false);
        outbound
    }

    /// Installs a fresh ordered stack at an initialization/reconnect boundary.
    /// Unlike [`Self::replace_windows`], reused native IDs do not retain focus,
    /// capture, or a pending click-to-front intent from the previous session.
    pub fn reset_windows(&mut self, windows: Vec<InputWindow>) -> Vec<OutboundMessage> {
        let mut outbound = self.cancel_pointer_capture();
        self.clear_electron_focus(&mut outbound);
        self.pending_raise_window_id = None;
        self.windows = normalize_windows(windows);
        self.recompute_desired_interception(false);
        outbound
    }

    /// Removes one window. Removing the capture owner synthesizes releases
    /// before clearing its focus; unrelated focus/capture state is preserved.
    pub fn remove_window(&mut self, window_id: u32) -> Vec<OutboundMessage> {
        if !self
            .windows
            .iter()
            .any(|window| window.window_id == window_id)
        {
            return Vec::new();
        }

        let mut outbound = Vec::new();
        let owns_drag = self
            .active_caption_drag
            .is_some_and(|drag| drag.window_id == window_id)
            || self
                .drag_validation
                .is_some_and(|drag| drag.window_id == window_id);
        if self.captured_window_id == Some(window_id) || owns_drag {
            outbound.extend(self.cancel_pointer_capture());
        }
        if self.focused_window_id == Some(window_id) {
            self.clear_electron_focus(&mut outbound);
        }
        if self.pending_raise_window_id == Some(window_id) {
            self.pending_raise_window_id = None;
        }
        self.windows.retain(|window| window.window_id != window_id);
        self.recompute_desired_interception(false);
        outbound
    }

    /// Updates one live window's bounds without changing its stack position.
    /// A non-positive rectangle removes that window.
    #[cfg(test)]
    pub fn update_window_rect(&mut self, window_id: u32, rect: InputRect) -> Vec<OutboundMessage> {
        if !rect.is_valid() {
            return self.remove_window(window_id);
        }
        let owns_drag = self
            .active_caption_drag
            .is_some_and(|drag| drag.window_id == window_id)
            || self
                .drag_validation
                .is_some_and(|drag| drag.window_id == window_id);
        let outbound = if owns_drag {
            self.cancel_pointer_capture()
        } else {
            Vec::new()
        };
        let Some(window) = self
            .windows
            .iter_mut()
            .find(|window| window.window_id == window_id)
        else {
            return outbound;
        };
        window.rect = rect;
        outbound
    }

    /// Updates alpha-aware hit-test pixels without changing lifecycle or stack.
    pub fn update_window_alpha_frame(
        &mut self,
        window_id: u32,
        width: u32,
        height: u32,
        rgba: Arc<[u8]>,
    ) -> Vec<OutboundMessage> {
        let Some(window) = self
            .windows
            .iter_mut()
            .find(|window| window.window_id == window_id)
        else {
            return Vec::new();
        };
        window.set_alpha_frame(width, height, rgba);
        Vec::new()
    }

    pub fn clear_window_alpha_frame(&mut self, window_id: u32) -> Vec<OutboundMessage> {
        let Some(window) = self
            .windows
            .iter_mut()
            .find(|window| window.window_id == window_id)
        else {
            return Vec::new();
        };
        window.clear_alpha_frame();
        Vec::new()
    }

    /// Moves one live window to the top without disturbing focus or capture.
    pub fn raise_window(&mut self, window_id: u32) -> Vec<OutboundMessage> {
        let Some(index) = self
            .windows
            .iter()
            .position(|window| window.window_id == window_id)
        else {
            return Vec::new();
        };
        if index + 1 != self.windows.len() {
            let window = self.windows.remove(index);
            self.windows.push(window);
        }
        Vec::new()
    }

    /// Compatibility one-window lifecycle boundary. Unlike `replace_windows`,
    /// re-publication deliberately clears the prior focus and capture.
    #[cfg(test)]
    pub fn publish_selection(&mut self, selected: Option<SelectedWindow>) -> Vec<OutboundMessage> {
        self.reset_windows(selected.into_iter().collect())
    }

    /// Updates bounds for the current registration without disturbing focus or
    /// pointer capture. A non-positive rectangle removes the selection and
    /// restores fail-open input. A stale window id is ignored.
    #[cfg(test)]
    pub fn update_selection_rect(
        &mut self,
        window_id: u32,
        rect: InputRect,
    ) -> Vec<OutboundMessage> {
        self.update_window_rect(window_id, rect)
    }

    /// Applies `command.input.intercept` and always emits an acknowledgement
    /// containing the resulting effective state.
    pub fn request_interception(&mut self, requested: bool) -> Vec<OutboundMessage> {
        let mut outbound = Vec::new();
        self.requested_interception = requested;
        self.atomic_interception
            .requested
            .store(requested, Ordering::Release);

        if !requested {
            self.pending_raise_window_id = None;
            outbound.extend(self.cancel_pointer_capture());
            self.clear_electron_focus(&mut outbound);
        }

        self.recompute_desired_interception(true);
        outbound
    }

    /// Tracks focus of the injected game's target window. Requested
    /// interception is retained across focus loss, but effective interception,
    /// Electron focus, and capture are cleared until the target regains focus.
    pub fn set_target_focused(&mut self, focused: bool) -> Vec<OutboundMessage> {
        if self.target_focused == focused {
            return Vec::new();
        }

        let mut outbound = Vec::new();
        self.target_focused = focused;
        if !focused {
            self.pending_raise_window_id = None;
            outbound.extend(self.cancel_pointer_capture());
            self.clear_electron_focus(&mut outbound);
        }
        self.recompute_desired_interception(false);
        outbound
    }

    /// Commits the routing state for the filter phase hudhook has just applied.
    /// Arming and disarming keep routing off for complete filtered queue drains;
    /// only matching Enabled/Disabled terminal phases may acknowledge. This
    /// prevents activation and release-boundary messages from reaching both
    /// destinations even when WndProc and Present run on different threads.
    pub fn apply_input_filter(
        &mut self,
        routing_enabled: bool,
        acknowledge: bool,
    ) -> Vec<OutboundMessage> {
        // Keep the sampled phase's routing state stable through before_render;
        // a concurrent request must not acknowledge a filter value hudhook has
        // not published yet.
        let effective = routing_enabled;
        let changed = effective != self.effective_interception;
        let mut outbound = Vec::new();

        if self.effective_interception && !effective {
            self.pending_raise_window_id = None;
            outbound.extend(self.cancel_pointer_capture());
            self.clear_electron_focus(&mut outbound);
        }

        self.effective_interception = effective;
        self.atomic_interception
            .effective
            .store(effective, Ordering::Release);

        if acknowledge
            && effective == self.desired_interception
            && (changed || self.acknowledgement_pending)
        {
            self.acknowledgement_pending = false;
            outbound.push(OutboundMessage::InputIntercept {
                intercepting: effective,
            });
        }
        outbound
    }

    /// Returns whether a native input message should be withheld from the game.
    /// The current hudhook integration uses its blanket `InputAll` filter while
    /// this state is true; this per-message form is also useful to test raw-input
    /// and outside-overlay fail-open behavior.
    #[cfg(test)]
    pub fn should_intercept_message(&self, msg: u32) -> bool {
        self.effective_interception && is_hudhook_input_message(msg)
    }

    /// Routes a Win32 message. `screen_to_client` is invoked only for
    /// `WM_MOUSEWHEEL`, whose lParam point is in screen coordinates. Returning
    /// `None` from it safely drops that outbound wheel packet.
    pub fn route_win32_message<F>(
        &mut self,
        msg: u32,
        wparam: u32,
        lparam: u32,
        screen_to_client: F,
    ) -> Vec<OutboundMessage>
    where
        F: FnOnce(InputPoint) -> Option<InputPoint>,
    {
        if matches!(msg, WM_CANCELMODE | WM_CAPTURECHANGED) {
            return self.cancel_pointer_capture();
        }

        match msg {
            WM_SETFOCUS => return self.set_target_focused(true),
            WM_KILLFOCUS => return self.set_target_focused(false),
            WM_ACTIVATEAPP => return self.set_target_focused(wparam != 0),
            _ => {}
        }

        let message_kind = classify_message(msg);
        let routing_enabled =
            self.effective_interception && self.requested_interception && self.target_focused;
        if self.drain_cancelled_caption_pointer(message_kind, routing_enabled) {
            return Vec::new();
        }

        if !routing_enabled {
            return Vec::new();
        }

        match message_kind {
            MessageKind::MouseMove => {
                self.route_pointer(msg, wparam, decode_signed_lparam_point(lparam), None)
            }
            MessageKind::MouseDown(button) => self.route_pointer(
                msg,
                wparam,
                decode_signed_lparam_point(lparam),
                Some(PointerTransition::Down(button)),
            ),
            MessageKind::MouseUp(button) => self.route_pointer(
                msg,
                wparam,
                decode_signed_lparam_point(lparam),
                Some(PointerTransition::Up(button)),
            ),
            MessageKind::Wheel => {
                let Some(client_point) = screen_to_client(decode_signed_lparam_point(lparam))
                else {
                    return Vec::new();
                };
                self.route_pointer(msg, wparam, client_point, None)
            }
            MessageKind::Keyboard => self.route_keyboard(msg, wparam, lparam),
            MessageKind::Other => Vec::new(),
        }
    }

    fn route_pointer(
        &mut self,
        msg: u32,
        wparam: u32,
        client_point: InputPoint,
        transition: Option<PointerTransition>,
    ) -> Vec<OutboundMessage> {
        if self.active_caption_drag.is_some() {
            return self.route_caption_drag(msg, client_point, transition);
        }

        let captured_before = self.captured_buttons != 0;
        let target = if captured_before {
            self.captured_window_id.and_then(|window_id| {
                self.windows
                    .iter()
                    .find(|window| window.window_id == window_id)
                    .cloned()
            })
        } else {
            self.windows
                .iter()
                .rev()
                .find(|window| window.hit_test(client_point))
                .cloned()
        };
        let Some(target) = target else {
            return Vec::new();
        };

        let mut outbound = Vec::with_capacity(2);
        if matches!(transition, Some(PointerTransition::Down(_)))
            && self.focused_window_id != Some(target.window_id)
        {
            self.focused_window_id = Some(target.window_id);
            outbound.push(OutboundMessage::WindowFocused {
                focus_window_id: target.window_id,
            });
        }

        if let Some(PointerTransition::Down(button)) = transition {
            if !captured_before {
                self.captured_window_id = Some(target.window_id);
                // Every pointer down that begins capture publishes a stack
                // intent, including a click on the current top window. The
                // bridge uses it to cancel any older asynchronously queued
                // click-to-front request. Additional buttons stay with the
                // existing capture owner and do not start another raise.
                self.pending_raise_window_id = Some(target.window_id);
            }
            self.captured_buttons |= button;

            if !captured_before && button == LEFT_BUTTON && target.caption_hit_test(client_point) {
                self.begin_caption_drag(&target, client_point);
                self.last_captured_point = Some(client_point);
                // Caption input belongs to the compositor. The page must not
                // receive an unmatched down or a synthetic up on cancellation.
                return outbound;
            }
        }
        if self.captured_buttons != 0 {
            self.last_captured_point = Some(client_point);
        }

        let local_point = target.rect.to_local(client_point);
        outbound.push(OutboundMessage::input_for(
            &target,
            msg,
            wparam,
            encode_signed_lparam_point(local_point),
        ));

        // Release capture after queuing the matching mouse-up packet, so that
        // an out-of-bounds release is delivered before capture ends.
        if let Some(PointerTransition::Up(button)) = transition {
            self.captured_buttons &= !button;
            if self.captured_buttons == 0 {
                self.captured_window_id = None;
                self.last_captured_point = None;
            }
        }

        outbound
    }

    fn begin_caption_drag(&mut self, target: &InputWindow, anchor: InputPoint) {
        self.next_drag_session = self.next_drag_session.wrapping_add(1).max(1);
        let drag_session = self.next_drag_session;
        self.active_caption_drag = Some(ActiveCaptionDrag {
            window_id: target.window_id,
            placement_epoch: target.placement_epoch,
            drag_session,
            anchor,
            original_origin: InputPoint::new(target.rect.x, target.rect.y),
        });
        self.drag_validation = Some(DragValidation {
            window_id: target.window_id,
            placement_epoch: target.placement_epoch,
            drag_session,
            latest_sequence: 0,
        });
        self.caption_owned_buttons |= LEFT_BUTTON;
        self.pending_drag_move = None;
    }

    fn route_caption_drag(
        &mut self,
        msg: u32,
        client_point: InputPoint,
        transition: Option<PointerTransition>,
    ) -> Vec<OutboundMessage> {
        self.last_captured_point = Some(client_point);
        let terminal = matches!(transition, Some(PointerTransition::Up(LEFT_BUTTON)));
        match transition {
            Some(PointerTransition::Down(button)) => self.caption_owned_buttons |= button,
            Some(PointerTransition::Up(button)) => self.caption_owned_buttons &= !button,
            None => {}
        }
        if msg == WM_MOUSEMOVE || terminal {
            self.queue_caption_drag_move(client_point, terminal);
        }

        if terminal {
            self.captured_buttons &= !LEFT_BUTTON;
            self.captured_window_id = None;
            self.last_captured_point = None;
            self.active_caption_drag = None;
        }

        Vec::new()
    }

    /// Drains pointer transitions already owned by a caption after the active
    /// drag has ended or been cancelled. All pointer traffic remains
    /// compositor-owned while any swallowed button is physically outstanding.
    /// A repeated down for an owned button proves its old release was missed;
    /// when routing is live, that bit is retired and the new down starts a
    /// normal gesture instead of leaving the drain stuck indefinitely.
    fn drain_cancelled_caption_pointer(
        &mut self,
        message_kind: MessageKind,
        routing_enabled: bool,
    ) -> bool {
        if self.active_caption_drag.is_some() || self.caption_owned_buttons == 0 {
            return false;
        }

        match message_kind {
            MessageKind::MouseDown(button) if self.caption_owned_buttons & button != 0 => {
                if routing_enabled {
                    self.caption_owned_buttons &= !button;
                    false
                } else {
                    true
                }
            }
            MessageKind::MouseDown(button) => {
                // Conservatively claim secondary buttons pressed while the
                // cancelled caption chord is still physically outstanding.
                self.caption_owned_buttons |= button;
                true
            }
            MessageKind::MouseUp(button) if self.caption_owned_buttons & button != 0 => {
                self.caption_owned_buttons &= !button;
                true
            }
            MessageKind::MouseUp(button) => {
                // A fresh normal down may coexist with a different stale
                // caption-owned button. Only its captured matching up may pass.
                self.captured_buttons & button == 0
            }
            MessageKind::MouseMove | MessageKind::Wheel => true,
            MessageKind::Keyboard | MessageKind::Other => false,
        }
    }

    fn queue_caption_drag_move(&mut self, client_point: InputPoint, terminal: bool) {
        let Some(drag) = self.active_caption_drag else {
            return;
        };
        self.next_drag_sequence = self.next_drag_sequence.wrapping_add(1).max(1);
        let sequence = self.next_drag_sequence;
        let x = saturating_i64_to_i32(
            i64::from(drag.original_origin.x) + i64::from(client_point.x)
                - i64::from(drag.anchor.x),
        );
        let y = saturating_i64_to_i32(
            i64::from(drag.original_origin.y) + i64::from(client_point.y)
                - i64::from(drag.anchor.y),
        );
        let intent = DragMoveIntent {
            window_id: drag.window_id,
            placement_epoch: drag.placement_epoch,
            drag_session: drag.drag_session,
            sequence,
            x,
            y,
            terminal,
        };
        self.drag_validation = Some(DragValidation {
            window_id: drag.window_id,
            placement_epoch: drag.placement_epoch,
            drag_session: drag.drag_session,
            latest_sequence: sequence,
        });
        self.pending_drag_move = Some(intent);
    }

    fn cancel_pointer_capture(&mut self) -> Vec<OutboundMessage> {
        let caption_drag_active = self.active_caption_drag.take().is_some();
        self.drag_validation = None;
        self.pending_drag_move = None;
        let captured_buttons = self.captured_buttons;
        self.captured_buttons = 0;
        let captured_window_id = self.captured_window_id.take();

        if caption_drag_active {
            self.last_captured_point = None;
            return Vec::new();
        }

        let Some(window_id) = captured_window_id else {
            self.last_captured_point = None;
            return Vec::new();
        };
        let Some(window) = self
            .windows
            .iter()
            .find(|window| window.window_id == window_id)
        else {
            self.last_captured_point = None;
            return Vec::new();
        };
        let Some(client_point) = self.last_captured_point.take() else {
            return Vec::new();
        };

        let lparam = encode_signed_lparam_point(window.rect.to_local(client_point));
        let mut remaining_buttons = captured_buttons;
        let mut outbound = Vec::new();
        for button in [LEFT_BUTTON, RIGHT_BUTTON, MIDDLE_BUTTON] {
            if captured_buttons & button == 0 {
                continue;
            }

            remaining_buttons &= !button;
            let msg = pointer_release_message(button);
            outbound.push(OutboundMessage::input_for(
                window,
                msg,
                encode_button_state_wparam(remaining_buttons),
                lparam,
            ));
        }
        outbound
    }

    fn route_keyboard(&self, msg: u32, wparam: u32, lparam: u32) -> Vec<OutboundMessage> {
        let Some(window_id) = self.focused_window_id else {
            return Vec::new();
        };
        let Some(window) = self
            .windows
            .iter()
            .find(|window| window.window_id == window_id)
        else {
            return Vec::new();
        };

        vec![OutboundMessage::input_for(window, msg, wparam, lparam)]
    }

    fn clear_electron_focus(&mut self, outbound: &mut Vec<OutboundMessage>) {
        if self.focused_window_id.take().is_some() {
            outbound.push(OutboundMessage::WindowFocused { focus_window_id: 0 });
        }
    }

    fn recompute_desired_interception(&mut self, force_acknowledgement: bool) {
        let desired =
            self.requested_interception && self.target_focused && !self.windows.is_empty();
        let changed = desired != self.desired_interception;
        self.desired_interception = desired;
        self.atomic_interception
            .desired
            .store(desired, Ordering::Release);
        self.acknowledgement_pending |= changed || force_acknowledgement;
    }
}

fn contains_window(windows: &[InputWindow], window_id: u32) -> bool {
    windows.iter().any(|window| window.window_id == window_id)
}

fn contains_window_epoch(windows: &[InputWindow], window_id: u32, placement_epoch: u64) -> bool {
    windows
        .iter()
        .any(|window| window.window_id == window_id && window.placement_epoch == placement_epoch)
}

fn normalize_windows(windows: Vec<InputWindow>) -> Vec<InputWindow> {
    let mut normalized = Vec::with_capacity(windows.len());
    for window in windows {
        if !window.rect.is_valid() {
            continue;
        }
        if let Some(existing) = normalized
            .iter()
            .position(|existing: &InputWindow| existing.window_id == window.window_id)
        {
            normalized.remove(existing);
        }
        normalized.push(window);
    }
    normalized
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PointerTransition {
    Down(u8),
    Up(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MessageKind {
    MouseMove,
    MouseDown(u8),
    MouseUp(u8),
    Wheel,
    Keyboard,
    Other,
}

fn classify_message(msg: u32) -> MessageKind {
    match msg {
        WM_MOUSEMOVE => MessageKind::MouseMove,
        WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => MessageKind::MouseDown(LEFT_BUTTON),
        WM_LBUTTONUP => MessageKind::MouseUp(LEFT_BUTTON),
        WM_RBUTTONDOWN | WM_RBUTTONDBLCLK => MessageKind::MouseDown(RIGHT_BUTTON),
        WM_RBUTTONUP => MessageKind::MouseUp(RIGHT_BUTTON),
        WM_MBUTTONDOWN | WM_MBUTTONDBLCLK => MessageKind::MouseDown(MIDDLE_BUTTON),
        WM_MBUTTONUP => MessageKind::MouseUp(MIDDLE_BUTTON),
        // WM_XBUTTON* remains intentionally unsupported. Electron 16's public
        // sendInputEvent API cannot represent X1/X2 and otherwise defaults a
        // missing button to left, so forwarding would create a false click.
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => MessageKind::Wheel,
        WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP | WM_CHAR | WM_SYSCHAR | WM_UNICHAR => {
            MessageKind::Keyboard
        }
        _ => MessageKind::Other,
    }
}

#[cfg(test)]
pub fn is_hudhook_input_message(msg: u32) -> bool {
    msg == WM_INPUT
        || (WM_KEYDOWN..=0x0109).contains(&msg)
        || (WM_MOUSEMOVE..=WM_MOUSEHWHEEL).contains(&msg)
}

fn pointer_release_message(button: u8) -> u32 {
    match button {
        LEFT_BUTTON => WM_LBUTTONUP,
        RIGHT_BUTTON => WM_RBUTTONUP,
        MIDDLE_BUTTON => WM_MBUTTONUP,
        _ => unreachable!("unknown captured mouse button"),
    }
}

fn encode_button_state_wparam(buttons: u8) -> u32 {
    let mut wparam = 0;
    if buttons & LEFT_BUTTON != 0 {
        wparam |= MK_LBUTTON;
    }
    if buttons & RIGHT_BUTTON != 0 {
        wparam |= MK_RBUTTON;
    }
    if buttons & MIDDLE_BUTTON != 0 {
        wparam |= MK_MBUTTON;
    }
    wparam
}

pub fn decode_signed_lparam_point(lparam: u32) -> InputPoint {
    InputPoint {
        x: i32::from((lparam as u16) as i16),
        y: i32::from(((lparam >> 16) as u16) as i16),
    }
}

pub fn encode_signed_lparam_point(point: InputPoint) -> u32 {
    let x = point.x.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
    let y = point.y.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
    u32::from(x as u16) | (u32::from(y as u16) << 16)
}

fn saturating_i64_to_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    const WINDOW_ID: u32 = 17;
    const RECT: InputRect = InputRect::new(-20, 30, 100, 50);

    fn selection() -> SelectedWindow {
        SelectedWindow::new(WINDOW_ID, RECT)
    }

    fn router_with_interception() -> InputRouter {
        let mut router = InputRouter::new();
        assert!(router.set_target_focused(true).is_empty());
        assert!(router.publish_selection(Some(selection())).is_empty());
        assert!(router.request_interception(true).is_empty());
        assert!(router.apply_input_filter(false, false).is_empty());
        assert_eq!(
            router.apply_input_filter(true, true),
            vec![OutboundMessage::InputIntercept { intercepting: true }]
        );
        router
    }

    fn router_with_windows(windows: Vec<InputWindow>) -> InputRouter {
        let mut router = InputRouter::new();
        assert!(router.set_target_focused(true).is_empty());
        assert!(router.replace_windows(windows).is_empty());
        assert!(router.request_interception(true).is_empty());
        assert!(router.apply_input_filter(false, false).is_empty());
        assert_eq!(
            router.apply_input_filter(true, true),
            vec![OutboundMessage::InputIntercept { intercepting: true }]
        );
        router
    }

    fn route(router: &mut InputRouter, msg: u32, point: InputPoint) -> Vec<OutboundMessage> {
        router.route_win32_message(msg, 0, encode_signed_lparam_point(point), |_| {
            unreachable!("only wheel routing converts screen coordinates")
        })
    }

    fn draggable_window(window_id: u32, rect: InputRect, placement_epoch: u64) -> InputWindow {
        InputWindow::new(window_id, rect)
            .with_caption(Some(InputCaption {
                left: 5,
                right: 5,
                top: 0,
                height: 15,
            }))
            .with_placement_epoch(placement_epoch)
    }

    #[test]
    fn routed_pointer_and_keyboard_input_carry_the_window_scale_tag() {
        let tagged = InputWindow::new(WINDOW_ID, RECT).with_scale_factor_micros(Some(1_250_000));
        let mut router = router_with_windows(vec![tagged]);
        let point = InputPoint::new(-10, 35);

        assert_eq!(
            route(&mut router, WM_MOUSEMOVE, point),
            vec![OutboundMessage::TaggedInput {
                window_id: WINDOW_ID,
                msg: WM_MOUSEMOVE,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(10, 5)),
                scale_factor_micros: 1_250_000,
            }]
        );
        assert_eq!(
            route(&mut router, WM_LBUTTONDOWN, point),
            vec![
                OutboundMessage::WindowFocused {
                    focus_window_id: WINDOW_ID,
                },
                OutboundMessage::TaggedInput {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONDOWN,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 5)),
                    scale_factor_micros: 1_250_000,
                },
            ]
        );
        assert_eq!(
            router.route_win32_message(WM_KEYDOWN, u32::from(b'A'), 0, |_| {
                unreachable!("keyboard routing does not convert screen coordinates")
            }),
            vec![OutboundMessage::TaggedInput {
                window_id: WINDOW_ID,
                msg: WM_KEYDOWN,
                wparam: u32::from(b'A'),
                lparam: 0,
                scale_factor_micros: 1_250_000,
            }]
        );
    }

    #[test]
    fn caption_down_focuses_captures_and_raises_without_reaching_dom() {
        let mut router = router_with_windows(vec![draggable_window(WINDOW_ID, RECT, 7)]);
        let anchor = InputPoint::new(-10, 35);

        assert_eq!(
            route(&mut router, WM_LBUTTONDOWN, anchor),
            vec![OutboundMessage::WindowFocused {
                focus_window_id: WINDOW_ID,
            }]
        );
        assert!(router.has_pointer_capture());
        assert_eq!(router.focused_window_id(), Some(WINDOW_ID));
        assert_eq!(router.take_pending_raise(), Some(WINDOW_ID));
        assert_eq!(router.take_pending_drag_move(), None);
    }

    #[test]
    fn caption_drag_uses_original_anchor_coalesces_and_consumes_terminal_up() {
        let mut router = router_with_windows(vec![draggable_window(WINDOW_ID, RECT, 7)]);
        let anchor = InputPoint::new(-10, 35);
        assert_eq!(
            route(&mut router, WM_LBUTTONDOWN, anchor),
            vec![OutboundMessage::WindowFocused {
                focus_window_id: WINDOW_ID,
            }]
        );

        assert!(route(&mut router, WM_MOUSEMOVE, InputPoint::new(20, 55)).is_empty());
        let first = router.take_pending_drag_move().unwrap();
        assert_eq!((first.x, first.y, first.terminal), (10, 50, false));
        assert!(router.apply_drag_move(first));

        // Applying the first placement changes the live rect, but the next
        // result remains relative to the immutable down anchor/original origin.
        assert!(route(&mut router, WM_MOUSEMOVE, InputPoint::new(30, 65)).is_empty());
        let superseded = router.take_pending_drag_move().unwrap();
        assert_eq!((superseded.x, superseded.y), (20, 60));
        assert!(route(&mut router, WM_LBUTTONUP, InputPoint::new(40, 75)).is_empty());
        let terminal = router.take_pending_drag_move().unwrap();
        assert_eq!((terminal.x, terminal.y, terminal.terminal), (30, 70, true));
        assert!(!router.has_pointer_capture());
        assert!(!router.apply_drag_move(superseded));
        assert!(router.apply_drag_move(terminal));
        assert!(!router.apply_drag_move(terminal));
        assert_eq!(router.windows()[0].rect, InputRect::new(30, 70, 100, 50));
    }

    #[test]
    fn caption_drag_cancel_and_same_id_new_epoch_emit_no_unmatched_dom_release() {
        let mut router = router_with_windows(vec![draggable_window(WINDOW_ID, RECT, 7)]);
        let anchor = InputPoint::new(-10, 35);
        route(&mut router, WM_LBUTTONDOWN, anchor);
        route(&mut router, WM_MOUSEMOVE, InputPoint::new(0, 45));
        let stale = router.take_pending_drag_move().unwrap();

        // Re-registration/external bounds can reuse the native ID, so the
        // placement epoch—not the ID alone—must invalidate delayed work.
        assert!(router
            .replace_windows(vec![draggable_window(WINDOW_ID, RECT, 8)])
            .is_empty());
        assert!(!router.has_pointer_capture());
        assert!(!router.apply_drag_move(stale));

        route(&mut router, WM_LBUTTONDOWN, anchor);
        let cancelled = router.request_interception(false);
        assert_eq!(
            cancelled,
            vec![OutboundMessage::WindowFocused { focus_window_id: 0 }]
        );
        assert!(!cancelled
            .iter()
            .any(|message| matches!(message, OutboundMessage::Input { .. })));
    }

    #[test]
    fn cancelled_caption_drag_drains_moves_and_every_owned_button_release() {
        let mut router = router_with_windows(vec![draggable_window(WINDOW_ID, RECT, 7)]);
        let anchor = InputPoint::new(-10, 35);
        route(&mut router, WM_LBUTTONDOWN, anchor);

        // Secondary buttons pressed during a caption gesture are compositor
        // owned too; Electron never received either down transition.
        assert!(route(&mut router, WM_RBUTTONDOWN, anchor).is_empty());
        assert!(route(&mut router, WM_MOUSEMOVE, InputPoint::new(0, 45)).is_empty());
        assert!(router.take_pending_drag_move().is_some());

        assert!(router
            .route_win32_message(WM_CAPTURECHANGED, 0, 0, |_| unreachable!())
            .is_empty());
        assert!(!router.has_pointer_capture());
        assert_eq!(router.take_pending_drag_move(), None);

        // Cancellation must not turn the held chord into unmatched DOM input.
        assert!(route(&mut router, WM_MOUSEMOVE, anchor).is_empty());
        assert!(route(&mut router, WM_RBUTTONUP, anchor).is_empty());
        assert!(route(&mut router, WM_MOUSEMOVE, anchor).is_empty());
        assert!(route(&mut router, WM_LBUTTONUP, anchor).is_empty());

        // Once every owned release arrives, ordinary hover routing resumes.
        assert_eq!(
            route(&mut router, WM_MOUSEMOVE, anchor),
            vec![OutboundMessage::Input {
                window_id: WINDOW_ID,
                msg: WM_MOUSEMOVE,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(10, 5)),
            }]
        );
    }

    #[test]
    fn caption_terminal_keeps_secondary_release_out_of_the_dom() {
        let mut router = router_with_windows(vec![draggable_window(WINDOW_ID, RECT, 7)]);
        let anchor = InputPoint::new(-10, 35);
        route(&mut router, WM_LBUTTONDOWN, anchor);
        assert!(route(&mut router, WM_RBUTTONDOWN, anchor).is_empty());
        assert!(route(&mut router, WM_LBUTTONUP, anchor).is_empty());
        assert!(!router.has_pointer_capture());
        assert!(router.take_pending_drag_move().unwrap().terminal);

        assert!(route(&mut router, WM_RBUTTONUP, anchor).is_empty());
        assert_eq!(
            route(&mut router, WM_RBUTTONDOWN, anchor),
            vec![OutboundMessage::Input {
                window_id: WINDOW_ID,
                msg: WM_RBUTTONDOWN,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(10, 5)),
            }]
        );
    }

    #[test]
    fn fresh_matching_down_retires_a_stale_caption_drain_and_starts_again() {
        let mut router = router_with_windows(vec![draggable_window(WINDOW_ID, RECT, 7)]);
        let anchor = InputPoint::new(-10, 35);
        route(&mut router, WM_LBUTTONDOWN, anchor);
        assert!(router
            .route_win32_message(WM_CANCELMODE, 0, 0, |_| unreachable!())
            .is_empty());
        assert!(!router.has_pointer_capture());

        // If focus loss hid the old release, a physically fresh matching down
        // proves that stale ownership can be retired instead of sticking.
        assert!(route(&mut router, WM_LBUTTONDOWN, anchor).is_empty());
        assert!(router.has_pointer_capture());
        assert!(route(&mut router, WM_LBUTTONUP, anchor).is_empty());
        assert!(!router.has_pointer_capture());
        assert!(router.take_pending_drag_move().unwrap().terminal);
    }

    #[test]
    fn invalid_caption_falls_back_to_normal_dom_pointer_routing() {
        let invalid = InputWindow::new(WINDOW_ID, RECT)
            .with_caption(Some(InputCaption {
                left: -1,
                right: 0,
                top: 0,
                height: 15,
            }))
            .with_placement_epoch(7);
        let mut router = router_with_windows(vec![invalid]);

        assert_eq!(
            route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 35)),
            vec![
                OutboundMessage::WindowFocused {
                    focus_window_id: WINDOW_ID,
                },
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONDOWN,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 5)),
                },
            ]
        );
        assert_eq!(router.take_pending_drag_move(), None);
    }

    #[test]
    fn transparent_top_pixel_falls_through_before_caption_drag_classification() {
        let back = draggable_window(1, InputRect::new(0, 0, 100, 50), 11);
        let front = draggable_window(2, InputRect::new(0, 0, 100, 50), 12).with_alpha_frame(
            1,
            1,
            vec![0, 0, 0, 0].into(),
        );
        let mut router = router_with_windows(vec![back, front]);

        assert_eq!(
            route(&mut router, WM_LBUTTONDOWN, InputPoint::new(10, 5)),
            vec![OutboundMessage::WindowFocused { focus_window_id: 1 }]
        );
        assert_eq!(router.take_pending_raise(), Some(1));
    }

    #[test]
    fn hit_test_uses_inclusive_top_left_and_exclusive_bottom_right_edges() {
        assert!(RECT.contains(InputPoint::new(-20, 30)));
        assert!(RECT.contains(InputPoint::new(79, 79)));
        assert!(!RECT.contains(InputPoint::new(-21, 30)));
        assert!(!RECT.contains(InputPoint::new(-20, 29)));
        assert!(!RECT.contains(InputPoint::new(80, 30)));
        assert!(!RECT.contains(InputPoint::new(-20, 80)));
        assert!(!InputRect::new(0, 0, 0, 10).contains(InputPoint::new(0, 0)));
        assert!(!InputRect::new(0, 0, 10, -1).contains(InputPoint::new(0, 0)));
    }

    #[test]
    fn client_coordinates_map_to_signed_overlay_local_coordinates() {
        assert_eq!(
            RECT.to_local(InputPoint::new(-15, 35)),
            InputPoint::new(5, 5)
        );
        assert_eq!(
            RECT.to_local(InputPoint::new(-25, 20)),
            InputPoint::new(-5, -10)
        );

        let point = InputPoint::new(-123, 456);
        assert_eq!(
            decode_signed_lparam_point(encode_signed_lparam_point(point)),
            point
        );
        assert_eq!(
            decode_signed_lparam_point(encode_signed_lparam_point(InputPoint::new(
                i32::MIN,
                i32::MAX,
            ))),
            InputPoint::new(i32::from(i16::MIN), i32::from(i16::MAX))
        );
    }

    #[test]
    fn overlapping_windows_hit_test_topmost_and_publish_serialized_raise_request() {
        let back = InputWindow::new(1, InputRect::new(0, 0, 100, 100));
        let front = InputWindow::new(2, InputRect::new(50, 0, 100, 100));
        let mut router = router_with_windows(vec![back, front]);

        assert_eq!(router.window_count(), 2);
        assert_eq!(router.topmost_window_id(), Some(2));
        assert_eq!(
            route(&mut router, WM_LBUTTONDOWN, InputPoint::new(10, 20)),
            vec![
                OutboundMessage::WindowFocused { focus_window_id: 1 },
                OutboundMessage::Input {
                    window_id: 1,
                    msg: WM_LBUTTONDOWN,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 20)),
                },
            ]
        );
        assert_eq!(router.topmost_window_id(), Some(2));
        assert_eq!(router.take_pending_raise(), Some(1));
        assert!(router.raise_window(1).is_empty());
        assert_eq!(router.topmost_window_id(), Some(1));
        assert_eq!(
            route(&mut router, WM_LBUTTONUP, InputPoint::new(10, 20)),
            vec![OutboundMessage::Input {
                window_id: 1,
                msg: WM_LBUTTONUP,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(10, 20)),
            }]
        );

        // The raised back window now wins the overlap at x=60.
        assert_eq!(
            route(&mut router, WM_MOUSEMOVE, InputPoint::new(60, 20)),
            vec![OutboundMessage::Input {
                window_id: 1,
                msg: WM_MOUSEMOVE,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(60, 20)),
            }]
        );

        // A click on the already-top window still emits an intent so the
        // bridge can invalidate any older queued click-to-front request.
        assert!(matches!(
            route(&mut router, WM_LBUTTONDOWN, InputPoint::new(60, 20)).as_slice(),
            [OutboundMessage::Input {
                window_id: 1,
                msg: WM_LBUTTONDOWN,
                ..
            }]
        ));
        assert_eq!(router.take_pending_raise(), Some(1));
    }

    #[test]
    fn capture_owner_survives_bounds_and_stack_changes_and_keyboard_keeps_focus() {
        let back = InputWindow::new(1, InputRect::new(0, 0, 100, 100));
        let front = InputWindow::new(2, InputRect::new(25, 0, 100, 100));
        let mut router = router_with_windows(vec![back, front]);

        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(50, 20));
        assert_eq!(router.state().captured_window_id, Some(2));
        assert!(router.raise_window(1).is_empty());
        assert!(router
            .update_window_rect(2, InputRect::new(100, 100, 80, 80))
            .is_empty());

        assert_eq!(
            route(&mut router, WM_MOUSEMOVE, InputPoint::new(-20, -30)),
            vec![OutboundMessage::Input {
                window_id: 2,
                msg: WM_MOUSEMOVE,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(-120, -130)),
            }]
        );
        assert_eq!(
            router.route_win32_message(WM_KEYDOWN, 0x41, 0x001e0001, |_| None),
            vec![OutboundMessage::Input {
                window_id: 2,
                msg: WM_KEYDOWN,
                wparam: 0x41,
                lparam: 0x001e0001,
            }]
        );
        assert_eq!(
            route(&mut router, WM_LBUTTONUP, InputPoint::new(-20, -30)),
            vec![OutboundMessage::Input {
                window_id: 2,
                msg: WM_LBUTTONUP,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(-120, -130)),
            }]
        );
        assert_eq!(router.state().captured_window_id, None);
    }

    #[test]
    fn removing_unrelated_window_preserves_focus_and_capture() {
        let mut router = router_with_windows(vec![
            InputWindow::new(1, InputRect::new(0, 0, 100, 100)),
            InputWindow::new(2, InputRect::new(20, 0, 100, 100)),
        ]);
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(30, 10));

        assert!(router.remove_window(1).is_empty());
        let state = router.state();
        assert_eq!(state.window_count, 1);
        assert_eq!(state.focused_window_id, Some(2));
        assert_eq!(state.captured_window_id, Some(2));
        assert_eq!(
            route(&mut router, WM_MOUSEMOVE, InputPoint::new(500, 500)),
            vec![OutboundMessage::Input {
                window_id: 2,
                msg: WM_MOUSEMOVE,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(480, 500)),
            }]
        );
    }

    #[test]
    fn removing_capture_owner_releases_buttons_then_blurs_but_keeps_interception_desired() {
        let mut router = router_with_windows(vec![
            InputWindow::new(1, InputRect::new(0, 0, 20, 20)),
            InputWindow::new(2, InputRect::new(40, 0, 40, 40)),
        ]);
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(50, 10));
        route(&mut router, WM_RBUTTONDOWN, InputPoint::new(50, 10));

        assert_eq!(
            router.remove_window(2),
            vec![
                OutboundMessage::Input {
                    window_id: 2,
                    msg: WM_LBUTTONUP,
                    wparam: MK_RBUTTON,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
                OutboundMessage::Input {
                    window_id: 2,
                    msg: WM_RBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
                OutboundMessage::WindowFocused { focus_window_id: 0 },
            ]
        );
        let state = router.state();
        assert_eq!(state.window_count, 1);
        assert_eq!(state.focused_window_id, None);
        assert_eq!(state.captured_window_id, None);
        assert!(router.atomic_interception_state().desired());
    }

    #[test]
    fn alpha_zero_falls_through_and_missing_or_invalid_pixels_use_rectangle() {
        let bottom = InputWindow::new(1, InputRect::new(0, 0, 2, 1));
        let top = InputWindow::new(2, InputRect::new(0, 0, 2, 1)).with_alpha_frame(
            2,
            1,
            Arc::from([255, 255, 255, 0, 255, 255, 255, 255]),
        );
        let mut router = router_with_windows(vec![bottom.clone(), top.clone()]);

        let transparent_hit = route(&mut router, WM_MOUSEMOVE, InputPoint::new(0, 0));
        assert!(matches!(
            transparent_hit.as_slice(),
            [OutboundMessage::Input { window_id: 1, .. }]
        ));

        assert!(router.replace_windows(vec![bottom.clone(), top]).is_empty());
        let opaque_hit = route(&mut router, WM_MOUSEMOVE, InputPoint::new(1, 0));
        assert!(matches!(
            opaque_hit.as_slice(),
            [OutboundMessage::Input { window_id: 2, .. }]
        ));

        let invalid = InputWindow::new(3, InputRect::new(0, 0, 2, 1)).with_alpha_frame(
            2,
            1,
            Arc::from([0_u8; 3]),
        );
        assert!(router
            .replace_windows(vec![bottom.clone(), invalid])
            .is_empty());
        let invalid_fallback = route(&mut router, WM_MOUSEMOVE, InputPoint::new(0, 0));
        assert!(matches!(
            invalid_fallback.as_slice(),
            [OutboundMessage::Input { window_id: 3, .. }]
        ));

        assert!(router.replace_windows(vec![bottom]).is_empty());
        assert!(router
            .update_window_alpha_frame(1, 1, 1, Arc::from([0_u8, 0, 0, 0]))
            .is_empty());
        assert!(route(&mut router, WM_MOUSEMOVE, InputPoint::new(0, 0)).is_empty());
        assert!(router.clear_window_alpha_frame(1).is_empty());
        assert!(!route(&mut router, WM_MOUSEMOVE, InputPoint::new(0, 0)).is_empty());
    }

    #[test]
    fn replace_filters_invalid_windows_and_last_duplicate_wins_topmost() {
        let mut router = InputRouter::new();
        router.set_target_focused(true);
        router.request_interception(true);
        assert!(router
            .replace_windows(vec![
                InputWindow::new(1, InputRect::new(0, 0, 10, 10)),
                InputWindow::new(2, InputRect::new(0, 0, 0, 10)),
                InputWindow::new(1, InputRect::new(20, 20, 30, 30)),
                InputWindow::new(3, InputRect::new(0, 0, 10, 10)),
            ])
            .is_empty());

        assert_eq!(router.window_count(), 2);
        assert_eq!(router.windows()[0].window_id, 1);
        assert_eq!(router.windows()[0].rect, InputRect::new(20, 20, 30, 30));
        assert_eq!(router.topmost_window_id(), Some(3));
        assert!(router.atomic_interception_state().desired());
        assert!(router.remove_window(3).is_empty());
        assert!(router.remove_window(1).is_empty());
        assert!(!router.atomic_interception_state().desired());
    }

    #[test]
    fn reset_with_reused_ids_releases_capture_clears_focus_and_drops_raise_intent() {
        let back = InputWindow::new(1, InputRect::new(0, 0, 100, 100));
        let front = InputWindow::new(2, InputRect::new(50, 0, 100, 100));
        let mut router = router_with_windows(vec![back.clone(), front.clone()]);

        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(60, 20));
        assert_eq!(router.focused_window_id(), Some(2));
        assert!(router.has_pointer_capture());

        assert_eq!(
            router.reset_windows(vec![back, front]),
            vec![
                OutboundMessage::Input {
                    window_id: 2,
                    msg: WM_LBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 20)),
                },
                OutboundMessage::WindowFocused { focus_window_id: 0 },
            ]
        );
        assert_eq!(router.focused_window_id(), None);
        assert!(!router.has_pointer_capture());
        assert_eq!(router.take_pending_raise(), None);
        assert_eq!(router.window_count(), 2);
        assert_eq!(router.topmost_window_id(), Some(2));
    }

    #[test]
    fn no_selection_is_fail_open_and_requested_state_survives_registration() {
        let mut router = InputRouter::new();
        assert!(router.set_target_focused(true).is_empty());
        assert!(router.request_interception(true).is_empty());
        assert_eq!(
            router.apply_input_filter(false, true),
            vec![OutboundMessage::InputIntercept {
                intercepting: false,
            }]
        );
        assert!(router.requested_interception());
        assert!(!router.effective_interception());
        assert!(!router.should_intercept_message(WM_INPUT));
        assert!(route(&mut router, WM_LBUTTONDOWN, InputPoint::new(0, 0)).is_empty());

        assert!(router.publish_selection(Some(selection())).is_empty());
        assert!(router.apply_input_filter(false, false).is_empty());
        assert_eq!(
            router.apply_input_filter(true, true),
            vec![OutboundMessage::InputIntercept { intercepting: true }]
        );
        assert!(router.effective_interception());
    }

    #[test]
    fn invalid_selection_remains_fail_open() {
        let mut router = InputRouter::new();
        router.request_interception(true);
        assert!(router
            .publish_selection(Some(SelectedWindow::new(
                WINDOW_ID,
                InputRect::new(0, 0, 0, 20),
            )))
            .is_empty());
        assert_eq!(router.selected_window(), None);
        assert!(!router.effective_interception());
        assert_eq!(
            router.apply_input_filter(false, true),
            vec![OutboundMessage::InputIntercept {
                intercepting: false,
            }]
        );
    }

    #[test]
    fn first_inside_mouse_down_focuses_before_forwarding_input() {
        let mut router = router_with_interception();
        let outbound = router.route_win32_message(
            WM_LBUTTONDOWN,
            0x0005,
            encode_signed_lparam_point(InputPoint::new(-10, 40)),
            |_| unreachable!(),
        );

        assert_eq!(
            outbound,
            vec![
                OutboundMessage::WindowFocused {
                    focus_window_id: WINDOW_ID,
                },
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONDOWN,
                    wparam: 0x0005,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
            ]
        );
        assert_eq!(router.focused_window_id(), Some(WINDOW_ID));
        assert!(router.has_pointer_capture());
    }

    #[test]
    fn activation_input_is_forwarded_only_after_an_arming_queue_drain() {
        let mut router = InputRouter::new();
        router.publish_selection(Some(selection()));
        assert!(router.request_interception(true).is_empty());
        assert!(router.set_target_focused(true).is_empty());

        let point = encode_signed_lparam_point(InputPoint::new(-10, 40));
        assert!(router
            .route_win32_message(WM_LBUTTONDOWN, 0, point, |_| {
                unreachable!("only wheel routing converts screen coordinates")
            })
            .is_empty());
        // A newly requested enable must not turn a previously sampled Disabled
        // phase into a premature false acknowledgement.
        assert!(router.apply_input_filter(false, true).is_empty());
        assert!(router.apply_input_filter(false, false).is_empty());
        assert!(router
            .route_win32_message(WM_LBUTTONDOWN, 0, point, |_| {
                unreachable!("only wheel routing converts screen coordinates")
            })
            .is_empty());
        assert_eq!(router.focused_window_id(), None);
        assert!(!router.has_pointer_capture());

        assert_eq!(
            router.apply_input_filter(true, true),
            vec![OutboundMessage::InputIntercept { intercepting: true }]
        );
        assert_eq!(
            router
                .route_win32_message(WM_LBUTTONDOWN, 0, point, |_| unreachable!())
                .len(),
            2
        );
        assert_eq!(router.focused_window_id(), Some(WINDOW_ID));
        assert!(router.has_pointer_capture());
    }

    #[test]
    fn pointer_capture_routes_an_outside_drag_until_matching_button_up() {
        let mut router = router_with_interception();
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));

        assert_eq!(
            route(&mut router, WM_MOUSEMOVE, InputPoint::new(-30, 20)),
            vec![OutboundMessage::Input {
                window_id: WINDOW_ID,
                msg: WM_MOUSEMOVE,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(-10, -10)),
            }]
        );
        assert_eq!(
            route(&mut router, WM_LBUTTONUP, InputPoint::new(-30, 20)),
            vec![OutboundMessage::Input {
                window_id: WINDOW_ID,
                msg: WM_LBUTTONUP,
                wparam: 0,
                lparam: encode_signed_lparam_point(InputPoint::new(-10, -10)),
            }]
        );
        assert!(!router.has_pointer_capture());
        assert!(route(&mut router, WM_MOUSEMOVE, InputPoint::new(-30, 20)).is_empty());
    }

    #[test]
    fn mismatched_mouse_up_does_not_end_existing_capture() {
        let mut router = router_with_interception();
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));
        route(&mut router, WM_RBUTTONUP, InputPoint::new(-30, 20));
        assert!(router.has_pointer_capture());
        route(&mut router, WM_LBUTTONUP, InputPoint::new(-30, 20));
        assert!(!router.has_pointer_capture());
    }

    #[test]
    fn xbuttons_are_safely_unsupported_by_the_electron16_path() {
        let mut router = router_with_interception();
        for message in [WM_XBUTTONDOWN, WM_XBUTTONUP, WM_XBUTTONDBLCLK] {
            assert!(router
                .route_win32_message(
                    message,
                    1 << 16,
                    encode_signed_lparam_point(InputPoint::new(-10, 40)),
                    |_| unreachable!(),
                )
                .is_empty());
            assert!(router.should_intercept_message(message));
            assert!(!router.has_pointer_capture());
        }
        assert!(router
            .route_win32_message(
                WM_XBUTTONUP,
                1 << 16,
                encode_signed_lparam_point(InputPoint::new(-30, 20)),
                |_| unreachable!(),
            )
            .is_empty());
    }

    #[test]
    fn native_capture_cancellation_sends_release_and_clears_software_capture() {
        for message in [WM_CANCELMODE, WM_CAPTURECHANGED] {
            let mut router = router_with_interception();
            route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));
            assert!(router.has_pointer_capture());

            assert_eq!(
                router.route_win32_message(message, 0, 0, |_| unreachable!()),
                vec![OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                }]
            );
            assert!(!router.has_pointer_capture());
            assert!(route(&mut router, WM_LBUTTONUP, InputPoint::new(-30, 20)).is_empty());
        }
    }

    #[test]
    fn lifecycle_cleanup_releases_every_captured_button_before_blur() {
        let mut router = router_with_interception();
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));
        route(&mut router, WM_RBUTTONDOWN, InputPoint::new(-10, 40));

        assert_eq!(
            router.request_interception(false),
            vec![
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONUP,
                    wparam: MK_RBUTTON,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_RBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
                OutboundMessage::WindowFocused { focus_window_id: 0 },
            ]
        );
        assert!(!router.has_pointer_capture());
    }

    #[test]
    fn keyboard_system_key_and_character_messages_require_electron_focus() {
        let mut router = router_with_interception();
        assert!(router
            .route_win32_message(WM_KEYDOWN, 0x41, 0x001e_0001, |_| unreachable!())
            .is_empty());
        assert!(router
            .route_win32_message(WM_CHAR, u32::from('a'), 0, |_| unreachable!())
            .is_empty());

        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));
        for msg in [
            WM_KEYDOWN,
            WM_KEYUP,
            WM_SYSKEYDOWN,
            WM_SYSKEYUP,
            WM_CHAR,
            WM_SYSCHAR,
            WM_UNICHAR,
        ] {
            assert_eq!(
                router.route_win32_message(msg, 0x41, 0x001e_0001, |_| unreachable!()),
                vec![OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg,
                    wparam: 0x41,
                    lparam: 0x001e_0001,
                }]
            );
        }
    }

    #[test]
    fn wheel_coordinates_cross_the_screen_to_client_seam_before_localization() {
        let screen_point = InputPoint::new(-300, 200);
        for message in [WM_MOUSEWHEEL, WM_MOUSEHWHEEL] {
            let mut router = router_with_interception();
            let conversion_called = Cell::new(false);

            let outbound = router.route_win32_message(
                message,
                120_u32 << 16,
                encode_signed_lparam_point(screen_point),
                |received| {
                    conversion_called.set(true);
                    assert_eq!(received, screen_point);
                    Some(InputPoint::new(-10, 40))
                },
            );
            assert!(conversion_called.get());
            assert_eq!(
                outbound,
                vec![OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: message,
                    wparam: 120_u32 << 16,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                }]
            );
        }

        let mut router = router_with_interception();
        assert!(router
            .route_win32_message(
                WM_MOUSEWHEEL,
                0,
                encode_signed_lparam_point(screen_point),
                |_| None,
            )
            .is_empty());
    }

    #[test]
    fn wheel_outside_is_not_forwarded_without_capture() {
        let mut router = router_with_interception();
        assert!(router
            .route_win32_message(
                WM_MOUSEWHEEL,
                0,
                encode_signed_lparam_point(InputPoint::new(1000, 1000)),
                |_| Some(InputPoint::new(500, 500)),
            )
            .is_empty());
        assert!(router.should_intercept_message(WM_MOUSEWHEEL));
    }

    #[test]
    fn release_clears_focus_and_capture_before_acknowledging_fail_open_state() {
        let mut router = router_with_interception();
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));

        assert_eq!(
            router.request_interception(false),
            vec![
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
                OutboundMessage::WindowFocused { focus_window_id: 0 },
            ]
        );
        assert!(router.effective_interception());
        // A request can race after message_filter sampled Enabled. That
        // terminal phase must not acknowledge false; Disarming first turns
        // routing off while InputAll remains published.
        assert!(router.apply_input_filter(true, true).is_empty());
        assert!(router.effective_interception());
        assert!(router.apply_input_filter(false, false).is_empty());
        assert!(!router.effective_interception());
        assert_eq!(
            router.apply_input_filter(false, true),
            vec![OutboundMessage::InputIntercept {
                intercepting: false,
            }]
        );
        assert_eq!(
            router.state(),
            InputRouterState {
                requested_interception: false,
                effective_interception: false,
                target_focused: true,
                window_count: 1,
                topmost_window_id: Some(WINDOW_ID),
                selected_window_id: Some(WINDOW_ID),
                focused_window_id: None,
                captured_window_id: None,
                pointer_captured: false,
            }
        );
    }

    #[test]
    fn close_cleans_up_and_reregistration_restores_only_requested_interception() {
        let mut router = router_with_interception();
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));

        assert_eq!(
            router.publish_selection(None),
            vec![
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
                OutboundMessage::WindowFocused { focus_window_id: 0 },
            ]
        );
        let state = router.state();
        assert!(state.requested_interception);
        assert!(state.effective_interception);
        assert_eq!(state.focused_window_id, None);
        assert!(!state.pointer_captured);
        assert_eq!(
            router.apply_input_filter(false, true),
            vec![OutboundMessage::InputIntercept {
                intercepting: false,
            }]
        );

        assert!(router.publish_selection(Some(selection())).is_empty());
        assert!(router.apply_input_filter(false, false).is_empty());
        assert_eq!(
            router.apply_input_filter(true, true),
            vec![OutboundMessage::InputIntercept { intercepting: true }]
        );
        assert_eq!(router.focused_window_id(), None);
        assert!(!router.has_pointer_capture());
    }

    #[test]
    fn target_focus_loss_cleans_up_and_regain_restores_effective_interception() {
        let mut router = router_with_interception();
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));

        assert_eq!(
            router.set_target_focused(false),
            vec![
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
                OutboundMessage::WindowFocused { focus_window_id: 0 },
            ]
        );
        assert!(router.effective_interception());
        assert!(!router.has_pointer_capture());
        assert_eq!(
            router.apply_input_filter(false, true),
            vec![OutboundMessage::InputIntercept {
                intercepting: false,
            }]
        );
        assert!(router.set_target_focused(true).is_empty());
        assert!(router.apply_input_filter(false, false).is_empty());
        assert_eq!(
            router.apply_input_filter(true, true),
            vec![OutboundMessage::InputIntercept { intercepting: true }]
        );
        assert_eq!(router.focused_window_id(), None);
    }

    #[test]
    fn native_focus_messages_drive_the_same_cleanup_and_restore_transitions() {
        let mut router = router_with_interception();
        let atomics = router.atomic_interception_state();
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));

        assert_eq!(
            router.route_win32_message(WM_ACTIVATEAPP, 0, 0, |_| unreachable!()),
            vec![
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(10, 10)),
                },
                OutboundMessage::WindowFocused { focus_window_id: 0 },
            ]
        );
        assert!(atomics.requested());
        assert!(!atomics.desired());
        assert!(atomics.effective());
        assert_eq!(
            router.apply_input_filter(false, true),
            vec![OutboundMessage::InputIntercept {
                intercepting: false,
            }]
        );
        assert!(router
            .route_win32_message(WM_KILLFOCUS, 0, 0, |_| unreachable!())
            .is_empty());

        assert!(router
            .route_win32_message(WM_SETFOCUS, 0, 0, |_| unreachable!())
            .is_empty());
        assert!(atomics.desired());
        assert!(router.apply_input_filter(false, false).is_empty());
        assert_eq!(
            router.apply_input_filter(true, true),
            vec![OutboundMessage::InputIntercept { intercepting: true }]
        );
        assert!(atomics.effective());
        assert!(router
            .route_win32_message(WM_ACTIVATEAPP, 1, 0, |_| unreachable!())
            .is_empty());
    }

    #[test]
    fn atomic_flags_follow_requested_and_effective_state_without_router_locking() {
        let mut router = InputRouter::new();
        let atomics = router.atomic_interception_state();
        assert!(!atomics.requested());
        assert!(!atomics.desired());
        assert!(!atomics.effective());

        router.request_interception(true);
        assert!(atomics.requested());
        assert!(!atomics.desired());
        assert!(!atomics.effective());
        router.set_target_focused(true);
        router.publish_selection(Some(selection()));
        assert!(atomics.desired());
        assert!(!atomics.effective());
        router.apply_input_filter(false, false);
        router.apply_input_filter(true, true);
        assert!(atomics.effective());
        router.set_target_focused(false);
        assert!(atomics.requested());
        assert!(!atomics.desired());
        assert!(atomics.effective());
        router.apply_input_filter(false, true);
        assert!(!atomics.effective());
        router.request_interception(false);
        assert!(!atomics.requested());
        assert!(!atomics.effective());
    }

    #[test]
    fn bounds_updates_preserve_focus_and_capture_but_republication_does_not() {
        let mut router = router_with_interception();
        route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40));

        assert!(router
            .update_selection_rect(WINDOW_ID, InputRect::new(10, 10, 100, 50),)
            .is_empty());
        assert_eq!(router.focused_window_id(), Some(WINDOW_ID));
        assert!(router.has_pointer_capture());

        assert_eq!(
            router.publish_selection(Some(SelectedWindow::new(
                WINDOW_ID,
                InputRect::new(10, 10, 100, 50),
            ))),
            vec![
                OutboundMessage::Input {
                    window_id: WINDOW_ID,
                    msg: WM_LBUTTONUP,
                    wparam: 0,
                    lparam: encode_signed_lparam_point(InputPoint::new(-20, 30)),
                },
                OutboundMessage::WindowFocused { focus_window_id: 0 },
            ]
        );
        assert_eq!(router.focused_window_id(), None);
        assert!(!router.has_pointer_capture());
        assert!(router.effective_interception());
    }

    #[test]
    fn global_interception_includes_outside_input_and_raw_input() {
        let mut router = router_with_interception();
        assert!(router.should_intercept_message(WM_LBUTTONDOWN));
        assert!(router.should_intercept_message(WM_XBUTTONDOWN));
        assert!(router.should_intercept_message(WM_MOUSEHWHEEL));
        assert!(router.should_intercept_message(WM_KEYDOWN));
        assert!(router.should_intercept_message(0x0109)); // WM_UNICHAR
        assert!(router.should_intercept_message(WM_INPUT));
        assert!(!router.should_intercept_message(0x000f)); // WM_PAINT
        assert!(router
            .route_win32_message(WM_INPUT, 0, 0, |_| unreachable!())
            .is_empty());
        assert!(route(&mut router, WM_LBUTTONDOWN, InputPoint::new(500, 500)).is_empty());

        router.request_interception(false);
        assert!(router.should_intercept_message(WM_LBUTTONDOWN));
        assert!(route(&mut router, WM_LBUTTONDOWN, InputPoint::new(-10, 40)).is_empty());
        router.apply_input_filter(false, true);
        assert!(!router.should_intercept_message(WM_LBUTTONDOWN));
        assert!(!router.should_intercept_message(WM_INPUT));
    }

    #[test]
    fn outbound_queue_coalesces_only_adjacent_mouse_moves() {
        let first_move = OutboundMessage::Input {
            window_id: WINDOW_ID,
            msg: WM_MOUSEMOVE,
            wparam: 0,
            lparam: 1,
        };
        let latest_move = OutboundMessage::Input {
            window_id: WINDOW_ID,
            msg: WM_MOUSEMOVE,
            wparam: 0,
            lparam: 2,
        };
        let down = OutboundMessage::Input {
            window_id: WINDOW_ID,
            msg: WM_LBUTTONDOWN,
            wparam: 0,
            lparam: 3,
        };
        let after_down_move = OutboundMessage::Input {
            window_id: WINDOW_ID,
            msg: WM_MOUSEMOVE,
            wparam: 0,
            lparam: 4,
        };

        let mut queue = OutboundQueue::new();
        queue.extend([
            first_move,
            latest_move.clone(),
            down.clone(),
            after_down_move.clone(),
        ]);
        assert_eq!(queue.len(), 3);
        assert_eq!(queue.pop_front(), Some(latest_move));
        assert_eq!(queue.pop_front(), Some(down));
        assert_eq!(queue.pop_front(), Some(after_down_move));
        assert!(queue.is_empty());
    }

    #[test]
    fn focus_and_acknowledgement_are_move_coalescing_barriers() {
        let move_message = |lparam| OutboundMessage::Input {
            window_id: WINDOW_ID,
            msg: WM_MOUSEMOVE,
            wparam: 0,
            lparam,
        };
        let mut queue = OutboundQueue::new();
        queue.extend([
            move_message(1),
            OutboundMessage::WindowFocused {
                focus_window_id: WINDOW_ID,
            },
            move_message(2),
            OutboundMessage::InputIntercept { intercepting: true },
            move_message(3),
        ]);

        assert_eq!(queue.len(), 5);
        assert_eq!(queue.pop_front(), Some(move_message(1)));
        assert_eq!(
            queue.pop_front(),
            Some(OutboundMessage::WindowFocused {
                focus_window_id: WINDOW_ID,
            })
        );
        assert_eq!(queue.pop_front(), Some(move_message(2)));
        assert_eq!(
            queue.pop_front(),
            Some(OutboundMessage::InputIntercept { intercepting: true })
        );
        assert_eq!(queue.pop_front(), Some(move_message(3)));
    }
}
