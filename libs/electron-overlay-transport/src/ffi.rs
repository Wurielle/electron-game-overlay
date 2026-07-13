//! Stable C ABI used by native compositor backends.
//!
//! The ABI exposes immutable, explicitly released scene snapshots. Native
//! callers never retain pointers into a live bridge and cannot decide whether
//! game input is suppressed; they only publish the filter state that their
//! backend has already applied and copy observed messages into the router.

use std::cell::RefCell;
use std::ffi::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::Arc;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};

use crate::{ElectronFrameBridge, ElectronScene};

pub const EGO_ABI_VERSION: u32 = 1;

pub const EGO_STATUS_OK: i32 = 0;
pub const EGO_STATUS_INVALID_ARGUMENT: i32 = -1;
pub const EGO_STATUS_ABI_MISMATCH: i32 = -2;
pub const EGO_STATUS_BUFFER_TOO_SMALL: i32 = -3;
pub const EGO_STATUS_INITIALIZATION_FAILED: i32 = -4;
pub const EGO_STATUS_OUT_OF_RANGE: i32 = -5;
pub const EGO_STATUS_INTERNAL_ERROR: i32 = -6;
pub const EGO_STATUS_PANIC: i32 = -7;

const BYTES_PER_PIXEL: u32 = 4;

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Opaque process-local transport/router instance.
pub struct EgoTransport {
    bridge: ElectronFrameBridge,
}

/// Opaque immutable scene lease. Every pointer in `views` is retained by
/// `scene` and remains valid until this object is released.
pub struct EgoSceneSnapshot {
    #[allow(dead_code)]
    scene: Arc<ElectronScene>,
    views: Vec<EgoWindowFrameV1>,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct EgoWindowFrameV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub window_id: u32,
    pub transparent: u32,
    pub rect_x: i32,
    pub rect_y: i32,
    pub rect_width: i32,
    pub rect_height: i32,
    pub state_revision: u64,
    pub sequence: u64,
    pub raster_width: u32,
    pub raster_height: u32,
    pub row_pitch: u64,
    pub name_utf8: *const u8,
    pub name_utf8_len: u64,
    pub rgba: *const u8,
    pub rgba_len: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct EgoInputStateV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub requested_interception: u32,
    pub desired_interception: u32,
    pub effective_interception: u32,
    pub target_focused: u32,
    pub window_count: u64,
    pub pointer_captured: u32,
    pub has_topmost_window: u32,
    pub topmost_window_id: u32,
    pub has_focused_window: u32,
    pub focused_window_id: u32,
    pub has_captured_window: u32,
    pub captured_window_id: u32,
}

#[derive(Debug)]
struct FfiError {
    status: i32,
    message: String,
}

impl FfiError {
    fn new(status: i32, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

type FfiResult<T = ()> = Result<T, FfiError>;

fn set_last_error(message: impl Into<String>) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = message.into());
}

fn clear_last_error() {
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown Rust panic".to_owned()
    }
}

fn ffi_call(operation: impl FnOnce() -> FfiResult) -> i32 {
    clear_last_error();
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(())) => EGO_STATUS_OK,
        Ok(Err(error)) => {
            set_last_error(error.message);
            error.status
        }
        Err(payload) => {
            set_last_error(format!(
                "electron-overlay-transport panicked across an ABI boundary: {}",
                panic_message(payload)
            ));
            EGO_STATUS_PANIC
        }
    }
}

unsafe fn transport_ref<'a>(transport: *const EgoTransport) -> FfiResult<&'a EgoTransport> {
    transport
        .as_ref()
        .ok_or_else(|| FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "transport pointer is null"))
}

unsafe fn snapshot_ref<'a>(snapshot: *const EgoSceneSnapshot) -> FfiResult<&'a EgoSceneSnapshot> {
    snapshot.as_ref().ok_or_else(|| {
        FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            "scene snapshot pointer is null",
        )
    })
}

fn bool_u32(value: bool) -> u32 {
    u32::from(value)
}

fn optional_id(value: Option<u32>) -> (u32, u32) {
    value.map_or((0, 0), |id| (1, id))
}

fn make_scene_snapshot(scene: Arc<ElectronScene>) -> FfiResult<EgoSceneSnapshot> {
    let mut views = Vec::with_capacity(scene.windows.len());
    for frame in &scene.windows {
        let row_pitch = frame.width.checked_mul(BYTES_PER_PIXEL).ok_or_else(|| {
            FfiError::new(EGO_STATUS_INTERNAL_ERROR, "frame row pitch overflowed")
        })?;
        let expected_len = u64::from(row_pitch)
            .checked_mul(u64::from(frame.height))
            .ok_or_else(|| {
                FfiError::new(EGO_STATUS_INTERNAL_ERROR, "frame byte length overflowed")
            })?;
        let rgba_len = u64::try_from(frame.rgba.len()).map_err(|_| {
            FfiError::new(
                EGO_STATUS_INTERNAL_ERROR,
                "frame byte length does not fit the ABI",
            )
        })?;
        if expected_len != rgba_len {
            return Err(FfiError::new(
                EGO_STATUS_INTERNAL_ERROR,
                format!(
                    "window {} has inconsistent RGBA dimensions: expected {expected_len}, got {rgba_len}",
                    frame.window_id
                ),
            ));
        }

        views.push(EgoWindowFrameV1 {
            struct_size: std::mem::size_of::<EgoWindowFrameV1>() as u32,
            abi_version: EGO_ABI_VERSION,
            window_id: frame.window_id,
            transparent: bool_u32(frame.transparent),
            rect_x: frame.rect.x,
            rect_y: frame.rect.y,
            rect_width: frame.rect.width,
            rect_height: frame.rect.height,
            state_revision: frame.state_revision,
            sequence: frame.sequence,
            raster_width: frame.width,
            raster_height: frame.height,
            row_pitch: u64::from(row_pitch),
            name_utf8: if frame.name.is_empty() {
                ptr::null()
            } else {
                frame.name.as_ptr()
            },
            name_utf8_len: u64::try_from(frame.name.len()).map_err(|_| {
                FfiError::new(
                    EGO_STATUS_INTERNAL_ERROR,
                    "window name does not fit the ABI",
                )
            })?,
            rgba: if frame.rgba.is_empty() {
                ptr::null()
            } else {
                frame.rgba.as_ptr()
            },
            rgba_len,
        });
    }
    Ok(EgoSceneSnapshot { scene, views })
}

unsafe fn validate_output_record<T>(struct_size: u32, abi_version: u32) -> FfiResult {
    if abi_version != EGO_ABI_VERSION {
        return Err(FfiError::new(
            EGO_STATUS_ABI_MISMATCH,
            format!("record ABI version {abi_version} does not match {EGO_ABI_VERSION}"),
        ));
    }
    if usize::try_from(struct_size).unwrap_or(0) < std::mem::size_of::<T>() {
        return Err(FfiError::new(
            EGO_STATUS_BUFFER_TOO_SMALL,
            format!(
                "record size {struct_size} is smaller than {}",
                std::mem::size_of::<T>()
            ),
        ));
    }
    Ok(())
}

#[no_mangle]
pub extern "C" fn ego_abi_version() -> u32 {
    EGO_ABI_VERSION
}

/// # Safety
/// `out_transport` must be writable. On success, its returned handle must
/// eventually be passed exactly once to [`ego_transport_destroy`].
#[no_mangle]
pub unsafe extern "C" fn ego_transport_create(
    abi_version: u32,
    out_transport: *mut *mut EgoTransport,
) -> i32 {
    ffi_call(|| {
        let out_transport = out_transport.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_transport pointer is null")
        })?;
        *out_transport = ptr::null_mut();
        if abi_version != EGO_ABI_VERSION {
            return Err(FfiError::new(
                EGO_STATUS_ABI_MISMATCH,
                format!("requested ABI version {abi_version} does not match {EGO_ABI_VERSION}"),
            ));
        }
        let bridge = ElectronFrameBridge::spawn().map_err(|error| {
            FfiError::new(
                EGO_STATUS_INITIALIZATION_FAILED,
                format!("cannot initialize Electron overlay transport: {error}"),
            )
        })?;
        *out_transport = Box::into_raw(Box::new(EgoTransport { bridge }));
        Ok(())
    })
}

/// # Safety
/// `transport` must be a live handle returned by [`ego_transport_create`]. No
/// other ABI call may use it concurrently, and it must not be destroyed more
/// than once.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_destroy(transport: *mut EgoTransport) -> i32 {
    ffi_call(|| {
        if transport.is_null() {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "transport pointer is null",
            ));
        }
        drop(Box::from_raw(transport));
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live for the call and `out_snapshot` must be
/// writable. The returned snapshot has independent lifetime and must be
/// released once.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_acquire_scene(
    transport: *const EgoTransport,
    out_snapshot: *mut *mut EgoSceneSnapshot,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        let out_snapshot = out_snapshot.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_snapshot pointer is null")
        })?;
        *out_snapshot = ptr::null_mut();
        *out_snapshot = Box::into_raw(Box::new(make_scene_snapshot(transport.bridge.scene())?));
        Ok(())
    })
}

/// # Safety
/// `snapshot` must be a live snapshot returned by
/// [`ego_transport_acquire_scene`] and must not be released more than once.
#[no_mangle]
pub unsafe extern "C" fn ego_scene_snapshot_release(snapshot: *mut EgoSceneSnapshot) -> i32 {
    ffi_call(|| {
        if snapshot.is_null() {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "scene snapshot pointer is null",
            ));
        }
        drop(Box::from_raw(snapshot));
        Ok(())
    })
}

/// # Safety
/// `snapshot` must remain live for the call and `out_count` must be writable.
#[no_mangle]
pub unsafe extern "C" fn ego_scene_snapshot_window_count(
    snapshot: *const EgoSceneSnapshot,
    out_count: *mut u64,
) -> i32 {
    ffi_call(|| {
        let snapshot = snapshot_ref(snapshot)?;
        let out_count = out_count.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_count pointer is null")
        })?;
        *out_count = u64::try_from(snapshot.views.len()).map_err(|_| {
            FfiError::new(
                EGO_STATUS_INTERNAL_ERROR,
                "scene window count does not fit the ABI",
            )
        })?;
        Ok(())
    })
}

/// # Safety
/// `snapshot` must remain live for the call. `inout_frame` must point to a
/// writable record initialized with its size and ABI version.
#[no_mangle]
pub unsafe extern "C" fn ego_scene_snapshot_get_window(
    snapshot: *const EgoSceneSnapshot,
    index: u64,
    inout_frame: *mut EgoWindowFrameV1,
) -> i32 {
    ffi_call(|| {
        let snapshot = snapshot_ref(snapshot)?;
        let inout_frame = inout_frame
            .as_mut()
            .ok_or_else(|| FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "frame pointer is null"))?;
        validate_output_record::<EgoWindowFrameV1>(
            inout_frame.struct_size,
            inout_frame.abi_version,
        )?;
        let index = usize::try_from(index).map_err(|_| {
            FfiError::new(
                EGO_STATUS_OUT_OF_RANGE,
                "scene window index is out of range",
            )
        })?;
        *inout_frame = *snapshot.views.get(index).ok_or_else(|| {
            FfiError::new(
                EGO_STATUS_OUT_OF_RANGE,
                "scene window index is out of range",
            )
        })?;
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live for the call and `out_desired` must be writable.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_desired_interception(
    transport: *const EgoTransport,
    out_desired: *mut u32,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        let out_desired = out_desired.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_desired pointer is null")
        })?;
        *out_desired = bool_u32(transport.bridge.desired_interception());
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live and must not be destroyed concurrently.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_set_target_focused(
    transport: *mut EgoTransport,
    focused: u32,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        transport.bridge.set_target_focused(focused != 0);
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live and must not be destroyed concurrently.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_apply_input_filter(
    transport: *mut EgoTransport,
    routing_enabled: u32,
    acknowledge: u32,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        transport
            .bridge
            .apply_input_filter(routing_enabled != 0, acknowledge != 0);
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live for the call. `inout_state` must point to a
/// writable record initialized with its size and ABI version.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_get_input_state(
    transport: *const EgoTransport,
    inout_state: *mut EgoInputStateV1,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        let inout_state = inout_state.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "input state pointer is null")
        })?;
        validate_output_record::<EgoInputStateV1>(
            inout_state.struct_size,
            inout_state.abi_version,
        )?;
        let state = transport.bridge.input_state();
        let (has_topmost_window, topmost_window_id) = optional_id(state.topmost_window_id);
        let (has_focused_window, focused_window_id) = optional_id(state.focused_window_id);
        let (has_captured_window, captured_window_id) = optional_id(state.captured_window_id);
        *inout_state = EgoInputStateV1 {
            struct_size: std::mem::size_of::<EgoInputStateV1>() as u32,
            abi_version: EGO_ABI_VERSION,
            requested_interception: bool_u32(state.requested_interception),
            desired_interception: bool_u32(transport.bridge.desired_interception()),
            effective_interception: bool_u32(state.effective_interception),
            target_focused: bool_u32(state.target_focused),
            window_count: u64::try_from(state.window_count).map_err(|_| {
                FfiError::new(
                    EGO_STATUS_INTERNAL_ERROR,
                    "input window count does not fit the ABI",
                )
            })?,
            pointer_captured: bool_u32(state.pointer_captured),
            has_topmost_window,
            topmost_window_id,
            has_focused_window,
            focused_window_id,
            has_captured_window,
            captured_window_id,
        };
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live for the call. `target_hwnd` must identify a
/// live target window for any message whose coordinate conversion uses that
/// HWND.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_route_window_message(
    transport: *mut EgoTransport,
    target_hwnd: usize,
    message: u32,
    wparam: u64,
    lparam: i64,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        if target_hwnd == 0 {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "target HWND is null",
            ));
        }
        let wparam = usize::try_from(wparam).map_err(|_| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "wparam does not fit this target",
            )
        })?;
        let lparam = isize::try_from(lparam).map_err(|_| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "lparam does not fit this target",
            )
        })?;
        transport.bridge.route_window_message(
            HWND(target_hwnd as *mut c_void),
            message,
            WPARAM(wparam),
            LPARAM(lparam),
        );
        Ok(())
    })
}

/// # Safety
/// When non-null, `buffer` must be writable for `buffer_size` bytes and
/// `required_size` must be writable. A null buffer is valid only with size 0.
#[no_mangle]
pub unsafe extern "C" fn ego_get_last_error_message(
    buffer: *mut c_char,
    buffer_size: u64,
    required_size: *mut u64,
) -> i32 {
    match catch_unwind(AssertUnwindSafe(|| {
        LAST_ERROR.with(|slot| {
            let message = slot.borrow();
            let required = message.len().saturating_add(1);
            if let Some(required_size) = required_size.as_mut() {
                *required_size = u64::try_from(required).unwrap_or(u64::MAX);
            }

            if buffer.is_null() {
                return if buffer_size == 0 {
                    EGO_STATUS_OK
                } else {
                    EGO_STATUS_INVALID_ARGUMENT
                };
            }

            let Ok(buffer_size) = usize::try_from(buffer_size) else {
                return EGO_STATUS_INVALID_ARGUMENT;
            };
            if buffer_size == 0 {
                return EGO_STATUS_BUFFER_TOO_SMALL;
            }

            let copy_len = message.len().min(buffer_size - 1);
            ptr::copy_nonoverlapping(message.as_ptr(), buffer.cast::<u8>(), copy_len);
            *buffer.cast::<u8>().add(copy_len) = 0;
            if buffer_size < required {
                EGO_STATUS_BUFFER_TOO_SMALL
            } else {
                EGO_STATUS_OK
            }
        })
    })) {
        Ok(status) => status,
        Err(_) => EGO_STATUS_PANIC,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_layouts_are_stable_on_x64() {
        assert_eq!(std::mem::size_of::<EgoWindowFrameV1>(), 96);
        assert_eq!(std::mem::size_of::<EgoInputStateV1>(), 64);
        assert_eq!(ego_abi_version(), EGO_ABI_VERSION);
    }

    #[test]
    fn null_arguments_return_status_and_error_text() {
        let status = unsafe { ego_transport_destroy(ptr::null_mut()) };
        assert_eq!(status, EGO_STATUS_INVALID_ARGUMENT);

        let mut required = 0_u64;
        assert_eq!(
            unsafe { ego_get_last_error_message(ptr::null_mut(), 0, &mut required) },
            EGO_STATUS_OK
        );
        assert!(required > 1);

        let mut message = vec![0_i8; required as usize];
        assert_eq!(
            unsafe { ego_get_last_error_message(message.as_mut_ptr(), required, &mut required) },
            EGO_STATUS_OK
        );
        let bytes = message
            .into_iter()
            .take_while(|byte| *byte != 0)
            .map(|byte| byte as u8)
            .collect::<Vec<_>>();
        assert!(String::from_utf8(bytes)
            .unwrap()
            .contains("transport pointer is null"));
    }
}
