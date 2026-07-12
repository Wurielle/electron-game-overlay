//! Synchronous Win32 input observation at the replacement window procedure.
//!
//! `WM_INPUT` contains an opaque handle whose data is only guaranteed while
//! the receiving window procedure is handling the message. These owned types
//! let render-loop integrations copy the useful data before queuing work for a
//! later render frame.

use std::ffi::c_void;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Input::{
    GetRawInputData, HRAWINPUT, RAWINPUT, RAWINPUTHEADER, RID_DEVICE_INFO_TYPE, RID_INPUT,
    RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
};

/// An owned subset of one raw mouse packet.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RawMouseInput {
    /// Raw mouse motion flags, including absolute/relative mode.
    pub flags: u16,
    /// Raw button transition and wheel flags.
    pub button_flags: u16,
    /// Wheel or other button-associated data.
    pub button_data: u16,
    /// Horizontal motion value or delta.
    pub last_x: i32,
    /// Vertical motion value or delta.
    pub last_y: i32,
    /// Absolute target-client cursor X captured with the raw packet.
    pub cursor_x: i32,
    /// Absolute target-client cursor Y captured with the raw packet.
    pub cursor_y: i32,
    /// Whether `cursor_x` and `cursor_y` contain a valid point.
    pub cursor_valid: bool,
}

/// An owned subset of one raw keyboard packet.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RawKeyboardInput {
    /// Hardware scan code.
    pub make_code: u16,
    /// Raw keyboard flags such as break and extended-key markers.
    pub flags: u16,
    /// Virtual-key code supplied by Win32.
    pub virtual_key: u16,
    /// Associated keyboard window message.
    pub message: u32,
}

/// Raw input copied synchronously from a `WM_INPUT` handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawInputData {
    /// Mouse input.
    Mouse(RawMouseInput),
    /// Keyboard input.
    Keyboard(RawKeyboardInput),
    /// A raw HID packet not interpreted by hudhook.
    Other,
}

/// One message observed synchronously by hudhook's replacement WndProc.
#[derive(Clone, Copy, Debug)]
pub struct SynchronousWndProcEvent {
    /// Window receiving the message.
    pub hwnd: HWND,
    /// Win32 message identifier.
    pub message: u32,
    /// Message `wParam`.
    pub wparam: WPARAM,
    /// Message `lParam`.
    pub lparam: LPARAM,
    /// Owned raw input when `message` is `WM_INPUT` and copying succeeded.
    pub raw_input: Option<RawInputData>,
}

/// Propagation decision returned by a synchronous WndProc handler.
#[derive(Clone, Copy, Debug)]
pub enum SynchronousWndProcDecision {
    /// Defer to hudhook's normal render-thread queue and published filter path.
    Forward,
    /// Consume the message and return the supplied result. Foreground
    /// `WM_INPUT` still receives mandatory `DefWindowProcW` cleanup.
    Handled(LRESULT),
    /// Consume the message through `DefWindowProcW`, used for `WM_INPUT`
    /// foreground-packet cleanup.
    HandledByDefWindowProc,
}

/// Thread-safe observer invoked inside the real replacement WndProc.
///
/// Implementations must remain fast and must not touch the mutable ImGui
/// context. They should copy or normalize input into their own synchronized
/// queue and consume only messages for which they own propagation.
pub trait SynchronousWndProcHandler: Send + Sync {
    /// Bind the window whose replacement procedure owns this handler.
    ///
    /// Hudhook calls this before installing the replacement procedure so
    /// process-wide input sources without an HWND can route their first packet.
    fn bind_target_window(&self, _hwnd: HWND) {}

    /// Observe and optionally consume one synchronous window message.
    fn handle(&self, event: SynchronousWndProcEvent) -> SynchronousWndProcDecision;
}

pub(crate) fn copy_raw_input(hwnd: HWND, lparam: LPARAM) -> Option<RawInputData> {
    let mut raw_data = RAWINPUT::default();
    let mut raw_data_size = std::mem::size_of::<RAWINPUT>() as u32;
    let header_size = std::mem::size_of::<RAWINPUTHEADER>() as u32;
    let copied = unsafe {
        GetRawInputData(
            HRAWINPUT(lparam.0 as *mut c_void),
            RID_INPUT,
            Some(&raw mut raw_data as *mut c_void),
            &mut raw_data_size,
            header_size,
        )
    };
    if copied == u32::MAX {
        return None;
    }

    match RID_DEVICE_INFO_TYPE(raw_data.header.dwType) {
        RIM_TYPEMOUSE => {
            let mouse = unsafe { raw_data.data.mouse };
            let buttons = unsafe { mouse.Anonymous.Anonymous };
            let mut cursor = POINT::default();
            let cursor_valid = unsafe {
                crate::process_input::get_cursor_pos_unfiltered(&raw mut cursor).as_bool()
                    && ScreenToClient(hwnd, &raw mut cursor).as_bool()
            };
            Some(RawInputData::Mouse(RawMouseInput {
                flags: mouse.usFlags.0,
                button_flags: buttons.usButtonFlags,
                button_data: buttons.usButtonData,
                last_x: mouse.lLastX,
                last_y: mouse.lLastY,
                cursor_x: cursor.x,
                cursor_y: cursor.y,
                cursor_valid,
            }))
        }
        RIM_TYPEKEYBOARD => {
            let keyboard = unsafe { raw_data.data.keyboard };
            Some(RawInputData::Keyboard(RawKeyboardInput {
                make_code: keyboard.MakeCode,
                flags: keyboard.Flags,
                virtual_key: keyboard.VKey,
                message: keyboard.Message,
            }))
        }
        _ => Some(RawInputData::Other),
    }
}
