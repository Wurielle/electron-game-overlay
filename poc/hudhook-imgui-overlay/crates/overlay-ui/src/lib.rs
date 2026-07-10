mod electron_frame;

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Mutex;

use electron_frame::ElectronFrameBridge;
use hudhook::imgui::{Condition, Context, Image, TextureId, Ui, WindowFlags};
use hudhook::{ImguiRenderLoop, RenderContext};
use tracing_subscriber::EnvFilter;

const TEXTURE_WIDTH: u32 = 128;
const TEXTURE_HEIGHT: u32 = 128;

pub struct PocRenderLoop {
    backend_name: &'static str,
    pixels: Vec<u8>,
    texture_id: Option<TextureId>,
    texture_error: Option<String>,
    electron_bridge: Option<ElectronFrameBridge>,
    electron_bridge_error: Option<String>,
    electron_texture_id: Option<TextureId>,
    electron_texture_size: Option<[u32; 2]>,
    electron_last_attempted_sequence: u64,
    electron_uploaded_sequence: u64,
    electron_texture_error: Option<String>,
    rendered_frames: u64,
    first_frame_logged: bool,
    last_display_size: Option<[f32; 2]>,
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
            electron_texture_id: None,
            electron_texture_size: None,
            electron_last_attempted_sequence: 0,
            electron_uploaded_sequence: 0,
            electron_texture_error: None,
            rendered_frames: 0,
            first_frame_logged: false,
            last_display_size: None,
        }
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
        let Some(frame) = self
            .electron_bridge
            .as_ref()
            .and_then(ElectronFrameBridge::latest)
        else {
            return;
        };

        if frame.sequence <= self.electron_last_attempted_sequence {
            return;
        }
        self.electron_last_attempted_sequence = frame.sequence;

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
            hudhook::tracing::error!(sequence = frame.sequence, %error);
            self.electron_texture_error = Some(error);
            return;
        }

        let frame_size = [frame.width, frame.height];
        let upload = match (self.electron_texture_id, self.electron_texture_size) {
            (Some(texture_id), Some(texture_size)) if texture_size == frame_size => render_context
                .replace_texture(texture_id, &frame.rgba, frame.width, frame.height)
                .map(|_| texture_id),
            _ => render_context.load_texture(&frame.rgba, frame.width, frame.height),
        };

        match upload {
            Ok(texture_id) => {
                let first_upload = self.electron_uploaded_sequence == 0;
                self.electron_texture_id = Some(texture_id);
                self.electron_texture_size = Some(frame_size);
                self.electron_uploaded_sequence = frame.sequence;
                self.electron_texture_error = None;

                if first_upload {
                    hudhook::tracing::info!(
                        sequence = frame.sequence,
                        width = frame.width,
                        height = frame.height,
                        "Electron frame uploaded to GPU"
                    );
                }
            }
            Err(error) => {
                hudhook::tracing::error!(
                    sequence = frame.sequence,
                    width = frame.width,
                    height = frame.height,
                    ?error,
                    "Electron frame GPU upload failed"
                );
                self.electron_texture_error = Some(format!("{error:?}"));
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

        let flags = WindowFlags::NO_DECORATION
            | WindowFlags::ALWAYS_AUTO_RESIZE
            | WindowFlags::NO_SAVED_SETTINGS
            | WindowFlags::NO_FOCUS_ON_APPEARING
            | WindowFlags::NO_NAV
            | WindowFlags::NO_INPUTS;

        ui.window("hudhook + ImGui compositor POC##always-visible")
            .position([24.0, 24.0], Condition::Always)
            .bg_alpha(0.9)
            .flags(flags)
            .build(|| {
                ui.text_colored(
                    [0.25, 0.95, 0.72, 1.0],
                    "Electron + Node + hudhook + ImGui path is alive",
                );
                ui.separator();
                ui.text("Hook/runtime: hudhook 0.9.1");
                ui.text(format!("Graphics API: {}", self.backend_name));
                ui.text(format!("Rendered frames: {}", self.rendered_frames));
                ui.text(format!(
                    "Display: {:.0} x {:.0}",
                    display_size[0], display_size[1]
                ));
                ui.text("Input: pass-through for this proof");
                if self.electron_uploaded_sequence > 0 {
                    ui.text(format!(
                        "Electron frame: {} (uploaded)",
                        self.electron_uploaded_sequence
                    ));
                } else {
                    ui.text("Electron frame: waiting for HudhookElectronDemo");
                }
                ui.spacing();

                if let (Some(texture_id), Some([width, height])) =
                    (self.electron_texture_id, self.electron_texture_size)
                {
                    Image::new(texture_id, [width as f32, height as f32]).build(ui);
                    ui.text("Electron BrowserWindow transported through node-game-overlay");
                } else if let Some(error) = &self.electron_texture_error {
                    ui.text_colored([1.0, 0.35, 0.3, 1.0], "Electron texture upload failed");
                    ui.text_wrapped(error);
                } else if let Some(error) = &self.electron_bridge_error {
                    ui.text_colored([1.0, 0.35, 0.3, 1.0], "Electron frame bridge failed");
                    ui.text_wrapped(error);
                } else if let Some(texture_id) = self.texture_id {
                    Image::new(texture_id, [TEXTURE_WIDTH as f32, TEXTURE_HEIGHT as f32]).build(ui);
                    ui.text("Waiting for Electron; generated RGBA fallback is visible");
                } else if let Some(error) = &self.texture_error {
                    ui.text_colored([1.0, 0.35, 0.3, 1.0], "Texture upload failed");
                    ui.text_wrapped(error);
                } else {
                    ui.text("Texture upload is pending");
                }
            });

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
