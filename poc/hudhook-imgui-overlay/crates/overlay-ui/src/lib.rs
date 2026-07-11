mod electron_frame;
mod electron_input;

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use electron_frame::{ElectronFrameBridge, ElectronScene};
use hudhook::imgui::{Condition, Context, Image, Io, TextureId, Ui, WindowFlags};
use hudhook::{ImguiRenderLoop, MessageFilter, RenderContext};
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
    first_frame_logged: bool,
    last_display_size: Option<[f32; 2]>,
    input_filter_phase: AtomicU8,
    sampled_input_filter_phase: AtomicU8,
    applied_input_filter: AtomicBool,
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
            first_frame_logged: false,
            last_display_size: None,
            input_filter_phase: AtomicU8::new(INPUT_FILTER_DISABLED),
            sampled_input_filter_phase: AtomicU8::new(INPUT_FILTER_DISABLED),
            applied_input_filter: AtomicBool::new(false),
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
}

impl ImguiRenderLoop for PocRenderLoop {
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
        _context: &mut Context,
        render_context: &'a mut dyn RenderContext,
    ) {
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

        if sampled_phase != INPUT_FILTER_DISABLED {
            MessageFilter::InputAll
        } else {
            MessageFilter::empty()
        }
    }
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
}
