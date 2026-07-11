//! Minimal client for the Electron overlay host's existing frame transport.
//!
//! The Node add-on owns the named mappings and sends low-volume control
//! messages through a message-only Win32 window. This module implements the
//! compatible client half without depending on the legacy injected renderer.

use std::collections::HashMap;
use std::error::Error;
use std::ffi::c_void;
use std::fmt;
use std::mem::size_of;
use std::slice;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};

use hudhook::tracing::{debug, info, warn};
use serde::Deserialize;
use windows::core::{w, Error as WindowsError, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, LPARAM, LRESULT, POINT, WAIT_ABANDONED, WAIT_OBJECT_0, WPARAM,
};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, FILE_MAP_READ,
    MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenMutexW, ReleaseMutex, WaitForSingleObject, MUTEX_MODIFY_STATE,
    SYNCHRONIZATION_SYNCHRONIZE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    FindWindowW, GetAncestor, GetForegroundWindow, GetMessageW, GetWindowLongPtrW, KillTimer,
    PostMessageW, PostQuitMessage, SendMessageTimeoutW, SetTimer, SetWindowLongPtrW,
    TranslateMessage, GA_ROOT, GWLP_USERDATA, GWLP_WNDPROC, HWND_MESSAGE, MSG, MSGFLT_ALLOW,
    SMTO_ABORTIFHUNG, SMTO_BLOCK, WINDOW_EX_STYLE, WM_APP, WM_CLOSE, WM_COPYDATA, WM_TIMER,
    WS_POPUP,
};

use crate::electron_input::{
    AtomicInterceptionState, DragMoveIntent, InputCaption, InputPoint, InputRect, InputRouter,
    InputRouterState, InputWindow, OutboundMessage, OutboundQueue,
};

/// Optional exact window-name filter. When absent, every announced Electron
/// window participates in the scene.
pub const ELECTRON_WINDOW_NAME_ENV: &str = "HUDHOOK_ELECTRON_WINDOW";

const IPC_HOST_WINDOW_TITLE: &str = "n_overlay_1a1y2o8l0b";
const IPC_MESSAGE_ID: i32 = 100;
const IPC_DIRECTION_CLIENT: i32 = 0;
const IPC_DIRECTION_HOST: i32 = 1;

const WM_IPC_MESSAGE: u32 = WM_APP + 0x200;
const WM_IPC_CONNECT_LINK: u32 = WM_IPC_MESSAGE + 1;
const WM_IPC_CONNECT_LINK_ACK: u32 = WM_IPC_CONNECT_LINK + 1;
const WM_IPC_CLOSE_LINK: u32 = WM_IPC_CONNECT_LINK_ACK + 1;
const WM_BRIDGE_SHUTDOWN: u32 = WM_APP + 0x310;
const WM_BRIDGE_FLUSH_OUTBOUND: u32 = WM_BRIDGE_SHUTDOWN + 1;
const WM_BRIDGE_RAISE_WINDOW: u32 = WM_BRIDGE_FLUSH_OUTBOUND + 1;
const WM_BRIDGE_MOVE_WINDOW: u32 = WM_BRIDGE_RAISE_WINDOW + 1;
const CONNECT_TIMER_ID: usize = 1;
const OUTBOUND_RETRY_TIMER_ID: usize = 2;
const CONNECT_RETRY_MILLIS: u32 = 500;
const OUTBOUND_RETRY_MILLIS: u32 = 250;
const OUTBOUND_SEND_TIMEOUT_MILLIS: u32 = 2_000;
const FRAME_HEADER_SIZE: usize = size_of::<i32>() * 2;
const BYTES_PER_PIXEL: usize = 4;

type PublishedScene = Arc<RwLock<Arc<ElectronScene>>>;
type SharedInputRouter = Arc<Mutex<InputRouter>>;
type SharedOutboundQueue = Arc<Mutex<OutboundQueue>>;
type SharedInputOrder = Arc<Mutex<()>>;
type SharedStackGeneration = Arc<AtomicU64>;

#[derive(Default)]
struct DragWakeSlot {
    pending: Option<DragMoveIntent>,
    wake_posted: bool,
}

#[derive(Clone, Default)]
struct SharedDragState {
    slot: Arc<Mutex<DragWakeSlot>>,
}

impl SharedDragState {
    /// Replaces the coalesced placement and posts exactly one outstanding wake.
    /// The post happens while holding the slot mutex: `PostMessageW` is
    /// asynchronous, so this is cheap, and a failed post can reset only the
    /// intent it tried to publish before a newer producer is allowed to enter.
    fn enqueue_and_wake<E>(
        &self,
        intent: DragMoveIntent,
        post_wake: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        let mut slot = self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.pending = Some(intent);
        if slot.wake_posted {
            return Ok(());
        }

        slot.wake_posted = true;
        if let Err(error) = post_wake() {
            // No producer can replace `intent` while this mutex is held. Once
            // reset completes, the next producer performs a fresh post rather
            // than having its newer sample erased by this failure.
            debug_assert_eq!(slot.pending, Some(intent));
            slot.pending = None;
            slot.wake_posted = false;
            return Err(error);
        }
        Ok(())
    }

    fn take_pending(&self) -> Option<DragMoveIntent> {
        let mut slot = self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let intent = slot.pending.take();
        // Clearing under the same mutex makes a later producer responsible for
        // a new wake even when it arrives while this intent is being applied.
        slot.wake_posted = false;
        intent
    }
}

/// One immutable frame copied out of the Electron-owned shared mapping.
#[derive(Debug)]
pub struct ElectronFrame {
    pub window_id: u32,
    pub name: String,
    pub rect: ElectronWindowRect,
    pub transparent: bool,
    /// Changes whenever membership, stack, or producer-owned placement changes.
    /// High-frequency compositor-local drag republishes the scene at this same
    /// revision so it cannot invalidate its own click-to-front generation.
    pub state_revision: u64,
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<[u8]>,
}

/// One immutable, atomically published compositor snapshot.
///
/// Windows are ordered back-to-front. Entries appear after their first valid
/// framebuffer has been copied; registration metadata remains in the bridge so
/// bounds and z-order received before that frame are preserved.
#[derive(Clone, Debug, Default)]
pub struct ElectronScene {
    pub state_revision: u64,
    pub windows: Vec<Arc<ElectronFrame>>,
}

/// Placement supplied by the Electron overlay host, in game-client pixels.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct ElectronWindowRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl From<ElectronWindowRect> for InputRect {
    fn from(rect: ElectronWindowRect) -> Self {
        Self::new(rect.x, rect.y, rect.width, rect.height)
    }
}

/// Owns the background Win32 IPC thread and exposes its most recent frame.
pub struct ElectronFrameBridge {
    scene: PublishedScene,
    input_router: SharedInputRouter,
    interception: Arc<AtomicInterceptionState>,
    outbound: SharedOutboundQueue,
    input_order: SharedInputOrder,
    stack_generation: SharedStackGeneration,
    drag: SharedDragState,
    window: usize,
    thread: Option<JoinHandle<()>>,
}

impl ElectronFrameBridge {
    /// Starts the IPC and shared-memory worker.
    pub fn spawn() -> Result<Self, ElectronFrameBridgeError> {
        let scene = Arc::new(RwLock::new(Arc::new(ElectronScene::default())));
        let worker_scene = Arc::clone(&scene);
        let input_router = Arc::new(Mutex::new(InputRouter::new()));
        let interception = input_router
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .atomic_interception_state();
        let worker_input_router = Arc::clone(&input_router);
        let outbound = Arc::new(Mutex::new(OutboundQueue::new()));
        let worker_outbound = Arc::clone(&outbound);
        let input_order = Arc::new(Mutex::new(()));
        let worker_input_order = Arc::clone(&input_order);
        let stack_generation = Arc::new(AtomicU64::new(0));
        let worker_stack_generation = Arc::clone(&stack_generation);
        let drag = SharedDragState::default();
        let worker_drag = drag.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);

        let thread = thread::Builder::new()
            .name("hudhook-electron-frame".to_owned())
            .spawn(move || {
                run_bridge_thread(
                    worker_scene,
                    worker_input_router,
                    worker_outbound,
                    worker_input_order,
                    worker_stack_generation,
                    worker_drag,
                    ready_tx,
                )
            })
            .map_err(ElectronFrameBridgeError::ThreadSpawn)?;

        let window = match ready_rx.recv() {
            Ok(Ok(window)) => window,
            Ok(Err(message)) => {
                let _ = thread.join();
                return Err(ElectronFrameBridgeError::Initialization(message));
            }
            Err(_) => {
                let _ = thread.join();
                return Err(ElectronFrameBridgeError::Initialization(
                    "Electron frame bridge thread exited during initialization".to_owned(),
                ));
            }
        };

        Ok(Self {
            scene,
            input_router,
            interception,
            outbound,
            input_order,
            stack_generation,
            drag,
            window,
            thread: Some(thread),
        })
    }

    /// Alias for [`Self::spawn`] for conventional constructor call sites.
    #[allow(dead_code)]
    pub fn new() -> Result<Self, ElectronFrameBridgeError> {
        Self::spawn()
    }

    /// Returns one stable, atomically published back-to-front scene snapshot.
    pub fn scene(&self) -> Arc<ElectronScene> {
        let _order = self
            .input_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.scene
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Returns the latest frame of the topmost currently composed window.
    ///
    /// This compatibility accessor preserves the former one-window API while
    /// multi-window renderers consume [`Self::scene`] instead.
    #[allow(dead_code)]
    pub fn latest(&self) -> Option<Arc<ElectronFrame>> {
        self.scene().windows.last().cloned()
    }

    /// Returns a diagnostic snapshot of the current input routing state.
    pub fn input_state(&self) -> InputRouterState {
        self.input_router
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .state()
    }

    /// Desired interception derived from the public request, target focus, and
    /// selected-window lifecycle. The render loop turns this into an applied
    /// hudhook filter through its guarded transition state machine.
    pub fn desired_interception(&self) -> bool {
        self.interception.desired()
    }

    /// Commits the routing/acknowledgement policy for the filter phase hudhook
    /// just published and queues any resulting cleanup/control packets.
    pub fn apply_input_filter(&self, routing_enabled: bool, acknowledge: bool) {
        let has_messages = {
            let _order = self
                .input_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let messages = self
                .input_router
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .apply_input_filter(routing_enabled, acknowledge);
            if messages.is_empty() {
                false
            } else {
                self.outbound
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend(messages);
                true
            }
        };
        if has_messages {
            self.wake_outbound_worker();
        }
    }

    /// Routes one message observed by hudhook and wakes the IPC worker for any
    /// resulting Electron packets. No synchronous cross-process send happens
    /// on the render/present thread.
    pub fn route_window_message(&self, hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) {
        let (has_messages, raised_window, drag_wake_error) = {
            // State mutation and queue publication share this lock with IPC
            // commands/lifecycle updates, giving their outbound packets one
            // total order across the render and bridge threads.
            let _order = self
                .input_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut input_router = self
                .input_router
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let target_root = unsafe { GetAncestor(hwnd, GA_ROOT) };
            let foreground = unsafe { GetForegroundWindow() };
            let target_focused = !foreground.0.is_null()
                && (foreground == hwnd || (!target_root.0.is_null() && foreground == target_root));
            let mut messages = input_router.set_target_focused(target_focused);
            messages.extend(input_router.route_win32_message(
                msg,
                wparam.0 as u32,
                lparam.0 as u32,
                |screen_point| {
                    let mut client_point = POINT {
                        x: screen_point.x,
                        y: screen_point.y,
                    };
                    if unsafe { ScreenToClient(hwnd, &raw mut client_point) }.as_bool() {
                        Some(InputPoint::new(client_point.x, client_point.y))
                    } else {
                        None
                    }
                },
            ));
            let raised_window = input_router.take_pending_raise().map(|window_id| {
                let generation = self
                    .stack_generation
                    .fetch_add(1, Ordering::AcqRel)
                    .wrapping_add(1);
                (window_id, generation)
            });
            let drag_wake_error = input_router.take_pending_drag_move().and_then(|intent| {
                let bridge_window = HWND(self.window as *mut c_void);
                self.drag
                    .enqueue_and_wake(intent, || unsafe {
                        PostMessageW(
                            Some(bridge_window),
                            WM_BRIDGE_MOVE_WINDOW,
                            WPARAM(0),
                            LPARAM(0),
                        )
                    })
                    .err()
            });
            let has_messages = if messages.is_empty() {
                false
            } else {
                self.outbound
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend(messages);
                true
            };
            (has_messages, raised_window, drag_wake_error)
        };

        if let Some((window_id, generation)) = raised_window {
            let bridge_window = HWND(self.window as *mut c_void);
            if let Err(error) = unsafe {
                PostMessageW(
                    Some(bridge_window),
                    WM_BRIDGE_RAISE_WINDOW,
                    WPARAM(window_id as usize),
                    LPARAM(generation as isize),
                )
            } {
                warn!(
                    window_id,
                    ?error,
                    "Cannot publish Electron click-to-front scene update"
                );
            }
        }
        if let Some(error) = drag_wake_error {
            warn!(?error, "Cannot publish Electron caption drag placement");
        }
        if !has_messages {
            return;
        }

        self.wake_outbound_worker();
    }

    fn wake_outbound_worker(&self) {
        let hwnd = HWND(self.window as *mut c_void);
        if let Err(error) =
            unsafe { PostMessageW(Some(hwnd), WM_BRIDGE_FLUSH_OUTBOUND, WPARAM(0), LPARAM(0)) }
        {
            warn!(?error, "Cannot wake Electron IPC worker for outbound input");
        }
    }
}

impl Drop for ElectronFrameBridge {
    fn drop(&mut self) {
        {
            let _order = self
                .input_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut input_router = self
                .input_router
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = input_router.request_interception(false);
            let _ = input_router.replace_windows(Vec::new());
        }
        let hwnd = HWND(self.window as *mut c_void);
        if let Err(error) =
            unsafe { PostMessageW(Some(hwnd), WM_BRIDGE_SHUTDOWN, WPARAM(0), LPARAM(0)) }
        {
            debug!(?error, "Electron frame bridge shutdown message failed");
        }

        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                warn!("Electron frame bridge IPC thread panicked during shutdown");
            }
        }
    }
}

/// Errors that can prevent the bridge thread from starting.
#[derive(Debug)]
pub enum ElectronFrameBridgeError {
    ThreadSpawn(std::io::Error),
    Initialization(String),
}

impl fmt::Display for ElectronFrameBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ThreadSpawn(error) => {
                write!(formatter, "cannot spawn Electron frame bridge: {error}")
            }
            Self::Initialization(message) => formatter.write_str(message),
        }
    }
}

impl Error for ElectronFrameBridgeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::ThreadSpawn(error) => Some(error),
            Self::Initialization(_) => None,
        }
    }
}

fn run_bridge_thread(
    scene: PublishedScene,
    input_router: SharedInputRouter,
    outbound: SharedOutboundQueue,
    input_order: SharedInputOrder,
    stack_generation: SharedStackGeneration,
    drag: SharedDragState,
    ready_tx: mpsc::SyncSender<Result<usize, String>>,
) {
    let title = wide_string(&format!("hudhook-electron-frame-{}", unsafe {
        GetCurrentProcessId()
    }));

    let hwnd = match unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            PCWSTR(title.as_ptr()),
            WS_POPUP,
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
    } {
        Ok(hwnd) => hwnd,
        Err(error) => {
            let _ = ready_tx.send(Err(format!(
                "cannot create Electron frame IPC window: {error}"
            )));
            return;
        }
    };

    let state = Box::new(BridgeThreadState::new(
        hwnd,
        scene,
        input_router,
        outbound,
        input_order,
        stack_generation,
        drag,
    ));
    let window_name_filter = state.window_name_filter.clone();
    let state_ptr = Box::into_raw(state);

    unsafe {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
        SetWindowLongPtrW(
            hwnd,
            GWLP_WNDPROC,
            bridge_window_proc as *const () as usize as isize,
        );

        for message in [
            WM_COPYDATA,
            WM_IPC_CONNECT_LINK,
            WM_IPC_CONNECT_LINK_ACK,
            WM_IPC_CLOSE_LINK,
        ] {
            if let Err(error) = ChangeWindowMessageFilterEx(hwnd, message, MSGFLT_ALLOW, None) {
                debug!(message, ?error, "Cannot relax IPC window message filter");
            }
        }

        SetTimer(Some(hwnd), CONNECT_TIMER_ID, CONNECT_RETRY_MILLIS, None);
        (*state_ptr).try_connect();
    }

    info!(
        target_window = window_name_filter.as_deref().unwrap_or("<all>"),
        "Electron frame bridge IPC thread started"
    );

    if ready_tx.send(Ok(hwnd.0 as usize)).is_err() {
        unsafe {
            let _ = DestroyWindow(hwnd);
            drop(Box::from_raw(state_ptr));
        }
        return;
    }

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if result.0 == -1 {
            warn!("Electron frame bridge message pump failed");
            break;
        }
        if result.0 == 0 {
            break;
        }

        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    unsafe {
        if GetWindowLongPtrW(hwnd, GWLP_USERDATA) != 0 {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            let _ = DestroyWindow(hwnd);
        }
        drop(Box::from_raw(state_ptr));
    }

    debug!("Electron frame bridge IPC thread stopped");
}

unsafe extern "system" fn bridge_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut BridgeThreadState;

    match message {
        WM_TIMER if wparam.0 == CONNECT_TIMER_ID => {
            if let Some(state) = state_ptr.as_mut() {
                state.try_connect();
            }
            return LRESULT(0);
        }
        WM_TIMER if wparam.0 == OUTBOUND_RETRY_TIMER_ID => {
            let _ = KillTimer(Some(hwnd), OUTBOUND_RETRY_TIMER_ID);
            let _ = PostMessageW(Some(hwnd), WM_BRIDGE_FLUSH_OUTBOUND, WPARAM(0), LPARAM(0));
            return LRESULT(0);
        }
        WM_IPC_CONNECT_LINK_ACK => {
            let host = state_ptr.as_mut().and_then(|state| {
                state.connected = true;
                let _ = KillTimer(Some(hwnd), CONNECT_TIMER_ID);
                info!(
                    host_pid = wparam.0,
                    "Electron frame bridge connected to Node host"
                );
                state.host
            });

            // Do not hold a mutable reference to the window state while using
            // SendMessage: cross-thread sent messages may re-enter this proc.
            if let Some(host) = host {
                if let Err(error) = send_game_process(host) {
                    warn!(
                        ?error,
                        "Cannot announce game process to Electron overlay host"
                    );
                }
                let _ = PostMessageW(Some(hwnd), WM_BRIDGE_FLUSH_OUTBOUND, WPARAM(0), LPARAM(0));
            }
            return LRESULT(0);
        }
        WM_COPYDATA => {
            if let Some(state) = state_ptr.as_mut() {
                let copy_data = lparam.0 as *const COPYDATASTRUCT;
                if !copy_data.is_null() {
                    state.on_copy_data(&*copy_data);
                    return LRESULT(1);
                }
            }
            return LRESULT(0);
        }
        WM_IPC_CLOSE_LINK => {
            if let Some(state) = state_ptr.as_mut() {
                state.disconnect();
                let _ = KillTimer(Some(hwnd), OUTBOUND_RETRY_TIMER_ID);
                SetTimer(Some(hwnd), CONNECT_TIMER_ID, CONNECT_RETRY_MILLIS, None);
            }
            return LRESULT(0);
        }
        WM_BRIDGE_FLUSH_OUTBOUND => {
            let transport = state_ptr.as_ref().and_then(|state| {
                state.connected.then(|| {
                    (
                        state.host,
                        Arc::clone(&state.outbound),
                        Arc::clone(&state.outbound_diagnostics),
                    )
                })
            });
            if let Some((Some(host), outbound, diagnostics)) = transport {
                if flush_outbound(host, &outbound, &diagnostics) {
                    let _ = KillTimer(Some(hwnd), OUTBOUND_RETRY_TIMER_ID);
                } else {
                    SetTimer(
                        Some(hwnd),
                        OUTBOUND_RETRY_TIMER_ID,
                        OUTBOUND_RETRY_MILLIS,
                        None,
                    );
                }
            }
            return LRESULT(0);
        }
        WM_BRIDGE_RAISE_WINDOW => {
            if let Some(state) = state_ptr.as_mut() {
                state.raise_scene_window(wparam.0 as u32, lparam.0 as u64);
            }
            return LRESULT(0);
        }
        WM_BRIDGE_MOVE_WINDOW => {
            if let Some(state) = state_ptr.as_mut() {
                state.apply_pending_drag_move();
            }
            return LRESULT(0);
        }
        WM_BRIDGE_SHUTDOWN | WM_CLOSE => {
            if let Some(state) = state_ptr.as_mut() {
                state.notify_host_of_close();
            }
            let _ = KillTimer(Some(hwnd), CONNECT_TIMER_ID);
            let _ = KillTimer(Some(hwnd), OUTBOUND_RETRY_TIMER_ID);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            let _ = DestroyWindow(hwnd);
            PostQuitMessage(0);
            return LRESULT(0);
        }
        _ => {}
    }

    DefWindowProcW(hwnd, message, wparam, lparam)
}

struct BridgeThreadState {
    hwnd: HWND,
    host: Option<HWND>,
    connected: bool,
    scene: PublishedScene,
    input_router: SharedInputRouter,
    outbound: SharedOutboundQueue,
    input_order: SharedInputOrder,
    stack_generation: SharedStackGeneration,
    drag: SharedDragState,
    outbound_diagnostics: Arc<OutboundDiagnostics>,
    window_name_filter: Option<String>,
    windows: Vec<RegisteredWindow>,
    state_revision: u64,
    sequence: u64,
    first_frame_logged: bool,
    mutex_name: Option<String>,
    frame_mutex: Option<NamedMutex>,
    closed_windows: HashMap<u32, String>,
    placement_epoch: u64,
}

impl BridgeThreadState {
    fn new(
        hwnd: HWND,
        scene: PublishedScene,
        input_router: SharedInputRouter,
        outbound: SharedOutboundQueue,
        input_order: SharedInputOrder,
        stack_generation: SharedStackGeneration,
        drag: SharedDragState,
    ) -> Self {
        Self {
            hwnd,
            host: None,
            connected: false,
            scene,
            input_router,
            outbound,
            input_order,
            stack_generation,
            drag,
            outbound_diagnostics: Arc::new(OutboundDiagnostics::default()),
            window_name_filter: window_name_filter(),
            windows: Vec::new(),
            state_revision: 0,
            sequence: 0,
            first_frame_logged: false,
            mutex_name: None,
            frame_mutex: None,
            closed_windows: HashMap::new(),
            placement_epoch: 0,
        }
    }

    unsafe fn try_connect(&mut self) {
        if self.connected {
            return;
        }

        let title = wide_string(IPC_HOST_WINDOW_TITLE);
        let Ok(host) = FindWindowW(w!("STATIC"), PCWSTR(title.as_ptr())) else {
            return;
        };

        self.host = Some(host);
        if let Err(error) = PostMessageW(
            Some(host),
            WM_IPC_CONNECT_LINK,
            WPARAM(self.hwnd.0 as usize),
            LPARAM(0),
        ) {
            debug!(?error, "Cannot request Electron overlay IPC connection");
        }
    }

    fn disconnect(&mut self) {
        self.host = None;
        self.connected = false;
        self.mutex_name = None;
        self.frame_mutex = None;
        self.windows.clear();
        self.closed_windows.clear();
        self.bump_state_revision();
        self.update_input_router_and_publish_scene(|router| {
            let mut outbound = router.request_interception(false);
            outbound.extend(router.replace_windows(Vec::new()));
            outbound
        });
        self.outbound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    unsafe fn notify_host_of_close(&self) {
        if let Some(host) = self.host {
            let _ = PostMessageW(
                Some(host),
                WM_IPC_CLOSE_LINK,
                WPARAM(GetCurrentProcessId() as usize),
                LPARAM(0),
            );
        }
    }

    unsafe fn on_copy_data(&mut self, copy_data: &COPYDATASTRUCT) {
        if copy_data.lpData.is_null() || copy_data.cbData == 0 {
            return;
        }

        let bytes = slice::from_raw_parts(copy_data.lpData.cast::<u8>(), copy_data.cbData as usize);
        match decode_overlay_packet(bytes) {
            Ok(packet) if packet.direction == IPC_DIRECTION_HOST => {
                self.dispatch(&packet.message_type, &packet.json);
            }
            Ok(packet) => {
                debug!(
                    direction = packet.direction,
                    "Ignoring Electron overlay packet with unexpected direction"
                );
            }
            Err(error) => warn!(%error, "Ignoring malformed Electron overlay IPC packet"),
        }
    }

    fn dispatch(&mut self, message_type: &str, json: &str) {
        let result = match message_type {
            "overlay.init" => serde_json::from_str::<OverlayInit>(json)
                .map_err(DispatchError::Json)
                .and_then(|message| {
                    self.on_overlay_init(message)
                        .map_err(DispatchError::Transport)
                }),
            "window" => serde_json::from_str::<WindowMetadata>(json)
                .map_err(DispatchError::Json)
                .and_then(|message| self.on_window(message).map_err(DispatchError::Transport)),
            "window.framebuffer" => serde_json::from_str::<WindowIdMessage>(json)
                .map_err(DispatchError::Json)
                .and_then(|message| {
                    self.on_framebuffer(message.window_id)
                        .map_err(DispatchError::Transport)
                }),
            "window.bounds" => serde_json::from_str::<WindowBoundsMessage>(json)
                .map_err(DispatchError::Json)
                .and_then(|message| {
                    self.on_window_bounds(message)
                        .map_err(DispatchError::Transport)
                }),
            "window.close" => serde_json::from_str::<WindowIdMessage>(json)
                .map_err(DispatchError::Json)
                .and_then(|message| {
                    self.on_window_close(message.window_id)
                        .map_err(DispatchError::Transport)
                }),
            "command.input.intercept" => serde_json::from_str::<InputInterceptCommand>(json)
                .map_err(DispatchError::Json)
                .map(|message| self.on_input_intercept(message.intercept)),
            _ => return,
        };

        if let Err(error) = result {
            warn!(message_type, %error, "Cannot process Electron overlay message");
        }
    }

    fn on_overlay_init(&mut self, message: OverlayInit) -> Result<(), TransportError> {
        self.mutex_name = Some(message.share_mem_mutex.clone());
        self.frame_mutex = match NamedMutex::open(&message.share_mem_mutex) {
            Ok(mutex) => Some(mutex),
            Err(error) => {
                warn!(?error, "Cannot open Electron frame mutex yet");
                None
            }
        };

        self.windows = normalize_registered_windows(
            message.windows,
            self.window_name_filter.as_deref(),
            &mut self.placement_epoch,
        );
        self.closed_windows.clear();
        self.bump_state_revision();
        let input_windows = self.input_windows();
        self.update_input_router_and_publish_scene(|router| router.reset_windows(input_windows));

        for window in &self.windows {
            info!(
                window_id = window.window_id,
                window_name = %window.name,
                buffer_name = %window.buffer_name,
                "Electron overlay metadata selected"
            );
        }

        let window_ids = self
            .windows
            .iter()
            .map(|window| window.window_id)
            .collect::<Vec<_>>();
        for window_id in window_ids {
            if let Err(error) = self.read_window_mapping(window_id) {
                debug!(
                    window_id,
                    %error,
                    "Electron overlay mapping is not readable yet"
                );
            }
        }

        Ok(())
    }

    fn on_window(&mut self, window: WindowMetadata) -> Result<(), TransportError> {
        let window_id = window.window_id;
        if !window_matches_filter(&window, self.window_name_filter.as_deref()) {
            if self
                .windows
                .iter()
                .any(|existing| existing.window_id == window_id)
            {
                self.windows
                    .retain(|existing| existing.window_id != window_id);
                self.bump_state_revision();
                self.update_input_router_and_publish_scene(|router| {
                    router.remove_window(window_id)
                });
            }
            return Ok(());
        }

        let readded_closed = self
            .closed_windows
            .get(&window_id)
            .is_some_and(|name| *name == window.name);
        self.closed_windows.remove(&window_id);

        let placement_epoch = advance_epoch(&mut self.placement_epoch);
        let reannounced = register_window_on_top(&mut self.windows, window, placement_epoch);
        let reselected = readded_closed || reannounced;
        self.bump_state_revision();
        let input_windows = self.input_windows();
        self.update_input_router_and_publish_scene(|router| router.replace_windows(input_windows));

        let registered = self
            .windows
            .last()
            .expect("the registered Electron window was just appended");
        if reselected {
            info!(
                window_id,
                window_name = %registered.name,
                buffer_name = %registered.buffer_name,
                "Electron overlay metadata reselected"
            );
        } else {
            info!(
                window_id,
                window_name = %registered.name,
                buffer_name = %registered.buffer_name,
                "Electron overlay metadata selected"
            );
        }

        self.read_window_mapping(window_id)?;
        Ok(())
    }

    fn on_framebuffer(&mut self, window_id: u32) -> Result<(), TransportError> {
        if self
            .windows
            .iter()
            .any(|window| window.window_id == window_id)
        {
            self.read_window_mapping(window_id)?;
        }
        Ok(())
    }

    fn on_window_bounds(&mut self, message: WindowBoundsMessage) -> Result<(), TransportError> {
        let window_id = message.window_id;
        let rect = message.rect;
        let placement_epoch = advance_epoch(&mut self.placement_epoch);
        let Some((_mapping_replaced, _was_routable)) =
            update_registered_window_bounds(&mut self.windows, message, placement_epoch)
        else {
            return Ok(());
        };

        self.bump_state_revision();
        let input_windows = self.input_windows();
        // External producer bounds establish a new placement epoch. Rebuilding
        // the router invalidates any queued compositor-local drag for this
        // registration while preserving ordinary focus/capture for peers.
        self.update_input_router_and_publish_scene(|router| router.replace_windows(input_windows));
        info!(
            window_id,
            x = rect.x,
            y = rect.y,
            width = rect.width,
            height = rect.height,
            "Electron overlay bounds updated"
        );

        Ok(())
    }

    fn on_window_close(&mut self, window_id: u32) -> Result<(), TransportError> {
        let Some(index) = self
            .windows
            .iter()
            .position(|window| window.window_id == window_id)
        else {
            return Ok(());
        };

        let closed = self.windows.remove(index);
        self.closed_windows.insert(window_id, closed.name.clone());
        self.bump_state_revision();
        self.update_input_router_and_publish_scene(|router| router.remove_window(window_id));
        info!(
            window_id,
            window_name = %closed.name,
            "Electron overlay window closed"
        );

        Ok(())
    }

    fn raise_scene_window(&mut self, window_id: u32, expected_generation: u64) {
        // Validate and apply the intent under the same ordering guard used by
        // WndProc routing. Otherwise a newer click can advance the generation
        // after this check but before the old raise reaches the router/scene.
        let input_order = Arc::clone(&self.input_order);
        let input_router = Arc::clone(&self.input_router);
        let _order = input_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let current_generation = self.stack_generation.load(Ordering::Acquire);
        if current_generation != expected_generation {
            debug!(
                window_id,
                expected_generation,
                current_generation,
                "Ignoring stale Electron click-to-front request"
            );
            return;
        }
        let Some(index) = self
            .windows
            .iter()
            .position(|window| window.window_id == window_id)
        else {
            return;
        };
        if index + 1 == self.windows.len() {
            return;
        }

        let window = self.windows.remove(index);
        self.windows.push(window);
        self.bump_state_revision();
        let messages = input_router
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .raise_window(window_id);
        debug_assert!(messages.is_empty(), "raising a live window is local-only");
        self.publish_scene();
        info!(window_id, "Electron overlay raised to top after input");
    }

    fn apply_pending_drag_move(&mut self) {
        let Some(intent) = self.drag.take_pending() else {
            return;
        };

        let input_order = Arc::clone(&self.input_order);
        let input_router = Arc::clone(&self.input_router);
        let _order = input_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(index) = self.windows.iter().position(|window| {
            window.window_id == intent.window_id && window.placement_epoch == intent.placement_epoch
        }) else {
            return;
        };
        if !input_router
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .apply_drag_move(intent)
        {
            return;
        }

        let window = &mut self.windows[index];
        let moved = window.rect.x != intent.x || window.rect.y != intent.y;
        window.rect.x = intent.x;
        window.rect.y = intent.y;
        let rect = window.rect;
        if !moved {
            return;
        }

        // Placement does not alter membership or stack order. Publishing a new
        // scene Arc is sufficient because snapshot construction detects the
        // changed rect; retaining state/stack revisions avoids invalidating the
        // click-to-front intent generated by the same caption down.
        self.publish_scene();
        info!(
            window_id = intent.window_id,
            x = rect.x,
            y = rect.y,
            width = rect.width,
            height = rect.height,
            placement_epoch = intent.placement_epoch,
            drag_session = intent.drag_session,
            terminal = intent.terminal,
            "Electron overlay moved by caption drag"
        );
    }

    fn on_input_intercept(&self, intercept: bool) {
        self.update_input_router(|router| router.request_interception(intercept));
    }

    fn update_input_router(&self, update: impl FnOnce(&mut InputRouter) -> Vec<OutboundMessage>) {
        let has_messages = {
            let _order = self
                .input_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let messages = update(
                &mut self
                    .input_router
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            );
            if messages.is_empty() {
                false
            } else {
                self.outbound
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend(messages);
                true
            }
        };
        if !has_messages {
            return;
        }

        if let Err(error) = unsafe {
            PostMessageW(
                Some(self.hwnd),
                WM_BRIDGE_FLUSH_OUTBOUND,
                WPARAM(0),
                LPARAM(0),
            )
        } {
            warn!(?error, "Cannot wake Electron IPC worker for outbound input");
        }
    }

    /// Applies one lifecycle/pixel mutation to the input stack and publishes
    /// the matching render scene under the same ordering guard. Readers of
    /// `ElectronFrameBridge::scene` take this guard too, so a Present boundary
    /// cannot observe the new hit-test state with the previous visual stack.
    fn update_input_router_and_publish_scene(
        &mut self,
        update: impl FnOnce(&mut InputRouter) -> Vec<OutboundMessage>,
    ) {
        let invalidates_stack_intents = self
            .scene
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .state_revision
            != self.state_revision;
        let input_order = Arc::clone(&self.input_order);
        let input_router = Arc::clone(&self.input_router);
        let outbound = Arc::clone(&self.outbound);
        let has_messages = {
            let _order = input_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // Lifecycle/metadata membership changes are ordered after any
            // click that routed against the previous published scene. Advance
            // the generation inside the guard so such queued raises cannot
            // overtake this transition. Ordinary same-scene frame refreshes do
            // not advance it, avoiding click starvation under continuous FPS.
            if invalidates_stack_intents {
                self.stack_generation.fetch_add(1, Ordering::AcqRel);
            }
            let messages = update(
                &mut input_router
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            );
            let has_messages = !messages.is_empty();
            if has_messages {
                outbound
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend(messages);
            }
            self.publish_scene();
            has_messages
        };

        if has_messages {
            if let Err(error) = unsafe {
                PostMessageW(
                    Some(self.hwnd),
                    WM_BRIDGE_FLUSH_OUTBOUND,
                    WPARAM(0),
                    LPARAM(0),
                )
            } {
                warn!(?error, "Cannot wake Electron IPC worker for outbound input");
            }
        }
    }

    fn read_window_mapping(&mut self, window_id: u32) -> Result<(), TransportError> {
        self.ensure_frame_mutex()?;

        let Some(index) = self
            .windows
            .iter()
            .position(|window| window.window_id == window_id)
        else {
            return Ok(());
        };
        let copied = {
            let mutex = self
                .frame_mutex
                .as_ref()
                .ok_or(TransportError::MutexUnavailable)?;
            let window = &mut self.windows[index];
            if window.mapping.is_none() {
                window.mapping = Some(FrameMapping::open(&window.buffer_name)?);
            }
            window
                .mapping
                .as_ref()
                .ok_or(TransportError::NoSelectedWindow)?
                .copy_frame(mutex)?
        };
        let Some((width, height, bgra)) = copied else {
            return Ok(());
        };
        let first_frame_for_window = self.windows[index].latest.is_none();
        if first_frame_for_window {
            // A window becomes composable only when its first pixels arrive.
            // Give that membership change its own scene revision so observers
            // can distinguish the partial and fully populated stack even when
            // overlay.init announced every window in one metadata revision.
            self.bump_state_revision();
        }
        let name = self.windows[index].name.clone();
        let rect = self.windows[index].rect;
        let transparent = self.windows[index].transparent;
        let rgba: Arc<[u8]> = premultiplied_bgra_to_straight_rgba(&bgra).into();

        self.sequence = self.sequence.wrapping_add(1).max(1);
        let frame = Arc::new(ElectronFrame {
            window_id,
            name,
            rect,
            transparent,
            state_revision: self.state_revision,
            sequence: self.sequence,
            width,
            height,
            rgba: Arc::clone(&rgba),
        });
        self.windows[index].latest = Some(Arc::clone(&frame));
        let input_windows = first_frame_for_window.then(|| self.input_windows());
        self.update_input_router_and_publish_scene(|router| {
            if let Some(input_windows) = input_windows {
                // The window becomes routable at the same publication boundary
                // where its first pixels make it compositable. Rebuild from
                // registry order so late first frames cannot change z-order.
                router.replace_windows(input_windows)
            } else if transparent {
                router.update_window_alpha_frame(window_id, width, height, Arc::clone(&rgba))
            } else {
                router.clear_window_alpha_frame(window_id)
            }
        });

        if !self.first_frame_logged {
            self.first_frame_logged = true;
            info!(
                window_id,
                window_name = %frame.name,
                sequence = frame.sequence,
                width = frame.width,
                height = frame.height,
                "Electron frame received from node-game-overlay"
            );
        }

        Ok(())
    }

    fn ensure_frame_mutex(&mut self) -> Result<(), TransportError> {
        if self.frame_mutex.is_some() {
            return Ok(());
        }

        let name = self
            .mutex_name
            .as_deref()
            .ok_or(TransportError::MutexUnavailable)?;
        self.frame_mutex = Some(NamedMutex::open(name)?);
        Ok(())
    }

    fn bump_state_revision(&mut self) {
        self.state_revision = self.state_revision.wrapping_add(1).max(1);
    }

    fn input_windows(&self) -> Vec<InputWindow> {
        build_input_windows(&self.windows)
    }

    fn publish_scene(&mut self) {
        let scene = build_scene_snapshot(&mut self.windows, self.state_revision);
        *self
            .scene
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(scene);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayInit {
    share_mem_mutex: String,
    windows: Vec<WindowMetadata>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowMetadata {
    window_id: u32,
    name: String,
    #[serde(default)]
    transparent: bool,
    buffer_name: String,
    rect: ElectronWindowRect,
    #[serde(default)]
    caption: Option<WindowCaptionMetadata>,
}

#[derive(Clone, Copy, Deserialize)]
struct WindowCaptionMetadata {
    #[serde(default)]
    left: i32,
    #[serde(default)]
    right: i32,
    #[serde(default)]
    top: i32,
    #[serde(default)]
    height: i32,
}

impl From<WindowCaptionMetadata> for InputCaption {
    fn from(caption: WindowCaptionMetadata) -> Self {
        Self {
            left: caption.left,
            right: caption.right,
            top: caption.top,
            height: caption.height,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowIdMessage {
    window_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowBoundsMessage {
    window_id: u32,
    rect: ElectronWindowRect,
    #[serde(default)]
    buffer_name: Option<String>,
}

#[derive(Deserialize)]
struct InputInterceptCommand {
    intercept: bool,
}

struct RegisteredWindow {
    window_id: u32,
    buffer_name: String,
    mapping: Option<FrameMapping>,
    latest: Option<Arc<ElectronFrame>>,
    name: String,
    rect: ElectronWindowRect,
    transparent: bool,
    caption: Option<InputCaption>,
    placement_epoch: u64,
}

impl RegisteredWindow {
    fn from_metadata(window: WindowMetadata, placement_epoch: u64) -> Self {
        Self {
            window_id: window.window_id,
            buffer_name: window.buffer_name,
            mapping: None,
            latest: None,
            name: window.name,
            rect: window.rect,
            transparent: window.transparent,
            caption: window.caption.map(InputCaption::from),
            placement_epoch,
        }
    }

    fn is_compositable(&self) -> bool {
        self.latest.is_some() && InputRect::from(self.rect).is_valid()
    }

    fn input_window(&self) -> InputWindow {
        debug_assert!(self.is_compositable());
        let window = InputWindow::new(self.window_id, self.rect.into())
            .with_caption(self.caption)
            .with_placement_epoch(self.placement_epoch);
        if !self.transparent {
            return window;
        }

        self.latest.as_ref().map_or(window.clone(), |frame| {
            window.with_alpha_frame(frame.width, frame.height, Arc::clone(&frame.rgba))
        })
    }
}

fn build_input_windows(windows: &[RegisteredWindow]) -> Vec<InputWindow> {
    windows
        .iter()
        .filter(|window| window.is_compositable())
        .map(RegisteredWindow::input_window)
        .collect()
}

fn window_name_filter() -> Option<String> {
    std::env::var(ELECTRON_WINDOW_NAME_ENV)
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

fn window_matches_filter(window: &WindowMetadata, filter: Option<&str>) -> bool {
    filter.is_none_or(|name| window.name == name)
}

fn normalize_registered_windows(
    windows: Vec<WindowMetadata>,
    filter: Option<&str>,
    placement_epoch: &mut u64,
) -> Vec<RegisteredWindow> {
    let mut normalized = Vec::new();
    for window in windows {
        if !window_matches_filter(&window, filter) {
            continue;
        }
        normalized.retain(|existing: &RegisteredWindow| existing.window_id != window.window_id);
        normalized.push(RegisteredWindow::from_metadata(
            window,
            advance_epoch(placement_epoch),
        ));
    }
    normalized
}

/// Registers one window at the top and returns whether the same id was
/// already present. Removing before appending makes duplicate announcements
/// deterministic and mirrors the legacy renderer's back-to-front vector.
fn register_window_on_top(
    windows: &mut Vec<RegisteredWindow>,
    window: WindowMetadata,
    placement_epoch: u64,
) -> bool {
    let window_id = window.window_id;
    let existed = windows
        .iter()
        .any(|existing| existing.window_id == window_id);
    windows.retain(|existing| existing.window_id != window_id);
    windows.push(RegisteredWindow::from_metadata(window, placement_epoch));
    existed
}

fn update_registered_window_bounds(
    windows: &mut [RegisteredWindow],
    message: WindowBoundsMessage,
    placement_epoch: u64,
) -> Option<(bool, bool)> {
    let window = windows
        .iter_mut()
        .find(|window| window.window_id == message.window_id)?;
    let was_routable = InputRect::from(window.rect).is_valid();
    window.rect = message.rect;
    window.placement_epoch = placement_epoch;
    let mapping_replaced = message.buffer_name.is_some_and(|buffer_name| {
        if buffer_name == window.buffer_name {
            false
        } else {
            window.buffer_name = buffer_name;
            window.mapping = None;
            true
        }
    });
    Some((mapping_replaced, was_routable))
}

fn advance_epoch(epoch: &mut u64) -> u64 {
    *epoch = epoch.wrapping_add(1).max(1);
    *epoch
}

fn build_scene_snapshot(windows: &mut [RegisteredWindow], state_revision: u64) -> ElectronScene {
    let windows = windows
        .iter_mut()
        .filter_map(|window| {
            if !window.is_compositable() {
                return None;
            }
            let current = window.latest.as_ref().cloned()?;
            let frame = if current.state_revision == state_revision
                && current.name == window.name
                && current.rect == window.rect
                && current.transparent == window.transparent
            {
                Arc::clone(&current)
            } else {
                Arc::new(ElectronFrame {
                    window_id: window.window_id,
                    name: window.name.clone(),
                    rect: window.rect,
                    transparent: window.transparent,
                    state_revision,
                    sequence: current.sequence,
                    width: current.width,
                    height: current.height,
                    rgba: Arc::clone(&current.rgba),
                })
            };
            window.latest = Some(Arc::clone(&frame));
            Some(frame)
        })
        .collect();

    ElectronScene {
        state_revision,
        windows,
    }
}

fn premultiplied_bgra_to_straight_rgba(bgra: &[u8]) -> Vec<u8> {
    debug_assert_eq!(bgra.len() % BYTES_PER_PIXEL, 0);
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(BYTES_PER_PIXEL) {
        let blue = pixel[0];
        let green = pixel[1];
        let red = pixel[2];
        let alpha = pixel[3];

        let straight = match alpha {
            0 => [0, 0, 0, 0],
            255 => [red, green, blue, alpha],
            _ => [
                unpremultiply_channel(red, alpha),
                unpremultiply_channel(green, alpha),
                unpremultiply_channel(blue, alpha),
                alpha,
            ],
        };
        rgba.extend_from_slice(&straight);
    }
    rgba
}

fn unpremultiply_channel(channel: u8, alpha: u8) -> u8 {
    debug_assert_ne!(alpha, 0);
    let numerator = u32::from(channel) * 255 + u32::from(alpha) / 2;
    ((numerator / u32::from(alpha)).min(255)) as u8
}

struct NamedMutex {
    handle: HANDLE,
}

impl NamedMutex {
    fn open(name: &str) -> Result<Self, TransportError> {
        let name = wide_string(name);
        let access = SYNCHRONIZATION_SYNCHRONIZE | MUTEX_MODIFY_STATE;
        let handle = unsafe { OpenMutexW(access, false, PCWSTR(name.as_ptr())) }
            .map_err(TransportError::Windows)?;
        Ok(Self { handle })
    }

    fn acquire(&self) -> Result<NamedMutexGuard<'_>, TransportError> {
        let result = unsafe { WaitForSingleObject(self.handle, u32::MAX) };
        if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
            Ok(NamedMutexGuard { mutex: self })
        } else {
            Err(TransportError::WaitFailed(result.0))
        }
    }
}

impl Drop for NamedMutex {
    fn drop(&mut self) {
        if let Err(error) = unsafe { CloseHandle(self.handle) } {
            debug!(?error, "Cannot close Electron frame mutex handle");
        }
    }
}

struct NamedMutexGuard<'a> {
    mutex: &'a NamedMutex,
}

impl Drop for NamedMutexGuard<'_> {
    fn drop(&mut self) {
        if let Err(error) = unsafe { ReleaseMutex(self.mutex.handle) } {
            warn!(?error, "Cannot release Electron frame mutex");
        }
    }
}

struct FrameMapping {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    size: usize,
}

impl FrameMapping {
    fn open(name: &str) -> Result<Self, TransportError> {
        let name = wide_string(name);
        let handle = unsafe { OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(name.as_ptr())) }
            .map_err(TransportError::Windows)?;
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0) };
        if view.Value.is_null() {
            let error = WindowsError::from_thread();
            let _ = unsafe { CloseHandle(handle) };
            return Err(TransportError::Windows(error));
        }

        let mut information = MEMORY_BASIC_INFORMATION::default();
        let queried = unsafe {
            VirtualQuery(
                Some(view.Value.cast_const()),
                &mut information,
                size_of::<MEMORY_BASIC_INFORMATION>(),
            )
        };
        if queried == 0 || information.RegionSize < FRAME_HEADER_SIZE {
            let _ = unsafe { UnmapViewOfFile(view) };
            let _ = unsafe { CloseHandle(handle) };
            return Err(TransportError::InvalidMappingSize(information.RegionSize));
        }

        Ok(Self {
            handle,
            view,
            size: information.RegionSize,
        })
    }

    fn copy_frame(
        &self,
        mutex: &NamedMutex,
    ) -> Result<Option<(u32, u32, Vec<u8>)>, TransportError> {
        let guard = mutex.acquire()?;
        let bytes = unsafe { slice::from_raw_parts(self.view.Value.cast::<u8>(), self.size) };

        let width = i32::from_le_bytes(bytes[0..4].try_into().expect("fixed header width"));
        let height = i32::from_le_bytes(bytes[4..8].try_into().expect("fixed header height"));
        if width <= 0 || height <= 0 {
            return Ok(None);
        }

        let width = width as u32;
        let height = height as u32;
        let pixel_bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL))
            .ok_or(TransportError::FrameDimensionsOverflow { width, height })?;
        let frame_end = FRAME_HEADER_SIZE
            .checked_add(pixel_bytes)
            .ok_or(TransportError::FrameDimensionsOverflow { width, height })?;
        if frame_end > self.size {
            return Err(TransportError::FrameOutsideMapping {
                width,
                height,
                required: frame_end,
                available: self.size,
            });
        }

        let bgra = bytes[FRAME_HEADER_SIZE..frame_end].to_vec();
        drop(guard);
        Ok(Some((width, height, bgra)))
    }
}

impl Drop for FrameMapping {
    fn drop(&mut self) {
        if let Err(error) = unsafe { UnmapViewOfFile(self.view) } {
            debug!(?error, "Cannot unmap Electron frame buffer");
        }
        if let Err(error) = unsafe { CloseHandle(self.handle) } {
            debug!(?error, "Cannot close Electron frame mapping handle");
        }
    }
}

#[derive(Debug)]
enum TransportError {
    Windows(WindowsError),
    WaitFailed(u32),
    InvalidMappingSize(usize),
    FrameDimensionsOverflow {
        width: u32,
        height: u32,
    },
    FrameOutsideMapping {
        width: u32,
        height: u32,
        required: usize,
        available: usize,
    },
    MutexUnavailable,
    NoSelectedWindow,
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Windows(error) => write!(formatter, "Windows transport error: {error}"),
            Self::WaitFailed(result) => {
                write!(formatter, "frame mutex wait failed: 0x{result:08x}")
            }
            Self::InvalidMappingSize(size) => {
                write!(formatter, "invalid frame mapping size: {size}")
            }
            Self::FrameDimensionsOverflow { width, height } => {
                write!(formatter, "frame dimensions overflow: {width}x{height}")
            }
            Self::FrameOutsideMapping {
                width,
                height,
                required,
                available,
            } => write!(
                formatter,
                "frame {width}x{height} needs {required} mapping bytes, only {available} available"
            ),
            Self::MutexUnavailable => formatter.write_str("Electron frame mutex is unavailable"),
            Self::NoSelectedWindow => formatter.write_str("Electron demo window is unavailable"),
        }
    }
}

#[derive(Debug)]
enum DispatchError {
    Json(serde_json::Error),
    Transport(TransportError),
}

impl fmt::Display for DispatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(formatter, "invalid JSON: {error}"),
            Self::Transport(error) => error.fmt(formatter),
        }
    }
}

struct OverlayPacket {
    direction: i32,
    message_type: String,
    json: String,
}

fn decode_overlay_packet(bytes: &[u8]) -> Result<OverlayPacket, PacketError> {
    let mut reader = PacketReader::new(bytes);
    let direction = reader.read_i32()?;
    let _client_id = reader.read_i32()?;
    let _host_port = reader.read_i32()?;
    let message_id = reader.read_i32()?;
    if message_id != IPC_MESSAGE_ID {
        return Err(PacketError::UnexpectedMessageId(message_id));
    }

    let message_type = reader.read_string()?;
    let json = reader.read_string()?;
    if !reader.is_finished() {
        return Err(PacketError::TrailingBytes(reader.remaining()));
    }

    Ok(OverlayPacket {
        direction,
        message_type,
        json,
    })
}

#[derive(Debug, Default)]
struct OutboundDiagnostics {
    first_mouse_logged: AtomicBool,
    first_keyboard_logged: AtomicBool,
}

impl OutboundDiagnostics {
    fn record(&self, message: &OutboundMessage) {
        match message {
            OutboundMessage::InputIntercept { intercepting: true } => {
                info!("Electron input intercept enabled");
            }
            OutboundMessage::InputIntercept {
                intercepting: false,
            } => {
                info!("Electron input intercept disabled");
            }
            OutboundMessage::WindowFocused { focus_window_id } if *focus_window_id != 0 => {
                info!(
                    window_id = focus_window_id,
                    "Electron overlay focused for input"
                );
            }
            _ => {}
        }

        let OutboundMessage::Input {
            window_id,
            msg,
            wparam,
            lparam,
        } = message
        else {
            return;
        };
        if (0x0200..=0x020e).contains(msg) && !self.first_mouse_logged.swap(true, Ordering::AcqRel)
        {
            info!(
                window_id,
                win32_message = msg,
                "Electron mouse input forwarded"
            );
        }
        if matches!(*msg, 0x0201..=0x0209) || (*msg == 0x0200 && *wparam & 0x0013 != 0) {
            let x = i32::from((*lparam as u16) as i16);
            let y = i32::from(((*lparam >> 16) as u16) as i16);
            info!(
                window_id,
                win32_message = msg,
                x,
                y,
                "Electron pointer input forwarded"
            );
        }
        match *msg {
            0x0201 => info!(window_id, "Electron left mouse down forwarded"),
            0x0202 => info!(window_id, "Electron left mouse up forwarded"),
            _ => {}
        }
        if (0x0100..=0x0109).contains(msg)
            && !self.first_keyboard_logged.swap(true, Ordering::AcqRel)
        {
            info!(
                window_id,
                win32_message = msg,
                "Electron keyboard input forwarded"
            );
        }
    }
}

fn flush_outbound(
    host: HWND,
    outbound: &SharedOutboundQueue,
    diagnostics: &OutboundDiagnostics,
) -> bool {
    loop {
        let Some(message) = outbound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_front()
        else {
            return true;
        };

        if let Err(error) = send_outbound_message(host, &message) {
            if should_retry_outbound(&message, &error) {
                outbound
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push_front(message);
                warn!(
                    ?error,
                    "Cannot send idempotent packet to Electron overlay host; retrying"
                );
            } else {
                // A SendMessageTimeout timeout is ambiguous: the receiver may
                // have processed WM_COPYDATA without replying. Non-idempotent
                // mouse/key packets are therefore at-most-once and are never
                // requeued, preventing duplicate clicks or keystrokes.
                warn!(?error, "Dropping outbound packet after send failure");
            }
            return false;
        }

        diagnostics.record(&message);
    }
}

fn should_retry_outbound(message: &OutboundMessage, error: &PacketError) -> bool {
    matches!(error, PacketError::HostSendFailed(_))
        && !matches!(message, OutboundMessage::Input { .. })
}

fn send_outbound_message(host: HWND, message: &OutboundMessage) -> Result<(), PacketError> {
    let (message_type, json) = outbound_message_payload(message);
    send_overlay_message(host, message_type, &json)
}

fn outbound_message_payload(message: &OutboundMessage) -> (&'static str, String) {
    match message {
        OutboundMessage::InputIntercept { intercepting } => (
            "game.input.intercept",
            serde_json::json!({
                "type": "game.input.intercept",
                "intercepting": intercepting,
            })
            .to_string(),
        ),
        OutboundMessage::WindowFocused { focus_window_id } => (
            "game.window.focused",
            serde_json::json!({
                "type": "game.window.focused",
                "focusWindowId": focus_window_id,
            })
            .to_string(),
        ),
        OutboundMessage::Input {
            window_id,
            msg,
            wparam,
            lparam,
        } => (
            "game.input",
            serde_json::json!({
                "type": "game.input",
                "windowId": window_id,
                "msg": msg,
                "wparam": wparam,
                "lparam": lparam,
            })
            .to_string(),
        ),
    }
}

fn send_game_process(host: HWND) -> Result<(), PacketError> {
    let path = std::env::current_exe()
        .map_err(PacketError::CurrentExecutable)?
        .to_string_lossy()
        .into_owned();
    let json = serde_json::json!({
        "type": "game.process",
        "path": path,
    })
    .to_string();
    send_overlay_message(host, "game.process", &json)
}

fn send_overlay_message(host: HWND, message_type: &str, json: &str) -> Result<(), PacketError> {
    let mut packet = encode_overlay_packet(IPC_DIRECTION_CLIENT, message_type, json)?;

    let copy_data = COPYDATASTRUCT {
        dwData: unsafe { GetCurrentProcessId() } as usize,
        cbData: packet
            .len()
            .try_into()
            .map_err(|_| PacketError::StringTooLong(packet.len()))?,
        lpData: packet.as_mut_ptr().cast(),
    };
    let mut host_result = 0usize;
    let delivered = unsafe {
        SendMessageTimeoutW(
            host,
            WM_COPYDATA,
            WPARAM(0),
            LPARAM((&raw const copy_data) as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            OUTBOUND_SEND_TIMEOUT_MILLIS,
            Some(&raw mut host_result),
        )
    };
    if delivered.0 == 0 {
        Err(PacketError::HostSendFailed(WindowsError::from_thread()))
    } else if host_result == 0 {
        Err(PacketError::HostRejectedMessage)
    } else {
        Ok(())
    }
}

fn encode_overlay_packet(
    direction: i32,
    message_type: &str,
    json: &str,
) -> Result<Vec<u8>, PacketError> {
    let mut packet = Vec::with_capacity(json.len() + 64);
    push_i32(&mut packet, direction);
    push_i32(&mut packet, 0);
    push_i32(&mut packet, 0);
    push_i32(&mut packet, IPC_MESSAGE_ID);
    push_string(&mut packet, message_type)?;
    push_string(&mut packet, json)?;
    Ok(packet)
}

fn push_i32(output: &mut Vec<u8>, value: i32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), PacketError> {
    let length: i32 = value
        .len()
        .try_into()
        .map_err(|_| PacketError::StringTooLong(value.len()))?;
    push_i32(output, length);
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

struct PacketReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> PacketReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn read_i32(&mut self) -> Result<i32, PacketError> {
        let bytes = self.take(size_of::<i32>())?;
        Ok(i32::from_le_bytes(
            bytes.try_into().expect("fixed i32 packet field"),
        ))
    }

    fn read_string(&mut self) -> Result<String, PacketError> {
        let signed_length = self.read_i32()?;
        let length: usize = signed_length
            .try_into()
            .map_err(|_| PacketError::NegativeLength(signed_length))?;
        let bytes = self.take(length)?;
        String::from_utf8(bytes.to_vec()).map_err(PacketError::InvalidUtf8)
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], PacketError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(PacketError::Truncated)?;
        let result = self
            .bytes
            .get(self.position..end)
            .ok_or(PacketError::Truncated)?;
        self.position = end;
        Ok(result)
    }

    fn is_finished(&self) -> bool {
        self.position == self.bytes.len()
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.position)
    }
}

#[derive(Debug)]
enum PacketError {
    Truncated,
    NegativeLength(i32),
    StringTooLong(usize),
    InvalidUtf8(std::string::FromUtf8Error),
    UnexpectedMessageId(i32),
    TrailingBytes(usize),
    CurrentExecutable(std::io::Error),
    HostSendFailed(WindowsError),
    HostRejectedMessage,
}

impl fmt::Display for PacketError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => formatter.write_str("truncated packet"),
            Self::NegativeLength(length) => write!(formatter, "negative string length: {length}"),
            Self::StringTooLong(length) => write!(formatter, "string is too long: {length} bytes"),
            Self::InvalidUtf8(error) => write!(formatter, "invalid UTF-8 string: {error}"),
            Self::UnexpectedMessageId(id) => write!(formatter, "unexpected message id: {id}"),
            Self::TrailingBytes(count) => write!(formatter, "packet has {count} trailing bytes"),
            Self::CurrentExecutable(error) => {
                write!(formatter, "cannot resolve target executable path: {error}")
            }
            Self::HostSendFailed(error) => {
                write!(
                    formatter,
                    "cannot send packet to Electron overlay host: {error}"
                )
            }
            Self::HostRejectedMessage => {
                formatter.write_str("Electron overlay host rejected message")
            }
        }
    }
}

fn wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drag_intent(sequence: u64) -> DragMoveIntent {
        DragMoveIntent {
            window_id: 42,
            placement_epoch: 7,
            drag_session: 3,
            sequence,
            x: sequence as i32,
            y: -(sequence as i32),
            terminal: false,
        }
    }

    #[test]
    fn failed_drag_wake_cannot_erase_a_newer_producer_intent() {
        let drag = SharedDragState::default();
        let first_drag = drag.clone();
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_failure_tx, release_failure_rx) = mpsc::channel();
        let first = thread::spawn(move || {
            first_drag.enqueue_and_wake(drag_intent(1), || {
                first_entered_tx.send(()).unwrap();
                release_failure_rx.recv().unwrap();
                Err("post failed")
            })
        });
        first_entered_rx.recv().unwrap();

        let second_drag = drag.clone();
        let (second_started_tx, second_started_rx) = mpsc::channel();
        let (second_posted_tx, second_posted_rx) = mpsc::channel();
        let second = thread::spawn(move || {
            second_started_tx.send(()).unwrap();
            second_drag.enqueue_and_wake(drag_intent(2), || {
                second_posted_tx.send(()).unwrap();
                Ok::<(), &'static str>(())
            })
        });
        second_started_rx.recv().unwrap();

        // Producer one still owns the slot while its asynchronous post call is
        // unresolved. Its failure reset completes before producer two can
        // replace the payload, so producer two performs a fresh wake.
        release_failure_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap(), Err("post failed"));
        assert_eq!(second.join().unwrap(), Ok(()));
        second_posted_rx.recv().unwrap();
        assert_eq!(drag.take_pending(), Some(drag_intent(2)));
    }

    #[test]
    fn successful_drag_wake_coalesces_to_latest_intent_until_worker_take() {
        let drag = SharedDragState::default();
        let mut wake_count = 0;
        assert_eq!(
            drag.enqueue_and_wake(drag_intent(1), || {
                wake_count += 1;
                Ok::<(), ()>(())
            }),
            Ok(())
        );
        assert_eq!(
            drag.enqueue_and_wake(drag_intent(2), || -> Result<(), ()> {
                panic!("an outstanding wake must suppress duplicate posts")
            }),
            Ok(())
        );
        assert_eq!(wake_count, 1);
        assert_eq!(drag.take_pending(), Some(drag_intent(2)));

        assert_eq!(
            drag.enqueue_and_wake(drag_intent(3), || {
                wake_count += 1;
                Ok::<(), ()>(())
            }),
            Ok(())
        );
        assert_eq!(wake_count, 2);
        assert_eq!(drag.take_pending(), Some(drag_intent(3)));
    }

    fn window_metadata(window_id: u32, name: &str, x: i32) -> WindowMetadata {
        WindowMetadata {
            window_id,
            name: name.to_owned(),
            transparent: true,
            buffer_name: format!("buffer-{window_id}"),
            rect: ElectronWindowRect {
                x,
                y: 20,
                width: 640,
                height: 360,
            },
            caption: None,
        }
    }

    fn normalize_test_windows(
        windows: Vec<WindowMetadata>,
        filter: Option<&str>,
    ) -> Vec<RegisteredWindow> {
        let mut placement_epoch = 0;
        normalize_registered_windows(windows, filter, &mut placement_epoch)
    }

    #[test]
    fn overlay_packet_round_trip_layout_matches_legacy_packer() {
        let mut bytes = Vec::new();
        push_i32(&mut bytes, IPC_DIRECTION_HOST);
        push_i32(&mut bytes, 7);
        push_i32(&mut bytes, 9);
        push_i32(&mut bytes, IPC_MESSAGE_ID);
        push_string(&mut bytes, "window.framebuffer").unwrap();
        push_string(&mut bytes, r#"{"type":"window.framebuffer","windowId":42}"#).unwrap();

        let packet = decode_overlay_packet(&bytes).unwrap();
        assert_eq!(packet.direction, IPC_DIRECTION_HOST);
        assert_eq!(packet.message_type, "window.framebuffer");
        assert_eq!(
            packet.json,
            r#"{"type":"window.framebuffer","windowId":42}"#
        );
    }

    #[test]
    fn outbound_input_uses_the_existing_client_envelope_and_json_contract() {
        let outbound = OutboundMessage::Input {
            window_id: 42,
            msg: 0x0200,
            wparam: 5,
            lparam: 0xfff6_000a,
        };
        let (message_type, json) = outbound_message_payload(&outbound);
        let bytes = encode_overlay_packet(IPC_DIRECTION_CLIENT, message_type, &json).unwrap();
        let packet = decode_overlay_packet(&bytes).unwrap();

        assert_eq!(packet.direction, IPC_DIRECTION_CLIENT);
        assert_eq!(packet.message_type, "game.input");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&packet.json).unwrap(),
            serde_json::json!({
                "type": "game.input",
                "windowId": 42,
                "msg": 0x0200,
                "wparam": 5,
                "lparam": 0xfff6_000a_u32,
            })
        );
    }

    #[test]
    fn send_failures_retry_only_idempotent_control_packets() {
        let send_failure =
            PacketError::HostSendFailed(WindowsError::from_hresult(windows::core::HRESULT(-1)));
        let input = OutboundMessage::Input {
            window_id: 42,
            msg: 0x0201,
            wparam: 0,
            lparam: 0,
        };
        let focus = OutboundMessage::WindowFocused {
            focus_window_id: 42,
        };
        let intercept = OutboundMessage::InputIntercept { intercepting: true };

        assert!(!should_retry_outbound(&input, &send_failure));
        assert!(should_retry_outbound(&focus, &send_failure));
        assert!(should_retry_outbound(&intercept, &send_failure));
        assert!(!should_retry_outbound(
            &intercept,
            &PacketError::HostRejectedMessage
        ));
    }

    #[test]
    fn malformed_packet_lengths_are_rejected() {
        let mut bytes = Vec::new();
        push_i32(&mut bytes, IPC_DIRECTION_HOST);
        push_i32(&mut bytes, 0);
        push_i32(&mut bytes, 0);
        push_i32(&mut bytes, IPC_MESSAGE_ID);
        push_i32(&mut bytes, -1);

        assert!(matches!(
            decode_overlay_packet(&bytes),
            Err(PacketError::NegativeLength(-1))
        ));
    }

    #[test]
    fn premultiplied_bgra_is_unpremultiplied_and_swizzled() {
        let bgra = [
            1, 2, 3, 255, 200, 150, 100, 0, 25, 50, 100, 128, 250, 0, 0, 10,
        ];

        assert_eq!(
            premultiplied_bgra_to_straight_rgba(&bgra),
            vec![3, 2, 1, 255, 0, 0, 0, 0, 199, 100, 50, 128, 0, 0, 255, 10,]
        );
    }

    #[test]
    fn window_packet_preserves_caption_geometry_for_native_drag_hit_testing() {
        let json = r#"{
            "windowId":42,
            "name":"Draggable",
            "transparent":true,
            "bufferName":"caption-buffer",
            "rect":{"x":64,"y":72,"width":640,"height":360},
            "caption":{"left":10,"right":12,"top":8,"height":40}
        }"#;
        let metadata: WindowMetadata = serde_json::from_str(json).unwrap();
        let registered = RegisteredWindow::from_metadata(metadata, 17);

        assert_eq!(registered.placement_epoch, 17);
        assert_eq!(
            registered.caption,
            Some(InputCaption {
                left: 10,
                right: 12,
                top: 8,
                height: 40,
            })
        );
    }

    #[test]
    fn overlay_init_preserves_back_to_front_order_and_last_duplicate_position() {
        let windows = normalize_test_windows(
            vec![
                window_metadata(10, "Back", 10),
                window_metadata(20, "Middle", 20),
                window_metadata(10, "Back replacement", 99),
                window_metadata(30, "Front", 30),
            ],
            None,
        );

        assert_eq!(
            windows
                .iter()
                .map(|window| (window.window_id, window.name.as_str(), window.rect.x))
                .collect::<Vec<_>>(),
            vec![
                (20, "Middle", 20),
                (10, "Back replacement", 99),
                (30, "Front", 30),
            ]
        );
    }

    #[test]
    fn explicit_window_name_is_an_exact_filter_and_absent_filter_keeps_all() {
        let announced = || {
            vec![
                window_metadata(10, "ExampleMainOverlay", 10),
                window_metadata(20, "ExampleStatusOverlay", 20),
                window_metadata(30, "ExampleMainOverlay child", 30),
            ]
        };

        let all = normalize_test_windows(announced(), None);
        assert_eq!(all.len(), 3);

        let filtered = normalize_test_windows(announced(), Some("ExampleMainOverlay"));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].window_id, 10);
    }

    #[test]
    fn streamed_registration_deduplicates_and_appends_the_window_on_top() {
        let mut windows = normalize_test_windows(
            vec![
                window_metadata(10, "Back", 10),
                window_metadata(20, "Middle", 20),
                window_metadata(30, "Front", 30),
            ],
            None,
        );

        assert!(register_window_on_top(
            &mut windows,
            window_metadata(20, "Middle replacement", 88),
            99,
        ));
        assert_eq!(
            windows
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![10, 30, 20]
        );
        assert_eq!(windows.last().unwrap().name, "Middle replacement");
        assert_eq!(windows.last().unwrap().rect.x, 88);
        assert_eq!(windows.last().unwrap().placement_epoch, 99);
    }

    #[test]
    fn bounds_update_changes_only_target_metadata_and_keeps_stack_position() {
        let mut windows = normalize_test_windows(
            vec![
                window_metadata(10, "Back", 10),
                window_metadata(20, "Front", 20),
            ],
            None,
        );
        let replacement_rect = ElectronWindowRect {
            x: -12,
            y: 34,
            width: 800,
            height: 450,
        };

        assert_eq!(
            update_registered_window_bounds(
                &mut windows,
                WindowBoundsMessage {
                    window_id: 10,
                    rect: replacement_rect,
                    buffer_name: Some("replacement".to_owned()),
                },
                99,
            ),
            Some((true, true))
        );
        assert_eq!(
            windows
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![10, 20]
        );
        assert_eq!(windows[0].rect, replacement_rect);
        assert_eq!(windows[0].buffer_name, "replacement");
        assert_eq!(windows[0].placement_epoch, 99);
        assert_eq!(windows[1].rect.x, 20);
    }

    #[test]
    fn scene_snapshot_is_atomic_ordered_and_republishes_current_metadata() {
        let mut invalid = window_metadata(40, "Invalid", 40);
        invalid.rect.width = 0;
        let mut windows = normalize_test_windows(
            vec![
                window_metadata(10, "Back", 10),
                window_metadata(20, "Waiting", 20),
                window_metadata(30, "Front", 30),
                invalid,
            ],
            None,
        );
        let back_pixels: Arc<[u8]> = vec![10, 20, 30, 255].into();
        let front_pixels: Arc<[u8]> = vec![40, 50, 60, 128].into();
        windows[0].latest = Some(Arc::new(ElectronFrame {
            window_id: 10,
            name: "stale".to_owned(),
            rect: ElectronWindowRect::default(),
            transparent: false,
            state_revision: 1,
            sequence: 7,
            width: 1,
            height: 1,
            rgba: Arc::clone(&back_pixels),
        }));
        let front_rect = windows[2].rect;
        windows[2].latest = Some(Arc::new(ElectronFrame {
            window_id: 30,
            name: "Front".to_owned(),
            rect: front_rect,
            transparent: true,
            state_revision: 1,
            sequence: 9,
            width: 1,
            height: 1,
            rgba: Arc::clone(&front_pixels),
        }));
        let invalid_rect = windows[3].rect;
        windows[3].latest = Some(Arc::new(ElectronFrame {
            window_id: 40,
            name: "Invalid".to_owned(),
            rect: invalid_rect,
            transparent: true,
            state_revision: 1,
            sequence: 10,
            width: 1,
            height: 1,
            rgba: vec![70, 80, 90, 255].into(),
        }));

        let scene = build_scene_snapshot(&mut windows, 42);
        assert_eq!(scene.state_revision, 42);
        assert_eq!(
            scene
                .windows
                .iter()
                .map(|frame| frame.window_id)
                .collect::<Vec<_>>(),
            vec![10, 30]
        );
        assert_eq!(scene.windows[0].name, "Back");
        assert_eq!(scene.windows[0].rect.x, 10);
        assert!(scene.windows[0].transparent);
        assert_eq!(scene.windows[0].state_revision, 42);
        assert_eq!(scene.windows[0].sequence, 7);
        assert!(Arc::ptr_eq(&scene.windows[0].rgba, &back_pixels));
        assert_eq!(scene.windows[1].state_revision, 42);
        assert!(Arc::ptr_eq(&scene.windows[1].rgba, &front_pixels));
        assert_eq!(
            build_input_windows(&windows)
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![10, 30]
        );
    }

    #[test]
    fn bounds_packet_preserves_signed_rect_and_replacement_mapping() {
        let json = r#"{"type":"window.bounds","windowId":42,"rect":{"x":-12,"y":34,"width":800,"height":450},"bufferName":"replacement"}"#;
        let mut bytes = Vec::new();
        push_i32(&mut bytes, IPC_DIRECTION_HOST);
        push_i32(&mut bytes, 7);
        push_i32(&mut bytes, 9);
        push_i32(&mut bytes, IPC_MESSAGE_ID);
        push_string(&mut bytes, "window.bounds").unwrap();
        push_string(&mut bytes, json).unwrap();

        let packet = decode_overlay_packet(&bytes).unwrap();
        assert_eq!(packet.message_type, "window.bounds");
        let message: WindowBoundsMessage = serde_json::from_str(&packet.json).unwrap();
        assert_eq!(message.window_id, 42);
        assert_eq!(
            message.rect,
            ElectronWindowRect {
                x: -12,
                y: 34,
                width: 800,
                height: 450,
            }
        );
        assert_eq!(message.buffer_name.as_deref(), Some("replacement"));
    }
}
