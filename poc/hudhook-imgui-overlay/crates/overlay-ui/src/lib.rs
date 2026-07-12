mod owned_input;

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use electron_overlay_core::{ElectronFrameBridge, ElectronScene};
use hudhook::imgui::{Condition, Context, Image, Io, StyleColor, TextureId, Ui, WindowFlags};
use hudhook::process_input::{
    ProcessInputCounters, ProcessMouseSuppression, ProcessRawMouseHandler,
};
use hudhook::sync_input::SynchronousWndProcHandler;
use hudhook::{ImguiRenderLoop, MessageFilter, RenderContext};
use owned_input::OwnedPointerInput;
use tracing_subscriber::EnvFilter;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};

const TEXTURE_WIDTH: u32 = 128;
const TEXTURE_HEIGHT: u32 = 128;
const INPUT_FILTER_DISABLED: u8 = 0;
const INPUT_FILTER_ARMING: u8 = 1;
const INPUT_FILTER_ENABLED: u8 = 2;
const INPUT_FILTER_DISARMING: u8 = 3;

#[derive(Default)]
struct ElectronTextureState {
    texture_id: Option<TextureId>,
    texture_size: Option<[u32; 2]>,
    last_attempted_sequence: u64,
    uploaded_sequence: u64,
    error: Option<String>,
}

const fn next_input_filter_phase(current_phase: u8, desired_interception: bool) -> u8 {
    match (current_phase, desired_interception) {
        (INPUT_FILTER_DISABLED, true) => INPUT_FILTER_ARMING,
        (INPUT_FILTER_ARMING, true) => INPUT_FILTER_ENABLED,
        (INPUT_FILTER_ARMING, false) => INPUT_FILTER_DISARMING,
        (INPUT_FILTER_ENABLED, true) => INPUT_FILTER_ENABLED,
        (INPUT_FILTER_ENABLED, false) => INPUT_FILTER_DISARMING,
        (INPUT_FILTER_DISARMING, true) => INPUT_FILTER_ARMING,
        (INPUT_FILTER_DISARMING, false) => INPUT_FILTER_DISABLED,
        _ => INPUT_FILTER_DISABLED,
    }
}

pub struct PocRenderLoop {
    backend_name: &'static str,
    pixels: Vec<u8>,
    texture_id: Option<TextureId>,
    texture_error: Option<String>,
    electron_bridge: Option<ElectronFrameBridge>,
    electron_bridge_error: Option<String>,
    electron_scene: Option<Arc<ElectronScene>>,
    electron_textures: HashMap<u32, ElectronTextureState>,
    electron_active_window_ids: Vec<u32>,
    electron_composed_window_ids: HashSet<u32>,
    electron_resume_pending: HashSet<u32>,
    electron_logged_scene_revision: u64,
    rendered_frames: u64,
    imgui_probe_click_count: u64,
    first_frame_logged: bool,
    last_display_size: Option<[f32; 2]>,
    framebuffer_scale_normalization_logged: bool,
    input_filter_phase: AtomicU8,
    sampled_input_filter_phase: AtomicU8,
    applied_input_filter: AtomicBool,
    process_mouse_suppression: Arc<ProcessMouseSuppression>,
    last_process_input_counters: ProcessInputCounters,
    last_process_input_report: Instant,
    owned_pointer_input: Arc<OwnedPointerInput>,
    owned_input_logged: bool,
}

impl PocRenderLoop {
    pub fn new(backend_name: &'static str) -> Self {
        let log_path = initialize_tracing();

        hudhook::tracing::info!(
            backend = backend_name,
            process_id = process::id(),
            log_path = ?log_path,
            "hudhook overlay initialization worker started"
        );

        let (electron_bridge, electron_bridge_error) = match ElectronFrameBridge::spawn() {
            Ok(bridge) => (Some(bridge), None),
            Err(error) => {
                hudhook::tracing::error!(%error, "Electron frame bridge failed to start");
                (None, Some(error.to_string()))
            }
        };

        let process_mouse_suppression = Arc::new(ProcessMouseSuppression::new());
        let owned_pointer_input = Arc::new(OwnedPointerInput::new(Arc::clone(
            &process_mouse_suppression,
        )));
        let process_raw_mouse_handler: Arc<dyn ProcessRawMouseHandler> =
            owned_pointer_input.clone();
        process_mouse_suppression.set_raw_mouse_handler(Arc::downgrade(&process_raw_mouse_handler));

        Self {
            backend_name,
            pixels: make_test_pattern(),
            texture_id: None,
            texture_error: None,
            electron_bridge,
            electron_bridge_error,
            electron_scene: None,
            electron_textures: HashMap::new(),
            electron_active_window_ids: Vec::new(),
            electron_composed_window_ids: HashSet::new(),
            electron_resume_pending: HashSet::new(),
            electron_logged_scene_revision: 0,
            rendered_frames: 0,
            imgui_probe_click_count: 0,
            first_frame_logged: false,
            last_display_size: None,
            framebuffer_scale_normalization_logged: false,
            input_filter_phase: AtomicU8::new(INPUT_FILTER_DISABLED),
            sampled_input_filter_phase: AtomicU8::new(INPUT_FILTER_DISABLED),
            applied_input_filter: AtomicBool::new(false),
            process_mouse_suppression,
            last_process_input_counters: ProcessInputCounters::default(),
            last_process_input_report: Instant::now(),
            owned_pointer_input,
            owned_input_logged: false,
        }
    }

    fn report_process_input_counters(&mut self) {
        let counters = self.process_mouse_suppression.counters();
        let previous_masked = total_masked_process_input(self.last_process_input_counters);
        let masked = total_masked_process_input(counters);
        if masked == previous_masked
            || (previous_masked != 0
                && self.last_process_input_report.elapsed() < Duration::from_secs(1))
        {
            return;
        }

        self.last_process_input_counters = counters;
        self.last_process_input_report = Instant::now();
        hudhook::tracing::info!(
            phase = ?self.process_mouse_suppression.phase(),
            async_calls = counters.get_async_key_state.calls,
            async_masked = counters.get_async_key_state.masked,
            key_calls = counters.get_key_state.calls,
            key_masked = counters.get_key_state.masked,
            keyboard_calls = counters.get_keyboard_state.calls,
            keyboard_masked = counters.get_keyboard_state.masked,
            cursor_calls = counters.get_cursor_pos.calls,
            cursor_masked = counters.get_cursor_pos.masked,
            raw_buffer_calls = counters.get_raw_input_buffer.calls,
            raw_buffer_masked = counters.get_raw_input_buffer.masked,
            "process-wide mouse polling suppression observed"
        );
    }

    fn drain_owned_pointer_input(&mut self, context: &mut Context) {
        let events = self.owned_pointer_input.drain();
        if events.is_empty() {
            return;
        }

        for event in events.iter().copied() {
            event.feed_imgui(context.io_mut());
            if let Some(bridge) = &self.electron_bridge {
                let (hwnd, message, wparam, lparam) = event.win32();
                bridge.route_window_message(hwnd, message, wparam, lparam);
            }
        }

        if !self.owned_input_logged {
            self.owned_input_logged = true;
            hudhook::tracing::info!(
                event_count = events.len(),
                "synchronous owned pointer input reached ImGui and Electron"
            );
        }
    }

    fn compose_electron_overlays(&mut self, ui: &Ui) {
        let Some(scene) = self.electron_scene.as_ref().map(Arc::clone) else {
            return;
        };

        let mut composed_order = Vec::with_capacity(scene.windows.len());
        for frame in &scene.windows {
            let Some(texture) = self.electron_textures.get(&frame.window_id) else {
                continue;
            };
            let Some(texture_id) = texture.texture_id else {
                continue;
            };
            if frame.sequence != texture.uploaded_sequence
                || frame.rect.width <= 0
                || frame.rect.height <= 0
            {
                continue;
            }

            let min = [frame.rect.x as f32, frame.rect.y as f32];
            let max = [
                frame.rect.x.saturating_add(frame.rect.width) as f32,
                frame.rect.y.saturating_add(frame.rect.height) as f32,
            ];
            ui.get_background_draw_list()
                .add_image(texture_id, min, max)
                .build();
            composed_order.push(frame.name.as_str());

            if self.electron_composed_window_ids.insert(frame.window_id) {
                hudhook::tracing::info!(
                    window_id = frame.window_id,
                    window_name = %frame.name,
                    x = frame.rect.x,
                    y = frame.rect.y,
                    width = frame.rect.width,
                    height = frame.rect.height,
                    transparent = frame.transparent,
                    sequence = frame.sequence,
                    "Electron overlay composed at native bounds"
                );
            }

            if self.electron_resume_pending.remove(&frame.window_id) {
                hudhook::tracing::info!(
                    window_id = frame.window_id,
                    window_name = %frame.name,
                    sequence = frame.sequence,
                    "Electron overlay composition resumed"
                );
            }
        }

        if !scene.windows.is_empty()
            && composed_order.len() == scene.windows.len()
            && scene.state_revision != self.electron_logged_scene_revision
        {
            self.electron_logged_scene_revision = scene.state_revision;
            hudhook::tracing::info!(
                window_count = scene.windows.len(),
                state_revision = scene.state_revision,
                order = %composed_order.join(">"),
                "Electron overlay scene composed"
            );
        }
    }

    fn render_diagnostics(&self, ui: &Ui, display_size: [f32; 2]) {
        let flags = WindowFlags::NO_DECORATION
            | WindowFlags::ALWAYS_AUTO_RESIZE
            | WindowFlags::NO_SAVED_SETTINGS
            | WindowFlags::NO_FOCUS_ON_APPEARING
            | WindowFlags::NO_NAV
            | WindowFlags::NO_INPUTS;

        ui.window("hudhook compositor diagnostics##always-visible")
            .position(
                [(display_size[0] - 16.0).max(16.0), 16.0],
                Condition::Always,
            )
            .position_pivot([1.0, 0.0])
            .bg_alpha(0.9)
            .flags(flags)
            .build(|| {
                ui.text_colored([0.25, 0.95, 0.72, 1.0], "hudhook compositor POC");
                ui.separator();
                ui.text(format!(
                    "API: {} | frames: {}",
                    self.backend_name, self.rendered_frames
                ));
                ui.text(format!(
                    "Display: {:.0} x {:.0}",
                    display_size[0], display_size[1]
                ));
                if let Some(input) = self
                    .electron_bridge
                    .as_ref()
                    .map(ElectronFrameBridge::input_state)
                {
                    ui.text(format!(
                        "Input: requested {} | effective {}",
                        input.requested_interception, input.effective_interception
                    ));
                    ui.text(format!(
                        "Focus: {} | capture {} | target {}",
                        input
                            .focused_window_id
                            .map_or_else(|| "none".to_owned(), |id| id.to_string()),
                        input.pointer_captured,
                        input.target_focused
                    ));
                } else {
                    ui.text("Input: pass-through (bridge unavailable)");
                }
                ui.separator();

                if let Some(scene) = self
                    .electron_scene
                    .as_ref()
                    .filter(|scene| !scene.windows.is_empty())
                {
                    let order = scene
                        .windows
                        .iter()
                        .map(|frame| frame.name.as_str())
                        .collect::<Vec<_>>()
                        .join(" > ");
                    ui.text(format!(
                        "Windows: {} | state: {}",
                        scene.windows.len(),
                        scene.state_revision
                    ));
                    ui.text_wrapped(format!("Stack: {order}"));
                    if let Some(frame) = scene.windows.last() {
                        let uploaded = self
                            .electron_textures
                            .get(&frame.window_id)
                            .is_some_and(|texture| texture.uploaded_sequence == frame.sequence);
                        ui.text(format!("Top: {} (id {})", frame.name, frame.window_id));
                        ui.text(format!(
                            "Bounds: {}, {} | {} x {}",
                            frame.rect.x, frame.rect.y, frame.rect.width, frame.rect.height
                        ));
                        ui.text(format!(
                            "Frame: {}{}",
                            frame.sequence,
                            if uploaded {
                                " (uploaded)"
                            } else {
                                " (pending)"
                            }
                        ));
                    }
                } else {
                    ui.text("Windows: none");
                    ui.text("Electron scene: waiting");
                }

                if let Some(error) = self
                    .electron_textures
                    .values()
                    .find_map(|texture| texture.error.as_deref())
                {
                    ui.text_colored([1.0, 0.35, 0.3, 1.0], "Electron texture upload failed");
                    ui.text_wrapped(error);
                } else if let Some(error) = &self.electron_bridge_error {
                    ui.text_colored([1.0, 0.35, 0.3, 1.0], "Electron frame bridge failed");
                    ui.text_wrapped(error);
                }

                if self
                    .electron_scene
                    .as_ref()
                    .is_none_or(|scene| scene.windows.is_empty())
                {
                    ui.spacing();
                    if let Some(texture_id) = self.texture_id {
                        Image::new(texture_id, [64.0, 64.0]).build(ui);
                        ui.text("Waiting for Electron window");
                    } else if let Some(error) = &self.texture_error {
                        ui.text_colored([1.0, 0.35, 0.3, 1.0], "Texture upload failed");
                        ui.text_wrapped(error);
                    } else {
                        ui.text("Fallback texture upload is pending");
                    }
                }
            });
    }

    fn effective_input_interception(&self) -> bool {
        self.electron_bridge
            .as_ref()
            .is_some_and(|bridge| bridge.input_state().effective_interception)
    }

    fn render_imgui_input_probe(
        &mut self,
        ui: &Ui,
        display_size: [f32; 2],
        effective_interception: bool,
    ) {
        let flags = WindowFlags::NO_RESIZE
            | WindowFlags::NO_MOVE
            | WindowFlags::NO_COLLAPSE
            | WindowFlags::NO_SCROLLBAR
            | WindowFlags::NO_SCROLL_WITH_MOUSE
            | WindowFlags::NO_SAVED_SETTINGS
            | WindowFlags::NO_FOCUS_ON_APPEARING
            | WindowFlags::NO_NAV;

        ui.window("NATIVE IMGUI INPUT PROBE##standalone-input-probe")
            .position(
                [24.0, (display_size[1] - 24.0).max(24.0)],
                Condition::Always,
            )
            .position_pivot([0.0, 1.0])
            .size([440.0, 250.0], Condition::Always)
            .bg_alpha(0.96)
            .flags(flags)
            .build(|| {
                if effective_interception {
                    ui.text_colored(
                        [0.25, 1.0, 0.55, 1.0],
                        "INTERCEPTION ENABLED - native ImGui input test",
                    );
                } else {
                    ui.text_colored(
                        [1.0, 0.45, 0.2, 1.0],
                        "INTERCEPTION OFF - enable it before testing",
                    );
                }
                ui.text("This control does not use Electron rendering or input routing.");
                ui.separator();

                let _button = ui.push_style_color(
                    StyleColor::Button,
                    if effective_interception {
                        [0.05, 0.48, 0.82, 1.0]
                    } else {
                        [0.38, 0.18, 0.12, 1.0]
                    },
                );
                let _button_hovered =
                    ui.push_style_color(StyleColor::ButtonHovered, [0.05, 0.72, 1.0, 1.0]);
                let _button_active =
                    ui.push_style_color(StyleColor::ButtonActive, [0.95, 0.28, 0.16, 1.0]);
                let clicked = ui.button_with_size(
                    "CLICK AND HOLD THIS NATIVE BUTTON##imgui-input-probe-button",
                    [408.0, 72.0],
                );
                let hovered = ui.is_item_hovered();
                let active = ui.is_item_active();
                let mouse_position = ui.io().mouse_pos;
                let want_capture_mouse = ui.io().want_capture_mouse;

                if clicked {
                    self.imgui_probe_click_count = self.imgui_probe_click_count.saturating_add(1);
                    hudhook::tracing::info!(
                        click_count = self.imgui_probe_click_count,
                        effective_interception,
                        mouse_x = mouse_position[0],
                        mouse_y = mouse_position[1],
                        "native ImGui input probe clicked"
                    );
                }

                let (state, color) = if active {
                    ("ACTIVE (button held)", [1.0, 0.35, 0.2, 1.0])
                } else if hovered {
                    ("HOVERED", [1.0, 0.9, 0.2, 1.0])
                } else {
                    ("IDLE", [0.72, 0.76, 0.82, 1.0])
                };
                ui.text_colored(color, format!("State: {state}"));
                ui.same_line();
                ui.text(format!("Clicks: {}", self.imgui_probe_click_count));
                ui.text(format!(
                    "Hovered: {hovered} | Active: {active} | Software cursor: {}",
                    if effective_interception { "ON" } else { "OFF" }
                ));
                ui.text(format!(
                    "Mouse: ({:.1}, {:.1}) | want_capture_mouse: {want_capture_mouse}",
                    mouse_position[0], mouse_position[1]
                ));
            });
    }
}

impl ImguiRenderLoop for PocRenderLoop {
    fn process_mouse_suppression(&self) -> Option<Arc<ProcessMouseSuppression>> {
        Some(Arc::clone(&self.process_mouse_suppression))
    }

    fn synchronous_wnd_proc_handler(&self) -> Option<Arc<dyn SynchronousWndProcHandler>> {
        Some(self.owned_pointer_input.clone())
    }

    fn initialize<'a>(
        &'a mut self,
        _context: &mut Context,
        render_context: &'a mut dyn RenderContext,
    ) {
        match render_context.load_texture(&self.pixels, TEXTURE_WIDTH, TEXTURE_HEIGHT) {
            Ok(texture_id) => {
                self.texture_id = Some(texture_id);
                hudhook::tracing::info!(
                    width = TEXTURE_WIDTH,
                    height = TEXTURE_HEIGHT,
                    "generated RGBA texture uploaded"
                );
            }
            Err(error) => {
                self.texture_error = Some(format!("{error:?}"));
                hudhook::tracing::error!(?error, "generated RGBA texture upload failed");
            }
        }
    }

    fn before_render<'a>(
        &'a mut self,
        context: &mut Context,
        render_context: &'a mut dyn RenderContext,
    ) {
        // hudhook updates DisplaySize from the swap-chain buffer dimensions,
        // which are already native pixels. Its DPI-derived framebuffer scale
        // would make the D3D viewport multiply those pixels a second time.
        if let Some(original_scale) = normalize_native_pixel_framebuffer_scale(
            &mut context.io_mut().display_framebuffer_scale,
        ) {
            if !self.framebuffer_scale_normalization_logged {
                self.framebuffer_scale_normalization_logged = true;
                hudhook::tracing::info!(
                    original_scale_x = original_scale[0],
                    original_scale_y = original_scale[1],
                    "hudhook ImGui framebuffer scale normalized to native pixels"
                );
            }
        }

        // hudhook stores the value returned by message_filter immediately
        // before this callback. Commit and log that exact sampled value here,
        // rather than re-reading effective state after the boundary.
        let sampled_phase = self.sampled_input_filter_phase.load(Ordering::Acquire);
        self.input_filter_phase
            .store(sampled_phase, Ordering::Release);
        let sampled_input_filter = sampled_phase != INPUT_FILTER_DISABLED;
        let previous = self
            .applied_input_filter
            .swap(sampled_input_filter, Ordering::AcqRel);
        if previous != sampled_input_filter {
            if sampled_input_filter {
                hudhook::tracing::info!("hudhook input filter enabled at render boundary");
            } else {
                hudhook::tracing::info!("hudhook input filter disabled at render boundary");
            }
        }
        if let Some(bridge) = &self.electron_bridge {
            // Arming/disarming hold routing disabled for a complete filtered
            // queue drain. Only matching terminal phases may acknowledge.
            bridge.apply_input_filter(
                sampled_phase == INPUT_FILTER_ENABLED,
                matches!(sampled_phase, INPUT_FILTER_DISABLED | INPUT_FILTER_ENABLED),
            );
        }
        self.owned_pointer_input.reconcile_physical_buttons();
        self.drain_owned_pointer_input(context);
        self.report_process_input_counters();
        context.io_mut().mouse_draw_cursor = self.effective_input_interception();

        let Some(scene) = self
            .electron_bridge
            .as_ref()
            .map(ElectronFrameBridge::scene)
        else {
            return;
        };

        let next_active_window_ids = scene
            .windows
            .iter()
            .map(|frame| frame.window_id)
            .collect::<Vec<_>>();
        let next_active_window_set = next_active_window_ids
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        let removed_window_ids = self
            .electron_active_window_ids
            .iter()
            .copied()
            .filter(|window_id| !next_active_window_set.contains(window_id))
            .collect::<Vec<_>>();
        for window_id in removed_window_ids {
            if self.electron_composed_window_ids.contains(&window_id) {
                self.electron_resume_pending.insert(window_id);
            }
            hudhook::tracing::info!(window_id, "Electron overlay window composition cleared");
        }
        if !self.electron_active_window_ids.is_empty() && next_active_window_ids.is_empty() {
            hudhook::tracing::info!("Electron overlay composition cleared");
        }
        self.electron_active_window_ids = next_active_window_ids;
        self.electron_scene = Some(Arc::clone(&scene));

        for frame in &scene.windows {
            let texture = self.electron_textures.entry(frame.window_id).or_default();
            // Metadata and stack order may change without a new bitmap. The
            // scene Arc already exposes those changes to composition.
            if frame.sequence == texture.last_attempted_sequence {
                continue;
            }
            texture.last_attempted_sequence = frame.sequence;

            let expected_length = (frame.width as usize)
                .checked_mul(frame.height as usize)
                .and_then(|pixels| pixels.checked_mul(4));
            if expected_length != Some(frame.rgba.len()) {
                let error = format!(
                    "invalid Electron frame: {} x {} has {} RGBA bytes",
                    frame.width,
                    frame.height,
                    frame.rgba.len()
                );
                hudhook::tracing::error!(
                    window_id = frame.window_id,
                    window_name = %frame.name,
                    sequence = frame.sequence,
                    %error
                );
                texture.error = Some(error);
                continue;
            }

            let frame_size = [frame.width, frame.height];
            let upload = match (texture.texture_id, texture.texture_size) {
                (Some(texture_id), Some(texture_size)) if texture_size == frame_size => {
                    render_context
                        .replace_texture(texture_id, frame.rgba.as_ref(), frame.width, frame.height)
                        .map(|_| texture_id)
                }
                _ => render_context.load_texture(frame.rgba.as_ref(), frame.width, frame.height),
            };

            match upload {
                Ok(texture_id) => {
                    let first_upload = texture.uploaded_sequence == 0;
                    texture.texture_id = Some(texture_id);
                    texture.texture_size = Some(frame_size);
                    texture.uploaded_sequence = frame.sequence;
                    texture.error = None;

                    if first_upload {
                        hudhook::tracing::info!(
                            window_id = frame.window_id,
                            window_name = %frame.name,
                            sequence = frame.sequence,
                            width = frame.width,
                            height = frame.height,
                            "Electron frame uploaded to GPU"
                        );
                    }
                }
                Err(error) => {
                    hudhook::tracing::error!(
                        window_id = frame.window_id,
                        window_name = %frame.name,
                        sequence = frame.sequence,
                        width = frame.width,
                        height = frame.height,
                        ?error,
                        "Electron frame GPU upload failed"
                    );
                    texture.error = Some(format!("{error:?}"));
                }
            }
        }
    }

    fn render(&mut self, ui: &mut Ui) {
        self.rendered_frames += 1;

        let display_size = ui.io().display_size;
        if let Some(previous_size) = self.last_display_size {
            if previous_size != display_size {
                hudhook::tracing::info!(
                    old_width = previous_size[0],
                    old_height = previous_size[1],
                    width = display_size[0],
                    height = display_size[1],
                    "ImGui display size changed"
                );
            }
        }
        self.last_display_size = Some(display_size);

        self.compose_electron_overlays(ui);
        self.render_diagnostics(ui, display_size);
        let effective_interception = self.effective_input_interception();
        self.render_imgui_input_probe(ui, display_size, effective_interception);

        if !self.first_frame_logged {
            self.first_frame_logged = true;
            hudhook::tracing::info!(
                backend = self.backend_name,
                width = display_size[0],
                height = display_size[1],
                "first ImGui frame rendered"
            );
        }
    }

    fn after_wnd_proc(&self, hwnd: HWND, umsg: u32, wparam: WPARAM, lparam: LPARAM) {
        if let Some(bridge) = &self.electron_bridge {
            bridge.route_window_message(hwnd, umsg, wparam, lparam);
        }
    }

    fn message_filter(&self, _io: &Io) -> MessageFilter {
        let desired_interception = self
            .electron_bridge
            .as_ref()
            .is_some_and(ElectronFrameBridge::desired_interception);
        let current_phase = self.input_filter_phase.load(Ordering::Acquire);
        let sampled_phase = next_input_filter_phase(current_phase, desired_interception);
        self.sampled_input_filter_phase
            .store(sampled_phase, Ordering::Release);
        self.owned_pointer_input.set_phase(sampled_phase);

        if sampled_phase != INPUT_FILTER_DISABLED {
            // Mouse and WM_INPUT propagation belong to the synchronous owned
            // handler. Hudhook keeps translating/blocking legacy keyboard
            // messages until the keyboard source moves to the same seam.
            MessageFilter::InputKeyboard | MessageFilter::InputRaw
        } else {
            MessageFilter::empty()
        }
    }
}

const fn total_masked_process_input(counters: ProcessInputCounters) -> u64 {
    counters
        .get_async_key_state
        .masked
        .saturating_add(counters.get_key_state.masked)
        .saturating_add(counters.get_keyboard_state.masked)
        .saturating_add(counters.get_cursor_pos.masked)
        .saturating_add(counters.get_raw_input_buffer.masked)
}

fn normalize_native_pixel_framebuffer_scale(scale: &mut [f32; 2]) -> Option<[f32; 2]> {
    const NATIVE_PIXEL_SCALE: [f32; 2] = [1.0, 1.0];

    let original_scale = *scale;
    *scale = NATIVE_PIXEL_SCALE;
    (original_scale != NATIVE_PIXEL_SCALE).then_some(original_scale)
}

fn make_test_pattern() -> Vec<u8> {
    let mut pixels = Vec::with_capacity((TEXTURE_WIDTH * TEXTURE_HEIGHT * 4) as usize);

    for y in 0..TEXTURE_HEIGHT {
        for x in 0..TEXTURE_WIDTH {
            let color = if ((x / 16) + (y / 16)) % 2 == 0 {
                [45, 212, 191, 255]
            } else {
                [13, 92, 168, 255]
            };
            pixels.extend_from_slice(&color);
        }
    }

    pixels
}

fn initialize_tracing() -> Option<PathBuf> {
    let dll_path = hudhook::util::get_dll_path()?;
    let (log_path, log_file) = create_log_file(&dll_path)?;
    let filter = EnvFilter::try_from_env("HUDHOOK_POC_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,hudhook=debug,hudhook_imgui_overlay_ui=debug"));

    let result = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(Mutex::new(log_file))
        .with_ansi(false)
        .with_file(true)
        .with_line_number(true)
        .with_thread_ids(true)
        .try_init();

    result.ok().map(|_| log_path)
}

fn create_log_file(dll_path: &Path) -> Option<(PathBuf, File)> {
    let log_name = format!(
        "{}-{}.log",
        dll_path.file_stem()?.to_string_lossy(),
        process::id()
    );
    let primary_path = dll_path.parent()?.join(&log_name);

    if let Ok(file) = File::create(&primary_path) {
        return Some((primary_path, file));
    }

    let fallback_directory = std::env::temp_dir().join("electron-game-overlay");
    fs::create_dir_all(&fallback_directory).ok()?;
    let fallback_path = fallback_directory.join(log_name);
    File::create(&fallback_path)
        .ok()
        .map(|file| (fallback_path, file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_filter_transitions_require_guarded_queue_drains() {
        assert_eq!(
            next_input_filter_phase(INPUT_FILTER_DISABLED, false),
            INPUT_FILTER_DISABLED
        );
        assert_eq!(
            next_input_filter_phase(INPUT_FILTER_DISABLED, true),
            INPUT_FILTER_ARMING
        );
        assert_eq!(
            next_input_filter_phase(INPUT_FILTER_ARMING, true),
            INPUT_FILTER_ENABLED
        );
        assert_eq!(
            next_input_filter_phase(INPUT_FILTER_ENABLED, true),
            INPUT_FILTER_ENABLED
        );
        assert_eq!(
            next_input_filter_phase(INPUT_FILTER_ARMING, false),
            INPUT_FILTER_DISARMING
        );
        assert_eq!(
            next_input_filter_phase(INPUT_FILTER_ENABLED, false),
            INPUT_FILTER_DISARMING
        );
        assert_eq!(
            next_input_filter_phase(INPUT_FILTER_DISARMING, false),
            INPUT_FILTER_DISABLED
        );
        assert_eq!(
            next_input_filter_phase(INPUT_FILTER_DISARMING, true),
            INPUT_FILTER_ARMING
        );
    }

    #[test]
    fn native_pixel_framebuffer_scale_keeps_unit_and_normalizes_non_unit_values() {
        let mut unit_scale = [1.0, 1.0];
        assert_eq!(
            normalize_native_pixel_framebuffer_scale(&mut unit_scale),
            None
        );
        assert_eq!(unit_scale, [1.0, 1.0]);

        let mut dpi_scale = [1.25, 1.5];
        assert_eq!(
            normalize_native_pixel_framebuffer_scale(&mut dpi_scale),
            Some([1.25, 1.5])
        );
        assert_eq!(dpi_scale, [1.0, 1.0]);
    }
}
