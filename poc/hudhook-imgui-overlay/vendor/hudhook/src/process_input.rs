//! Process-wide Win32 mouse polling and buffered-input suppression.
//!
//! Games can observe mouse buttons and the cursor through User32 polling APIs
//! even after their window messages have been consumed. This module provides a
//! small atomic policy object and a MinHook hook set that can hide those values
//! while an overlay owns input. Hook callbacks call the real User32 function
//! first, then apply the published policy to its result.

use std::ffi::c_void;
use std::mem;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock, RwLock, Weak};

use windows::core::{s, w, BOOL, PCSTR};
use windows::Win32::Foundation::{HANDLE, HMODULE, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::Input::{RAWINPUT, RAWINPUTHEADER, RAWMOUSE, RIM_TYPEMOUSE};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, RIM_INPUTSINK};

use crate::mh::{MhHook, MH_STATUS};
use crate::sync_input::RawMouseInput;
use crate::{Hooks, ImguiRenderLoop};

const VK_LBUTTON: i32 = 0x01;
const VK_RBUTTON: i32 = 0x02;
const VK_MBUTTON: i32 = 0x04;
const VK_XBUTTON1: i32 = 0x05;
const VK_XBUTTON2: i32 = 0x06;
const MOUSE_VIRTUAL_KEYS: [i32; 5] = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2];

/// Bit representing the physical left mouse button in a snapshot mask.
pub const PHYSICAL_MOUSE_LEFT_BUTTON: u8 = 1 << 0;
/// Bit representing the physical right mouse button in a snapshot mask.
pub const PHYSICAL_MOUSE_RIGHT_BUTTON: u8 = 1 << 1;
/// Bit representing the physical middle mouse button in a snapshot mask.
pub const PHYSICAL_MOUSE_MIDDLE_BUTTON: u8 = 1 << 2;
/// Bit representing physical mouse X button 1 in a snapshot mask.
pub const PHYSICAL_MOUSE_X1_BUTTON: u8 = 1 << 3;
/// Bit representing physical mouse X button 2 in a snapshot mask.
pub const PHYSICAL_MOUSE_X2_BUTTON: u8 = 1 << 4;

const PHYSICAL_MOUSE_BUTTONS: [(i32, u8); 5] = [
    (VK_LBUTTON, PHYSICAL_MOUSE_LEFT_BUTTON),
    (VK_RBUTTON, PHYSICAL_MOUSE_RIGHT_BUTTON),
    (VK_MBUTTON, PHYSICAL_MOUSE_MIDDLE_BUTTON),
    (VK_XBUTTON1, PHYSICAL_MOUSE_X1_BUTTON),
    (VK_XBUTTON2, PHYSICAL_MOUSE_X2_BUTTON),
];

type GetAsyncKeyStateFn = unsafe extern "system" fn(i32) -> i16;
type GetKeyStateFn = unsafe extern "system" fn(i32) -> i16;
type GetKeyboardStateFn = unsafe extern "system" fn(*mut u8) -> BOOL;
type GetCursorPosFn = unsafe extern "system" fn(*mut POINT) -> BOOL;
type GetRawInputBufferFn = unsafe extern "system" fn(*mut RAWINPUT, *mut u32, u32) -> u32;

static PROCESS_MOUSE_SUPPRESSION: OnceLock<Arc<ProcessMouseSuppression>> = OnceLock::new();
static GET_ASYNC_KEY_STATE_ORIGINAL: OnceLock<GetAsyncKeyStateFn> = OnceLock::new();
static GET_KEY_STATE_ORIGINAL: OnceLock<GetKeyStateFn> = OnceLock::new();
static GET_KEYBOARD_STATE_ORIGINAL: OnceLock<GetKeyboardStateFn> = OnceLock::new();
static GET_CURSOR_POS_ORIGINAL: OnceLock<GetCursorPosFn> = OnceLock::new();
static GET_RAW_INPUT_BUFFER_ORIGINAL: OnceLock<GetRawInputBufferFn> = OnceLock::new();

/// Input-filter phase shared between the render boundary and process hooks.
///
/// Mouse state remains hidden during both transition phases so the game cannot
/// observe an edge in the guarded queue-drain windows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum ProcessInputPhase {
    /// User32 results pass through unchanged.
    #[default]
    Disabled = 0,
    /// Input is being armed and results are already hidden.
    Arming = 1,
    /// Overlay input ownership is effective.
    Enabled = 2,
    /// Input is being released and remains hidden until the final boundary.
    Disarming = 3,
}

impl ProcessInputPhase {
    const fn from_atomic(value: u8) -> Self {
        match value {
            1 => Self::Arming,
            2 => Self::Enabled,
            3 => Self::Disarming,
            _ => Self::Disabled,
        }
    }

    const fn suppresses_mouse(self) -> bool {
        !matches!(self, Self::Disabled)
    }
}

/// Unfiltered physical state for the five Win32 mouse virtual keys.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PhysicalMouseButtonSnapshot {
    /// Buttons currently held, using the `PHYSICAL_MOUSE_*_BUTTON` bit masks.
    pub down: u8,
    /// Buttons pressed since the previous Win32 query, using the same masks.
    pub pressed_since_last: u8,
}

/// Receives original buffered raw-mouse records before game-facing masking.
pub trait ProcessRawMouseHandler: Send + Sync {
    /// Handles one mouse record returned by the original `GetRawInputBuffer`.
    fn handle_process_raw_mouse(&self, input: RawMouseInput);
}

/// Call and masking totals for one hooked User32 API.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProcessInputApiCounters {
    /// Number of calls observed by the detour.
    pub calls: u64,
    /// Number of calls whose returned mouse state was hidden.
    pub masked: u64,
}

/// Snapshot of process-wide mouse polling diagnostics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProcessInputCounters {
    /// `GetAsyncKeyState` totals.
    pub get_async_key_state: ProcessInputApiCounters,
    /// `GetKeyState` totals.
    pub get_key_state: ProcessInputApiCounters,
    /// `GetKeyboardState` totals.
    pub get_keyboard_state: ProcessInputApiCounters,
    /// `GetCursorPos` totals.
    pub get_cursor_pos: ProcessInputApiCounters,
    /// `GetRawInputBuffer` totals.
    pub get_raw_input_buffer: ProcessInputApiCounters,
}

#[derive(Default)]
struct AtomicApiCounters {
    calls: AtomicU64,
    masked: AtomicU64,
}

impl AtomicApiCounters {
    fn record(&self, masked: bool) {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if masked {
            self.masked.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn snapshot(&self) -> ProcessInputApiCounters {
        ProcessInputApiCounters {
            calls: self.calls.load(Ordering::Relaxed),
            masked: self.masked.load(Ordering::Relaxed),
        }
    }
}

/// Atomic policy used by the process-wide User32 input hooks.
pub struct ProcessMouseSuppression {
    phase: AtomicU8,
    frozen_point: AtomicU64,
    frozen_point_valid: AtomicBool,
    get_async_key_state: AtomicApiCounters,
    get_key_state: AtomicApiCounters,
    get_keyboard_state: AtomicApiCounters,
    get_cursor_pos: AtomicApiCounters,
    get_raw_input_buffer: AtomicApiCounters,
    raw_mouse_handler: RwLock<Option<Weak<dyn ProcessRawMouseHandler>>>,
}

impl Default for ProcessMouseSuppression {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessMouseSuppression {
    /// Creates a disabled policy with a frozen point at the origin.
    pub const fn new() -> Self {
        Self {
            phase: AtomicU8::new(ProcessInputPhase::Disabled as u8),
            frozen_point: AtomicU64::new(pack_point(POINT { x: 0, y: 0 })),
            frozen_point_valid: AtomicBool::new(false),
            get_async_key_state: AtomicApiCounters {
                calls: AtomicU64::new(0),
                masked: AtomicU64::new(0),
            },
            get_key_state: AtomicApiCounters {
                calls: AtomicU64::new(0),
                masked: AtomicU64::new(0),
            },
            get_keyboard_state: AtomicApiCounters {
                calls: AtomicU64::new(0),
                masked: AtomicU64::new(0),
            },
            get_cursor_pos: AtomicApiCounters {
                calls: AtomicU64::new(0),
                masked: AtomicU64::new(0),
            },
            get_raw_input_buffer: AtomicApiCounters {
                calls: AtomicU64::new(0),
                masked: AtomicU64::new(0),
            },
            raw_mouse_handler: RwLock::new(None),
        }
    }

    /// Creates a disabled policy with the supplied initial frozen point.
    pub fn with_frozen_point(point: POINT) -> Self {
        let state = Self::new();
        state.set_frozen_point(point);
        state
    }

    /// Publishes the phase used by every process-input detour.
    pub fn set_phase(&self, phase: ProcessInputPhase) {
        self.phase.store(phase as u8, Ordering::Release);
    }

    /// Returns the currently published phase.
    pub fn phase(&self) -> ProcessInputPhase {
        ProcessInputPhase::from_atomic(self.phase.load(Ordering::Acquire))
    }

    /// Atomically replaces the screen point returned while suppression is active.
    pub fn set_frozen_point(&self, point: POINT) {
        self.frozen_point
            .store(pack_point(point), Ordering::Release);
        self.frozen_point_valid.store(true, Ordering::Release);
    }

    /// Returns the currently published frozen screen point.
    pub fn frozen_point(&self) -> POINT {
        unpack_point(self.frozen_point.load(Ordering::Acquire))
    }

    /// Publishes a frozen point before enabling effective suppression.
    pub fn enable_at(&self, point: POINT) {
        self.set_frozen_point(point);
        self.set_phase(ProcessInputPhase::Enabled);
    }

    /// Installs a weak buffered raw-mouse observer without creating an Arc cycle.
    pub fn set_raw_mouse_handler(&self, handler: Weak<dyn ProcessRawMouseHandler>) {
        *self
            .raw_mouse_handler
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handler);
    }

    /// Samples physical mouse buttons without passing through the masking detour.
    pub fn physical_mouse_buttons(&self) -> PhysicalMouseButtonSnapshot {
        let _ejection_guard = crate::hook_ejection_guard();
        physical_mouse_buttons_from(|virtual_key| unsafe {
            GET_ASYNC_KEY_STATE_ORIGINAL.get().map_or_else(
                || GetAsyncKeyState(virtual_key),
                |original| original(virtual_key),
            )
        })
    }

    /// Returns a consistent-enough diagnostic snapshot of monotonic counters.
    pub fn counters(&self) -> ProcessInputCounters {
        ProcessInputCounters {
            get_async_key_state: self.get_async_key_state.snapshot(),
            get_key_state: self.get_key_state.snapshot(),
            get_keyboard_state: self.get_keyboard_state.snapshot(),
            get_cursor_pos: self.get_cursor_pos.snapshot(),
            get_raw_input_buffer: self.get_raw_input_buffer.snapshot(),
        }
    }

    fn suppresses_mouse(&self) -> bool {
        self.phase().suppresses_mouse()
    }

    fn filter_async_key_state(&self, virtual_key: i32, original: i16) -> i16 {
        let masked = self.suppresses_mouse() && is_mouse_virtual_key(virtual_key);
        self.get_async_key_state.record(masked);
        if masked {
            0
        } else {
            original
        }
    }

    fn filter_key_state(&self, virtual_key: i32, original: i16) -> i16 {
        let masked = self.suppresses_mouse() && is_mouse_virtual_key(virtual_key);
        self.get_key_state.record(masked);
        if masked {
            0
        } else {
            original
        }
    }

    unsafe fn filter_keyboard_state(&self, key_state: *mut u8, succeeded: bool) {
        let masked = succeeded && !key_state.is_null() && self.suppresses_mouse();
        self.get_keyboard_state.record(masked);
        if !masked {
            return;
        }

        for virtual_key in MOUSE_VIRTUAL_KEYS {
            // SAFETY: GetKeyboardState succeeded for the caller-provided
            // 256-byte buffer, and every mouse virtual-key index is in range.
            unsafe { *key_state.add(virtual_key as usize) = 0 };
        }
    }

    unsafe fn filter_cursor_pos(&self, point: *mut POINT, succeeded: bool) {
        let masked = succeeded
            && !point.is_null()
            && self.suppresses_mouse()
            && self.frozen_point_valid.load(Ordering::Acquire);
        self.get_cursor_pos.record(masked);
        if masked {
            // SAFETY: GetCursorPos succeeded for the caller-provided POINT.
            unsafe { point.write(self.frozen_point()) };
        }
    }

    unsafe fn filter_raw_input_buffer(
        &self,
        data: *mut RAWINPUT,
        buffer_size: usize,
        block_count: u32,
    ) {
        // Keep this game-facing neutralization aligned with ReShade's maintained
        // Win32 input path (Copyright (C) 2014 Patrick Mours, BSD-3-Clause):
        // https://github.com/crosire/reshade/blob/main/source/input_windows.cpp
        // ReShade likewise marks mouse records as input-sink data and zeros the
        // RAWMOUSE payload while its overlay owns input.
        let mut masked = false;
        if block_count == u32::MAX
            || block_count == 0
            || data.is_null()
            || buffer_size == 0
            || !self.suppresses_mouse()
        {
            self.get_raw_input_buffer.record(false);
            return;
        }

        let bytes = data.cast::<u8>();
        let header_size = mem::size_of::<RAWINPUTHEADER>();
        let mut offset = 0usize;
        for index in 0..block_count {
            let Some(header_end) = offset.checked_add(header_size) else {
                break;
            };
            if header_end > buffer_size {
                break;
            }

            let header_ptr = unsafe { bytes.add(offset).cast::<RAWINPUTHEADER>() };
            let mut header = unsafe { ptr::read_unaligned(header_ptr) };
            let block_size = header.dwSize as usize;
            let Some(block_end) = offset.checked_add(block_size) else {
                break;
            };
            if block_size < header_size || block_end > buffer_size {
                break;
            }

            if header.dwType == RIM_TYPEMOUSE.0 {
                if block_size >= header_size + mem::size_of::<RAWMOUSE>() {
                    let mouse =
                        unsafe { ptr::read_unaligned(bytes.add(header_end).cast::<RAWMOUSE>()) };
                    self.publish_raw_mouse(mouse);
                }

                header.hDevice = HANDLE::default();
                header.wParam = WPARAM(RIM_INPUTSINK as usize);
                unsafe {
                    ptr::write_unaligned(header_ptr, header);
                    ptr::write_bytes(bytes.add(header_end), 0, block_size - header_size);
                }
                masked = true;
            }

            if index + 1 < block_count {
                let Some(next_offset) = next_raw_input_block_offset(bytes, block_end) else {
                    break;
                };
                if next_offset <= offset || next_offset > buffer_size {
                    break;
                }
                offset = next_offset;
            }
        }
        self.get_raw_input_buffer.record(masked);
    }

    fn publish_raw_mouse(&self, mouse: RAWMOUSE) {
        let handler = self
            .raw_mouse_handler
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .and_then(Weak::upgrade);
        let Some(handler) = handler else {
            return;
        };
        let buttons = unsafe { mouse.Anonymous.Anonymous };
        handler.handle_process_raw_mouse(RawMouseInput {
            flags: mouse.usFlags.0,
            button_flags: buttons.usButtonFlags,
            button_data: buttons.usButtonData,
            last_x: mouse.lLastX,
            last_y: mouse.lLastY,
            cursor_x: 0,
            cursor_y: 0,
            cursor_valid: false,
        });
    }
}

/// Calls the real `GetCursorPos` implementation without applying suppression.
///
/// # Safety
///
/// `point` must satisfy the Win32 `GetCursorPos` pointer contract.
pub unsafe fn get_cursor_pos_unfiltered(point: *mut POINT) -> BOOL {
    let _ejection_guard = crate::hook_ejection_guard();
    if let Some(original) = GET_CURSOR_POS_ORIGINAL.get() {
        unsafe { original(point) }
    } else if unsafe { GetCursorPos(point) }.is_ok() {
        BOOL(1)
    } else {
        BOOL(0)
    }
}

fn physical_mouse_buttons_from(mut query: impl FnMut(i32) -> i16) -> PhysicalMouseButtonSnapshot {
    let mut snapshot = PhysicalMouseButtonSnapshot::default();
    for (virtual_key, mask) in PHYSICAL_MOUSE_BUTTONS {
        let state = query(virtual_key) as u16;
        if state & 0x8000 != 0 {
            snapshot.down |= mask;
        }
        if state & 0x0001 != 0 {
            snapshot.pressed_since_last |= mask;
        }
    }
    snapshot
}

fn next_raw_input_block_offset(base: *const u8, block_end_offset: usize) -> Option<usize> {
    const RAW_INPUT_BLOCK_ALIGNMENT: usize = mem::size_of::<u64>();

    let base_address = base as usize;
    let block_end_address = base_address.checked_add(block_end_offset)?;
    let aligned_address = block_end_address.checked_add(RAW_INPUT_BLOCK_ALIGNMENT - 1)?
        & !(RAW_INPUT_BLOCK_ALIGNMENT - 1);
    aligned_address.checked_sub(base_address)
}

const fn is_mouse_virtual_key(virtual_key: i32) -> bool {
    matches!(
        virtual_key,
        VK_LBUTTON | VK_RBUTTON | VK_MBUTTON | VK_XBUTTON1 | VK_XBUTTON2
    )
}

const fn pack_point(point: POINT) -> u64 {
    (point.x as u32 as u64) | ((point.y as u32 as u64) << 32)
}

const fn unpack_point(packed: u64) -> POINT {
    POINT {
        x: packed as u32 as i32,
        y: (packed >> 32) as u32 as i32,
    }
}

unsafe extern "system" fn get_async_key_state_detour(virtual_key: i32) -> i16 {
    let _ejection_guard = crate::hook_ejection_guard();
    // SAFETY: The trampoline and state are published before MinHook enables
    // this detour and remain published for the process lifetime.
    let original = unsafe { *GET_ASYNC_KEY_STATE_ORIGINAL.get().unwrap_unchecked() };
    let result = unsafe { original(virtual_key) };
    let state = unsafe { PROCESS_MOUSE_SUPPRESSION.get().unwrap_unchecked() };
    state.filter_async_key_state(virtual_key, result)
}

unsafe extern "system" fn get_key_state_detour(virtual_key: i32) -> i16 {
    let _ejection_guard = crate::hook_ejection_guard();
    // SAFETY: See get_async_key_state_detour.
    let original = unsafe { *GET_KEY_STATE_ORIGINAL.get().unwrap_unchecked() };
    let result = unsafe { original(virtual_key) };
    let state = unsafe { PROCESS_MOUSE_SUPPRESSION.get().unwrap_unchecked() };
    state.filter_key_state(virtual_key, result)
}

unsafe extern "system" fn get_keyboard_state_detour(key_state: *mut u8) -> BOOL {
    let _ejection_guard = crate::hook_ejection_guard();
    // SAFETY: See get_async_key_state_detour. The original API owns validation
    // of the caller-provided buffer and is always invoked before masking.
    let original = unsafe { *GET_KEYBOARD_STATE_ORIGINAL.get().unwrap_unchecked() };
    let result = unsafe { original(key_state) };
    let state = unsafe { PROCESS_MOUSE_SUPPRESSION.get().unwrap_unchecked() };
    unsafe { state.filter_keyboard_state(key_state, result.as_bool()) };
    result
}

unsafe extern "system" fn get_cursor_pos_detour(point: *mut POINT) -> BOOL {
    let _ejection_guard = crate::hook_ejection_guard();
    // SAFETY: See get_async_key_state_detour. The original API owns validation
    // of the caller-provided pointer and is always invoked before masking.
    let original = unsafe { *GET_CURSOR_POS_ORIGINAL.get().unwrap_unchecked() };
    let result = unsafe { original(point) };
    let state = unsafe { PROCESS_MOUSE_SUPPRESSION.get().unwrap_unchecked() };
    unsafe { state.filter_cursor_pos(point, result.as_bool()) };
    result
}

unsafe extern "system" fn get_raw_input_buffer_detour(
    data: *mut RAWINPUT,
    buffer_size: *mut u32,
    header_size: u32,
) -> u32 {
    let _ejection_guard = crate::hook_ejection_guard();
    // SAFETY: See get_async_key_state_detour. The original API validates the
    // caller-owned buffer before the bounded post-processing pass below.
    let original = unsafe { *GET_RAW_INPUT_BUFFER_ORIGINAL.get().unwrap_unchecked() };
    let result = unsafe { original(data, buffer_size, header_size) };
    let returned_buffer_size = if buffer_size.is_null() {
        0
    } else {
        unsafe { *buffer_size as usize }
    };
    let state = unsafe { PROCESS_MOUSE_SUPPRESSION.get().unwrap_unchecked() };
    unsafe { state.filter_raw_input_buffer(data, returned_buffer_size, result) };
    result
}

/// MinHook hook set for process-wide User32 mouse input APIs.
pub struct ProcessInputHooks {
    hooks: [MhHook; 5],
    state: Arc<ProcessMouseSuppression>,
}

impl ProcessInputHooks {
    /// Creates all five hooks without enabling them.
    ///
    /// MinHook must already be initialized, and only one instance may be
    /// created in a process. [`Hudhook::apply`](crate::Hudhook::apply) enables
    /// the returned hook set together with the graphics hooks.
    pub fn new(state: Arc<ProcessMouseSuppression>) -> std::result::Result<Box<Self>, MH_STATUS> {
        if PROCESS_MOUSE_SUPPRESSION.get().is_some()
            || GET_ASYNC_KEY_STATE_ORIGINAL.get().is_some()
            || GET_KEY_STATE_ORIGINAL.get().is_some()
            || GET_KEYBOARD_STATE_ORIGINAL.get().is_some()
            || GET_CURSOR_POS_ORIGINAL.get().is_some()
            || GET_RAW_INPUT_BUFFER_ORIGINAL.get().is_some()
        {
            return Err(MH_STATUS::MH_ERROR_ALREADY_CREATED);
        }

        let user32 = unsafe { GetModuleHandleW(w!("user32.dll")) }
            .map_err(|_| MH_STATUS::MH_ERROR_MODULE_NOT_FOUND)?;
        let targets = User32Targets::resolve(user32)?;

        let get_async_key_state = unsafe {
            MhHook::new(
                targets.get_async_key_state,
                get_async_key_state_detour as *const () as *mut c_void,
            )?
        };
        let get_key_state = unsafe {
            MhHook::new(
                targets.get_key_state,
                get_key_state_detour as *const () as *mut c_void,
            )?
        };
        let get_keyboard_state = unsafe {
            MhHook::new(
                targets.get_keyboard_state,
                get_keyboard_state_detour as *const () as *mut c_void,
            )?
        };
        let get_cursor_pos = unsafe {
            MhHook::new(
                targets.get_cursor_pos,
                get_cursor_pos_detour as *const () as *mut c_void,
            )?
        };
        let get_raw_input_buffer = unsafe {
            MhHook::new(
                targets.get_raw_input_buffer,
                get_raw_input_buffer_detour as *const () as *mut c_void,
            )?
        };

        // SAFETY: Each target is a resolved User32 export with the exact ABI of
        // its corresponding function-pointer alias.
        let async_original = unsafe {
            mem::transmute::<*mut c_void, GetAsyncKeyStateFn>(get_async_key_state.trampoline())
        };
        let key_original =
            unsafe { mem::transmute::<*mut c_void, GetKeyStateFn>(get_key_state.trampoline()) };
        let keyboard_original = unsafe {
            mem::transmute::<*mut c_void, GetKeyboardStateFn>(get_keyboard_state.trampoline())
        };
        let cursor_original =
            unsafe { mem::transmute::<*mut c_void, GetCursorPosFn>(get_cursor_pos.trampoline()) };
        let raw_input_buffer_original = unsafe {
            mem::transmute::<*mut c_void, GetRawInputBufferFn>(get_raw_input_buffer.trampoline())
        };

        GET_ASYNC_KEY_STATE_ORIGINAL
            .set(async_original)
            .map_err(|_| MH_STATUS::MH_ERROR_ALREADY_CREATED)?;
        GET_KEY_STATE_ORIGINAL
            .set(key_original)
            .map_err(|_| MH_STATUS::MH_ERROR_ALREADY_CREATED)?;
        GET_KEYBOARD_STATE_ORIGINAL
            .set(keyboard_original)
            .map_err(|_| MH_STATUS::MH_ERROR_ALREADY_CREATED)?;
        GET_CURSOR_POS_ORIGINAL
            .set(cursor_original)
            .map_err(|_| MH_STATUS::MH_ERROR_ALREADY_CREATED)?;
        GET_RAW_INPUT_BUFFER_ORIGINAL
            .set(raw_input_buffer_original)
            .map_err(|_| MH_STATUS::MH_ERROR_ALREADY_CREATED)?;
        PROCESS_MOUSE_SUPPRESSION
            .set(Arc::clone(&state))
            .map_err(|_| MH_STATUS::MH_ERROR_ALREADY_CREATED)?;

        Ok(Box::new(Self {
            hooks: [
                get_async_key_state,
                get_key_state,
                get_keyboard_state,
                get_cursor_pos,
                get_raw_input_buffer,
            ],
            state,
        }))
    }
}

impl Hooks for ProcessInputHooks {
    fn from_render_loop<T>(_render_loop: T) -> Box<Self>
    where
        Self: Sized,
        T: ImguiRenderLoop + Send + Sync + 'static,
    {
        Self::new(Arc::new(ProcessMouseSuppression::new()))
            .expect("failed to create process input hooks")
    }

    fn hooks(&self) -> &[MhHook] {
        &self.hooks
    }

    unsafe fn unhook(&mut self) -> windows::core::Result<()> {
        self.state.set_phase(ProcessInputPhase::Disabled);
        Ok(())
    }
}

struct User32Targets {
    get_async_key_state: *mut c_void,
    get_key_state: *mut c_void,
    get_keyboard_state: *mut c_void,
    get_cursor_pos: *mut c_void,
    get_raw_input_buffer: *mut c_void,
}

impl User32Targets {
    fn resolve(user32: HMODULE) -> std::result::Result<Self, MH_STATUS> {
        Ok(Self {
            get_async_key_state: resolve_export(user32, s!("GetAsyncKeyState"))?,
            get_key_state: resolve_export(user32, s!("GetKeyState"))?,
            get_keyboard_state: resolve_export(user32, s!("GetKeyboardState"))?,
            get_cursor_pos: resolve_export(user32, s!("GetCursorPos"))?,
            get_raw_input_buffer: resolve_export(user32, s!("GetRawInputBuffer"))?,
        })
    }
}

fn resolve_export(module: HMODULE, name: PCSTR) -> std::result::Result<*mut c_void, MH_STATUS> {
    let procedure =
        unsafe { GetProcAddress(module, name) }.ok_or(MH_STATUS::MH_ERROR_FUNCTION_NOT_FOUND)?;
    Ok(procedure as *const () as *mut c_void)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct RecordingRawMouseHandler(Mutex<Vec<RawMouseInput>>);

    impl ProcessRawMouseHandler for RecordingRawMouseHandler {
        fn handle_process_raw_mouse(&self, input: RawMouseInput) {
            self.0.lock().unwrap().push(input);
        }
    }

    #[test]
    fn signed_point_packing_is_lossless() {
        for point in [
            POINT { x: 0, y: 0 },
            POINT { x: -123, y: 456 },
            POINT {
                x: i32::MIN,
                y: i32::MAX,
            },
            POINT {
                x: i32::MAX,
                y: i32::MIN,
            },
        ] {
            let unpacked = unpack_point(pack_point(point));
            assert_eq!((unpacked.x, unpacked.y), (point.x, point.y));
        }
    }

    #[test]
    fn key_queries_mask_only_mouse_buttons_during_guarded_phases() {
        let state = ProcessMouseSuppression::new();
        let down = i16::MIN | 1;

        assert_eq!(state.filter_async_key_state(VK_LBUTTON, down), down);
        state.set_phase(ProcessInputPhase::Arming);
        assert_eq!(state.filter_async_key_state(VK_LBUTTON, down), 0);
        assert_eq!(state.filter_key_state(0x41, down), down);
        state.set_phase(ProcessInputPhase::Enabled);
        assert_eq!(state.filter_key_state(VK_XBUTTON2, down), 0);
        state.set_phase(ProcessInputPhase::Disarming);
        assert_eq!(state.filter_key_state(VK_RBUTTON, down), 0);
        state.set_phase(ProcessInputPhase::Disabled);
        assert_eq!(state.filter_key_state(VK_RBUTTON, down), down);

        let counters = state.counters();
        assert_eq!(
            counters.get_async_key_state,
            ProcessInputApiCounters {
                calls: 2,
                masked: 1,
            }
        );
        assert_eq!(
            counters.get_key_state,
            ProcessInputApiCounters {
                calls: 4,
                masked: 2,
            }
        );
    }

    #[test]
    fn keyboard_state_masks_mouse_slots_without_touching_other_keys() {
        let state = ProcessMouseSuppression::new();
        state.set_phase(ProcessInputPhase::Enabled);
        let mut keys = [0x80_u8; 256];

        unsafe { state.filter_keyboard_state(keys.as_mut_ptr(), true) };

        for virtual_key in MOUSE_VIRTUAL_KEYS {
            assert_eq!(keys[virtual_key as usize], 0);
        }
        assert_eq!(keys[0x41], 0x80);

        let mut failed = [0x80_u8; 256];
        unsafe { state.filter_keyboard_state(failed.as_mut_ptr(), false) };
        assert!(failed.iter().all(|value| *value == 0x80));
        assert_eq!(
            state.counters().get_keyboard_state,
            ProcessInputApiCounters {
                calls: 2,
                masked: 1,
            }
        );
    }

    #[test]
    fn cursor_position_freezes_until_the_disabled_boundary() {
        let state = ProcessMouseSuppression::with_frozen_point(POINT { x: -50, y: 75 });
        let mut point = POINT { x: 400, y: 300 };

        unsafe { state.filter_cursor_pos(&mut point, true) };
        assert_eq!((point.x, point.y), (400, 300));

        state.set_phase(ProcessInputPhase::Arming);
        unsafe { state.filter_cursor_pos(&mut point, true) };
        assert_eq!((point.x, point.y), (-50, 75));

        state.set_frozen_point(POINT { x: 12, y: -34 });
        state.set_phase(ProcessInputPhase::Disarming);
        point = POINT { x: 900, y: 800 };
        unsafe { state.filter_cursor_pos(&mut point, true) };
        assert_eq!((point.x, point.y), (12, -34));

        state.set_phase(ProcessInputPhase::Disabled);
        point = POINT { x: 1, y: 2 };
        unsafe { state.filter_cursor_pos(&mut point, true) };
        assert_eq!((point.x, point.y), (1, 2));

        assert_eq!(
            state.counters().get_cursor_pos,
            ProcessInputApiCounters {
                calls: 4,
                masked: 2,
            }
        );
    }

    #[test]
    fn cursor_position_is_not_masked_without_a_valid_frozen_sample() {
        let state = ProcessMouseSuppression::new();
        state.set_phase(ProcessInputPhase::Enabled);
        let mut point = POINT { x: 400, y: 300 };

        unsafe { state.filter_cursor_pos(&mut point, true) };

        assert_eq!((point.x, point.y), (400, 300));
        assert_eq!(
            state.counters().get_cursor_pos,
            ProcessInputApiCounters {
                calls: 1,
                masked: 0,
            }
        );
    }

    #[test]
    fn failed_or_null_bulk_queries_are_counted_but_never_masked() {
        let state = ProcessMouseSuppression::new();
        state.set_phase(ProcessInputPhase::Enabled);

        unsafe {
            state.filter_keyboard_state(std::ptr::null_mut(), true);
            state.filter_cursor_pos(std::ptr::null_mut(), true);
        }

        assert_eq!(
            state.counters().get_keyboard_state,
            ProcessInputApiCounters {
                calls: 1,
                masked: 0,
            }
        );
        assert_eq!(
            state.counters().get_cursor_pos,
            ProcessInputApiCounters {
                calls: 1,
                masked: 0,
            }
        );
    }

    #[test]
    fn physical_button_snapshot_preserves_down_and_recent_press_bits() {
        let snapshot = physical_mouse_buttons_from(|virtual_key| match virtual_key {
            VK_LBUTTON => i16::MIN | 1,
            VK_RBUTTON => 1,
            VK_XBUTTON2 => i16::MIN,
            _ => 0,
        });

        assert_eq!(
            snapshot.down,
            PHYSICAL_MOUSE_LEFT_BUTTON | PHYSICAL_MOUSE_X2_BUTTON
        );
        assert_eq!(
            snapshot.pressed_since_last,
            PHYSICAL_MOUSE_LEFT_BUTTON | PHYSICAL_MOUSE_RIGHT_BUTTON
        );
    }

    #[test]
    fn raw_input_buffer_publishes_then_neutralizes_mouse_records() {
        let state = ProcessMouseSuppression::new();
        let recorder = Arc::new(RecordingRawMouseHandler::default());
        let handler: Arc<dyn ProcessRawMouseHandler> = recorder.clone();
        state.set_raw_mouse_handler(Arc::downgrade(&handler));
        state.set_phase(ProcessInputPhase::Enabled);

        let mut mouse = RAWMOUSE::default();
        mouse.lLastX = 17;
        mouse.lLastY = -9;
        mouse.Anonymous.Anonymous.usButtonFlags = 1;
        mouse.Anonymous.Anonymous.usButtonData = 120;

        let mut raw = RAWINPUT::default();
        raw.header.dwType = RIM_TYPEMOUSE.0;
        raw.header.dwSize = mem::size_of::<RAWINPUT>() as u32;
        raw.header.hDevice = HANDLE(1usize as *mut c_void);
        raw.header.wParam = WPARAM(0);
        raw.data.mouse = mouse;

        unsafe {
            state.filter_raw_input_buffer(&raw mut raw, mem::size_of::<RAWINPUT>(), 1);
        }

        assert!(raw.header.hDevice.is_invalid());
        assert_eq!(raw.header.wParam, WPARAM(RIM_INPUTSINK as usize));
        let filtered_mouse = unsafe { raw.data.mouse };
        assert_eq!(filtered_mouse.lLastX, 0);
        assert_eq!(filtered_mouse.lLastY, 0);
        assert_eq!(
            unsafe { filtered_mouse.Anonymous.Anonymous.usButtonFlags },
            0
        );

        let captured = recorder.0.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].last_x, 17);
        assert_eq!(captured[0].last_y, -9);
        assert_eq!(captured[0].button_flags, 1);
        assert_eq!(captured[0].button_data, 120);
        assert_eq!(
            state.counters().get_raw_input_buffer,
            ProcessInputApiCounters {
                calls: 1,
                masked: 1,
            }
        );
    }

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn raw_input_buffer_aligns_the_absolute_next_block_address() {
        let state = ProcessMouseSuppression::new();
        state.set_phase(ProcessInputPhase::Enabled);

        let raw_size = mem::size_of::<RAWINPUT>();
        assert_eq!(raw_size % 8, 0);

        let mut storage = vec![0_u8; raw_size * 2 + 16];
        let storage_address = storage.as_mut_ptr() as usize;
        let base_offset = (4 + 8 - (storage_address & 7)) & 7;
        let base = unsafe { storage.as_mut_ptr().add(base_offset) };
        assert_eq!((base as usize) & 7, 4);

        // NEXTRAWINPUTBLOCK aligns (base + dwSize), so an 8-byte-sized first
        // record needs four bytes of padding when the caller's base is 4 mod 8.
        let second_offset = raw_size + 4;
        let buffer_size = second_offset + raw_size;

        let mut keyboard = RAWINPUT::default();
        keyboard.header.dwType = windows::Win32::UI::Input::RIM_TYPEKEYBOARD.0;
        keyboard.header.dwSize = raw_size as u32;
        keyboard.header.hDevice = HANDLE(1usize as *mut c_void);
        keyboard.header.wParam = WPARAM(77);

        let mut mouse = RAWINPUT::default();
        mouse.header.dwType = RIM_TYPEMOUSE.0;
        mouse.header.dwSize = raw_size as u32;
        mouse.header.hDevice = HANDLE(2usize as *mut c_void);
        mouse.header.wParam = WPARAM(88);
        mouse.data.mouse.lLastX = 91;
        mouse.data.mouse.lLastY = -37;

        unsafe {
            ptr::write_unaligned(base.cast::<RAWINPUT>(), keyboard);
            ptr::write_unaligned(base.add(second_offset).cast::<RAWINPUT>(), mouse);
            state.filter_raw_input_buffer(base.cast::<RAWINPUT>(), buffer_size, 2);
        }

        let keyboard = unsafe { ptr::read_unaligned(base.cast::<RAWINPUT>()) };
        let mouse = unsafe { ptr::read_unaligned(base.add(second_offset).cast::<RAWINPUT>()) };
        assert_eq!(keyboard.header.hDevice.0 as usize, 1);
        assert_eq!(keyboard.header.wParam, WPARAM(77));
        assert!(mouse.header.hDevice.is_invalid());
        assert_eq!(mouse.header.wParam, WPARAM(RIM_INPUTSINK as usize));
        assert_eq!(unsafe { mouse.data.mouse.lLastX }, 0);
        assert_eq!(unsafe { mouse.data.mouse.lLastY }, 0);
        assert_eq!(
            state.counters().get_raw_input_buffer,
            ProcessInputApiCounters {
                calls: 1,
                masked: 1,
            }
        );
    }
}
