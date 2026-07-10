//! Minimal client for the Electron overlay host's existing frame transport.
//!
//! The Node add-on owns the named mappings and sends low-volume control
//! messages through a message-only Win32 window. This module implements the
//! compatible client half without depending on the legacy injected renderer.

use std::error::Error;
use std::ffi::c_void;
use std::fmt;
use std::mem::size_of;
use std::slice;
use std::sync::{mpsc, Arc, RwLock};
use std::thread::{self, JoinHandle};

use hudhook::tracing::{debug, info, warn};
use serde::Deserialize;
use windows::core::{w, Error as WindowsError, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WAIT_ABANDONED, WAIT_OBJECT_0, WPARAM,
};
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
    FindWindowW, GetMessageW, GetWindowLongPtrW, KillTimer, PostMessageW, PostQuitMessage,
    SendMessageW, SetTimer, SetWindowLongPtrW, TranslateMessage, GWLP_USERDATA, GWLP_WNDPROC,
    HWND_MESSAGE, MSG, MSGFLT_ALLOW, WINDOW_EX_STYLE, WM_APP, WM_CLOSE, WM_COPYDATA, WM_TIMER,
    WS_POPUP,
};

/// The real client overlay preferred when no explicit override is configured.
pub const DEFAULT_ELECTRON_WINDOW_NAME: &str = "ExampleMainOverlay";

/// Optional exact window-name override used by the one-window compositor.
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
const CONNECT_TIMER_ID: usize = 1;
const CONNECT_RETRY_MILLIS: u32 = 500;
const FRAME_HEADER_SIZE: usize = size_of::<i32>() * 2;
const BYTES_PER_PIXEL: usize = 4;

type LatestFrame = Arc<RwLock<Option<Arc<ElectronFrame>>>>;

/// One immutable frame copied out of the Electron-owned shared mapping.
#[derive(Debug)]
pub struct ElectronFrame {
    pub window_id: u32,
    pub name: String,
    pub rect: ElectronWindowRect,
    pub transparent: bool,
    /// Changes whenever selection or placement state changes.
    pub state_revision: u64,
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<[u8]>,
}

/// Placement supplied by the Electron overlay host, in game-client pixels.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct ElectronWindowRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Owns the background Win32 IPC thread and exposes its most recent frame.
pub struct ElectronFrameBridge {
    latest: LatestFrame,
    window: usize,
    thread: Option<JoinHandle<()>>,
}

impl ElectronFrameBridge {
    /// Starts the IPC and shared-memory worker.
    pub fn spawn() -> Result<Self, ElectronFrameBridgeError> {
        let latest = Arc::new(RwLock::new(None));
        let worker_latest = Arc::clone(&latest);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);

        let thread = thread::Builder::new()
            .name("hudhook-electron-frame".to_owned())
            .spawn(move || run_bridge_thread(worker_latest, ready_tx))
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
            latest,
            window,
            thread: Some(thread),
        })
    }

    /// Alias for [`Self::spawn`] for conventional constructor call sites.
    #[allow(dead_code)]
    pub fn new() -> Result<Self, ElectronFrameBridgeError> {
        Self::spawn()
    }

    /// Returns a stable reference-counted snapshot of the latest frame.
    pub fn latest(&self) -> Option<Arc<ElectronFrame>> {
        self.latest
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Drop for ElectronFrameBridge {
    fn drop(&mut self) {
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

fn run_bridge_thread(latest: LatestFrame, ready_tx: mpsc::SyncSender<Result<usize, String>>) {
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

    let state = Box::new(BridgeThreadState::new(hwnd, latest));
    let preferred_window_name = state.preferred_window_name.clone();
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
        target_window = %preferred_window_name,
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
                SetTimer(Some(hwnd), CONNECT_TIMER_ID, CONNECT_RETRY_MILLIS, None);
            }
            return LRESULT(0);
        }
        WM_BRIDGE_SHUTDOWN | WM_CLOSE => {
            if let Some(state) = state_ptr.as_mut() {
                state.notify_host_of_close();
            }
            let _ = KillTimer(Some(hwnd), CONNECT_TIMER_ID);
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
    latest: LatestFrame,
    preferred_window_name: String,
    announced_windows: Vec<WindowMetadata>,
    state_revision: u64,
    sequence: u64,
    first_frame_logged: bool,
    mutex_name: Option<String>,
    frame_mutex: Option<NamedMutex>,
    selected: Option<SelectedWindow>,
    last_closed_window_name: Option<String>,
}

impl BridgeThreadState {
    fn new(hwnd: HWND, latest: LatestFrame) -> Self {
        Self {
            hwnd,
            host: None,
            connected: false,
            latest,
            preferred_window_name: preferred_window_name(),
            announced_windows: Vec::new(),
            state_revision: 0,
            sequence: 0,
            first_frame_logged: false,
            mutex_name: None,
            frame_mutex: None,
            selected: None,
            last_closed_window_name: None,
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
        self.announced_windows.clear();
        self.selected = None;
        self.last_closed_window_name = None;
        self.bump_state_revision();
        self.clear_latest();
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

        self.announced_windows = message.windows;
        self.last_closed_window_name = None;
        self.selected = None;
        self.bump_state_revision();
        self.clear_latest();

        let window =
            select_candidate(&self.announced_windows, &self.preferred_window_name).cloned();
        if let Some(window) = window {
            self.select_window(window)?;
        }

        Ok(())
    }

    fn on_window(&mut self, window: WindowMetadata) -> Result<(), TransportError> {
        let window_id = window.window_id;
        let readded_closed = self.last_closed_window_name.as_deref() == Some(window.name.as_str());
        if readded_closed {
            self.last_closed_window_name = None;
        }
        let reannounced_selected = self
            .selected
            .as_ref()
            .is_some_and(|selected| selected.window_id == window_id);
        let preferred_upgrade = window.name == self.preferred_window_name
            && self
                .selected
                .as_ref()
                .map(|selected| selected.name.as_str())
                != Some(self.preferred_window_name.as_str());
        let should_select =
            self.selected.is_none() || reannounced_selected || readded_closed || preferred_upgrade;

        upsert_announced_window(&mut self.announced_windows, window);
        if should_select {
            let candidate = if reannounced_selected {
                self.announced_windows
                    .iter()
                    .find(|window| window.window_id == window_id)
            } else {
                select_candidate(&self.announced_windows, &self.preferred_window_name)
            }
            .cloned();

            if let Some(window) = candidate {
                self.select_window_with_marker(window, reannounced_selected || readded_closed)?;
            }
        }

        Ok(())
    }

    fn on_framebuffer(&mut self, window_id: u32) -> Result<(), TransportError> {
        if self.selected.as_ref().map(|window| window.window_id) == Some(window_id) {
            self.read_selected_mapping()?;
        }
        Ok(())
    }

    fn on_window_bounds(&mut self, message: WindowBoundsMessage) -> Result<(), TransportError> {
        update_announced_window_bounds(&mut self.announced_windows, &message);

        let window_id = message.window_id;
        let rect = message.rect;
        {
            let Some(selected) = self.selected.as_mut() else {
                return Ok(());
            };
            if selected.window_id != window_id {
                return Ok(());
            }

            selected.rect = rect;
            if let Some(buffer_name) = message.buffer_name {
                if buffer_name != selected.buffer_name {
                    selected.buffer_name = buffer_name;
                    selected.mapping = None;
                }
            }
        }

        self.bump_state_revision();
        info!(
            window_id,
            x = rect.x,
            y = rect.y,
            width = rect.width,
            height = rect.height,
            "Electron overlay bounds updated"
        );
        self.republish_latest_metadata();

        Ok(())
    }

    fn on_window_close(&mut self, window_id: u32) -> Result<(), TransportError> {
        self.announced_windows
            .retain(|window| window.window_id != window_id);

        if self.selected.as_ref().map(|window| window.window_id) != Some(window_id) {
            return Ok(());
        }

        let closed = self
            .selected
            .take()
            .ok_or(TransportError::NoSelectedWindow)?;
        self.last_closed_window_name = Some(closed.name.clone());
        self.bump_state_revision();
        self.clear_latest();
        info!(
            window_id,
            window_name = %closed.name,
            "Electron overlay window closed"
        );

        let replacement =
            select_candidate(&self.announced_windows, &self.preferred_window_name).cloned();
        if let Some(window) = replacement {
            self.select_window(window)?;
        }

        Ok(())
    }

    fn select_window(&mut self, window: WindowMetadata) -> Result<(), TransportError> {
        self.select_window_with_marker(window, false)
    }

    fn select_window_with_marker(
        &mut self,
        window: WindowMetadata,
        reselected: bool,
    ) -> Result<(), TransportError> {
        if reselected {
            info!(
                window_id = window.window_id,
                window_name = %window.name,
                buffer_name = %window.buffer_name,
                "Electron overlay metadata reselected"
            );
        } else {
            info!(
                window_id = window.window_id,
                window_name = %window.name,
                buffer_name = %window.buffer_name,
                "Electron overlay metadata selected"
            );
        }

        self.bump_state_revision();
        self.clear_latest();
        self.selected = Some(SelectedWindow {
            window_id: window.window_id,
            name: window.name,
            rect: window.rect,
            transparent: window.transparent,
            buffer_name: window.buffer_name,
            mapping: None,
        });
        self.read_selected_mapping()
    }

    fn read_selected_mapping(&mut self) -> Result<(), TransportError> {
        self.ensure_frame_mutex()?;

        let selected = self
            .selected
            .as_mut()
            .ok_or(TransportError::NoSelectedWindow)?;
        if selected.mapping.is_none() {
            selected.mapping = Some(FrameMapping::open(&selected.buffer_name)?);
        }

        let mapping = selected
            .mapping
            .as_ref()
            .ok_or(TransportError::NoSelectedWindow)?;
        let mutex = self
            .frame_mutex
            .as_ref()
            .ok_or(TransportError::MutexUnavailable)?;
        let Some((width, height, bgra)) = mapping.copy_frame(mutex)? else {
            return Ok(());
        };
        let window_id = selected.window_id;
        let name = selected.name.clone();
        let rect = selected.rect;
        let transparent = selected.transparent;
        let rgba = premultiplied_bgra_to_straight_rgba(&bgra);

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
            rgba: rgba.into(),
        });

        *self
            .latest
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&frame));

        if !self.first_frame_logged {
            self.first_frame_logged = true;
            info!(
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

    fn republish_latest_metadata(&self) {
        let Some(selected) = self.selected.as_ref() else {
            return;
        };

        let current = self
            .latest
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(current) = current else {
            return;
        };
        if current.window_id != selected.window_id {
            return;
        }

        let frame = Arc::new(ElectronFrame {
            window_id: selected.window_id,
            name: selected.name.clone(),
            rect: selected.rect,
            transparent: selected.transparent,
            state_revision: self.state_revision,
            sequence: current.sequence,
            width: current.width,
            height: current.height,
            rgba: Arc::clone(&current.rgba),
        });
        *self
            .latest
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(frame);
    }

    fn clear_latest(&self) {
        *self
            .latest
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
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

struct SelectedWindow {
    window_id: u32,
    buffer_name: String,
    mapping: Option<FrameMapping>,
    name: String,
    rect: ElectronWindowRect,
    transparent: bool,
}

fn preferred_window_name() -> String {
    std::env::var(ELECTRON_WINDOW_NAME_ENV)
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ELECTRON_WINDOW_NAME.to_owned())
}

fn select_candidate<'a>(
    windows: &'a [WindowMetadata],
    preferred_window_name: &str,
) -> Option<&'a WindowMetadata> {
    windows
        .iter()
        .find(|window| window.name == preferred_window_name)
        .or_else(|| windows.first())
}

fn upsert_announced_window(windows: &mut Vec<WindowMetadata>, window: WindowMetadata) {
    if let Some(existing) = windows
        .iter_mut()
        .find(|existing| existing.window_id == window.window_id)
    {
        *existing = window;
    } else {
        windows.push(window);
    }
}

fn update_announced_window_bounds(windows: &mut [WindowMetadata], message: &WindowBoundsMessage) {
    if let Some(window) = windows
        .iter_mut()
        .find(|window| window.window_id == message.window_id)
    {
        window.rect = message.rect;
        if let Some(buffer_name) = message.buffer_name.as_ref() {
            window.buffer_name = buffer_name.clone();
        }
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
    let mut packet = Vec::with_capacity(json.len() + 64);
    push_i32(&mut packet, IPC_DIRECTION_CLIENT);
    push_i32(&mut packet, 0);
    push_i32(&mut packet, 0);
    push_i32(&mut packet, IPC_MESSAGE_ID);
    push_string(&mut packet, "game.process")?;
    push_string(&mut packet, &json)?;

    let copy_data = COPYDATASTRUCT {
        dwData: unsafe { GetCurrentProcessId() } as usize,
        cbData: packet
            .len()
            .try_into()
            .map_err(|_| PacketError::StringTooLong(packet.len()))?,
        lpData: packet.as_mut_ptr().cast(),
    };
    let result = unsafe {
        SendMessageW(
            host,
            WM_COPYDATA,
            None,
            Some(LPARAM((&copy_data as *const COPYDATASTRUCT) as isize)),
        )
    };
    if result.0 == 0 {
        Err(PacketError::HostRejectedMessage)
    } else {
        Ok(())
    }
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
        }
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
    fn selection_prefers_configured_name_and_falls_back_in_announcement_order() {
        let mut windows = vec![window_metadata(10, "Fallback", 10)];
        upsert_announced_window(&mut windows, window_metadata(20, "ExampleMainOverlay", 20));
        upsert_announced_window(&mut windows, window_metadata(10, "Fallback", 99));

        let preferred = select_candidate(&windows, "ExampleMainOverlay").unwrap();
        assert_eq!(preferred.window_id, 20);

        let fallback = select_candidate(&windows, "Missing").unwrap();
        assert_eq!(fallback.window_id, 10);
        assert_eq!(fallback.rect.x, 99);
        assert_eq!(
            windows
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            vec![10, 20]
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
