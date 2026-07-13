//! Synchronous pointer ownership for the intercepted overlay path.
//!
//! Hudhook invokes this source inside its replacement WndProc. The source
//! copies raw/legacy pointer data into one owned queue; the render thread drains
//! that queue once and fans the same ordered events out to ImGui and Electron.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use hudhook::imgui::{Io, MouseButton};
use hudhook::process_input::{
    get_cursor_pos_unfiltered, ProcessInputPhase, ProcessMouseSuppression, ProcessRawMouseHandler,
    PHYSICAL_MOUSE_LEFT_BUTTON, PHYSICAL_MOUSE_MIDDLE_BUTTON, PHYSICAL_MOUSE_RIGHT_BUTTON,
    PHYSICAL_MOUSE_X1_BUTTON, PHYSICAL_MOUSE_X2_BUTTON,
};
use hudhook::sync_input::{
    RawInputData, RawMouseInput, SynchronousWndProcDecision, SynchronousWndProcEvent,
    SynchronousWndProcHandler,
};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT};
use windows::Win32::UI::Input::MOUSE_MOVE_ABSOLUTE;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetMessageTime, RIM_INPUT, RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP,
    RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_BUTTON_5_UP, RI_MOUSE_HWHEEL, RI_MOUSE_LEFT_BUTTON_DOWN,
    RI_MOUSE_LEFT_BUTTON_UP, RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_UP,
    RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_UP, RI_MOUSE_WHEEL, WHEEL_DELTA,
    WM_ACTIVATEAPP, WM_CANCELMODE, WM_CAPTURECHANGED, WM_INPUT, WM_KILLFOCUS, WM_LBUTTONDBLCLK,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEFIRST,
    WM_MOUSEHWHEEL, WM_MOUSELAST, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON1,
};

use electron_overlay_transport::InputPoint;

const INPUT_FILTER_DISABLED: u8 = 0;
const INPUT_FILTER_ARMING: u8 = 1;
const INPUT_FILTER_ENABLED: u8 = 2;
const INPUT_FILTER_DISARMING: u8 = 3;
const MAX_PENDING_EVENTS: usize = 2048;
// Only game-facing GetCursorPos calls see this off-client point. Hudhook's raw
// copier uses the original trampoline, so overlay hit testing retains the real
// cursor while Unity clears any previously hovered menu element.
const GAME_NEUTRAL_CURSOR_POINT: POINT = POINT {
    x: i16::MIN as i32,
    y: i16::MIN as i32,
};

const LEFT_BUTTON: u8 = PHYSICAL_MOUSE_LEFT_BUTTON;
const RIGHT_BUTTON: u8 = PHYSICAL_MOUSE_RIGHT_BUTTON;
const MIDDLE_BUTTON: u8 = PHYSICAL_MOUSE_MIDDLE_BUTTON;
const EXTRA1_BUTTON: u8 = PHYSICAL_MOUSE_X1_BUTTON;
const EXTRA2_BUTTON: u8 = PHYSICAL_MOUSE_X2_BUTTON;

const MK_LBUTTON: u32 = 0x0001;
const MK_RBUTTON: u32 = 0x0002;
const MK_SHIFT: u32 = 0x0004;
const MK_CONTROL: u32 = 0x0008;
const MK_MBUTTON: u32 = 0x0010;
const MK_XBUTTON1: u32 = 0x0020;
const MK_XBUTTON2: u32 = 0x0040;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PointerButton {
    Left,
    Right,
    Middle,
    Extra1,
    Extra2,
}

impl PointerButton {
    const fn mask(self) -> u8 {
        match self {
            Self::Left => LEFT_BUTTON,
            Self::Right => RIGHT_BUTTON,
            Self::Middle => MIDDLE_BUTTON,
            Self::Extra1 => EXTRA1_BUTTON,
            Self::Extra2 => EXTRA2_BUTTON,
        }
    }

    const fn imgui(self) -> MouseButton {
        match self {
            Self::Left => MouseButton::Left,
            Self::Right => MouseButton::Right,
            Self::Middle => MouseButton::Middle,
            Self::Extra1 => MouseButton::Extra1,
            Self::Extra2 => MouseButton::Extra2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PointerEventKind {
    Move,
    Button { button: PointerButton, down: bool },
    Wheel { horizontal: f32, vertical: f32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PointerSource {
    Legacy,
    Raw,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WheelSignature {
    source: PointerSource,
    horizontal: bool,
    delta: i16,
    point: InputPoint,
    message_time: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WheelSample {
    horizontal: bool,
    delta: i16,
    route_lparam: u32,
    source: PointerSource,
    message_time: i32,
}

/// One normalized target-client pointer event plus its Electron-compatible
/// Win32 representation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OwnedPointerEvent {
    window: usize,
    point: InputPoint,
    kind: PointerEventKind,
    message: u32,
    wparam: u32,
    lparam: u32,
}

impl OwnedPointerEvent {
    pub fn feed_imgui(self, io: &mut Io) {
        io.add_mouse_pos_event([self.point.x as f32, self.point.y as f32]);
        match self.kind {
            PointerEventKind::Move => {}
            PointerEventKind::Button { button, down } => {
                io.add_mouse_button_event(button.imgui(), down);
            }
            PointerEventKind::Wheel {
                horizontal,
                vertical,
            } => {
                io.add_mouse_wheel_event([horizontal, vertical]);
            }
        }
    }

    pub const fn win32(self) -> (HWND, u32, WPARAM, LPARAM) {
        (
            HWND(self.window as *mut _),
            self.message,
            WPARAM(self.wparam as usize),
            LPARAM(self.lparam as isize),
        )
    }
}

#[derive(Default)]
struct PointerState {
    window: Option<usize>,
    point: Option<InputPoint>,
    last_os_point: Option<InputPoint>,
    buttons: u8,
    modifiers: u32,
    last_wheel: Option<WheelSignature>,
    pending: VecDeque<OwnedPointerEvent>,
}

impl PointerState {
    fn seed_route(&mut self, hwnd: HWND, point: InputPoint) {
        self.window = Some(hwnd.0 as usize);
        self.point = Some(point);
        self.last_os_point = Some(point);
    }

    fn reset(&mut self) {
        self.window = None;
        self.point = None;
        self.last_os_point = None;
        self.buttons = 0;
        self.modifiers = 0;
        self.last_wheel = None;
        self.pending.clear();
    }

    fn cancel(&mut self) {
        if self.buttons == 0 {
            self.pending
                .retain(|event| matches!(event.kind, PointerEventKind::Button { down: false, .. }));
            self.last_os_point = None;
            self.modifiers = 0;
            self.last_wheel = None;
            return;
        }
        self.pending.clear();
        let (Some(window), Some(point)) = (self.window, self.point) else {
            self.reset();
            return;
        };
        let hwnd = HWND(window as *mut _);
        let lparam = encode_point(point);
        let held = self.buttons;
        for (mask, button, message) in [
            (LEFT_BUTTON, PointerButton::Left, WM_LBUTTONUP),
            (RIGHT_BUTTON, PointerButton::Right, WM_RBUTTONUP),
            (MIDDLE_BUTTON, PointerButton::Middle, WM_MBUTTONUP),
            (EXTRA1_BUTTON, PointerButton::Extra1, WM_XBUTTONUP),
            (EXTRA2_BUTTON, PointerButton::Extra2, WM_XBUTTONUP),
        ] {
            if held & mask != 0 {
                self.button(hwnd, point, button, false, message, lparam);
            }
        }
        self.last_os_point = None;
        self.modifiers = 0;
        self.last_wheel = None;
    }

    fn push(&mut self, event: OwnedPointerEvent) {
        if matches!(event.kind, PointerEventKind::Move) {
            if let Some(tail) = self.pending.back_mut() {
                if matches!(tail.kind, PointerEventKind::Move) {
                    *tail = event;
                    return;
                }
            }
        }

        if self.pending.len() >= MAX_PENDING_EVENTS {
            if let Some(coalescible_index) = self.pending.iter().position(|pending| {
                matches!(
                    pending.kind,
                    PointerEventKind::Move | PointerEventKind::Wheel { .. }
                )
            }) {
                self.pending.remove(coalescible_index);
            }
        }
        // Never evict a button transition. A queue containing only transitions
        // may temporarily exceed the soft cap so releases remain lossless.
        self.pending.push_back(event);
    }

    fn move_to(&mut self, hwnd: HWND, point: InputPoint, wparam: u32, lparam: u32) {
        self.window = Some(hwnd.0 as usize);
        if self.point == Some(point) {
            return;
        }
        self.point = Some(point);
        self.push(OwnedPointerEvent {
            window: hwnd.0 as usize,
            point,
            kind: PointerEventKind::Move,
            message: WM_MOUSEMOVE,
            wparam,
            lparam,
        });
    }

    fn button(
        &mut self,
        hwnd: HWND,
        point: InputPoint,
        button: PointerButton,
        down: bool,
        message: u32,
        route_lparam: u32,
    ) {
        self.window = Some(hwnd.0 as usize);
        self.point = Some(point);
        let was_down = self.buttons & button.mask() != 0;
        if was_down == down {
            return;
        }
        if down {
            self.buttons |= button.mask();
        } else {
            self.buttons &= !button.mask();
        }
        self.push(OwnedPointerEvent {
            window: hwnd.0 as usize,
            point,
            kind: PointerEventKind::Button { button, down },
            message,
            wparam: mouse_key_state(self.buttons, self.modifiers),
            lparam: route_lparam,
        });
    }

    fn wheel(&mut self, hwnd: HWND, point: InputPoint, sample: WheelSample) {
        let signature = WheelSignature {
            source: sample.source,
            horizontal: sample.horizontal,
            delta: sample.delta,
            point,
            message_time: sample.message_time,
        };
        if self.last_wheel.is_some_and(|previous| {
            previous.source != signature.source
                && previous.horizontal == signature.horizontal
                && previous.delta == signature.delta
                && previous.point == signature.point
                && previous.message_time.abs_diff(signature.message_time) <= 8
        }) {
            return;
        }
        self.last_wheel = Some(signature);
        self.window = Some(hwnd.0 as usize);
        self.point = Some(point);
        let (message, horizontal, vertical) = if sample.horizontal {
            (
                WM_MOUSEHWHEEL,
                sample.delta as f32 / WHEEL_DELTA as f32,
                0.0,
            )
        } else {
            (WM_MOUSEWHEEL, 0.0, sample.delta as f32 / WHEEL_DELTA as f32)
        };
        let wparam =
            mouse_key_state(self.buttons, self.modifiers) | ((sample.delta as u16 as u32) << 16);
        self.push(OwnedPointerEvent {
            window: hwnd.0 as usize,
            point,
            kind: PointerEventKind::Wheel {
                horizontal,
                vertical,
            },
            message,
            wparam,
            lparam: sample.route_lparam,
        });
    }

    fn reconcile_physical_buttons(&mut self, down: u8, pressed_since_last: u8) -> usize {
        let (Some(window), Some(point)) = (self.window, self.point) else {
            return 0;
        };
        let hwnd = HWND(window as *mut _);
        let route_lparam = encode_point(point);
        let mut event_count = 0;
        let pending_button_edges = self.pending.iter().fold(0, |mask, event| match event.kind {
            PointerEventKind::Button { button, .. } => mask | button.mask(),
            _ => mask,
        });

        for (mask, button, down_message, up_message) in [
            (
                LEFT_BUTTON,
                PointerButton::Left,
                WM_LBUTTONDOWN,
                WM_LBUTTONUP,
            ),
            (
                RIGHT_BUTTON,
                PointerButton::Right,
                WM_RBUTTONDOWN,
                WM_RBUTTONUP,
            ),
            (
                MIDDLE_BUTTON,
                PointerButton::Middle,
                WM_MBUTTONDOWN,
                WM_MBUTTONUP,
            ),
            (
                EXTRA1_BUTTON,
                PointerButton::Extra1,
                WM_XBUTTONDOWN,
                WM_XBUTTONUP,
            ),
            (
                EXTRA2_BUTTON,
                PointerButton::Extra2,
                WM_XBUTTONDOWN,
                WM_XBUTTONUP,
            ),
        ] {
            let physically_down = down & mask != 0;
            let pressed = pressed_since_last & mask != 0;

            // GetAsyncKeyState's low bit preserves a short press that began and
            // ended between render boundaries. Publish both edges at the last
            // routed pointer position so neither ImGui nor Electron loses it.
            if pressed && !physically_down && pending_button_edges & mask == 0 {
                let before = self.buttons;
                self.button(hwnd, point, button, true, down_message, route_lparam);
                event_count += usize::from(self.buttons != before);

                let before = self.buttons;
                self.button(hwnd, point, button, false, up_message, route_lparam);
                event_count += usize::from(self.buttons != before);
                continue;
            }

            let before = self.buttons;
            let message = if physically_down {
                down_message
            } else {
                up_message
            };
            self.button(hwnd, point, button, physically_down, message, route_lparam);
            event_count += usize::from(self.buttons != before);
        }

        event_count
    }
}

/// Pointer-only synchronous input source used while interception is active.
pub struct OwnedPointerInput {
    phase: AtomicU8,
    process_mouse_suppression: Arc<ProcessMouseSuppression>,
    target_window: AtomicUsize,
    pointer_route_ready: AtomicBool,
    process_raw_input_logged: AtomicBool,
    state: Mutex<PointerState>,
}

impl Default for OwnedPointerInput {
    fn default() -> Self {
        Self::new(Arc::new(ProcessMouseSuppression::new()))
    }
}

impl OwnedPointerInput {
    pub fn new(process_mouse_suppression: Arc<ProcessMouseSuppression>) -> Self {
        Self {
            phase: AtomicU8::new(INPUT_FILTER_DISABLED),
            process_mouse_suppression,
            target_window: AtomicUsize::new(0),
            pointer_route_ready: AtomicBool::new(false),
            process_raw_input_logged: AtomicBool::new(false),
            state: Mutex::new(PointerState::default()),
        }
    }

    pub fn set_phase(&self, phase: u8) {
        let previous = self.phase.load(Ordering::Acquire);
        let seed = (previous == INPUT_FILTER_DISABLED && phase != INPUT_FILTER_DISABLED)
            .then(|| self.sample_target_cursor())
            .flatten();
        self.set_phase_with_seed(phase, seed);
    }

    fn set_phase_with_seed(&self, phase: u8, seed: Option<(HWND, InputPoint)>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = self.phase.load(Ordering::Acquire);
        if previous != phase {
            if previous == INPUT_FILTER_DISABLED && phase != INPUT_FILTER_DISABLED {
                self.process_mouse_suppression
                    .set_frozen_point(GAME_NEUTRAL_CURSOR_POINT);
            }

            if previous == INPUT_FILTER_ENABLED {
                state.cancel();
            } else if phase != INPUT_FILTER_ENABLED {
                state.reset();
                self.pointer_route_ready.store(false, Ordering::Release);
            }

            if previous == INPUT_FILTER_DISABLED && phase != INPUT_FILTER_DISABLED {
                if let Some((hwnd, point)) = seed {
                    state.seed_route(hwnd, point);
                    self.pointer_route_ready.store(true, Ordering::Release);
                }
            }

            let process_phase = match phase {
                INPUT_FILTER_ARMING => ProcessInputPhase::Arming,
                INPUT_FILTER_ENABLED => ProcessInputPhase::Enabled,
                INPUT_FILTER_DISARMING => ProcessInputPhase::Disarming,
                _ => ProcessInputPhase::Disabled,
            };
            if process_phase == ProcessInputPhase::Disabled {
                self.phase.store(phase, Ordering::Release);
                self.process_mouse_suppression.set_phase(process_phase);
            } else {
                self.process_mouse_suppression.set_phase(process_phase);
                self.phase.store(phase, Ordering::Release);
            }
        }
    }

    fn bind_target_window(&self, hwnd: HWND) {
        let hwnd = hwnd.0 as usize;
        if hwnd != 0 {
            self.target_window.store(hwnd, Ordering::Release);
        }
    }

    fn target_window(&self) -> Option<HWND> {
        let hwnd = self.target_window.load(Ordering::Acquire);
        (hwnd != 0).then_some(HWND(hwnd as *mut _))
    }

    fn sample_target_cursor(&self) -> Option<(HWND, InputPoint)> {
        let hwnd = self.target_window()?;
        let mut cursor = POINT::default();
        let sampled = unsafe { get_cursor_pos_unfiltered(&raw mut cursor) }.as_bool()
            && unsafe { ScreenToClient(hwnd, &raw mut cursor) }.as_bool();
        sampled.then(|| {
            (
                hwnd,
                clamp_client_point(hwnd, InputPoint::new(cursor.x, cursor.y)),
            )
        })
    }

    pub fn drain(&self) -> Vec<OwnedPointerEvent> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.pending.drain(..).collect()
    }

    /// Reconciles button transitions missed by the target WndProc/raw-input
    /// route against an unfiltered physical snapshot. Guarded transition phases
    /// sample and discard so input cannot leak across ownership boundaries.
    pub fn reconcile_physical_buttons(&self) {
        let phase = self.phase.load(Ordering::Acquire);
        if phase == INPUT_FILTER_DISABLED {
            return;
        }

        let snapshot = self.process_mouse_suppression.physical_mouse_buttons();
        if phase != INPUT_FILTER_ENABLED {
            return;
        }

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.phase.load(Ordering::Acquire) != INPUT_FILTER_ENABLED {
            return;
        }
        let route = (state.window, state.point);
        // Buffered RAWMOUSE owns short click transitions. GetAsyncKeyState's
        // racy low bit can be observed before the corresponding buffered raw
        // packet and would then duplicate that packet's down/up pair. Keep
        // only the high-bit held-state reconciliation here.
        let event_count = state.reconcile_physical_buttons(snapshot.down, 0);

        if event_count != 0 {
            let (window, point) = route;
            hudhook::tracing::info!(
                physical_down = snapshot.down,
                physical_pressed_since_last = snapshot.pressed_since_last,
                event_count,
                target_hwnd = window.unwrap_or_default(),
                pointer_x = point.map_or(0, |point| point.x),
                pointer_y = point.map_or(0, |point| point.y),
                "physical mouse buttons reconciled into owned pointer route"
            );
        } else if snapshot.pressed_since_last != 0 && route.0.is_none() {
            hudhook::tracing::warn!(
                physical_down = snapshot.down,
                physical_pressed_since_last = snapshot.pressed_since_last,
                "physical mouse button snapshot had no current pointer route"
            );
        }
    }

    fn capture_legacy(state: &mut PointerState, event: SynchronousWndProcEvent) {
        let lparam = event.lparam.0 as u32;
        state.modifiers = event.wparam.0 as u32 & (MK_CONTROL | MK_SHIFT);
        let message_time = unsafe { GetMessageTime() };
        let screen_coordinates = matches!(event.message, WM_MOUSEWHEEL | WM_MOUSEHWHEEL);
        let mut point = decode_point(lparam);
        if screen_coordinates {
            let mut native = POINT {
                x: point.x,
                y: point.y,
            };
            if unsafe { ScreenToClient(event.hwnd, &raw mut native) }.as_bool() {
                point = InputPoint::new(native.x, native.y);
            } else {
                return;
            }
        }

        match event.message {
            WM_MOUSEMOVE => state.move_to(event.hwnd, point, event.wparam.0 as u32, lparam),
            WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => state.button(
                event.hwnd,
                point,
                PointerButton::Left,
                true,
                event.message,
                lparam,
            ),
            WM_LBUTTONUP => state.button(
                event.hwnd,
                point,
                PointerButton::Left,
                false,
                event.message,
                lparam,
            ),
            WM_RBUTTONDOWN | WM_RBUTTONDBLCLK => state.button(
                event.hwnd,
                point,
                PointerButton::Right,
                true,
                event.message,
                lparam,
            ),
            WM_RBUTTONUP => state.button(
                event.hwnd,
                point,
                PointerButton::Right,
                false,
                event.message,
                lparam,
            ),
            WM_MBUTTONDOWN | WM_MBUTTONDBLCLK => state.button(
                event.hwnd,
                point,
                PointerButton::Middle,
                true,
                event.message,
                lparam,
            ),
            WM_MBUTTONUP => state.button(
                event.hwnd,
                point,
                PointerButton::Middle,
                false,
                event.message,
                lparam,
            ),
            WM_XBUTTONDOWN | WM_XBUTTONDBLCLK => {
                let button = if high_word(event.wparam.0 as u32) == XBUTTON1 {
                    PointerButton::Extra1
                } else {
                    PointerButton::Extra2
                };
                state.button(event.hwnd, point, button, true, event.message, lparam);
            }
            WM_XBUTTONUP => {
                let button = if high_word(event.wparam.0 as u32) == XBUTTON1 {
                    PointerButton::Extra1
                } else {
                    PointerButton::Extra2
                };
                state.button(event.hwnd, point, button, false, event.message, lparam);
            }
            WM_MOUSEWHEEL => {
                state.wheel(
                    event.hwnd,
                    point,
                    WheelSample {
                        horizontal: false,
                        delta: high_word(event.wparam.0 as u32) as i16,
                        route_lparam: lparam,
                        source: PointerSource::Legacy,
                        message_time,
                    },
                );
            }
            WM_MOUSEHWHEEL => {
                state.wheel(
                    event.hwnd,
                    point,
                    WheelSample {
                        horizontal: true,
                        delta: high_word(event.wparam.0 as u32) as i16,
                        route_lparam: lparam,
                        source: PointerSource::Legacy,
                        message_time,
                    },
                );
            }
            _ => {}
        }
    }

    fn capture_raw_mouse(state: &mut PointerState, hwnd: HWND, mouse: RawMouseInput) {
        state.modifiers = current_modifiers();
        let os_point = mouse
            .cursor_valid
            .then_some(InputPoint::new(mouse.cursor_x, mouse.cursor_y));
        let relative = mouse.flags & MOUSE_MOVE_ABSOLUTE.0 == 0;
        let point = if relative {
            match (os_point, state.last_os_point, state.point) {
                (Some(current), Some(previous), Some(virtual_point)) if current == previous => {
                    InputPoint::new(
                        virtual_point.x.saturating_add(mouse.last_x),
                        virtual_point.y.saturating_add(mouse.last_y),
                    )
                }
                (Some(current), _, _) => current,
                (None, _, Some(virtual_point)) => InputPoint::new(
                    virtual_point.x.saturating_add(mouse.last_x),
                    virtual_point.y.saturating_add(mouse.last_y),
                ),
                (None, _, None) => return,
            }
        } else if let Some(current) = os_point.or(state.point) {
            current
        } else {
            return;
        };
        state.last_os_point = os_point;
        let point = clamp_client_point(hwnd, point);
        let client_lparam = encode_point(point);
        let mouse_state = mouse_key_state(state.buttons, state.modifiers);
        state.move_to(hwnd, point, mouse_state, client_lparam);

        let button_flags = mouse.button_flags as u32;
        for (flag, button, down, message) in [
            (
                RI_MOUSE_LEFT_BUTTON_DOWN,
                PointerButton::Left,
                true,
                WM_LBUTTONDOWN,
            ),
            (
                RI_MOUSE_LEFT_BUTTON_UP,
                PointerButton::Left,
                false,
                WM_LBUTTONUP,
            ),
            (
                RI_MOUSE_RIGHT_BUTTON_DOWN,
                PointerButton::Right,
                true,
                WM_RBUTTONDOWN,
            ),
            (
                RI_MOUSE_RIGHT_BUTTON_UP,
                PointerButton::Right,
                false,
                WM_RBUTTONUP,
            ),
            (
                RI_MOUSE_MIDDLE_BUTTON_DOWN,
                PointerButton::Middle,
                true,
                WM_MBUTTONDOWN,
            ),
            (
                RI_MOUSE_MIDDLE_BUTTON_UP,
                PointerButton::Middle,
                false,
                WM_MBUTTONUP,
            ),
            (
                RI_MOUSE_BUTTON_4_DOWN,
                PointerButton::Extra1,
                true,
                WM_XBUTTONDOWN,
            ),
            (
                RI_MOUSE_BUTTON_4_UP,
                PointerButton::Extra1,
                false,
                WM_XBUTTONUP,
            ),
            (
                RI_MOUSE_BUTTON_5_DOWN,
                PointerButton::Extra2,
                true,
                WM_XBUTTONDOWN,
            ),
            (
                RI_MOUSE_BUTTON_5_UP,
                PointerButton::Extra2,
                false,
                WM_XBUTTONUP,
            ),
        ] {
            if button_flags & flag != 0 {
                state.button(hwnd, point, button, down, message, client_lparam);
            }
        }

        let mut screen = POINT {
            x: point.x,
            y: point.y,
        };
        let screen_lparam = if unsafe { ClientToScreen(hwnd, &raw mut screen) }.as_bool() {
            encode_point(InputPoint::new(screen.x, screen.y))
        } else {
            client_lparam
        };
        let message_time = unsafe { GetMessageTime() };
        if button_flags & RI_MOUSE_WHEEL != 0 {
            state.wheel(
                hwnd,
                point,
                WheelSample {
                    horizontal: false,
                    delta: mouse.button_data as i16,
                    route_lparam: screen_lparam,
                    source: PointerSource::Raw,
                    message_time,
                },
            );
        }
        if button_flags & RI_MOUSE_HWHEEL != 0 {
            state.wheel(
                hwnd,
                point,
                WheelSample {
                    horizontal: true,
                    delta: mouse.button_data as i16,
                    route_lparam: screen_lparam,
                    source: PointerSource::Raw,
                    message_time,
                },
            );
        }
    }
}

impl SynchronousWndProcHandler for OwnedPointerInput {
    fn bind_target_window(&self, hwnd: HWND) {
        OwnedPointerInput::bind_target_window(self, hwnd);
    }

    fn handle(&self, event: SynchronousWndProcEvent) -> SynchronousWndProcDecision {
        self.bind_target_window(event.hwnd);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let phase = self.phase.load(Ordering::Acquire);
        if phase == INPUT_FILTER_DISABLED {
            return SynchronousWndProcDecision::Forward;
        }

        if matches!(
            event.message,
            WM_KILLFOCUS | WM_CANCELMODE | WM_CAPTURECHANGED
        ) || (event.message == WM_ACTIVATEAPP && event.wparam.0 == 0)
        {
            state.cancel();
            return SynchronousWndProcDecision::Forward;
        }

        if event.message == WM_INPUT {
            if let Some(RawInputData::Mouse(mouse)) = event.raw_input {
                if phase == INPUT_FILTER_ENABLED {
                    Self::capture_raw_mouse(&mut state, event.hwnd, mouse);
                    if state.window.is_some() && state.point.is_some() {
                        self.pointer_route_ready.store(true, Ordering::Release);
                    }
                }
                return if (event.wparam.0 as u32 & 0xff) == RIM_INPUT {
                    SynchronousWndProcDecision::HandledByDefWindowProc
                } else {
                    SynchronousWndProcDecision::Handled(LRESULT(0))
                };
            }

            // Copied raw keyboard/HID packets stay on hudhook's normal queue;
            // the published InputRaw filter blocks the game's WndProc while
            // hudhook feeds ImGui from the owned copy.
            return SynchronousWndProcDecision::Forward;
        }

        if (WM_MOUSEFIRST..=WM_MOUSELAST).contains(&event.message) {
            if phase == INPUT_FILTER_ENABLED {
                Self::capture_legacy(&mut state, event);
                if state.window.is_some() && state.point.is_some() {
                    self.pointer_route_ready.store(true, Ordering::Release);
                }
            }
            return if matches!(
                event.message,
                WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK
            ) {
                SynchronousWndProcDecision::Handled(LRESULT(1))
            } else {
                SynchronousWndProcDecision::Handled(LRESULT(0))
            };
        }

        SynchronousWndProcDecision::Forward
    }
}

impl ProcessRawMouseHandler for OwnedPointerInput {
    fn handle_process_raw_mouse(&self, mut input: RawMouseInput) {
        let needs_route = !self.pointer_route_ready.load(Ordering::Acquire);
        let absolute = input.flags & MOUSE_MOVE_ABSOLUTE.0 != 0;
        let sampled_cursor = (needs_route || absolute)
            .then(|| self.sample_target_cursor())
            .flatten();
        input = with_buffered_cursor_sample(input, sampled_cursor.map(|(_, point)| point));

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.phase.load(Ordering::Acquire) != INPUT_FILTER_ENABLED {
            return;
        }

        if state.window.is_none() {
            if let Some((hwnd, point)) = sampled_cursor {
                state.seed_route(hwnd, point);
                self.pointer_route_ready.store(true, Ordering::Release);
            }
        }
        let Some(window) = state.window else {
            if input.button_flags != 0 {
                hudhook::tracing::warn!(
                    button_flags = input.button_flags,
                    "buffered raw mouse buttons had no current pointer route"
                );
            }
            return;
        };

        Self::capture_raw_mouse(&mut state, HWND(window as *mut _), input);
        if state.window.is_some() && state.point.is_some() {
            self.pointer_route_ready.store(true, Ordering::Release);
        }
        drop(state);

        let first = !self.process_raw_input_logged.swap(true, Ordering::AcqRel);
        if first || input.button_flags != 0 {
            hudhook::tracing::info!(
                first_packet = first,
                button_flags = input.button_flags,
                button_data = input.button_data,
                delta_x = input.last_x,
                delta_y = input.last_y,
                target_hwnd = window,
                "buffered process raw mouse input reached owned pointer route"
            );
        }
    }
}

fn with_buffered_cursor_sample(
    mut input: RawMouseInput,
    cursor: Option<InputPoint>,
) -> RawMouseInput {
    if input.flags & MOUSE_MOVE_ABSOLUTE.0 != 0 {
        if let Some(cursor) = cursor {
            input.cursor_x = cursor.x;
            input.cursor_y = cursor.y;
            input.cursor_valid = true;
        }
    }
    input
}

fn current_modifiers() -> u32 {
    let mut modifiers = 0;
    if unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0 {
        modifiers |= MK_CONTROL;
    }
    if unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0 {
        modifiers |= MK_SHIFT;
    }
    modifiers
}

fn clamp_client_point(hwnd: HWND, point: InputPoint) -> InputPoint {
    let mut rect = windows::Win32::Foundation::RECT::default();
    if unsafe { GetClientRect(hwnd, &raw mut rect) }.is_err() {
        return point;
    }
    InputPoint::new(
        point
            .x
            .clamp(rect.left, rect.right.saturating_sub(1).max(rect.left)),
        point
            .y
            .clamp(rect.top, rect.bottom.saturating_sub(1).max(rect.top)),
    )
}

const fn mouse_key_state(buttons: u8, modifiers: u32) -> u32 {
    let mut state = modifiers & (MK_CONTROL | MK_SHIFT);
    if buttons & LEFT_BUTTON != 0 {
        state |= MK_LBUTTON;
    }
    if buttons & RIGHT_BUTTON != 0 {
        state |= MK_RBUTTON;
    }
    if buttons & MIDDLE_BUTTON != 0 {
        state |= MK_MBUTTON;
    }
    if buttons & EXTRA1_BUTTON != 0 {
        state |= MK_XBUTTON1;
    }
    if buttons & EXTRA2_BUTTON != 0 {
        state |= MK_XBUTTON2;
    }
    state
}

const fn high_word(value: u32) -> u16 {
    ((value >> 16) & 0xffff) as u16
}

const fn decode_point(lparam: u32) -> InputPoint {
    InputPoint::new(
        lparam as u16 as i16 as i32,
        (lparam >> 16) as u16 as i16 as i32,
    )
}

const fn encode_point(point: InputPoint) -> u32 {
    (point.x as i16 as u16 as u32) | ((point.y as i16 as u16 as u32) << 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hwnd() -> HWND {
        HWND(std::ptr::dangling_mut())
    }

    #[test]
    fn move_coalescing_never_crosses_a_button_barrier() {
        let mut state = PointerState::default();
        state.move_to(
            hwnd(),
            InputPoint::new(1, 2),
            0,
            encode_point(InputPoint::new(1, 2)),
        );
        state.move_to(
            hwnd(),
            InputPoint::new(3, 4),
            0,
            encode_point(InputPoint::new(3, 4)),
        );
        state.button(
            hwnd(),
            InputPoint::new(3, 4),
            PointerButton::Left,
            true,
            WM_LBUTTONDOWN,
            encode_point(InputPoint::new(3, 4)),
        );
        state.move_to(
            hwnd(),
            InputPoint::new(5, 6),
            MK_LBUTTON,
            encode_point(InputPoint::new(5, 6)),
        );

        let events = state.pending.into_iter().collect::<Vec<_>>();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].point, InputPoint::new(3, 4));
        assert!(matches!(
            events[1].kind,
            PointerEventKind::Button { down: true, .. }
        ));
        assert_eq!(events[2].point, InputPoint::new(5, 6));
    }

    #[test]
    fn repeated_raw_and_legacy_button_edges_are_deduplicated_by_state() {
        let mut state = PointerState::default();
        let point = InputPoint::new(-20, 30);
        let packed = encode_point(point);
        state.button(
            hwnd(),
            point,
            PointerButton::Left,
            true,
            WM_LBUTTONDOWN,
            packed,
        );
        state.button(
            hwnd(),
            point,
            PointerButton::Left,
            true,
            WM_LBUTTONDOWN,
            packed,
        );
        state.button(
            hwnd(),
            point,
            PointerButton::Left,
            false,
            WM_LBUTTONUP,
            packed,
        );
        state.button(
            hwnd(),
            point,
            PointerButton::Left,
            false,
            WM_LBUTTONUP,
            packed,
        );

        assert_eq!(state.pending.len(), 2);
        assert!(matches!(
            state.pending[0].kind,
            PointerEventKind::Button { down: true, .. }
        ));
        assert!(matches!(
            state.pending[1].kind,
            PointerEventKind::Button { down: false, .. }
        ));
    }

    #[test]
    fn wheel_preserves_signed_delta_and_screen_route_coordinates() {
        let mut state = PointerState::default();
        let point = InputPoint::new(10, -4);
        let screen_lparam = encode_point(InputPoint::new(400, 300));
        state.wheel(
            hwnd(),
            point,
            WheelSample {
                horizontal: false,
                delta: -120,
                route_lparam: screen_lparam,
                source: PointerSource::Legacy,
                message_time: 10,
            },
        );

        let event = state.pending.pop_front().unwrap();
        assert_eq!(event.point, point);
        assert_eq!(event.message, WM_MOUSEWHEEL);
        assert_eq!(high_word(event.wparam) as i16, -120);
        assert_eq!(event.lparam, screen_lparam);
        assert!(matches!(
            event.kind,
            PointerEventKind::Wheel {
                horizontal: 0.0,
                vertical: -1.0
            }
        ));
    }

    #[test]
    fn arming_and_disarming_consume_without_publishing_pointer_events() {
        let source = OwnedPointerInput::default();
        for phase in [INPUT_FILTER_ARMING, INPUT_FILTER_DISARMING] {
            source.set_phase(phase);
            let decision = source.handle(SynchronousWndProcEvent {
                hwnd: hwnd(),
                message: WM_LBUTTONDOWN,
                wparam: WPARAM(0),
                lparam: LPARAM(encode_point(InputPoint::new(2, 3)) as isize),
                raw_input: None,
            });
            assert!(matches!(
                decision,
                SynchronousWndProcDecision::Handled(LRESULT(0))
            ));
            assert!(source.drain().is_empty());
        }
    }

    #[test]
    fn owned_pointer_phases_publish_the_same_process_suppression_boundaries() {
        let process = Arc::new(ProcessMouseSuppression::new());
        let source = OwnedPointerInput::new(Arc::clone(&process));

        for (phase, expected) in [
            (INPUT_FILTER_ARMING, ProcessInputPhase::Arming),
            (INPUT_FILTER_ENABLED, ProcessInputPhase::Enabled),
            (INPUT_FILTER_DISARMING, ProcessInputPhase::Disarming),
            (INPUT_FILTER_DISABLED, ProcessInputPhase::Disabled),
        ] {
            source.set_phase(phase);
            assert_eq!(process.phase(), expected);
        }
        let neutral = process.frozen_point();
        assert_eq!(
            (neutral.x, neutral.y),
            (GAME_NEUTRAL_CURSOR_POINT.x, GAME_NEUTRAL_CURSOR_POINT.y)
        );
    }

    #[test]
    fn cancellation_publishes_every_held_button_release() {
        let mut state = PointerState::default();
        let point = InputPoint::new(20, 30);
        let packed = encode_point(point);
        state.button(
            hwnd(),
            point,
            PointerButton::Left,
            true,
            WM_LBUTTONDOWN,
            packed,
        );
        state.button(
            hwnd(),
            point,
            PointerButton::Right,
            true,
            WM_RBUTTONDOWN,
            packed,
        );

        state.cancel();

        assert_eq!(state.buttons, 0);
        assert_eq!(state.pending.len(), 2);
        assert!(state
            .pending
            .iter()
            .all(|event| matches!(event.kind, PointerEventKind::Button { down: false, .. })));
    }

    #[test]
    fn raw_relative_motion_advances_virtual_cursor_when_os_cursor_is_fixed() {
        let mut state = PointerState {
            point: Some(InputPoint::new(100, 80)),
            last_os_point: Some(InputPoint::new(50, 50)),
            ..PointerState::default()
        };
        OwnedPointerInput::capture_raw_mouse(
            &mut state,
            hwnd(),
            RawMouseInput {
                last_x: 7,
                last_y: -3,
                cursor_x: 50,
                cursor_y: 50,
                cursor_valid: true,
                ..RawMouseInput::default()
            },
        );

        assert_eq!(state.point, Some(InputPoint::new(107, 77)));
        assert_eq!(
            state.pending.back().unwrap().point,
            InputPoint::new(107, 77)
        );
    }

    #[test]
    fn physical_snapshot_reconciles_missing_down_and_up_edges() {
        let route = hwnd();
        let mut state = PointerState {
            window: Some(route.0 as usize),
            point: Some(InputPoint::new(12, 34)),
            ..PointerState::default()
        };

        assert_eq!(state.reconcile_physical_buttons(LEFT_BUTTON, 0), 1);
        assert_eq!(state.buttons, LEFT_BUTTON);
        assert!(matches!(
            state.pending.back().map(|event| event.kind),
            Some(PointerEventKind::Button {
                button: PointerButton::Left,
                down: true
            })
        ));

        assert_eq!(state.reconcile_physical_buttons(0, 0), 1);
        assert_eq!(state.buttons, 0);
        assert_eq!(state.pending.len(), 2);
        assert!(matches!(
            state.pending.back().map(|event| event.kind),
            Some(PointerEventKind::Button {
                button: PointerButton::Left,
                down: false
            })
        ));
    }

    #[test]
    fn physical_snapshot_preserves_a_short_click_between_render_boundaries() {
        let route = hwnd();
        let mut state = PointerState {
            window: Some(route.0 as usize),
            point: Some(InputPoint::new(12, 34)),
            ..PointerState::default()
        };

        assert_eq!(state.reconcile_physical_buttons(0, LEFT_BUTTON), 2);
        assert_eq!(state.buttons, 0);
        assert!(matches!(
            state.pending.front().map(|event| event.kind),
            Some(PointerEventKind::Button {
                button: PointerButton::Left,
                down: true
            })
        ));
        assert!(matches!(
            state.pending.back().map(|event| event.kind),
            Some(PointerEventKind::Button {
                button: PointerButton::Left,
                down: false
            })
        ));
    }

    #[test]
    fn physical_snapshot_does_not_duplicate_queued_real_click_edges() {
        let route = hwnd();
        let point = InputPoint::new(12, 34);
        let mut state = PointerState {
            window: Some(route.0 as usize),
            point: Some(point),
            ..PointerState::default()
        };
        let lparam = encode_point(point);
        state.button(
            route,
            point,
            PointerButton::Left,
            true,
            WM_LBUTTONDOWN,
            lparam,
        );
        state.button(
            route,
            point,
            PointerButton::Left,
            false,
            WM_LBUTTONUP,
            lparam,
        );

        assert_eq!(state.reconcile_physical_buttons(0, LEFT_BUTTON), 0);
        assert_eq!(state.pending.len(), 2);
        assert!(matches!(
            state.pending.front().map(|event| event.kind),
            Some(PointerEventKind::Button { down: true, .. })
        ));
        assert!(matches!(
            state.pending.back().map(|event| event.kind),
            Some(PointerEventKind::Button { down: false, .. })
        ));
    }

    #[test]
    fn pipeline_binding_sets_buffered_input_target_before_messages() {
        let source = OwnedPointerInput::default();
        let route = hwnd();

        SynchronousWndProcHandler::bind_target_window(&source, route);

        assert_eq!(source.target_window().map(|window| window.0), Some(route.0));
    }

    #[test]
    fn activation_seed_bootstraps_buffered_only_pointer_route() {
        let source = OwnedPointerInput::default();
        let route = hwnd();
        let point = InputPoint::new(31, 47);

        source.set_phase_with_seed(INPUT_FILTER_ENABLED, Some((route, point)));

        let state = source
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(state.window, Some(route.0 as usize));
        assert_eq!(state.point, Some(point));
        assert_eq!(state.last_os_point, Some(point));
        assert!(state.pending.is_empty());
        assert!(source.pointer_route_ready.load(Ordering::Acquire));
    }

    #[test]
    fn buffered_relative_input_uses_activation_seed_before_any_wndproc_move() {
        let source = OwnedPointerInput::default();
        let route = hwnd();
        source.set_phase_with_seed(
            INPUT_FILTER_ENABLED,
            Some((route, InputPoint::new(100, 80))),
        );

        source.handle_process_raw_mouse(RawMouseInput {
            last_x: 7,
            last_y: -3,
            ..RawMouseInput::default()
        });

        let events = source.drain();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].point, InputPoint::new(107, 77));
        assert!(matches!(events[0].kind, PointerEventKind::Move));
    }

    #[test]
    fn absolute_buffered_input_uses_unfiltered_client_cursor_sample() {
        let input = with_buffered_cursor_sample(
            RawMouseInput {
                flags: MOUSE_MOVE_ABSOLUTE.0,
                last_x: 65_535,
                last_y: 32_768,
                ..RawMouseInput::default()
            },
            Some(InputPoint::new(222, 111)),
        );

        assert!(input.cursor_valid);
        assert_eq!((input.cursor_x, input.cursor_y), (222, 111));
    }

    #[test]
    fn raw_buffer_owner_reconciliation_uses_only_high_bit_state() {
        let route = hwnd();
        let mut state = PointerState {
            window: Some(route.0 as usize),
            point: Some(InputPoint::new(12, 34)),
            ..PointerState::default()
        };

        // The low-bit click hint is deliberately not passed by the owner.
        assert_eq!(state.reconcile_physical_buttons(0, 0), 0);
        assert_eq!(state.reconcile_physical_buttons(LEFT_BUTTON, 0), 1);
        assert_eq!(state.buttons, LEFT_BUTTON);
    }

    #[test]
    fn buffered_callback_rechecks_phase_after_taking_pointer_lock() {
        let source = OwnedPointerInput::default();
        let route = hwnd();
        source.set_phase_with_seed(INPUT_FILTER_ENABLED, Some((route, InputPoint::new(10, 20))));
        source.set_phase_with_seed(INPUT_FILTER_DISARMING, None);
        source.handle_process_raw_mouse(RawMouseInput {
            last_x: 5,
            last_y: 6,
            button_flags: RI_MOUSE_LEFT_BUTTON_DOWN as u16,
            ..RawMouseInput::default()
        });

        assert!(source.drain().is_empty());
    }

    #[test]
    fn modified_button_keeps_ctrl_and_shift_in_electron_wparam() {
        let mut state = PointerState {
            modifiers: MK_CONTROL | MK_SHIFT,
            ..PointerState::default()
        };
        let point = InputPoint::new(4, 5);
        state.button(
            hwnd(),
            point,
            PointerButton::Left,
            true,
            WM_LBUTTONDOWN,
            encode_point(point),
        );

        let event = state.pending.back().unwrap();
        assert_eq!(
            event.wparam & (MK_LBUTTON | MK_CONTROL | MK_SHIFT),
            MK_LBUTTON | MK_CONTROL | MK_SHIFT
        );
    }

    #[test]
    fn focus_loss_then_disarming_preserves_imgui_release() {
        let source = OwnedPointerInput::default();
        source.set_phase(INPUT_FILTER_ENABLED);
        let point = InputPoint::new(8, 9);
        source.handle(SynchronousWndProcEvent {
            hwnd: hwnd(),
            message: WM_LBUTTONDOWN,
            wparam: WPARAM(0),
            lparam: LPARAM(encode_point(point) as isize),
            raw_input: None,
        });
        assert!(matches!(
            source.drain().as_slice(),
            [OwnedPointerEvent {
                kind: PointerEventKind::Button { down: true, .. },
                ..
            }]
        ));

        source.handle(SynchronousWndProcEvent {
            hwnd: hwnd(),
            message: WM_KILLFOCUS,
            wparam: WPARAM(0),
            lparam: LPARAM(0),
            raw_input: None,
        });
        source.set_phase(INPUT_FILTER_DISARMING);

        assert!(matches!(
            source.drain().as_slice(),
            [OwnedPointerEvent {
                kind: PointerEventKind::Button { down: false, .. },
                ..
            }]
        ));
    }
}
