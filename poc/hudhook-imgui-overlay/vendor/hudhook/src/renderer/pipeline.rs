use std::collections::HashMap;
use std::mem;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use imgui::Context;
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use tracing::{error, warn};
use windows::core::{Error, Result, HRESULT};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW, GWLP_WNDPROC, RIM_INPUT,
    WM_INPUT, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

use crate::renderer::input::{imgui_wnd_proc_impl, WndProcType};
use crate::renderer::RenderEngine;
use crate::sync_input::{
    copy_raw_input, RawInputData, SynchronousWndProcDecision, SynchronousWndProcEvent,
    SynchronousWndProcHandler,
};
use crate::{util, ImguiRenderLoop, MessageFilter};

type RenderLoop = Box<dyn ImguiRenderLoop + Send + Sync>;

// Safety: HWND is an opaque integer handle, safe to send/share across threads.
#[derive(Clone, Copy, Debug)]
#[repr(transparent)]
pub(crate) struct SendableHwnd(HWND);
unsafe impl Send for SendableHwnd {}
unsafe impl Sync for SendableHwnd {}

static PIPELINE_STATES: Lazy<Mutex<HashMap<usize, Arc<PipelineSharedState>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static WND_PROC_EJECTION_BARRIER: util::HookEjectionBarrier = util::HookEjectionBarrier::new();

#[derive(Debug)]
pub(crate) struct PipelineMessage(
    pub(crate) SendableHwnd,
    pub(crate) u32,
    pub(crate) WPARAM,
    pub(crate) LPARAM,
    pub(crate) Option<RawInputData>,
);

pub(crate) struct PipelineSharedState {
    pub(crate) message_filter: AtomicU32,
    pub(crate) wnd_proc: WndProcType,
    pub(crate) tx: Sender<PipelineMessage>,
    pub(crate) synchronous_wnd_proc_handler: Option<Arc<dyn SynchronousWndProcHandler>>,
}

pub(crate) struct Pipeline<T: RenderEngine> {
    hwnd: HWND,
    ctx: Context,
    engine: T,
    render_loop: RenderLoop,
    rx: Receiver<PipelineMessage>,
    shared_state: Arc<PipelineSharedState>,
    queue_buffer: OnceCell<Vec<PipelineMessage>>,
    start_of_first_frame: OnceCell<Instant>,
    wnd_proc_attached: bool,
}

impl<T: RenderEngine> Pipeline<T> {
    pub(crate) fn new(
        hwnd: HWND,
        mut ctx: Context,
        mut engine: T,
        mut render_loop: RenderLoop,
    ) -> std::result::Result<Self, (Error, RenderLoop)> {
        let (width, height) = util::win_size(hwnd);

        ctx.io_mut().display_size = [width as f32, height as f32];

        render_loop.initialize(&mut ctx, &mut engine);

        if let Err(e) = engine.setup_fonts(&mut ctx) {
            return Err((e, render_loop));
        }

        let synchronous_wnd_proc_handler = render_loop.synchronous_wnd_proc_handler();
        if let Some(handler) = &synchronous_wnd_proc_handler {
            handler.bind_target_window(hwnd);
        }
        let (tx, rx) = mpsc::channel();

        // Keep the registry locked while publishing the replacement WndProc
        // and inserting its state. A concurrently delivered message will wait
        // for the fully initialized entry instead of falling through a gap.
        let mut pipeline_states = PIPELINE_STATES.lock();
        let wnd_proc = unsafe {
            #[cfg(target_arch = "x86")]
            type SwlpRet = i32;
            #[cfg(target_arch = "x86_64")]
            type SwlpRet = isize;

            let previous =
                SetWindowLongPtrW(hwnd, GWLP_WNDPROC, pipeline_wnd_proc as *const () as _);
            if previous == 0 {
                return Err((Error::from_thread(), render_loop));
            }
            mem::transmute::<SwlpRet, WndProcType>(previous)
        };

        let shared_state = Arc::new(PipelineSharedState {
            message_filter: AtomicU32::new(MessageFilter::empty().bits()),
            wnd_proc,
            tx,
            synchronous_wnd_proc_handler,
        });

        pipeline_states.insert(hwnd.0 as usize, Arc::clone(&shared_state));
        drop(pipeline_states);

        let queue_buffer = OnceCell::from(Vec::new());

        Ok(Self {
            hwnd,
            ctx,
            engine,
            render_loop,
            rx,
            shared_state: Arc::clone(&shared_state),
            queue_buffer,
            start_of_first_frame: OnceCell::new(),
            wnd_proc_attached: true,
        })
    }

    pub(crate) fn prepare_render(&mut self) -> Result<()> {
        let mut queue_buffer = self.queue_buffer.take().unwrap();
        queue_buffer.clear();
        queue_buffer.extend(self.rx.try_iter());
        queue_buffer.drain(..).for_each(
            |PipelineMessage(SendableHwnd(hwnd), umsg, wparam, lparam, raw_input)| {
                imgui_wnd_proc_impl(hwnd, umsg, wparam, lparam, raw_input, self);
            },
        );
        self.queue_buffer
            .set(queue_buffer)
            .expect("OnceCell should be empty");

        let message_filter = self.render_loop.message_filter(self.ctx.io());

        self.shared_state
            .message_filter
            .store(message_filter.bits(), Ordering::SeqCst);

        let io = self.ctx.io_mut();

        io.nav_active = true;
        io.nav_visible = true;

        self.render_loop
            .before_render(&mut self.ctx, &mut self.engine);

        Ok(())
    }

    pub(crate) fn render(&mut self, render_target: T::RenderTarget) -> Result<()> {
        let delta_time = Instant::now()
            .checked_duration_since(*self.start_of_first_frame.get_or_init(Instant::now))
            .unwrap_or(Duration::ZERO)
            .checked_sub(Duration::from_secs_f64(self.ctx.time()))
            .unwrap_or(Duration::ZERO);

        self.ctx.io_mut().update_delta_time(delta_time);

        let [w, h] = self.ctx.io().display_size;
        let [fsw, fsh] = self.ctx.io().display_framebuffer_scale;

        if (w * fsw) <= 0.0 || (h * fsh) <= 0.0 {
            warn!(
                "Insufficient display size: {w}x{h}, framebuffer_scale: {fsw}x{fsh}; skipping \
                 frame"
            );
            return Ok(());
        }

        let ui = self.ctx.frame();
        self.render_loop.render(ui);
        let draw_data = self.ctx.render();

        self.engine.render(draw_data, render_target)?;

        Ok(())
    }

    pub(crate) fn context(&mut self) -> &mut Context {
        &mut self.ctx
    }

    pub(crate) fn render_loop(&mut self) -> &mut RenderLoop {
        &mut self.render_loop
    }

    pub(crate) fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.ctx.io_mut().display_size = [width as f32, height as f32];
        }
    }

    #[cfg(feature = "dx11")]
    pub(crate) fn update_display_size_from_swap_chain(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            let io = self.ctx.io_mut();
            io.display_size = [width as f32, height as f32];

            let dpi = unsafe { GetDpiForWindow(self.hwnd) };
            if dpi > 0 {
                let scale = dpi as f32 / 96.0;
                io.display_framebuffer_scale = [scale, scale];
            }
        }
    }

    pub(crate) fn cleanup(&mut self) -> Result<()> {
        if !self.wnd_proc_attached {
            return Ok(());
        }

        {
            let mut states = PIPELINE_STATES.lock();
            let current = unsafe { GetWindowLongPtrW(self.hwnd, GWLP_WNDPROC) };
            let replacement = pipeline_wnd_proc as *const () as isize;
            if current != replacement {
                let error = Error::new(
                    HRESULT(0x80004005_u32 as i32),
                    "a later WndProc subclass must be removed before hudhook can detach",
                );
                error!(
                    hwnd = ?self.hwnd,
                    current,
                    replacement,
                    ?error,
                    "Refusing to clobber a later WndProc subclass during cleanup"
                );
                return Err(error);
            }

            let previous = unsafe {
                SetWindowLongPtrW(
                    self.hwnd,
                    GWLP_WNDPROC,
                    self.shared_state.wnd_proc as usize as _,
                )
            };
            if previous == 0 {
                let error = Error::from_thread();
                error!(
                    hwnd = ?self.hwnd,
                    ?error,
                    "Could not restore the saved WndProc during cleanup"
                );
                return Err(error);
            }

            states.remove(&(self.hwnd.0 as usize));
            self.wnd_proc_attached = false;
        }

        // Restoring the saved procedure prevents new hudhook WndProc entries.
        // Wait for callbacks that had already entered before allowing the
        // pipeline and its synchronous handler to be destroyed.
        WND_PROC_EJECTION_BARRIER.wait_for_all_guards();
        Ok(())
    }

    pub(crate) fn into_render_loop(self) -> RenderLoop {
        debug_assert!(!self.wnd_proc_attached);
        self.render_loop
    }
}

unsafe extern "system" fn pipeline_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let _wnd_proc_guard = WND_PROC_EJECTION_BARRIER.acquire_ejection_guard();
    let shared_state = {
        let shared_state_guard = PIPELINE_STATES.lock();

        let Some(shared_state) = shared_state_guard.get(&(hwnd.0 as usize)) else {
            error!("Could not get shared state for handle {hwnd:?}");
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        };

        Arc::clone(shared_state)
    };

    let raw_input = (msg == WM_INPUT)
        .then(|| copy_raw_input(hwnd, lparam))
        .flatten();
    if let Some(handler) = &shared_state.synchronous_wnd_proc_handler {
        match handler.handle(SynchronousWndProcEvent {
            hwnd,
            message: msg,
            wparam,
            lparam,
            raw_input,
        }) {
            SynchronousWndProcDecision::Forward => {}
            SynchronousWndProcDecision::Handled(result) => {
                if msg == WM_INPUT && (wparam.0 as u32 & 0xff) == RIM_INPUT {
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
                return result;
            }
            SynchronousWndProcDecision::HandledByDefWindowProc => {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
        }
    }

    if let Err(e) = shared_state.tx.send(PipelineMessage(
        SendableHwnd(hwnd),
        msg,
        wparam,
        lparam,
        raw_input,
    )) {
        error!("Could not send window message through pipeline: {e:?}");
    }

    // CONCURRENCY: as the message interpretation now happens out of band, this
    // expresses the intent as of *before* the current message was received.
    let message_filter =
        MessageFilter::from_bits_retain(shared_state.message_filter.load(Ordering::SeqCst));

    if message_filter.is_blocking(msg) {
        filtered_message_result(hwnd, msg, wparam, lparam)
    } else {
        CallWindowProcW(Some(shared_state.wnd_proc), hwnd, msg, wparam, lparam)
    }
}

unsafe fn filtered_message_result(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_INPUT && (wparam.0 as u32 & 0xff) == RIM_INPUT {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    if matches!(msg, WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK) {
        return LRESULT(1);
    }
    LRESULT(0)
}
