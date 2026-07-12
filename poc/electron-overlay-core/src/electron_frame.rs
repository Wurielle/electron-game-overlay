//! Client for the Electron overlay host's authenticated loopback transport.
//!
//! A message-only window still serializes scene, input, and drag mutations on
//! one thread. Cross-process traffic uses framed TCP on the loopback interface.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::ffi::c_void;
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::Deserialize;
use tracing::{debug, info, warn};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetAncestor,
    GetForegroundWindow, GetMessageW, GetWindowLongPtrW, KillTimer, PostMessageW, PostQuitMessage,
    SetTimer, SetWindowLongPtrW, TranslateMessage, GA_ROOT, GWLP_USERDATA, GWLP_WNDPROC,
    HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WM_APP, WM_CLOSE, WM_TIMER, WS_POPUP,
};

use crate::electron_input::{
    AtomicInterceptionState, DragMoveIntent, InputCaption, InputPoint, InputRect, InputRouter,
    InputRouterState, InputWindow, OutboundMessage, OutboundQueue,
};
use crate::electron_wire::{encode_json, WireDecoder, WireFrame, WirePacket};

/// Optional exact window-name filter. When absent, every announced Electron
/// window participates in the scene.
///
/// The legacy environment variable name is part of the existing SDK contract
/// and is retained while the injected rendering backend is replaced.
pub const ELECTRON_WINDOW_NAME_ENV: &str = "HUDHOOK_ELECTRON_WINDOW";

const WM_BRIDGE_SHUTDOWN: u32 = WM_APP + 0x310;
const WM_BRIDGE_FLUSH_OUTBOUND: u32 = WM_BRIDGE_SHUTDOWN + 1;
const WM_BRIDGE_RAISE_WINDOW: u32 = WM_BRIDGE_FLUSH_OUTBOUND + 1;
const WM_BRIDGE_MOVE_WINDOW: u32 = WM_BRIDGE_RAISE_WINDOW + 1;
const WM_BRIDGE_INBOUND: u32 = WM_BRIDGE_MOVE_WINDOW + 1;
const CONNECT_TIMER_ID: usize = 1;
const OUTBOUND_RETRY_TIMER_ID: usize = 2;
const CONNECT_RETRY_MILLIS: u32 = 500;
const OUTBOUND_RETRY_MILLIS: u32 = 250;
const CONNECT_TIMEOUT_MILLIS: u64 = 250;
const NETWORK_IDLE_MILLIS: u64 = 2;
const NETWORK_COMMAND_CAPACITY: usize = 256;
const NETWORK_INBOUND_CAPACITY: usize = 8;
const TRANSPORT_VERSION: u32 = 1;
const DISCOVERY_DIRECTORY: &str = "electron-game-overlay";
// This legacy filename is an existing producer protocol detail. Changing it
// requires a coordinated SDK migration, not a rendering-backend change.
const DISCOVERY_FILE: &str = "hudhook-transport-v1.json";
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

/// One immutable frame received from the Electron loopback host.
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
/// framebuffer has been received; registration metadata remains in the bridge so
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

/// Owns the background Win32 state thread and exposes its most recent frame.
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
    /// Starts the state and loopback transport worker.
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
            .name("electron-overlay-frame".to_owned())
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
    /// native filter through its guarded transition state machine.
    pub fn desired_interception(&self) -> bool {
        self.interception.desired()
    }

    /// Publishes whether the target game window is currently focused.
    ///
    /// Injected backends that observe focus outside the routed Win32 message
    /// stream use this explicit seam. Any resulting Electron focus or cleanup
    /// packets retain the same ordering and asynchronous delivery guarantees as
    /// messages routed through [`Self::route_window_message`].
    pub fn set_target_focused(&self, focused: bool) {
        let has_messages = {
            let _order = self
                .input_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let messages = self
                .input_router
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .set_target_focused(focused);
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

    /// Commits the routing/acknowledgement policy for the filter phase the
    /// backend just published and queues any resulting cleanup/control packets.
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

    /// Routes one message observed by the injected backend and wakes the
    /// transport worker for any resulting Electron packets. No synchronous
    /// cross-process send happens on the render/present thread.
    pub fn route_window_message(&self, hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) {
        let (has_messages, raised_window, drag_wake_error) = {
            // State mutation and queue publication share this lock with transport
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
            warn!(
                ?error,
                "Cannot wake Electron transport worker for outbound input"
            );
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
                warn!("Electron frame bridge state thread panicked during shutdown");
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
    let title = wide_string(&format!("electron-overlay-frame-{}", unsafe {
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
                "cannot create Electron frame state window: {error}"
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

        SetTimer(Some(hwnd), CONNECT_TIMER_ID, CONNECT_RETRY_MILLIS, None);
        (*state_ptr).try_connect();
    }

    info!(
        target_window = window_name_filter.as_deref().unwrap_or("<all>"),
        "Electron frame bridge state thread started"
    );

    if ready_tx.send(Ok(hwnd.0 as usize)).is_err() {
        unsafe {
            (*state_ptr).disconnect();
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
            (*state_ptr).disconnect();
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            let _ = DestroyWindow(hwnd);
        }
        drop(Box::from_raw(state_ptr));
    }

    debug!("Electron frame bridge state thread stopped");
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
        WM_BRIDGE_INBOUND => {
            if let Some(state) = state_ptr.as_mut() {
                state.drain_inbound();
            }
            return LRESULT(0);
        }
        WM_BRIDGE_FLUSH_OUTBOUND => {
            if let Some(state) = state_ptr.as_mut() {
                if state.flush_outbound() {
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
                state.disconnect();
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

struct TcpTransport {
    generation: u64,
    commands: mpsc::SyncSender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

enum NetworkInbound {
    Packet { generation: u64, packet: WirePacket },
    Closed { generation: u64, reason: String },
}

#[derive(Deserialize)]
struct DiscoveryDocument {
    version: u32,
    pid: u32,
    port: u16,
    token: String,
}

struct BridgeThreadState {
    hwnd: HWND,
    transport: Option<TcpTransport>,
    inbound_tx: mpsc::SyncSender<NetworkInbound>,
    inbound_rx: mpsc::Receiver<NetworkInbound>,
    connection_generation: u64,
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
        let (inbound_tx, inbound_rx) = mpsc::sync_channel(NETWORK_INBOUND_CAPACITY);
        Self {
            hwnd,
            transport: None,
            inbound_tx,
            inbound_rx,
            connection_generation: 0,
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
            closed_windows: HashMap::new(),
            placement_epoch: 0,
        }
    }

    unsafe fn try_connect(&mut self) {
        if self.transport.is_some() {
            return;
        }

        let discovery = match read_discovery_document() {
            Ok(discovery) => discovery,
            Err(error) => {
                debug!(%error, "Electron overlay transport discovery is not ready");
                return;
            }
        };
        let current_pid = GetCurrentProcessId();
        if discovery.version != TRANSPORT_VERSION {
            debug!(
                version = discovery.version,
                expected_version = TRANSPORT_VERSION,
                producer_pid = discovery.pid,
                target_pid = current_pid,
                "Ignoring Electron overlay transport discovery for another protocol version"
            );
            return;
        }
        if discovery.token.is_empty() || discovery.port == 0 {
            debug!("Ignoring incomplete Electron overlay transport discovery document");
            return;
        }

        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, discovery.port);
        let stream = match TcpStream::connect_timeout(
            &address.into(),
            Duration::from_millis(CONNECT_TIMEOUT_MILLIS),
        ) {
            Ok(stream) => stream,
            Err(error) => {
                debug!(?address, %error, "Cannot connect to Electron overlay loopback transport yet");
                return;
            }
        };
        if let Err(error) = stream.set_nodelay(true) {
            debug!(%error, "Cannot disable Electron overlay transport Nagle buffering");
        }
        if let Err(error) = stream.set_nonblocking(true) {
            warn!(%error, "Cannot configure Electron overlay transport as nonblocking");
            return;
        }

        let hello = match game_process_packet(&discovery.token) {
            Ok(packet) => packet,
            Err(error) => {
                warn!(%error, "Cannot build Electron overlay transport process hello");
                return;
            }
        };
        self.connection_generation = self.connection_generation.wrapping_add(1).max(1);
        let generation = self.connection_generation;
        let transport = match start_network_worker(
            self.hwnd,
            generation,
            stream,
            hello,
            self.inbound_tx.clone(),
        ) {
            Ok(transport) => transport,
            Err(error) => {
                warn!(%error, "Cannot start Electron overlay loopback transport worker");
                return;
            }
        };

        self.transport = Some(transport);
        let _ = KillTimer(Some(self.hwnd), CONNECT_TIMER_ID);
        info!(
            host_port = discovery.port,
            producer_pid = discovery.pid,
            target_pid = current_pid,
            "Electron frame bridge connected to overlay transport"
        );
        let _ = PostMessageW(
            Some(self.hwnd),
            WM_BRIDGE_FLUSH_OUTBOUND,
            WPARAM(0),
            LPARAM(0),
        );
    }

    fn disconnect(&mut self) {
        if let Some(transport) = self.transport.take() {
            let TcpTransport {
                commands,
                stop,
                thread,
                ..
            } = transport;
            stop.store(true, Ordering::Release);
            drop(commands);
            if thread.join().is_err() {
                warn!("Electron overlay transport worker panicked during shutdown");
            }
        }
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

    unsafe fn drain_inbound(&mut self) {
        while let Ok(message) = self.inbound_rx.try_recv() {
            match message {
                NetworkInbound::Packet { generation, packet }
                    if self
                        .transport
                        .as_ref()
                        .is_some_and(|transport| transport.generation == generation) =>
                {
                    match packet {
                        WirePacket::Json(json) => self.dispatch_json(&json),
                        WirePacket::Frame(frame) => {
                            if let Err(error) = self.on_frame(frame) {
                                warn!(%error, "Cannot process Electron overlay frame");
                            }
                        }
                    }
                }
                NetworkInbound::Closed { generation, reason }
                    if self
                        .transport
                        .as_ref()
                        .is_some_and(|transport| transport.generation == generation) =>
                {
                    warn!(%reason, "Electron overlay loopback transport disconnected");
                    self.disconnect();
                    let _ = KillTimer(Some(self.hwnd), OUTBOUND_RETRY_TIMER_ID);
                    SetTimer(
                        Some(self.hwnd),
                        CONNECT_TIMER_ID,
                        CONNECT_RETRY_MILLIS,
                        None,
                    );
                }
                _ => {}
            }
        }
    }

    fn dispatch_json(&mut self, json: &str) {
        let message_type = match serde_json::from_str::<MessageEnvelope>(json) {
            Ok(message) => message.message_type,
            Err(error) => {
                warn!(%error, "Ignoring malformed Electron overlay transport JSON packet");
                return;
            }
        };
        self.dispatch(&message_type, json);
    }

    unsafe fn flush_outbound(&mut self) -> bool {
        let Some(commands) = self
            .transport
            .as_ref()
            .map(|transport| transport.commands.clone())
        else {
            return true;
        };

        loop {
            let Some(message) = self
                .outbound
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front()
            else {
                return true;
            };
            let (_, json) = outbound_message_payload(&message);
            let packet = match encode_json(&json) {
                Ok(packet) => packet,
                Err(error) => {
                    warn!(%error, "Dropping invalid outbound Electron overlay transport packet");
                    continue;
                }
            };

            match commands.try_send(packet) {
                Ok(()) => self.outbound_diagnostics.record(&message),
                Err(mpsc::TrySendError::Full(_)) => {
                    self.outbound
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push_front(message);
                    return false;
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    // The worker may have written any prefix of this packet.
                    // Drop it and all worker-owned packets on reconnect so
                    // mouse/key events remain at-most-once.
                    warn!("Dropping outbound packet after Electron overlay transport failure");
                    self.disconnect();
                    let _ = KillTimer(Some(self.hwnd), OUTBOUND_RETRY_TIMER_ID);
                    SetTimer(
                        Some(self.hwnd),
                        CONNECT_TIMER_ID,
                        CONNECT_RETRY_MILLIS,
                        None,
                    );
                    return true;
                }
            }
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
                "Electron overlay metadata selected"
            );
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
                "Electron overlay metadata reselected"
            );
        } else {
            info!(
                window_id,
                window_name = %registered.name,
                "Electron overlay metadata selected"
            );
        }
        Ok(())
    }

    fn on_window_bounds(&mut self, message: WindowBoundsMessage) -> Result<(), TransportError> {
        let window_id = message.window_id;
        let rect = message.rect;
        let placement_epoch = advance_epoch(&mut self.placement_epoch);
        let Some((_raster_reset, _was_routable)) =
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
            warn!(
                ?error,
                "Cannot wake Electron transport worker for outbound input"
            );
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
                warn!(
                    ?error,
                    "Cannot wake Electron transport worker for outbound input"
                );
            }
        }
    }

    fn on_frame(&mut self, frame: WireFrame) -> Result<(), TransportError> {
        let WireFrame {
            window_id,
            width,
            height,
            bgra,
        } = frame;
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL))
            .ok_or(TransportError::FrameDimensionsOverflow { width, height })?;
        if bgra.len() != expected {
            return Err(TransportError::FrameLengthMismatch {
                width,
                height,
                expected,
                actual: bgra.len(),
            });
        }
        let Some(index) = self
            .windows
            .iter()
            .position(|window| window.window_id == window_id)
        else {
            debug!(
                window_id,
                "Ignoring frame for an unregistered Electron window"
            );
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
                "Electron frame received from overlay transport"
            );
        }

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
    windows: Vec<WindowMetadata>,
}

#[derive(Deserialize)]
struct MessageEnvelope {
    #[serde(rename = "type")]
    message_type: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowMetadata {
    window_id: u32,
    name: String,
    #[serde(default)]
    transparent: bool,
    rect: ElectronWindowRect,
    #[serde(default)]
    caption: Option<WindowCaptionMetadata>,
    #[serde(default)]
    scale_factor_micros: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
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
    max_width: Option<u32>,
    #[serde(default)]
    max_height: Option<u32>,
    #[serde(default)]
    min_width: Option<u32>,
    #[serde(default)]
    min_height: Option<u32>,
    #[serde(default)]
    drag_border_width: Option<u32>,
    #[serde(default)]
    caption: Option<WindowCaptionMetadata>,
    #[serde(default)]
    scale_factor_micros: Option<u32>,
    #[serde(default)]
    raster_changed: Option<bool>,
}

#[derive(Deserialize)]
struct InputInterceptCommand {
    intercept: bool,
}

struct RegisteredWindow {
    window_id: u32,
    latest: Option<Arc<ElectronFrame>>,
    name: String,
    rect: ElectronWindowRect,
    transparent: bool,
    caption: Option<InputCaption>,
    scale_factor_micros: Option<u32>,
    placement_epoch: u64,
}

impl RegisteredWindow {
    fn from_metadata(window: WindowMetadata, placement_epoch: u64) -> Self {
        Self {
            window_id: window.window_id,
            latest: None,
            name: window.name,
            rect: window.rect,
            transparent: window.transparent,
            caption: window.caption.map(InputCaption::from),
            scale_factor_micros: window.scale_factor_micros,
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
            .with_scale_factor_micros(self.scale_factor_micros)
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
    let WindowBoundsMessage {
        window_id,
        rect,
        max_width: _max_width,
        max_height: _max_height,
        min_width: _min_width,
        min_height: _min_height,
        drag_border_width: _drag_border_width,
        caption,
        scale_factor_micros,
        raster_changed,
    } = message;
    let window = windows
        .iter_mut()
        .find(|window| window.window_id == window_id)?;
    let was_routable = InputRect::from(window.rect).is_valid();
    window.rect = rect;
    if let Some(caption) = caption {
        window.caption = Some(caption.into());
    }
    if let Some(scale_factor_micros) = scale_factor_micros {
        window.scale_factor_micros = Some(scale_factor_micros);
    }
    if raster_changed.unwrap_or(false) {
        window.latest = None;
    }
    window.placement_epoch = placement_epoch;
    Some((raster_changed.unwrap_or(false), was_routable))
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

#[derive(Debug)]
enum TransportError {
    FrameDimensionsOverflow {
        width: u32,
        height: u32,
    },
    FrameLengthMismatch {
        width: u32,
        height: u32,
        expected: usize,
        actual: usize,
    },
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FrameDimensionsOverflow { width, height } => {
                write!(formatter, "frame dimensions overflow: {width}x{height}")
            }
            Self::FrameLengthMismatch {
                width,
                height,
                expected,
                actual,
            } => write!(
                formatter,
                "frame {width}x{height} needs {expected} BGRA bytes, received {actual}"
            ),
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

        let Some((window_id, msg, wparam, lparam, _scale_factor_micros)) = message.input_fields()
        else {
            return;
        };
        if (0x0200..=0x020e).contains(&msg) && !self.first_mouse_logged.swap(true, Ordering::AcqRel)
        {
            info!(
                window_id,
                win32_message = msg,
                "Electron mouse input forwarded"
            );
        }
        if matches!(msg, 0x0201..=0x0209) || (msg == 0x0200 && wparam & 0x0013 != 0) {
            let x = i32::from((lparam as u16) as i16);
            let y = i32::from(((lparam >> 16) as u16) as i16);
            info!(
                window_id,
                win32_message = msg,
                x,
                y,
                "Electron pointer input forwarded"
            );
        }
        match msg {
            0x0201 => info!(window_id, "Electron left mouse down forwarded"),
            0x0202 => info!(window_id, "Electron left mouse up forwarded"),
            _ => {}
        }
        if (0x0100..=0x0109).contains(&msg)
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
        OutboundMessage::TaggedInput {
            window_id,
            msg,
            wparam,
            lparam,
            scale_factor_micros,
        } => (
            "game.input",
            serde_json::json!({
                "type": "game.input",
                "windowId": window_id,
                "msg": msg,
                "wparam": wparam,
                "lparam": lparam,
                "scaleFactorMicros": scale_factor_micros,
            })
            .to_string(),
        ),
    }
}

fn discovery_path() -> PathBuf {
    std::env::temp_dir()
        .join(DISCOVERY_DIRECTORY)
        .join(DISCOVERY_FILE)
}

fn read_discovery_document() -> Result<DiscoveryDocument, DiscoveryError> {
    let path = discovery_path();
    let bytes = fs::read(&path).map_err(|source| DiscoveryError::Read { path, source })?;
    serde_json::from_slice(&bytes).map_err(DiscoveryError::Json)
}

fn game_process_packet(token: &str) -> Result<Vec<u8>, NetworkError> {
    let path = std::env::current_exe()
        .map_err(NetworkError::CurrentExecutable)?
        .to_string_lossy()
        .into_owned();
    let json = serde_json::json!({
        "type": "game.process",
        "protocolVersion": TRANSPORT_VERSION,
        "token": token,
        "pid": unsafe { GetCurrentProcessId() },
        "path": path,
    })
    .to_string();
    encode_json(&json).map_err(NetworkError::Wire)
}

fn start_network_worker(
    hwnd: HWND,
    generation: u64,
    stream: TcpStream,
    hello: Vec<u8>,
    inbound: mpsc::SyncSender<NetworkInbound>,
) -> Result<TcpTransport, io::Error> {
    let window = hwnd.0 as usize;
    let (commands, command_rx) = mpsc::sync_channel(NETWORK_COMMAND_CAPACITY);
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("electron-overlay-tcp".to_owned())
        .spawn(move || {
            run_network_worker(
                window,
                generation,
                stream,
                hello,
                command_rx,
                inbound,
                worker_stop,
            )
        })?;
    Ok(TcpTransport {
        generation,
        commands,
        stop,
        thread,
    })
}

fn run_network_worker(
    window: usize,
    generation: u64,
    mut stream: TcpStream,
    hello: Vec<u8>,
    commands: mpsc::Receiver<Vec<u8>>,
    inbound: mpsc::SyncSender<NetworkInbound>,
    stop: Arc<AtomicBool>,
) {
    let mut writes = VecDeque::from([hello]);
    let mut write_offset = 0;
    let mut decoder = WireDecoder::default();
    let mut read_buffer = [0_u8; 64 * 1024];
    let close_reason = 'connected: loop {
        if stop.load(Ordering::Acquire) {
            break 'connected "shutdown requested".to_owned();
        }

        while writes.len() < NETWORK_COMMAND_CAPACITY {
            match commands.try_recv() {
                Ok(packet) => writes.push_back(packet),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    if stop.load(Ordering::Acquire) {
                        break 'connected "shutdown requested".to_owned();
                    }
                    break;
                }
            }
        }

        let mut made_progress = false;
        match flush_pending_writes(&mut stream, &mut writes, &mut write_offset) {
            Ok(progress) => made_progress |= progress,
            Err(error) => break 'connected format!("socket write failed: {error}"),
        }

        loop {
            match stream.read(&mut read_buffer) {
                Ok(0) => break 'connected "socket closed by host".to_owned(),
                Ok(read) => {
                    made_progress = true;
                    match decoder.push(&read_buffer[..read]) {
                        Ok(packets) => {
                            for packet in packets {
                                if !publish_inbound(
                                    window,
                                    &inbound,
                                    &stop,
                                    NetworkInbound::Packet { generation, packet },
                                ) {
                                    break 'connected "state thread unavailable".to_owned();
                                }
                            }
                        }
                        Err(error) => {
                            break 'connected format!("invalid host packet: {error}");
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => break 'connected format!("socket read failed: {error}"),
            }
        }

        if !made_progress {
            thread::sleep(Duration::from_millis(NETWORK_IDLE_MILLIS));
        }
    };

    let _ = stream.shutdown(Shutdown::Both);
    if !stop.load(Ordering::Acquire) {
        let _ = publish_inbound(
            window,
            &inbound,
            &stop,
            NetworkInbound::Closed {
                generation,
                reason: close_reason,
            },
        );
    }
}

fn flush_pending_writes(
    writer: &mut impl Write,
    writes: &mut VecDeque<Vec<u8>>,
    write_offset: &mut usize,
) -> io::Result<bool> {
    let mut made_progress = false;
    while let Some(packet) = writes.front() {
        match writer.write(&packet[*write_offset..]) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(written) => {
                made_progress = true;
                *write_offset += written;
                if *write_offset == packet.len() {
                    writes.pop_front();
                    *write_offset = 0;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(made_progress),
            Err(error) => return Err(error),
        }
    }
    Ok(made_progress)
}

fn publish_inbound(
    window: usize,
    inbound: &mpsc::SyncSender<NetworkInbound>,
    stop: &AtomicBool,
    mut message: NetworkInbound,
) -> bool {
    loop {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        match inbound.try_send(message) {
            Ok(()) => {
                let hwnd = HWND(window as *mut c_void);
                return unsafe {
                    PostMessageW(Some(hwnd), WM_BRIDGE_INBOUND, WPARAM(0), LPARAM(0)).is_ok()
                };
            }
            Err(mpsc::TrySendError::Full(returned)) => {
                message = returned;
                thread::sleep(Duration::from_millis(NETWORK_IDLE_MILLIS));
            }
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
        }
    }
}

#[derive(Debug)]
enum DiscoveryError {
    Read { path: PathBuf, source: io::Error },
    Json(serde_json::Error),
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, source } => {
                write!(formatter, "cannot read {}: {source}", path.display())
            }
            Self::Json(error) => write!(formatter, "invalid discovery JSON: {error}"),
        }
    }
}

#[derive(Debug)]
enum NetworkError {
    CurrentExecutable(io::Error),
    Wire(crate::electron_wire::WireError),
}

impl fmt::Display for NetworkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CurrentExecutable(error) => {
                write!(formatter, "cannot resolve target executable path: {error}")
            }
            Self::Wire(error) => error.fmt(formatter),
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
            rect: ElectronWindowRect {
                x,
                y: 20,
                width: 640,
                height: 360,
            },
            caption: None,
            scale_factor_micros: None,
        }
    }

    fn normalize_test_windows(
        windows: Vec<WindowMetadata>,
        filter: Option<&str>,
    ) -> Vec<RegisteredWindow> {
        let mut placement_epoch = 0;
        normalize_registered_windows(windows, filter, &mut placement_epoch)
    }

    fn test_bridge_state() -> BridgeThreadState {
        BridgeThreadState::new(
            HWND(std::ptr::null_mut()),
            Arc::new(RwLock::new(Arc::new(ElectronScene::default()))),
            Arc::new(Mutex::new(InputRouter::new())),
            Arc::new(Mutex::new(OutboundQueue::new())),
            Arc::new(Mutex::new(())),
            Arc::new(AtomicU64::new(0)),
            SharedDragState::default(),
        )
    }

    struct PartialWriter {
        bytes: Vec<u8>,
        block_next: bool,
    }

    impl Write for PartialWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.block_next {
                self.block_next = false;
                return Err(io::Error::from(io::ErrorKind::WouldBlock));
            }
            self.block_next = true;
            let written = bytes.len().min(3);
            self.bytes.extend_from_slice(&bytes[..written]);
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn partial_nonblocking_writes_resume_without_duplicating_packet_bytes() {
        let expected = [b"hello".as_slice(), b"input-event".as_slice()].concat();
        let mut writes = VecDeque::from([b"hello".to_vec(), b"input-event".to_vec()]);
        let mut offset = 0;
        let mut writer = PartialWriter {
            bytes: Vec::new(),
            block_next: false,
        };

        while !writes.is_empty() {
            flush_pending_writes(&mut writer, &mut writes, &mut offset).unwrap();
        }

        assert_eq!(offset, 0);
        assert_eq!(writer.bytes, expected);
    }

    #[test]
    fn process_hello_is_the_first_framed_authenticated_target_identity() {
        let token = "01".repeat(32);
        let packet = game_process_packet(&token).unwrap();
        let mut decoder = WireDecoder::default();
        let packets = decoder.push(&packet).unwrap();
        let WirePacket::Json(json) = &packets[0] else {
            panic!("expected JSON hello");
        };
        let value: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(value["type"], "game.process");
        assert_eq!(value["protocolVersion"], TRANSPORT_VERSION);
        assert_eq!(value["token"], token);
        assert_eq!(value["pid"], unsafe { GetCurrentProcessId() });
        assert!(value["path"].as_str().is_some_and(|path| !path.is_empty()));
    }

    #[test]
    fn direct_frame_makes_registered_window_compositable() {
        let mut state = test_bridge_state();
        state
            .on_overlay_init(OverlayInit {
                windows: vec![window_metadata(42, "Direct frame", 10)],
            })
            .unwrap();
        assert!(state.scene.read().unwrap().windows.is_empty());

        state
            .on_frame(WireFrame {
                window_id: 42,
                width: 1,
                height: 1,
                bgra: vec![25, 50, 100, 128],
            })
            .unwrap();

        let scene = state.scene.read().unwrap().clone();
        assert_eq!(scene.windows.len(), 1);
        assert_eq!(scene.windows[0].window_id, 42);
        assert_eq!(scene.windows[0].rgba.as_ref(), &[199, 100, 50, 128]);
    }

    #[test]
    fn disconnect_clears_pixels_and_fresh_snapshot_restores_them() {
        let mut state = test_bridge_state();
        state
            .on_overlay_init(OverlayInit {
                windows: vec![window_metadata(42, "Reconnect", 10)],
            })
            .unwrap();
        state
            .on_frame(WireFrame {
                window_id: 42,
                width: 1,
                height: 1,
                bgra: vec![1, 2, 3, 255],
            })
            .unwrap();
        assert_eq!(state.scene.read().unwrap().windows.len(), 1);

        state.disconnect();
        assert!(state.scene.read().unwrap().windows.is_empty());
        assert!(state.windows.is_empty());

        state
            .on_overlay_init(OverlayInit {
                windows: vec![window_metadata(42, "Reconnect", 10)],
            })
            .unwrap();
        assert!(state.scene.read().unwrap().windows.is_empty());
        state
            .on_frame(WireFrame {
                window_id: 42,
                width: 1,
                height: 1,
                bgra: vec![4, 5, 6, 255],
            })
            .unwrap();
        assert_eq!(state.scene.read().unwrap().windows.len(), 1);
    }

    #[test]
    fn outbound_input_uses_framed_json_and_preserves_the_event_contract() {
        let outbound = OutboundMessage::Input {
            window_id: 42,
            msg: 0x0200,
            wparam: 5,
            lparam: 0xfff6_000a,
        };
        let (message_type, json) = outbound_message_payload(&outbound);
        let bytes = encode_json(&json).unwrap();
        let mut decoder = WireDecoder::default();
        let packets = decoder.push(&bytes).unwrap();
        let WirePacket::Json(packet_json) = &packets[0] else {
            panic!("expected JSON packet");
        };

        assert_eq!(message_type, "game.input");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(packet_json).unwrap(),
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
    fn tagged_outbound_input_serializes_scale_while_legacy_input_omits_it() {
        let tagged = OutboundMessage::TaggedInput {
            window_id: 42,
            msg: 0x0200,
            wparam: 5,
            lparam: 0xfff6_000a,
            scale_factor_micros: 1_250_000,
        };
        let (_, tagged_json) = outbound_message_payload(&tagged);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&tagged_json).unwrap(),
            serde_json::json!({
                "type": "game.input",
                "windowId": 42,
                "msg": 0x0200,
                "wparam": 5,
                "lparam": 0xfff6_000a_u32,
                "scaleFactorMicros": 1_250_000,
            })
        );

        let legacy = OutboundMessage::Input {
            window_id: 42,
            msg: 0x0200,
            wparam: 5,
            lparam: 0xfff6_000a,
        };
        let (_, legacy_json) = outbound_message_payload(&legacy);
        assert!(serde_json::from_str::<serde_json::Value>(&legacy_json)
            .unwrap()
            .get("scaleFactorMicros")
            .is_none());
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
            "rect":{"x":64,"y":72,"width":640,"height":360},
            "caption":{"left":10,"right":12,"top":8,"height":40},
            "scaleFactorMicros":1250000
        }"#;
        let metadata: WindowMetadata = serde_json::from_str(json).unwrap();
        let registered = RegisteredWindow::from_metadata(metadata, 17);

        assert_eq!(registered.placement_epoch, 17);
        assert_eq!(registered.scale_factor_micros, Some(1_250_000));
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
                    max_width: None,
                    max_height: None,
                    min_width: None,
                    min_height: None,
                    drag_border_width: None,
                    caption: None,
                    scale_factor_micros: None,
                    raster_changed: None,
                },
                99,
            ),
            Some((false, true))
        );
        assert_eq!(
            windows
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![10, 20]
        );
        assert_eq!(windows[0].rect, replacement_rect);
        assert_eq!(windows[0].placement_epoch, 99);
        assert_eq!(windows[1].rect.x, 20);
    }

    #[test]
    fn bounds_update_applies_scaled_caption_with_rect_without_reordering() {
        let mut back = window_metadata(10, "Back", 10);
        back.caption = Some(WindowCaptionMetadata {
            left: 10,
            right: 10,
            top: 10,
            height: 40,
        });
        let mut windows =
            normalize_test_windows(vec![back, window_metadata(20, "Front", 20)], None);
        windows[0].latest = Some(Arc::new(ElectronFrame {
            window_id: 10,
            name: "Back".to_owned(),
            rect: windows[0].rect,
            transparent: true,
            state_revision: 1,
            sequence: 1,
            width: 640,
            height: 360,
            rgba: vec![1, 2, 3, 255].into(),
        }));
        let message: WindowBoundsMessage = serde_json::from_str(
            r#"{
                "type":"window.bounds",
                "windowId":10,
                "rect":{"x":15,"y":30,"width":960,"height":540},
                "maxWidth":2880,
                "maxHeight":1620,
                "minWidth":150,
                "minHeight":150,
                "dragBorderWidth":15,
                "caption":{"left":15,"right":15,"top":15,"height":60},
                "scaleFactorMicros":1500000,
                "rasterChanged":true
            }"#,
        )
        .unwrap();

        assert_eq!(message.max_width, Some(2880));
        assert_eq!(message.max_height, Some(1620));
        assert_eq!(message.min_width, Some(150));
        assert_eq!(message.min_height, Some(150));
        assert_eq!(message.drag_border_width, Some(15));
        assert_eq!(message.scale_factor_micros, Some(1_500_000));
        assert_eq!(message.raster_changed, Some(true));
        assert_eq!(
            message.caption,
            Some(WindowCaptionMetadata {
                left: 15,
                right: 15,
                top: 15,
                height: 60,
            })
        );
        assert_eq!(
            update_registered_window_bounds(&mut windows, message, 99),
            Some((true, true))
        );

        assert_eq!(
            windows
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![10, 20]
        );
        assert_eq!(
            windows[0].rect,
            ElectronWindowRect {
                x: 15,
                y: 30,
                width: 960,
                height: 540,
            }
        );
        assert_eq!(
            windows[0].caption,
            Some(InputCaption {
                left: 15,
                right: 15,
                top: 15,
                height: 60,
            })
        );
        assert_eq!(windows[0].placement_epoch, 99);
        assert_eq!(windows[0].scale_factor_micros, Some(1_500_000));
        assert!(windows[0].latest.is_none());
        assert_eq!(windows[1].rect.x, 20);
        assert_eq!(windows[1].caption, None);
        assert!(build_scene_snapshot(&mut windows, 2).windows.is_empty());
        assert!(build_input_windows(&windows).is_empty());

        windows[0].latest = Some(Arc::new(ElectronFrame {
            window_id: 10,
            name: "Back".to_owned(),
            rect: windows[0].rect,
            transparent: true,
            state_revision: 3,
            sequence: 2,
            width: 960,
            height: 540,
            rgba: vec![255; 960 * 540 * 4].into(),
        }));
        assert_eq!(
            build_scene_snapshot(&mut windows, 3)
                .windows
                .iter()
                .map(|frame| frame.window_id)
                .collect::<Vec<_>>(),
            vec![10]
        );
        assert_eq!(
            build_input_windows(&windows)
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![10]
        );
    }

    #[test]
    fn rect_only_bounds_update_retains_existing_caption_geometry() {
        let mut back = window_metadata(10, "Back", 10);
        back.scale_factor_micros = Some(1_000_000);
        back.caption = Some(WindowCaptionMetadata {
            left: 12,
            right: 14,
            top: 8,
            height: 44,
        });
        let mut windows =
            normalize_test_windows(vec![back, window_metadata(20, "Front", 20)], None);
        windows[0].latest = Some(Arc::new(ElectronFrame {
            window_id: 10,
            name: "Back".to_owned(),
            rect: windows[0].rect,
            transparent: true,
            state_revision: 1,
            sequence: 1,
            width: 640,
            height: 360,
            rgba: vec![1, 2, 3, 255].into(),
        }));
        let retained = Arc::clone(windows[0].latest.as_ref().unwrap());
        let message: WindowBoundsMessage = serde_json::from_str(
            r#"{
                "type":"window.bounds",
                "windowId":10,
                "rect":{"x":-12,"y":34,"width":800,"height":450}
            }"#,
        )
        .unwrap();

        assert_eq!(message.max_width, None);
        assert_eq!(message.max_height, None);
        assert_eq!(message.min_width, None);
        assert_eq!(message.min_height, None);
        assert_eq!(message.drag_border_width, None);
        assert_eq!(message.caption, None);
        assert_eq!(message.scale_factor_micros, None);
        assert_eq!(message.raster_changed, None);
        assert_eq!(
            update_registered_window_bounds(&mut windows, message, 100),
            Some((false, true))
        );

        assert_eq!(
            windows
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![10, 20]
        );
        assert_eq!(windows[0].rect.x, -12);
        assert_eq!(windows[0].rect.y, 34);
        assert_eq!(windows[0].rect.width, 800);
        assert_eq!(windows[0].rect.height, 450);
        assert_eq!(
            windows[0].caption,
            Some(InputCaption {
                left: 12,
                right: 14,
                top: 8,
                height: 44,
            })
        );
        assert_eq!(windows[0].placement_epoch, 100);
        assert_eq!(windows[0].scale_factor_micros, Some(1_000_000));
        assert!(Arc::ptr_eq(windows[0].latest.as_ref().unwrap(), &retained));
        assert_eq!(windows[1].rect.x, 20);
    }

    #[test]
    fn explicit_raster_unchanged_bounds_update_retains_latest_pixels() {
        let mut windows = normalize_test_windows(vec![window_metadata(10, "Back", 10)], None);
        windows[0].latest = Some(Arc::new(ElectronFrame {
            window_id: 10,
            name: "Back".to_owned(),
            rect: windows[0].rect,
            transparent: true,
            state_revision: 1,
            sequence: 1,
            width: 640,
            height: 360,
            rgba: vec![255; 640 * 360 * 4].into(),
        }));
        let retained = Arc::clone(windows[0].latest.as_ref().unwrap());
        let message: WindowBoundsMessage = serde_json::from_str(
            r#"{
                "type":"window.bounds",
                "windowId":10,
                "rect":{"x":25,"y":35,"width":640,"height":360},
                "rasterChanged":false
            }"#,
        )
        .unwrap();

        assert_eq!(message.raster_changed, Some(false));
        assert_eq!(
            update_registered_window_bounds(&mut windows, message, 101),
            Some((false, true))
        );
        assert!(Arc::ptr_eq(windows[0].latest.as_ref().unwrap(), &retained));
        assert_eq!(windows[0].rect.x, 25);
        assert_eq!(windows[0].rect.y, 35);
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
    fn bounds_packet_preserves_signed_rect_over_framed_json() {
        let json = r#"{"type":"window.bounds","windowId":42,"rect":{"x":-12,"y":34,"width":800,"height":450}}"#;
        let bytes = encode_json(json).unwrap();
        let mut decoder = WireDecoder::default();
        let packets = decoder.push(&bytes).unwrap();
        let WirePacket::Json(packet_json) = &packets[0] else {
            panic!("expected JSON packet");
        };
        let message: WindowBoundsMessage = serde_json::from_str(packet_json).unwrap();
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
    }
}
