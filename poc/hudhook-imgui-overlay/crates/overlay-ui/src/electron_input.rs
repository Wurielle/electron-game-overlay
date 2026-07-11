//! Pure input routing for the selected Electron overlay window.
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectedWindow {
    pub window_id: u32,
    pub rect: InputRect,
}

impl SelectedWindow {
    pub const fn new(window_id: u32, rect: InputRect) -> Self {
        Self { window_id, rect }
    }
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
        if let OutboundMessage::Input {
            window_id,
            msg: WM_MOUSEMOVE,
            ..
        } = &message
        {
            if matches!(
                self.messages.back(),
                Some(OutboundMessage::Input {
                    window_id: pending_window_id,
                    msg: WM_MOUSEMOVE,
                    ..
                }) if pending_window_id == window_id
            ) {
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
    pub selected_window_id: Option<u32>,
    pub focused_window_id: Option<u32>,
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

#[derive(Debug)]
pub struct InputRouter {
    requested_interception: bool,
    desired_interception: bool,
    effective_interception: bool,
    target_focused: bool,
    selected: Option<SelectedWindow>,
    focused_window_id: Option<u32>,
    captured_buttons: u8,
    last_captured_point: Option<InputPoint>,
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
            selected: None,
            focused_window_id: None,
            captured_buttons: 0,
            last_captured_point: None,
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
        InputRouterState {
            requested_interception: self.requested_interception,
            effective_interception: self.effective_interception,
            target_focused: self.target_focused,
            selected_window_id: self.selected.map(|window| window.window_id),
            focused_window_id: self.focused_window_id,
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

    pub fn selected_window(&self) -> Option<SelectedWindow> {
        self.selected
    }

    #[cfg(test)]
    pub fn focused_window_id(&self) -> Option<u32> {
        self.focused_window_id
    }

    #[cfg(test)]
    pub fn has_pointer_capture(&self) -> bool {
        self.captured_buttons != 0
    }

    /// Publishes (or re-publishes) the selected Electron window. Publication is
    /// a lifecycle boundary and therefore always clears Electron focus and
    /// capture left by the previous registration. Use `update_selection_rect`
    /// for an ordinary bounds change during the same registration.
    ///
    /// Invalid rectangles are treated as no selection so interception remains
    /// fail-open.
    pub fn publish_selection(&mut self, selected: Option<SelectedWindow>) -> Vec<OutboundMessage> {
        let selected = selected.filter(|window| window.rect.is_valid());
        let mut outbound = Vec::new();
        outbound.extend(self.cancel_pointer_capture());
        self.clear_electron_focus(&mut outbound);

        self.selected = selected;
        self.recompute_desired_interception(false);
        outbound
    }

    /// Updates bounds for the current registration without disturbing focus or
    /// pointer capture. A non-positive rectangle removes the selection and
    /// restores fail-open input. A stale window id is ignored.
    pub fn update_selection_rect(
        &mut self,
        window_id: u32,
        rect: InputRect,
    ) -> Vec<OutboundMessage> {
        let Some(selected) = self.selected.as_mut() else {
            return Vec::new();
        };
        if selected.window_id != window_id {
            return Vec::new();
        }
        if !rect.is_valid() {
            return self.publish_selection(None);
        }

        selected.rect = rect;
        Vec::new()
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

        if !self.effective_interception || !self.requested_interception || !self.target_focused {
            return Vec::new();
        }

        match classify_message(msg) {
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
        let Some(selected) = self.selected else {
            return Vec::new();
        };

        let captured_before = self.captured_buttons != 0;
        let inside = selected.rect.contains(client_point);
        if !inside && !captured_before {
            return Vec::new();
        }

        let mut outbound = Vec::with_capacity(2);
        if matches!(transition, Some(PointerTransition::Down(_)))
            && self.focused_window_id != Some(selected.window_id)
        {
            self.focused_window_id = Some(selected.window_id);
            outbound.push(OutboundMessage::WindowFocused {
                focus_window_id: selected.window_id,
            });
        }

        if let Some(PointerTransition::Down(button)) = transition {
            self.captured_buttons |= button;
        }
        if self.captured_buttons != 0 {
            self.last_captured_point = Some(client_point);
        }

        let local_point = selected.rect.to_local(client_point);
        outbound.push(OutboundMessage::Input {
            window_id: selected.window_id,
            msg,
            wparam,
            lparam: encode_signed_lparam_point(local_point),
        });

        // Release capture after queuing the matching mouse-up packet, so that
        // an out-of-bounds release is delivered before capture ends.
        if let Some(PointerTransition::Up(button)) = transition {
            self.captured_buttons &= !button;
            if self.captured_buttons == 0 {
                self.last_captured_point = None;
            }
        }

        outbound
    }

    fn cancel_pointer_capture(&mut self) -> Vec<OutboundMessage> {
        let captured_buttons = self.captured_buttons;
        self.captured_buttons = 0;

        let Some(selected) = self.selected else {
            self.last_captured_point = None;
            return Vec::new();
        };
        let Some(client_point) = self.last_captured_point.take() else {
            return Vec::new();
        };

        let lparam = encode_signed_lparam_point(selected.rect.to_local(client_point));
        let mut remaining_buttons = captured_buttons;
        let mut outbound = Vec::new();
        for button in [LEFT_BUTTON, RIGHT_BUTTON, MIDDLE_BUTTON] {
            if captured_buttons & button == 0 {
                continue;
            }

            remaining_buttons &= !button;
            let msg = pointer_release_message(button);
            outbound.push(OutboundMessage::Input {
                window_id: selected.window_id,
                msg,
                wparam: encode_button_state_wparam(remaining_buttons),
                lparam,
            });
        }
        outbound
    }

    fn route_keyboard(&self, msg: u32, wparam: u32, lparam: u32) -> Vec<OutboundMessage> {
        let Some(window_id) = self.focused_window_id else {
            return Vec::new();
        };
        if self.selected.map(|window| window.window_id) != Some(window_id) {
            return Vec::new();
        }

        vec![OutboundMessage::Input {
            window_id,
            msg,
            wparam,
            lparam,
        }]
    }

    fn clear_electron_focus(&mut self, outbound: &mut Vec<OutboundMessage>) {
        if self.focused_window_id.take().is_some() {
            outbound.push(OutboundMessage::WindowFocused { focus_window_id: 0 });
        }
    }

    fn recompute_desired_interception(&mut self, force_acknowledgement: bool) {
        let desired = self.requested_interception && self.target_focused && self.selected.is_some();
        let changed = desired != self.desired_interception;
        self.desired_interception = desired;
        self.atomic_interception
            .desired
            .store(desired, Ordering::Release);
        self.acknowledgement_pending |= changed || force_acknowledgement;
    }
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

    fn route(router: &mut InputRouter, msg: u32, point: InputPoint) -> Vec<OutboundMessage> {
        router.route_win32_message(msg, 0, encode_signed_lparam_point(point), |_| {
            unreachable!("only wheel routing converts screen coordinates")
        })
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
                selected_window_id: Some(WINDOW_ID),
                focused_window_id: None,
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
