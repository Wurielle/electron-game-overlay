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

use crate::{
    ElectronFrameBridge, ElectronScene, RuntimeDiagnostic, RuntimeDiagnosticCode, TargetSurface,
    GRAPHICS_API_D3D10, GRAPHICS_API_D3D11, GRAPHICS_API_D3D12, GRAPHICS_API_D3D9,
    GRAPHICS_API_OPENGL, GRAPHICS_API_UNKNOWN, GRAPHICS_API_VULKAN, TARGET_SURFACE_FOCUSED,
    TARGET_SURFACE_FULLSCREEN, TARGET_SURFACE_MINIMIZED, TARGET_SURFACE_STATE_FLAGS,
    TARGET_SURFACE_VISIBLE,
};

pub const EGO_ABI_VERSION: u32 = 1;

pub const EGO_STATUS_OK: i32 = 0;
pub const EGO_STATUS_INVALID_ARGUMENT: i32 = -1;
pub const EGO_STATUS_ABI_MISMATCH: i32 = -2;
pub const EGO_STATUS_BUFFER_TOO_SMALL: i32 = -3;
pub const EGO_STATUS_INITIALIZATION_FAILED: i32 = -4;
pub const EGO_STATUS_OUT_OF_RANGE: i32 = -5;
pub const EGO_STATUS_INTERNAL_ERROR: i32 = -6;
pub const EGO_STATUS_PANIC: i32 = -7;

pub const EGO_RUNTIME_DIAGNOSTIC_ABI_VERSION: u32 = 1;
pub const EGO_RUNTIME_DIAGNOSTIC_RUNTIME_READY: u32 = 1;
pub const EGO_RUNTIME_DIAGNOSTIC_SWAPCHAIN_READY: u32 = 2;
pub const EGO_RUNTIME_DIAGNOSTIC_SCENE_QUERY_FAILED: u32 = 3;
pub const EGO_RUNTIME_DIAGNOSTIC_SCENE_RENDERING_STARTED: u32 = 4;
pub const EGO_RUNTIME_DIAGNOSTIC_FRAME_REJECTED: u32 = 5;
pub const EGO_RUNTIME_DIAGNOSTIC_FRAME_UPLOAD_FAILED: u32 = 6;
pub const EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTER_RESET: u32 = 7;
pub const EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED: u32 = 8;

pub const EGO_GRAPHICS_API_UNKNOWN: u32 = GRAPHICS_API_UNKNOWN;
pub const EGO_GRAPHICS_API_D3D9: u32 = GRAPHICS_API_D3D9;
pub const EGO_GRAPHICS_API_D3D10: u32 = GRAPHICS_API_D3D10;
pub const EGO_GRAPHICS_API_D3D11: u32 = GRAPHICS_API_D3D11;
pub const EGO_GRAPHICS_API_D3D12: u32 = GRAPHICS_API_D3D12;
pub const EGO_GRAPHICS_API_OPENGL: u32 = GRAPHICS_API_OPENGL;
pub const EGO_GRAPHICS_API_VULKAN: u32 = GRAPHICS_API_VULKAN;

pub const EGO_TARGET_SURFACE_FOCUSED: u32 = TARGET_SURFACE_FOCUSED;
pub const EGO_TARGET_SURFACE_MINIMIZED: u32 = TARGET_SURFACE_MINIMIZED;
pub const EGO_TARGET_SURFACE_VISIBLE: u32 = TARGET_SURFACE_VISIBLE;
pub const EGO_TARGET_SURFACE_FULLSCREEN: u32 = TARGET_SURFACE_FULLSCREEN;

const BYTES_PER_PIXEL: u32 = 4;
const MAX_SAFE_JSON_INTEGER_U64: u64 = 9_007_199_254_740_991;

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

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct EgoTargetSurfaceV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub surface_id: u64,
    pub target_hwnd: u64,
    pub monitor_handle: u64,
    pub revision: u64,
    pub graphics_api: u32,
    pub render_width: u32,
    pub render_height: u32,
    pub client_screen_x: i32,
    pub client_screen_y: i32,
    pub client_width: u32,
    pub client_height: u32,
    pub window_screen_x: i32,
    pub window_screen_y: i32,
    pub window_width: u32,
    pub window_height: u32,
    pub dpi_x: u32,
    pub dpi_y: u32,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub monitor_width: u32,
    pub monitor_height: u32,
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: u32,
    pub work_height: u32,
    pub state_flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct EgoRuntimeDiagnosticV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub code: u32,
    pub error_code: i32,
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

unsafe fn validate_output_record<T>(
    struct_size: u32,
    abi_version: u32,
    expected_abi_version: u32,
) -> FfiResult {
    if abi_version != expected_abi_version {
        return Err(FfiError::new(
            EGO_STATUS_ABI_MISMATCH,
            format!("record ABI version {abi_version} does not match {expected_abi_version}"),
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

fn validate_positive_dimension(name: &str, value: u32) -> FfiResult {
    if value == 0 {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            format!("target surface {name} must be greater than zero"),
        ));
    }
    Ok(())
}

fn validate_target_surface_revision(revision: u64) -> FfiResult {
    if !(1..=MAX_SAFE_JSON_INTEGER_U64).contains(&revision) {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            format!(
                "target surface revision {revision} is outside the exact JSON integer range 1..={MAX_SAFE_JSON_INTEGER_U64}"
            ),
        ));
    }
    Ok(())
}

fn validate_target_surface(surface: &EgoTargetSurfaceV1) -> FfiResult {
    unsafe {
        validate_output_record::<EgoTargetSurfaceV1>(
            surface.struct_size,
            surface.abi_version,
            EGO_ABI_VERSION,
        )?;
    }
    if surface.surface_id == 0 {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            "target surface ID is zero",
        ));
    }
    if surface.target_hwnd == 0 {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            "target surface HWND is null",
        ));
    }
    if surface.monitor_handle == 0 {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            "target surface monitor handle is null",
        ));
    }
    validate_target_surface_revision(surface.revision)?;
    for (name, value) in [
        ("render width", surface.render_width),
        ("render height", surface.render_height),
        ("client width", surface.client_width),
        ("client height", surface.client_height),
        ("window width", surface.window_width),
        ("window height", surface.window_height),
        ("horizontal DPI", surface.dpi_x),
        ("vertical DPI", surface.dpi_y),
        ("monitor width", surface.monitor_width),
        ("monitor height", surface.monitor_height),
        ("work-area width", surface.work_width),
        ("work-area height", surface.work_height),
    ] {
        validate_positive_dimension(name, value)?;
    }
    if surface.state_flags & !TARGET_SURFACE_STATE_FLAGS != 0 {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            format!(
                "target surface state flags {:#x} contain unsupported bits",
                surface.state_flags
            ),
        ));
    }
    Ok(())
}

fn validate_runtime_diagnostic(
    diagnostic: &EgoRuntimeDiagnosticV1,
) -> FfiResult<RuntimeDiagnostic> {
    unsafe {
        validate_output_record::<EgoRuntimeDiagnosticV1>(
            diagnostic.struct_size,
            diagnostic.abi_version,
            EGO_RUNTIME_DIAGNOSTIC_ABI_VERSION,
        )?;
    }
    let code = match diagnostic.code {
        EGO_RUNTIME_DIAGNOSTIC_RUNTIME_READY => RuntimeDiagnosticCode::RuntimeReady,
        EGO_RUNTIME_DIAGNOSTIC_SWAPCHAIN_READY => RuntimeDiagnosticCode::SwapchainReady,
        EGO_RUNTIME_DIAGNOSTIC_SCENE_QUERY_FAILED => RuntimeDiagnosticCode::SceneQueryFailed,
        EGO_RUNTIME_DIAGNOSTIC_SCENE_RENDERING_STARTED => {
            RuntimeDiagnosticCode::SceneRenderingStarted
        }
        EGO_RUNTIME_DIAGNOSTIC_FRAME_REJECTED => RuntimeDiagnosticCode::FrameRejected,
        EGO_RUNTIME_DIAGNOSTIC_FRAME_UPLOAD_FAILED => RuntimeDiagnosticCode::FrameUploadFailed,
        EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTER_RESET => RuntimeDiagnosticCode::InputRouterReset,
        EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED => RuntimeDiagnosticCode::InputRoutingFailed,
        code => {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                format!("runtime diagnostic code {code} is not supported"),
            ));
        }
    };
    let error_code = match diagnostic.error_code {
        EGO_STATUS_OK => None,
        EGO_STATUS_INVALID_ARGUMENT
        | EGO_STATUS_ABI_MISMATCH
        | EGO_STATUS_BUFFER_TOO_SMALL
        | EGO_STATUS_INITIALIZATION_FAILED
        | EGO_STATUS_OUT_OF_RANGE
        | EGO_STATUS_INTERNAL_ERROR
        | EGO_STATUS_PANIC => Some(diagnostic.error_code),
        error_code => {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                format!("runtime diagnostic error code {error_code} is not a defined EGO status"),
            ));
        }
    };
    Ok(RuntimeDiagnostic { code, error_code })
}

impl From<EgoTargetSurfaceV1> for TargetSurface {
    fn from(surface: EgoTargetSurfaceV1) -> Self {
        Self {
            surface_id: surface.surface_id,
            target_hwnd: surface.target_hwnd,
            monitor_handle: surface.monitor_handle,
            revision: surface.revision,
            graphics_api: surface.graphics_api,
            render_width: surface.render_width,
            render_height: surface.render_height,
            client_screen_x: surface.client_screen_x,
            client_screen_y: surface.client_screen_y,
            client_width: surface.client_width,
            client_height: surface.client_height,
            window_screen_x: surface.window_screen_x,
            window_screen_y: surface.window_screen_y,
            window_width: surface.window_width,
            window_height: surface.window_height,
            dpi_x: surface.dpi_x,
            dpi_y: surface.dpi_y,
            monitor_x: surface.monitor_x,
            monitor_y: surface.monitor_y,
            monitor_width: surface.monitor_width,
            monitor_height: surface.monitor_height,
            work_x: surface.work_x,
            work_y: surface.work_y,
            work_width: surface.work_width,
            work_height: surface.work_height,
            state_flags: surface.state_flags,
        }
    }
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
            EGO_ABI_VERSION,
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
/// `transport` must remain live for the call and `out_epoch` must be writable.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_session_epoch(
    transport: *const EgoTransport,
    out_epoch: *mut u64,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        let out_epoch = out_epoch.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_epoch pointer is null")
        })?;
        *out_epoch = transport.bridge.producer_session_epoch();
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
            EGO_ABI_VERSION,
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
/// `transport` must remain live for the call. `surface` must point to a
/// readable record initialized with its size and ABI version.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_publish_target_surface(
    transport: *mut EgoTransport,
    surface: *const EgoTargetSurfaceV1,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        let surface = surface.as_ref().ok_or_else(|| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "target surface pointer is null",
            )
        })?;
        validate_target_surface(surface)?;
        transport.bridge.publish_target_surface((*surface).into());
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live for the call.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_remove_target_surface(
    transport: *mut EgoTransport,
    surface_id: u64,
    revision: u64,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        if surface_id == 0 {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "target surface ID is zero",
            ));
        }
        validate_target_surface_revision(revision)?;
        transport.bridge.remove_target_surface(surface_id, revision);
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live for the call.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_publish_fps(
    transport: *mut EgoTransport,
    fps_milli: u32,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        transport.bridge.publish_fps(fps_milli);
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live for the call. `diagnostic` must point to a
/// readable record initialized with its size and diagnostic ABI version. The
/// record is copied synchronously and no caller-owned pointer is retained.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_publish_diagnostic(
    transport: *mut EgoTransport,
    diagnostic: *const EgoRuntimeDiagnosticV1,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        let diagnostic = diagnostic.as_ref().ok_or_else(|| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "runtime diagnostic pointer is null",
            )
        })?;
        let diagnostic = validate_runtime_diagnostic(diagnostic)?;
        transport.bridge.publish_diagnostic(diagnostic);
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

    fn valid_target_surface() -> EgoTargetSurfaceV1 {
        EgoTargetSurfaceV1 {
            struct_size: std::mem::size_of::<EgoTargetSurfaceV1>() as u32,
            abi_version: EGO_ABI_VERSION,
            surface_id: 0x1000,
            target_hwnd: 0x2000,
            monitor_handle: 0x3000,
            revision: 1,
            graphics_api: EGO_GRAPHICS_API_D3D11,
            render_width: 1920,
            render_height: 1080,
            client_screen_x: -1920,
            client_screen_y: 10,
            client_width: 1920,
            client_height: 1080,
            window_screen_x: -1928,
            window_screen_y: -21,
            window_width: 1936,
            window_height: 1119,
            dpi_x: 144,
            dpi_y: 144,
            monitor_x: -2560,
            monitor_y: 0,
            monitor_width: 2560,
            monitor_height: 1440,
            work_x: -2560,
            work_y: 0,
            work_width: 2560,
            work_height: 1400,
            state_flags: EGO_TARGET_SURFACE_FOCUSED | EGO_TARGET_SURFACE_VISIBLE,
        }
    }

    fn valid_runtime_diagnostic() -> EgoRuntimeDiagnosticV1 {
        EgoRuntimeDiagnosticV1 {
            struct_size: std::mem::size_of::<EgoRuntimeDiagnosticV1>() as u32,
            abi_version: EGO_RUNTIME_DIAGNOSTIC_ABI_VERSION,
            code: EGO_RUNTIME_DIAGNOSTIC_FRAME_UPLOAD_FAILED,
            error_code: EGO_STATUS_INTERNAL_ERROR,
        }
    }

    #[test]
    fn abi_layouts_are_stable_on_x64() {
        assert_eq!(std::mem::size_of::<EgoWindowFrameV1>(), 96);
        assert_eq!(std::mem::size_of::<EgoInputStateV1>(), 64);
        assert_eq!(std::mem::size_of::<EgoTargetSurfaceV1>(), 128);
        assert_eq!(std::mem::size_of::<EgoRuntimeDiagnosticV1>(), 16);
        assert_eq!(std::mem::align_of::<EgoRuntimeDiagnosticV1>(), 4);
        assert_eq!(std::mem::offset_of!(EgoRuntimeDiagnosticV1, struct_size), 0);
        assert_eq!(std::mem::offset_of!(EgoRuntimeDiagnosticV1, abi_version), 4);
        assert_eq!(std::mem::offset_of!(EgoRuntimeDiagnosticV1, code), 8);
        assert_eq!(std::mem::offset_of!(EgoRuntimeDiagnosticV1, error_code), 12);
        assert_eq!(std::mem::align_of::<EgoTargetSurfaceV1>(), 8);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, struct_size), 0);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, abi_version), 4);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, surface_id), 8);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, target_hwnd), 16);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, monitor_handle), 24);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, revision), 32);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, graphics_api), 40);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, render_width), 44);
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, render_height), 48);
        assert_eq!(
            std::mem::offset_of!(EgoTargetSurfaceV1, client_screen_x),
            52
        );
        assert_eq!(std::mem::offset_of!(EgoTargetSurfaceV1, state_flags), 124);
        assert_eq!(ego_abi_version(), EGO_ABI_VERSION);
        assert_eq!(EGO_RUNTIME_DIAGNOSTIC_ABI_VERSION, 1);
        assert_eq!(EGO_RUNTIME_DIAGNOSTIC_RUNTIME_READY, 1);
        assert_eq!(EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED, 8);
        assert_eq!(EGO_GRAPHICS_API_D3D9, 0x9000);
        assert_eq!(EGO_GRAPHICS_API_D3D10, 0xa000);
        assert_eq!(EGO_GRAPHICS_API_D3D11, 0xb000);
        assert_eq!(EGO_GRAPHICS_API_D3D12, 0xc000);
        assert_eq!(EGO_GRAPHICS_API_OPENGL, 0x10000);
        assert_eq!(EGO_GRAPHICS_API_VULKAN, 0x20000);
        assert_eq!(
            EGO_TARGET_SURFACE_FOCUSED
                | EGO_TARGET_SURFACE_MINIMIZED
                | EGO_TARGET_SURFACE_VISIBLE
                | EGO_TARGET_SURFACE_FULLSCREEN,
            TARGET_SURFACE_STATE_FLAGS
        );
    }

    #[test]
    fn null_arguments_return_status_and_error_text() {
        let status = unsafe { ego_transport_destroy(ptr::null_mut()) };
        assert_eq!(status, EGO_STATUS_INVALID_ARGUMENT);

        let mut epoch = u64::MAX;
        assert_eq!(
            unsafe { ego_transport_session_epoch(ptr::null(), &mut epoch) },
            EGO_STATUS_INVALID_ARGUMENT
        );

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

    #[test]
    fn target_surface_record_validation_rejects_bad_headers_handles_dimensions_and_flags() {
        let mut surface = valid_target_surface();

        surface.struct_size -= 1;
        assert_eq!(
            validate_target_surface(&surface).unwrap_err().status,
            EGO_STATUS_BUFFER_TOO_SMALL
        );
        surface = valid_target_surface();
        surface.abi_version += 1;
        assert_eq!(
            validate_target_surface(&surface).unwrap_err().status,
            EGO_STATUS_ABI_MISMATCH
        );

        for clear in [
            (|record: &mut EgoTargetSurfaceV1| record.surface_id = 0)
                as fn(&mut EgoTargetSurfaceV1),
            |record| record.target_hwnd = 0,
            |record| record.monitor_handle = 0,
            |record| record.render_width = 0,
            |record| record.render_height = 0,
            |record| record.client_width = 0,
            |record| record.client_height = 0,
            |record| record.window_width = 0,
            |record| record.window_height = 0,
            |record| record.dpi_x = 0,
            |record| record.dpi_y = 0,
            |record| record.monitor_width = 0,
            |record| record.monitor_height = 0,
            |record| record.work_width = 0,
            |record| record.work_height = 0,
        ] {
            let mut invalid = valid_target_surface();
            clear(&mut invalid);
            assert_eq!(
                validate_target_surface(&invalid).unwrap_err().status,
                EGO_STATUS_INVALID_ARGUMENT
            );
        }

        surface = valid_target_surface();
        surface.state_flags = TARGET_SURFACE_STATE_FLAGS | 0x10;
        assert_eq!(
            validate_target_surface(&surface).unwrap_err().status,
            EGO_STATUS_INVALID_ARGUMENT
        );

        surface = valid_target_surface();
        surface.revision = 0;
        assert_eq!(
            validate_target_surface(&surface).unwrap_err().status,
            EGO_STATUS_INVALID_ARGUMENT
        );
        surface.revision = MAX_SAFE_JSON_INTEGER_U64 + 1;
        assert_eq!(
            validate_target_surface(&surface).unwrap_err().status,
            EGO_STATUS_INVALID_ARGUMENT
        );
        surface.revision = MAX_SAFE_JSON_INTEGER_U64;
        assert!(validate_target_surface(&surface).is_ok());

        surface = valid_target_surface();
        surface.graphics_api = u32::MAX;
        assert!(validate_target_surface(&surface).is_ok());
    }

    #[test]
    fn runtime_diagnostic_validation_rejects_bad_headers_unknown_codes_and_undefined_statuses() {
        let expected_codes = [
            (
                EGO_RUNTIME_DIAGNOSTIC_RUNTIME_READY,
                RuntimeDiagnosticCode::RuntimeReady,
            ),
            (
                EGO_RUNTIME_DIAGNOSTIC_SWAPCHAIN_READY,
                RuntimeDiagnosticCode::SwapchainReady,
            ),
            (
                EGO_RUNTIME_DIAGNOSTIC_SCENE_QUERY_FAILED,
                RuntimeDiagnosticCode::SceneQueryFailed,
            ),
            (
                EGO_RUNTIME_DIAGNOSTIC_SCENE_RENDERING_STARTED,
                RuntimeDiagnosticCode::SceneRenderingStarted,
            ),
            (
                EGO_RUNTIME_DIAGNOSTIC_FRAME_REJECTED,
                RuntimeDiagnosticCode::FrameRejected,
            ),
            (
                EGO_RUNTIME_DIAGNOSTIC_FRAME_UPLOAD_FAILED,
                RuntimeDiagnosticCode::FrameUploadFailed,
            ),
            (
                EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTER_RESET,
                RuntimeDiagnosticCode::InputRouterReset,
            ),
            (
                EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED,
                RuntimeDiagnosticCode::InputRoutingFailed,
            ),
        ];
        for (raw, expected) in expected_codes {
            let mut diagnostic = valid_runtime_diagnostic();
            diagnostic.code = raw;
            diagnostic.error_code = EGO_STATUS_OK;
            assert_eq!(
                validate_runtime_diagnostic(&diagnostic).unwrap(),
                RuntimeDiagnostic {
                    code: expected,
                    error_code: None,
                }
            );
        }

        let mut diagnostic = valid_runtime_diagnostic();
        diagnostic.struct_size -= 1;
        assert_eq!(
            validate_runtime_diagnostic(&diagnostic).unwrap_err().status,
            EGO_STATUS_BUFFER_TOO_SMALL
        );

        diagnostic = valid_runtime_diagnostic();
        diagnostic.abi_version += 1;
        assert_eq!(
            validate_runtime_diagnostic(&diagnostic).unwrap_err().status,
            EGO_STATUS_ABI_MISMATCH
        );

        diagnostic = valid_runtime_diagnostic();
        diagnostic.code = 0;
        assert_eq!(
            validate_runtime_diagnostic(&diagnostic).unwrap_err().status,
            EGO_STATUS_INVALID_ARGUMENT
        );
        diagnostic.code = EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED + 1;
        assert_eq!(
            validate_runtime_diagnostic(&diagnostic).unwrap_err().status,
            EGO_STATUS_INVALID_ARGUMENT
        );

        for error_code in [1, i32::MIN, EGO_STATUS_PANIC - 1] {
            diagnostic = valid_runtime_diagnostic();
            diagnostic.error_code = error_code;
            assert_eq!(
                validate_runtime_diagnostic(&diagnostic).unwrap_err().status,
                EGO_STATUS_INVALID_ARGUMENT
            );
        }

        for error_code in EGO_STATUS_PANIC..=EGO_STATUS_INVALID_ARGUMENT {
            diagnostic = valid_runtime_diagnostic();
            diagnostic.error_code = error_code;
            assert_eq!(
                validate_runtime_diagnostic(&diagnostic).unwrap().error_code,
                Some(error_code)
            );
        }
    }

    #[test]
    fn telemetry_and_diagnostic_c_abi_smoke_publish_validated_updates() {
        let mut transport = ptr::null_mut();
        assert_eq!(
            unsafe { ego_transport_create(EGO_ABI_VERSION, &mut transport) },
            EGO_STATUS_OK
        );
        assert!(!transport.is_null());

        let surface = valid_target_surface();
        assert_eq!(
            unsafe { ego_transport_publish_target_surface(transport, &surface) },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_publish_fps(transport, 59_940) },
            EGO_STATUS_OK
        );
        let diagnostic = valid_runtime_diagnostic();
        assert_eq!(
            unsafe { ego_transport_publish_diagnostic(ptr::null_mut(), &diagnostic) },
            EGO_STATUS_INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { ego_transport_publish_diagnostic(transport, &diagnostic) },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_publish_diagnostic(transport, ptr::null()) },
            EGO_STATUS_INVALID_ARGUMENT
        );
        let mut invalid_diagnostic = diagnostic;
        invalid_diagnostic.code = u32::MAX;
        assert_eq!(
            unsafe { ego_transport_publish_diagnostic(transport, &invalid_diagnostic) },
            EGO_STATUS_INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { ego_transport_remove_target_surface(transport, surface.surface_id, 2) },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe {
                ego_transport_remove_target_surface(
                    transport,
                    surface.surface_id,
                    MAX_SAFE_JSON_INTEGER_U64,
                )
            },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_remove_target_surface(transport, surface.surface_id, 0) },
            EGO_STATUS_INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe {
                ego_transport_remove_target_surface(
                    transport,
                    surface.surface_id,
                    MAX_SAFE_JSON_INTEGER_U64 + 1,
                )
            },
            EGO_STATUS_INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { ego_transport_remove_target_surface(transport, 0, 3) },
            EGO_STATUS_INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { ego_transport_publish_target_surface(transport, ptr::null()) },
            EGO_STATUS_INVALID_ARGUMENT
        );
        assert_eq!(unsafe { ego_transport_destroy(transport) }, EGO_STATUS_OK);
    }
}
