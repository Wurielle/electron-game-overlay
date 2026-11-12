//! Stable C ABI used by native compositor backends.
//!
//! The ABI exposes immutable, explicitly released scene snapshots. Native
//! callers never retain pointers into a live bridge and cannot decide whether
//! game input is suppressed; they only publish the filter state that their
//! backend has already applied and copy observed messages into the router.

use std::cell::RefCell;
use std::ffi::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::ptr;
use std::sync::Arc;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};

use crate::{
    ElectronFrameBridge, ElectronScene, RuntimeDiagnostic, RuntimeDiagnosticCode, TargetSurface,
    TransportDrainResult, GRAPHICS_API_D3D10, GRAPHICS_API_D3D11, GRAPHICS_API_D3D12,
    GRAPHICS_API_D3D9, GRAPHICS_API_OPENGL, GRAPHICS_API_UNKNOWN, GRAPHICS_API_VULKAN,
    TARGET_SURFACE_FOCUSED, TARGET_SURFACE_FULLSCREEN, TARGET_SURFACE_MINIMIZED,
    TARGET_SURFACE_STATE_FLAGS, TARGET_SURFACE_VISIBLE,
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
pub const EGO_STATUS_TIMED_OUT: i32 = -8;
pub const EGO_STATUS_NOT_CONNECTED: i32 = -9;

pub const EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS: u32 = 1_000;
pub const EGO_TRANSPORT_DIRECTORY_MAX_UTF8_BYTES: u64 = 4 * 32_767;
#[cfg(feature = "private-memory-route")]
pub const EGO_PRIVATE_ROUTE_VERSION: u32 = 2;
pub const EGO_INPUT_CAPABILITY_COPIED_WM_INPUT: u64 = crate::INPUT_CAPABILITY_COPIED_WM_INPUT;
pub const EGO_INPUT_CAPABILITY_COPIED_RAW_INPUT_BUFFER: u64 =
    crate::INPUT_CAPABILITY_COPIED_RAW_INPUT_BUFFER;
const MAX_DIRECTORY_UTF16_UNITS: usize = 32_767;

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

fn input_state_record(state: crate::InputRouterState, desired: bool) -> FfiResult<EgoInputStateV1> {
    let (has_topmost_window, topmost_window_id) = optional_id(state.topmost_window_id);
    let (has_focused_window, focused_window_id) = optional_id(state.focused_window_id);
    let (has_captured_window, captured_window_id) = optional_id(state.captured_window_id);
    Ok(EgoInputStateV1 {
        struct_size: std::mem::size_of::<EgoInputStateV1>() as u32,
        abi_version: EGO_ABI_VERSION,
        requested_interception: bool_u32(state.requested_interception),
        desired_interception: bool_u32(desired),
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
    })
}

fn private_directory_from_utf8(bytes: &[u8]) -> FfiResult<PathBuf> {
    if bytes.is_empty() || bytes.len() > EGO_TRANSPORT_DIRECTORY_MAX_UTF8_BYTES as usize {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            "private transport directory length is invalid",
        ));
    }
    let value = std::str::from_utf8(bytes).map_err(|_| {
        FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            "private transport directory is not valid UTF-8",
        )
    })?;
    if value.contains('\0') || value.encode_utf16().count() > MAX_DIRECTORY_UTF16_UNITS {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            "private transport directory contains NUL or exceeds the Windows path limit",
        ));
    }
    let directory = PathBuf::from(value);
    if !directory.is_absolute() {
        return Err(FfiError::new(
            EGO_STATUS_INVALID_ARGUMENT,
            "private transport directory must be an absolute Windows path",
        ));
    }
    Ok(directory)
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

/// Starts a participant-private transport without consulting process-wide
/// environment variables or legacy discovery records.
///
/// # Safety
/// `directory_utf8` must be readable for `directory_utf8_len` bytes and contain
/// an absolute Windows directory encoded as UTF-8 without a trailing NUL. Its
/// bytes are copied synchronously. `out_transport` must be writable, and a
/// successful handle must be destroyed exactly once.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_create_for_directory(
    abi_version: u32,
    directory_utf8: *const u8,
    directory_utf8_len: u64,
    out_transport: *mut *mut EgoTransport,
) -> i32 {
    create_private_transport(
        abi_version,
        directory_utf8,
        directory_utf8_len,
        None,
        out_transport,
    )
}

/// Starts a private transport with immutable native-host input capabilities.
/// The first hello and every reconnect advertise these optional capabilities.
///
/// # Safety
/// Directory and output pointers follow [`ego_transport_create_for_directory`].
#[no_mangle]
pub unsafe extern "C" fn ego_transport_create_for_directory_with_input_capabilities(
    abi_version: u32,
    directory_utf8: *const u8,
    directory_utf8_len: u64,
    input_capabilities: u64,
    out_transport: *mut *mut EgoTransport,
) -> i32 {
    create_private_transport(
        abi_version,
        directory_utf8,
        directory_utf8_len,
        Some(input_capabilities),
        out_transport,
    )
}

/// Caller-owned, fixed-layout loopback route for one exact target incarnation.
#[cfg(feature = "private-memory-route")]
#[repr(C)]
pub struct EgoPrivateRouteV2 {
    pub struct_size: u32,
    pub version: u32,
    pub target_creation_time_100ns: u64,
    pub producer_creation_time_100ns: u64,
    pub input_capabilities: u64,
    pub producer_pid: u32,
    pub target_pid: u32,
    pub port: u16,
    pub reserved: u16,
    pub reserved2: u32,
    pub token_ascii: [u8; 64],
}

#[cfg(feature = "private-memory-route")]
const _: () = {
    assert!(std::mem::size_of::<EgoPrivateRouteV2>() == 112);
    assert!(std::mem::offset_of!(EgoPrivateRouteV2, token_ascii) == 48);
};

/// Starts a private bridge without file discovery or a startup log. The route
/// is copied before returning. Reconnect uses only this exact authorized route.
///
/// # Safety
/// `route` must point to a readable aligned route record. `out_transport`
/// must be writable. Destroy a successful handle exactly once.
#[cfg(feature = "private-memory-route")]
#[no_mangle]
pub unsafe extern "C" fn ego_transport_create_for_private_route_v2(
    abi_version: u32,
    route: *const EgoPrivateRouteV2,
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
                "transport ABI mismatch",
            ));
        }
        let route = route.as_ref().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "private route pointer is null")
        })?;
        if route.struct_size as usize != std::mem::size_of::<EgoPrivateRouteV2>()
            || route.version != EGO_PRIVATE_ROUTE_VERSION
            || route.reserved != 0
            || route.reserved2 != 0
        {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "invalid private route record",
            ));
        }
        let token = std::str::from_utf8(&route.token_ascii).map_err(|_| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "invalid private route token encoding",
            )
        })?;
        let bridge = ElectronFrameBridge::spawn_for_route(
            crate::private_route::ProducerIdentity {
                pid: route.producer_pid,
                creation_time: route.producer_creation_time_100ns,
            },
            route.target_pid,
            route.target_creation_time_100ns,
            route.port,
            token.to_owned(),
            route.input_capabilities,
        )
        .map_err(|error| FfiError::new(EGO_STATUS_INITIALIZATION_FAILED, error.to_string()))?;
        *out_transport = Box::into_raw(Box::new(EgoTransport { bridge }));
        Ok(())
    })
}

unsafe fn create_private_transport(
    abi_version: u32,
    directory_utf8: *const u8,
    directory_utf8_len: u64,
    input_capabilities: Option<u64>,
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
        if input_capabilities
            .is_some_and(|capabilities| !crate::valid_input_capabilities(capabilities))
        {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "native input capability flags are invalid",
            ));
        }
        if directory_utf8.is_null()
            || directory_utf8_len == 0
            || directory_utf8_len > EGO_TRANSPORT_DIRECTORY_MAX_UTF8_BYTES
        {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "private transport directory pointer or length is invalid",
            ));
        }
        let directory = private_directory_from_utf8(std::slice::from_raw_parts(
            directory_utf8,
            directory_utf8_len as usize,
        ))?;
        let bridge = match input_capabilities {
            Some(capabilities) => ElectronFrameBridge::spawn_for_directory_with_input_capabilities(
                directory,
                capabilities,
            ),
            None => ElectronFrameBridge::spawn_for_directory(directory),
        }
        .map_err(|error| {
            FfiError::new(
                EGO_STATUS_INITIALIZATION_FAILED,
                format!("cannot initialize private Electron overlay transport: {error}"),
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

/// Waits for all outbound packets published before this call to be written to
/// the current loopback socket, up to `timeout_ms`.
///
/// # Safety
/// `transport` must remain live for the complete call and must not be destroyed
/// concurrently. `timeout_ms` must be between 1 and
/// [`EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS`] inclusive.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_drain(transport: *mut EgoTransport, timeout_ms: u32) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        if timeout_ms == 0 || timeout_ms > EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                format!(
                    "transport drain timeout must be between 1 and {EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS} milliseconds"
                ),
            ));
        }

        match transport
            .bridge
            .drain_outbound(Duration::from_millis(u64::from(timeout_ms)))
        {
            TransportDrainResult::Drained => Ok(()),
            TransportDrainResult::NotConnected => Err(FfiError::new(
                EGO_STATUS_NOT_CONNECTED,
                "overlay transport is not connected",
            )),
            TransportDrainResult::TimedOut => Err(FfiError::new(
                EGO_STATUS_TIMED_OUT,
                format!("overlay transport did not drain within {timeout_ms} milliseconds"),
            )),
        }
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
/// `snapshot` must remain live and `out_incarnation` must be writable. The
/// registration identity belongs to the same immutable snapshot as its pixels.
#[no_mangle]
pub unsafe extern "C" fn ego_scene_snapshot_window_incarnation(
    snapshot: *const EgoSceneSnapshot,
    index: u64,
    out_incarnation: *mut u64,
) -> i32 {
    ffi_call(|| {
        let out_incarnation = out_incarnation.as_mut().ok_or_else(|| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "out_incarnation pointer is null",
            )
        })?;
        *out_incarnation = 0;
        let snapshot = snapshot_ref(snapshot)?;
        let index = usize::try_from(index).map_err(|_| {
            FfiError::new(
                EGO_STATUS_OUT_OF_RANGE,
                "scene window index is out of range",
            )
        })?;
        *out_incarnation = snapshot
            .scene
            .windows
            .get(index)
            .ok_or_else(|| {
                FfiError::new(
                    EGO_STATUS_OUT_OF_RANGE,
                    "scene window index is out of range",
                )
            })?
            .incarnation;
        Ok(())
    })
}

/// # Safety
/// `snapshot` must remain live and `out_count` must be writable. Registrations
/// include windows awaiting pixels and are separate from compositable frames.
#[no_mangle]
pub unsafe extern "C" fn ego_scene_snapshot_registration_count(
    snapshot: *const EgoSceneSnapshot,
    out_count: *mut u64,
) -> i32 {
    ffi_call(|| {
        let out_count = out_count.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_count pointer is null")
        })?;
        *out_count = 0;
        let snapshot = snapshot_ref(snapshot)?;
        *out_count = snapshot.scene.registrations.len() as u64;
        Ok(())
    })
}

/// # Safety
/// `snapshot` must remain live and both outputs must be writable. Identity is
/// retained through raster replacement and disappears only when registration
/// is removed or reset in this immutable producer snapshot.
#[no_mangle]
pub unsafe extern "C" fn ego_scene_snapshot_get_registration(
    snapshot: *const EgoSceneSnapshot,
    index: u64,
    out_window_id: *mut u32,
    out_incarnation: *mut u64,
) -> i32 {
    ffi_call(|| {
        let out_window_id = out_window_id.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_window_id pointer is null")
        })?;
        let out_incarnation = out_incarnation.as_mut().ok_or_else(|| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "out_incarnation pointer is null",
            )
        })?;
        *out_window_id = 0;
        *out_incarnation = 0;
        let snapshot = snapshot_ref(snapshot)?;
        let index = usize::try_from(index).map_err(|_| {
            FfiError::new(
                EGO_STATUS_OUT_OF_RANGE,
                "scene registration index is out of range",
            )
        })?;
        let registration = snapshot.scene.registrations.get(index).ok_or_else(|| {
            FfiError::new(
                EGO_STATUS_OUT_OF_RANGE,
                "scene registration index is out of range",
            )
        })?;
        *out_window_id = registration.window_id;
        *out_incarnation = registration.incarnation;
        Ok(())
    })
}

/// # Safety
/// Transport must be live and out_cursor must be writable. -1 means game-owned.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_cursor_at(
    transport: *const EgoTransport,
    x: i32,
    y: i32,
    out_cursor: *mut i32,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        let output = out_cursor
            .as_mut()
            .ok_or_else(|| FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "null cursor"))?;
        *output = transport.bridge.cursor_at(x, y);
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
/// The transport must remain live. Call only when the backend authoritatively
/// retires its actual native input owner. Target focus cleanup, filter release
/// and the terminal ACK share one router transaction; producer intent survives.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_retire_input_filter(transport: *mut EgoTransport) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        transport.bridge.retire_input_filter();
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
        *inout_state = input_state_record(state, transport.bridge.desired_interception())?;
        Ok(())
    })
}

/// # Safety
/// The transport must remain live; the initialized v1 record and revision
/// output must be writable. The revision and state share one router lock.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_get_cooperative_input_state(
    transport: *const EgoTransport,
    inout_state: *mut EgoInputStateV1,
    out_revision: *mut u64,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        let inout_state = inout_state.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "input state pointer is null")
        })?;
        let out_revision = out_revision.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_revision pointer is null")
        })?;
        validate_output_record::<EgoInputStateV1>(
            inout_state.struct_size,
            inout_state.abi_version,
            EGO_ABI_VERSION,
        )?;
        let (state, desired, revision) = transport.bridge.cooperative_input_state();
        *inout_state = input_state_record(state, desired)?;
        *out_revision = revision;
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
/// `transport` must remain live and `out_hit` must be writable. Coordinates
/// are physical client pixels, interpreted by the window owner's router.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_hit_test_window(
    transport: *const EgoTransport,
    window_id: u32,
    incarnation: u64,
    x: i32,
    y: i32,
    out_hit: *mut u32,
) -> i32 {
    ffi_call(|| {
        let out_hit = out_hit
            .as_mut()
            .ok_or_else(|| FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_hit pointer is null"))?;
        *out_hit = 0;
        let transport = transport_ref(transport)?;
        *out_hit = bool_u32(
            transport
                .bridge
                .hit_test_window(window_id, incarnation, x, y),
        );
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live and `out_incarnation` must be writable. Zero
/// means the local ID is not registered. Unpainted windows retain identity.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_window_incarnation(
    transport: *const EgoTransport,
    window_id: u32,
    out_incarnation: *mut u64,
) -> i32 {
    ffi_call(|| {
        let out_incarnation = out_incarnation.as_mut().ok_or_else(|| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "out_incarnation pointer is null",
            )
        })?;
        *out_incarnation = 0;
        let transport = transport_ref(transport)?;
        *out_incarnation = transport.bridge.window_incarnation(window_id);
        Ok(())
    })
}

/// # Safety
/// All outputs must be writable and `transport` must remain live. Revision
/// zero means no explicit SDK window-focus request has been observed.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_cooperative_focus_request(
    transport: *const EgoTransport,
    after_revision: u64,
    out_revision: *mut u64,
    out_window_id: *mut u32,
    out_incarnation: *mut u64,
    out_focused: *mut u32,
) -> i32 {
    ffi_call(|| {
        let out_revision = out_revision.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_revision pointer is null")
        })?;
        let out_window_id = out_window_id.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_window_id pointer is null")
        })?;
        let out_focused = out_focused.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_focused pointer is null")
        })?;
        let out_incarnation = out_incarnation.as_mut().ok_or_else(|| {
            FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "out_incarnation pointer is null",
            )
        })?;
        let transport = transport_ref(transport)?;
        let (revision, window_id, incarnation, focused) =
            transport.bridge.cooperative_focus_request(after_revision);
        *out_revision = revision;
        *out_window_id = window_id;
        *out_incarnation = incarnation;
        *out_focused = bool_u32(focused);
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live. A zero ID clears this participant's focus;
/// this does not change actual target focus or interception requests.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_set_cooperative_focus(
    transport: *mut EgoTransport,
    focused_window_id: u32,
    incarnation: u64,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        transport.bridge.set_cooperative_focus(
            (focused_window_id != 0).then_some(focused_window_id),
            incarnation,
        );
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live and `global_requested` must be zero or one.
/// This controls aggregate routing without changing the producer's own request.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_set_cooperative_interception(
    transport: *mut EgoTransport,
    global_requested: u32,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        if global_requested > 1 {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "global interception request must be zero or one",
            ));
        }
        transport
            .bridge
            .set_cooperative_interception(global_requested != 0);
        Ok(())
    })
}

/// # Safety
/// The transport must remain live. `sampled_revision` is the token returned
/// with the input state used to compute this aggregate grant. Stale decisions
/// still apply their actual filter phase, but cannot acknowledge newer input.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_set_cooperative_interception_checked(
    transport: *mut EgoTransport,
    global_requested: u32,
    sampled_revision: u64,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        if global_requested > 1 {
            return Err(FfiError::new(
                EGO_STATUS_INVALID_ARGUMENT,
                "global interception request must be zero or one",
            ));
        }
        transport
            .bridge
            .set_cooperative_interception_for_revision(global_requested != 0, sampled_revision);
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live. Retirement releases this participant's pointer
/// capture, caption drag and keyboard focus without altering another member.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_release_cooperative_ownership(
    transport: *mut EgoTransport,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        transport.bridge.release_cooperative_ownership();
        Ok(())
    })
}

/// # Safety
/// `transport` must remain live and `out_cursor` must be writable. Global
/// hit testing/capture already selected `window_id`; no local fallback occurs.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_cursor_for_window(
    transport: *const EgoTransport,
    window_id: u32,
    incarnation: u64,
    out_cursor: *mut i32,
) -> i32 {
    ffi_call(|| {
        let out_cursor = out_cursor.as_mut().ok_or_else(|| {
            FfiError::new(EGO_STATUS_INVALID_ARGUMENT, "out_cursor pointer is null")
        })?;
        *out_cursor = -1;
        let transport = transport_ref(transport)?;
        *out_cursor = transport.bridge.cursor_for_window(window_id, incarnation);
        Ok(())
    })
}

/// # Safety
/// The handle must remain live and nonzero HWNDs must belong to the target.
/// The window ID has already been selected by the cooperative registry. Zero
/// drops the event without falling back to this participant's local stack.
#[no_mangle]
pub unsafe extern "C" fn ego_transport_route_owned_window_message(
    transport: *mut EgoTransport,
    window_id: u32,
    incarnation: u64,
    target_hwnd: usize,
    message: u32,
    wparam: u64,
    lparam: i64,
) -> i32 {
    ffi_call(|| {
        let transport = transport_ref(transport)?;
        if window_id == 0 {
            return Ok(());
        }
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
        transport.bridge.route_owned_window_message(
            window_id,
            incarnation,
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
    fn registration_metadata_is_available_without_compositable_frames() {
        let snapshot = make_scene_snapshot(Arc::new(ElectronScene {
            state_revision: 1,
            registrations: vec![crate::ElectronWindowRegistration {
                window_id: 7,
                incarnation: 11,
            }],
            windows: Vec::new(),
        }))
        .unwrap();
        let mut frames = 99;
        let mut registrations = 0;
        assert_eq!(
            unsafe { ego_scene_snapshot_window_count(&snapshot, &mut frames) },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_scene_snapshot_registration_count(&snapshot, &mut registrations) },
            EGO_STATUS_OK
        );
        assert_eq!(frames, 0);
        assert_eq!(registrations, 1);
        let mut id = 0;
        let mut incarnation = 0;
        assert_eq!(
            unsafe { ego_scene_snapshot_get_registration(&snapshot, 0, &mut id, &mut incarnation) },
            EGO_STATUS_OK
        );
        assert_eq!((id, incarnation), (7, 11));
        assert_eq!(
            unsafe { ego_scene_snapshot_get_registration(&snapshot, 1, &mut id, &mut incarnation) },
            EGO_STATUS_OUT_OF_RANGE
        );
        assert_eq!((id, incarnation), (0, 0));
    }

    #[test]
    fn private_directory_validation_rejects_ambiguous_encoding_and_nonabsolute_paths() {
        for invalid in [
            &b""[..],
            &b"relative\\member"[..],
            &b"C:drive-relative"[..],
            &b"\\root-relative"[..],
            &b"C:\\member\0foreign"[..],
            &[0xff, 0xfe][..],
        ] {
            assert_eq!(
                private_directory_from_utf8(invalid).unwrap_err().status,
                EGO_STATUS_INVALID_ARGUMENT,
            );
        }
        assert_eq!(
            private_directory_from_utf8(format!("C:\\{}", "x".repeat(32_767)).as_bytes())
                .unwrap_err()
                .status,
            EGO_STATUS_INVALID_ARGUMENT,
        );
        for valid in [
            r"C:\members\app-a",
            r"\\server\share\app-b",
            "C:\\メンバー\\🦀",
        ] {
            assert_eq!(
                private_directory_from_utf8(valid.as_bytes()).unwrap(),
                PathBuf::from(valid),
            );
        }

        let mut output = 1usize as *mut EgoTransport;
        assert_eq!(
            unsafe {
                ego_transport_create_for_directory(EGO_ABI_VERSION, ptr::null(), 0, &mut output)
            },
            EGO_STATUS_INVALID_ARGUMENT,
        );
        assert!(output.is_null());
        assert_eq!(
            unsafe {
                ego_transport_create_for_directory(
                    EGO_ABI_VERSION,
                    b"C:\\member".as_ptr(),
                    EGO_TRANSPORT_DIRECTORY_MAX_UTF8_BYTES + 1,
                    &mut output,
                )
            },
            EGO_STATUS_INVALID_ARGUMENT,
        );
        assert!(output.is_null());
    }

    #[test]
    fn private_input_capability_constructor_rejects_invalid_flags_and_arguments() {
        let directory = b"C:\\member";
        for capabilities in [EGO_INPUT_CAPABILITY_COPIED_RAW_INPUT_BUFFER, 4, u64::MAX] {
            let mut output = 1usize as *mut EgoTransport;
            assert_eq!(
                unsafe {
                    ego_transport_create_for_directory_with_input_capabilities(
                        EGO_ABI_VERSION,
                        directory.as_ptr(),
                        directory.len() as u64,
                        capabilities,
                        &mut output,
                    )
                },
                EGO_STATUS_INVALID_ARGUMENT,
            );
            assert!(output.is_null());
        }
        for (abi, directory, length, expected) in [
            (
                EGO_ABI_VERSION + 1,
                directory.as_ptr(),
                directory.len() as u64,
                EGO_STATUS_ABI_MISMATCH,
            ),
            (EGO_ABI_VERSION, ptr::null(), 0, EGO_STATUS_INVALID_ARGUMENT),
            (
                EGO_ABI_VERSION,
                directory.as_ptr(),
                EGO_TRANSPORT_DIRECTORY_MAX_UTF8_BYTES + 1,
                EGO_STATUS_INVALID_ARGUMENT,
            ),
            (
                EGO_ABI_VERSION,
                b"relative".as_ptr(),
                8,
                EGO_STATUS_INVALID_ARGUMENT,
            ),
        ] {
            let mut output = 1usize as *mut EgoTransport;
            assert_eq!(
                unsafe {
                    ego_transport_create_for_directory_with_input_capabilities(
                        abi,
                        directory,
                        length,
                        0,
                        &mut output,
                    )
                },
                expected,
            );
            assert!(output.is_null());
        }
        assert_eq!(
            unsafe {
                ego_transport_create_for_directory_with_input_capabilities(
                    EGO_ABI_VERSION,
                    directory.as_ptr(),
                    directory.len() as u64,
                    0,
                    ptr::null_mut(),
                )
            },
            EGO_STATUS_INVALID_ARGUMENT,
        );
    }

    #[test]
    fn private_input_capabilities_are_in_the_first_socket_hello_and_reconnect() {
        use std::fs;
        use std::io::Read;
        use std::net::{Shutdown, TcpListener};
        use std::time::Instant;

        struct OwnedTransport(*mut EgoTransport);
        impl Drop for OwnedTransport {
            fn drop(&mut self) {
                assert_eq!(unsafe { ego_transport_destroy(self.0) }, EGO_STATUS_OK);
            }
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ego-input-capabilities-{}-{nonce}",
            std::process::id(),
        ));
        for capabilities in [None, Some(0), Some(1), Some(3)] {
            let directory = root.join(format!("{capabilities:?}"));
            fs::create_dir_all(&directory).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let token = "ab".repeat(32);
            fs::write(
                directory.join("electron-overlay-transport-v1.targeted"),
                b"private",
            )
            .unwrap();
            fs::write(
                directory.join("electron-overlay-transport-v1.json"),
                serde_json::to_vec(&serde_json::json!({
                    "version": 1, "pid": std::process::id(),
                    "port": listener.local_addr().unwrap().port(),
                    "token": token, "targetPid": std::process::id(),
                }))
                .unwrap(),
            )
            .unwrap();
            let bytes = directory.to_str().unwrap().as_bytes();
            let mut handle = ptr::null_mut();
            let status = unsafe {
                match capabilities {
                    Some(capabilities) => {
                        ego_transport_create_for_directory_with_input_capabilities(
                            EGO_ABI_VERSION,
                            bytes.as_ptr(),
                            bytes.len() as u64,
                            capabilities,
                            &mut handle,
                        )
                    }
                    None => ego_transport_create_for_directory(
                        EGO_ABI_VERSION,
                        bytes.as_ptr(),
                        bytes.len() as u64,
                        &mut handle,
                    ),
                }
            };
            assert_eq!(status, EGO_STATUS_OK);
            let transport = OwnedTransport(handle);
            for _ in 0..2 {
                let deadline = Instant::now() + Duration::from_secs(3);
                let mut peer = loop {
                    match listener.accept() {
                        Ok((peer, _)) => break peer,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "capability transport did not connect"
                            );
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(error) => panic!("capability accept failed: {error}"),
                    }
                };
                peer.set_nonblocking(false).unwrap();
                peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut header = [0u8; 5];
                peer.read_exact(&mut header).unwrap();
                assert_eq!(header[4], crate::electron_wire::JSON_KIND);
                let length = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
                assert!(length <= 64 * 1024);
                let mut body = vec![0; length];
                peer.read_exact(&mut body).unwrap();
                let hello: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(hello["type"], "game.process");
                assert_eq!(hello["token"], token);
                let advertised = hello["capabilities"].as_array().unwrap();
                for (name, expected) in [
                    ("input-capabilities-v1", capabilities.is_some()),
                    (
                        "copied-wm-input-v1",
                        capabilities.is_some_and(|flags| flags & 1 != 0),
                    ),
                    (
                        "copied-raw-input-buffer-v1",
                        capabilities.is_some_and(|flags| flags & 2 != 0),
                    ),
                ] {
                    assert_eq!(
                        advertised.iter().any(|value| value == name),
                        expected,
                        "incorrect {name} for flags {capabilities:?}"
                    );
                }
                // A peer rejected before its SDK snapshot remains dormant;
                // merely sending the capability hello is not authentication.
                assert_eq!(unsafe { (*transport.0).bridge.producer_session_epoch() }, 0);
                peer.shutdown(Shutdown::Both).unwrap();
            }
            drop(transport);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn private_directory_transports_keep_tokens_scenes_and_disconnects_isolated() {
        use std::fs;
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener, TcpStream};
        use std::time::Instant;

        const CHILD_FLAG: &str = "EGO_TEST_PRIVATE_TRANSPORT_CHILD";
        let mode = std::env::var(CHILD_FLAG);
        if mode.is_err() {
            // Run with a conflicting process-wide route in a separate process;
            // other unit tests never observe temporary global environment state.
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root =
                std::env::temp_dir().join(format!("ego-private-{}-{nonce}", std::process::id()));
            fs::create_dir(&root).unwrap();
            let modes: &[&str] = if cfg!(feature = "private-memory-route") {
                &["directory", "memory"]
            } else {
                &["directory"]
            };
            for mode in modes {
                let result = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "ffi::tests::private_directory_transports_keep_tokens_scenes_and_disconnects_isolated",
                        "--nocapture",
                    ])
                    .env(CHILD_FLAG, mode)
                    .env("ELECTRON_GAME_OVERLAY_RUN_DIRECTORY", &root)
                    .output()
                    .unwrap();
                assert!(
                    result.status.success(),
                    "private {mode} child failed:\n{}\n{}",
                    String::from_utf8_lossy(&result.stdout),
                    String::from_utf8_lossy(&result.stderr),
                );
                assert!(fs::read_dir(&root).unwrap().next().is_none());
            }
            fs::remove_dir(root).unwrap();
            return;
        }
        let memory_route = mode.unwrap() == "memory";

        struct OwnedTransport(*mut EgoTransport);
        impl Drop for OwnedTransport {
            fn drop(&mut self) {
                assert_eq!(unsafe { ego_transport_destroy(self.0) }, EGO_STATUS_OK);
            }
        }
        fn accept(listener: &TcpListener) -> TcpStream {
            listener.set_nonblocking(true).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        return stream;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "private member did not connect");
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("private member accept failed: {error}"),
                }
            }
        }
        fn hello(stream: &mut TcpStream) -> serde_json::Value {
            let mut header = [0u8; 5];
            stream.read_exact(&mut header).unwrap();
            assert_eq!(header[4], crate::electron_wire::JSON_KIND);
            let length = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
            assert!(length <= 64 * 1024);
            let mut body = vec![0; length];
            stream.read_exact(&mut body).unwrap();
            serde_json::from_slice(&body).unwrap()
        }
        fn send_scene(stream: &mut TcpStream, name: &str, bgra: [u8; 4]) {
            let init = serde_json::json!({
                "type": "overlay.init",
                "windows": [{"windowId": 7, "name": name, "transparent": false,
                    "rect": {"x": 4, "y": 5, "width": 1, "height": 1}}],
            });
            stream
                .write_all(&crate::electron_wire::encode_json(&init.to_string()).unwrap())
                .unwrap();
            let mut packet = Vec::from(16u32.to_le_bytes());
            packet.push(crate::electron_wire::FRAME_KIND);
            packet.extend_from_slice(&7u32.to_le_bytes());
            packet.extend_from_slice(&1u32.to_le_bytes());
            packet.extend_from_slice(&1u32.to_le_bytes());
            packet.extend_from_slice(&bgra);
            stream.write_all(&packet).unwrap();
        }
        fn wait_for(mut condition: impl FnMut() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !condition() {
                assert!(Instant::now() < deadline, "private scene did not settle");
                std::thread::sleep(Duration::from_millis(2));
            }
        }

        let sentinel =
            PathBuf::from(std::env::var_os("ELECTRON_GAME_OVERLAY_RUN_DIRECTORY").unwrap());
        let root = sentinel.join("private-members");
        let a = root.join("a");
        let b = root.join("b");
        let listener_a = TcpListener::bind("127.0.0.1:0").unwrap();
        let listener_b = TcpListener::bind("127.0.0.1:0").unwrap();
        for (directory, listener, token) in [(&a, &listener_a, "a"), (&b, &listener_b, "b")] {
            if memory_route {
                continue;
            }
            fs::create_dir_all(directory).unwrap();
            fs::write(
                directory.join("electron-overlay-transport-v1.targeted"),
                b"private",
            )
            .unwrap();
            fs::write(
                directory.join("electron-overlay-transport-v1.json"),
                serde_json::to_vec(&serde_json::json!({
                    "version": 1, "pid": std::process::id(),
                    "port": listener.local_addr().unwrap().port(),
                    "token": token.repeat(64), "targetPid": std::process::id(),
                }))
                .unwrap(),
            )
            .unwrap();
        }
        let create = |directory: &std::path::Path, listener: &TcpListener, token: u8| {
            let mut transport = ptr::null_mut();
            #[cfg(not(feature = "private-memory-route"))]
            let _ = (listener, token);
            if memory_route {
                #[cfg(not(feature = "private-memory-route"))]
                unreachable!("memory route fixture requires the feature");
                #[cfg(feature = "private-memory-route")]
                {
                    let creation_time = crate::electron_frame::process_creation_time().unwrap();
                    let mut route = EgoPrivateRouteV2 {
                        struct_size: std::mem::size_of::<EgoPrivateRouteV2>() as u32,
                        version: EGO_PRIVATE_ROUTE_VERSION,
                        target_creation_time_100ns: creation_time + 1,
                        producer_creation_time_100ns: creation_time + 1,
                        input_capabilities: EGO_INPUT_CAPABILITY_COPIED_WM_INPUT,
                        producer_pid: std::process::id(),
                        target_pid: std::process::id(),
                        port: listener.local_addr().unwrap().port(),
                        reserved: 0,
                        reserved2: 0,
                        token_ascii: [token; 64],
                    };
                    assert_eq!(
                        unsafe {
                            ego_transport_create_for_private_route_v2(
                                EGO_ABI_VERSION,
                                &route,
                                &mut transport,
                            )
                        },
                        EGO_STATUS_INITIALIZATION_FAILED
                    );
                    assert!(transport.is_null());
                    route.target_creation_time_100ns = creation_time;
                    assert_eq!(
                        unsafe {
                            ego_transport_create_for_private_route_v2(
                                EGO_ABI_VERSION,
                                &route,
                                &mut transport,
                            )
                        },
                        EGO_STATUS_INITIALIZATION_FAILED
                    );
                    assert!(transport.is_null());
                    route.producer_creation_time_100ns = creation_time;
                    assert_eq!(
                        unsafe {
                            ego_transport_create_for_private_route_v2(
                                EGO_ABI_VERSION,
                                &route,
                                &mut transport,
                            )
                        },
                        EGO_STATUS_OK
                    );
                    route.token_ascii.fill(b'?');
                }
            } else {
                let mut bytes = directory.to_str().unwrap().as_bytes().to_vec();
                assert_eq!(
                    unsafe {
                        ego_transport_create_for_directory(
                            EGO_ABI_VERSION,
                            bytes.as_ptr(),
                            bytes.len() as u64,
                            &mut transport,
                        )
                    },
                    EGO_STATUS_OK
                );
                bytes.fill(b'?');
            }
            OwnedTransport(transport)
        };
        let transport_a = create(&a, &listener_a, b'a');
        let transport_b = create(&b, &listener_b, b'b');
        let mut peer_a = accept(&listener_a);
        let mut peer_b = accept(&listener_b);
        assert_eq!(hello(&mut peer_a)["token"], "a".repeat(64));
        assert_eq!(hello(&mut peer_b)["token"], "b".repeat(64));
        send_scene(&mut peer_a, "member-a", [1, 2, 3, 255]);
        send_scene(&mut peer_b, "member-b", [4, 5, 6, 255]);
        wait_for(|| unsafe {
            (*transport_a.0).bridge.scene().windows.len() == 1
                && (*transport_b.0).bridge.scene().windows.len() == 1
        });
        let scene_a = unsafe { (*transport_a.0).bridge.scene() };
        let scene_b = unsafe { (*transport_b.0).bridge.scene() };
        assert_eq!(scene_a.windows[0].window_id, 7);
        assert_eq!(scene_b.windows[0].window_id, 7);
        assert_eq!(scene_a.windows[0].name, "member-a");
        assert_eq!(scene_b.windows[0].name, "member-b");
        assert_eq!(&*scene_a.windows[0].rgba, &[3, 2, 1, 255]);
        assert_eq!(&*scene_b.windows[0].rgba, &[6, 5, 4, 255]);

        let retained_snapshot = make_scene_snapshot(Arc::clone(&scene_a)).unwrap();
        let mut old_incarnation = 0;
        assert_eq!(
            unsafe {
                ego_scene_snapshot_window_incarnation(&retained_snapshot, 0, &mut old_incarnation)
            },
            EGO_STATUS_OK,
        );
        assert_ne!(old_incarnation, 0);
        peer_a
            .write_all(
                &crate::electron_wire::encode_json(
                    &serde_json::json!({"type":"window.close","windowId":7}).to_string(),
                )
                .unwrap(),
            )
            .unwrap();
        send_scene(&mut peer_a, "member-a-recreated", [10, 11, 12, 255]);
        wait_for(|| unsafe {
            (*transport_a.0)
                .bridge
                .scene()
                .windows
                .first()
                .is_some_and(|window| window.name == "member-a-recreated")
        });
        let new_incarnation = unsafe { (*transport_a.0).bridge.window_incarnation(7) };
        assert_ne!(new_incarnation, old_incarnation);
        let mut snapshot_incarnation = 0;
        assert_eq!(
            unsafe {
                ego_scene_snapshot_window_incarnation(
                    &retained_snapshot,
                    0,
                    &mut snapshot_incarnation,
                )
            },
            EGO_STATUS_OK,
        );
        assert_eq!(snapshot_incarnation, old_incarnation);
        let mut hit = 1;
        assert_eq!(
            unsafe {
                ego_transport_hit_test_window(transport_a.0, 7, old_incarnation, 4, 5, &mut hit)
            },
            EGO_STATUS_OK,
        );
        assert_eq!(hit, 0);
        assert_eq!(
            unsafe {
                ego_transport_hit_test_window(transport_a.0, 7, new_incarnation, 4, 5, &mut hit)
            },
            EGO_STATUS_OK,
        );
        assert_eq!(hit, 1);
        assert_eq!(
            unsafe { ego_transport_set_target_focused(transport_a.0, 1) },
            EGO_STATUS_OK
        );
        // Native prepared a disabled aggregate before a newer producer command.
        // Its stale terminal phase must not enqueue a false ACK ahead of the
        // true acknowledgement once that command has been sampled and applied.
        let mut input_state: EgoInputStateV1 = unsafe { std::mem::zeroed() };
        input_state.struct_size = std::mem::size_of::<EgoInputStateV1>() as u32;
        input_state.abi_version = EGO_ABI_VERSION;
        let mut sampled_revision = 0;
        assert_eq!(
            unsafe {
                ego_transport_get_cooperative_input_state(
                    transport_a.0,
                    &mut input_state,
                    &mut sampled_revision,
                )
            },
            EGO_STATUS_OK
        );
        peer_a
            .write_all(
                &crate::electron_wire::encode_json(
                    r#"{"type":"command.input.intercept","intercept":true}"#,
                )
                .unwrap(),
            )
            .unwrap();
        wait_for(|| unsafe { (*transport_a.0).bridge.input_state().requested_interception });
        assert_eq!(
            unsafe {
                ego_transport_set_cooperative_interception_checked(
                    transport_a.0,
                    0,
                    sampled_revision,
                )
            },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_apply_input_filter(transport_a.0, 0, 1) },
            EGO_STATUS_OK
        );
        let previous_revision = sampled_revision;
        assert_eq!(
            unsafe {
                ego_transport_get_cooperative_input_state(
                    transport_a.0,
                    &mut input_state,
                    &mut sampled_revision,
                )
            },
            EGO_STATUS_OK
        );
        assert_ne!(sampled_revision, previous_revision);
        assert_eq!(input_state.requested_interception, 1);
        assert_eq!(
            unsafe {
                ego_transport_set_cooperative_interception_checked(
                    transport_a.0,
                    1,
                    sampled_revision,
                )
            },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_apply_input_filter(transport_a.0, 1, 1) },
            EGO_STATUS_OK
        );
        assert_eq!(
            hello(&mut peer_a),
            serde_json::json!({
                "type":"game.input.intercept", "intercepting":true,
            })
        );
        assert_eq!(
            unsafe { ego_transport_set_cooperative_interception(transport_a.0, 1) },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_apply_input_filter(transport_a.0, 1, 1) },
            EGO_STATUS_OK
        );
        let mut cursor = 0;
        assert_eq!(
            unsafe {
                ego_transport_cursor_for_window(transport_a.0, 7, old_incarnation, &mut cursor)
            },
            EGO_STATUS_OK
        );
        assert_eq!(cursor, -1);
        assert_eq!(
            unsafe {
                ego_transport_cursor_for_window(transport_a.0, 7, new_incarnation, &mut cursor)
            },
            EGO_STATUS_OK
        );
        assert_eq!(cursor, 32512);

        // A real owner retirement must release even after a newer producer
        // request invalidates the old Present sample. It must preserve that
        // request for a promoted owner, and a repeated retirement is silent.
        assert_eq!(
            unsafe {
                ego_transport_get_cooperative_input_state(
                    transport_a.0,
                    &mut input_state,
                    &mut sampled_revision,
                )
            },
            EGO_STATUS_OK
        );
        let retired_sample = sampled_revision;
        peer_a
            .write_all(
                &crate::electron_wire::encode_json(
                    r#"{"type":"command.input.intercept","intercept":true}"#,
                )
                .unwrap(),
            )
            .unwrap();
        wait_for(|| unsafe {
            (*transport_a.0).bridge.cooperative_input_state().2 != retired_sample
        });
        assert_eq!(
            unsafe { ego_transport_retire_input_filter(transport_a.0) },
            EGO_STATUS_OK
        );
        assert_eq!(
            hello(&mut peer_a),
            serde_json::json!({
                "type":"game.input.intercept", "intercepting":false,
            })
        );
        assert!(unsafe { (*transport_a.0).bridge.input_state().requested_interception });
        assert_eq!(
            unsafe { ego_transport_retire_input_filter(transport_a.0) },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_set_target_focused(transport_a.0, 1) },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe {
                ego_transport_set_cooperative_interception_checked(transport_a.0, 1, retired_sample)
            },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_apply_input_filter(transport_a.0, 1, 1) },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe {
                ego_transport_get_cooperative_input_state(
                    transport_a.0,
                    &mut input_state,
                    &mut sampled_revision,
                )
            },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe {
                ego_transport_set_cooperative_interception_checked(
                    transport_a.0,
                    1,
                    sampled_revision,
                )
            },
            EGO_STATUS_OK
        );
        assert_eq!(
            unsafe { ego_transport_apply_input_filter(transport_a.0, 1, 1) },
            EGO_STATUS_OK
        );
        assert_eq!(
            hello(&mut peer_a),
            serde_json::json!({
                "type":"game.input.intercept", "intercepting":true,
            })
        );

        if memory_route {
            peer_a.shutdown(Shutdown::Both).unwrap();
            peer_a = accept(&listener_a);
            let reconnect = hello(&mut peer_a);
            assert_eq!(reconnect["token"], "a".repeat(64));
            assert!(reconnect["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "copied-wm-input-v1"));
        }
        drop(listener_a);
        peer_a.shutdown(Shutdown::Both).unwrap();
        wait_for(|| unsafe { (*transport_a.0).bridge.scene().windows.is_empty() });
        send_scene(&mut peer_b, "member-b-surviving", [7, 8, 9, 255]);
        wait_for(|| unsafe {
            (*transport_b.0)
                .bridge
                .scene()
                .windows
                .first()
                .is_some_and(|window| window.name == "member-b-surviving")
        });
        assert_eq!(
            unsafe { (*transport_b.0).bridge.input_state().window_count },
            1
        );
        drop(transport_a);
        drop(transport_b);
        if memory_route {
            assert!(!root.exists());
        } else {
            fs::remove_dir_all(root).unwrap();
        }
    }

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
    fn abi_layouts_are_stable_on_supported_windows_architectures() {
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
        assert_eq!(EGO_STATUS_TIMED_OUT, -8);
        assert_eq!(EGO_STATUS_NOT_CONNECTED, -9);
        assert_eq!(EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS, 1_000);
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
        assert_eq!(
            unsafe { ego_transport_drain(ptr::null_mut(), 1) },
            EGO_STATUS_INVALID_ARGUMENT
        );

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

        assert_eq!(
            unsafe { ego_transport_drain(transport, 0) },
            EGO_STATUS_INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { ego_transport_drain(transport, EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS + 1) },
            EGO_STATUS_INVALID_ARGUMENT
        );
        let drain_status = unsafe { ego_transport_drain(transport, 25) };
        assert!(
            matches!(
                drain_status,
                EGO_STATUS_OK | EGO_STATUS_NOT_CONNECTED | EGO_STATUS_TIMED_OUT
            ),
            "transport drain returned an unexpected status {drain_status}"
        );

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
