//! # hudhook
//!
//! This library implements a mechanism for hooking into the
//! render loop of applications and drawing things on screen via
//! [`dear imgui`](https://docs.rs/imgui/0.11.0/imgui/).
//!
//! Currently, DirectX9, DirectX 11, DirectX 12 and OpenGL 3 are supported.
//!
//! For complete, fully fledged examples of usage, check out the following
//! projects:
//!
//! - [`darksoulsiii-practice-tool`](https://github.com/veeenu/darksoulsiii-practice-tool)
//! - [`eldenring-practice-tool`](https://github.com/veeenu/eldenring-practice-tool)
//!
//! It is a good idea to refer to these projects for any doubts about the API
//! which aren't clarified by this documentation, as this project is directly
//! derived from them.
//!
//! Refer to [this post](https://veeenu.github.io/blog/sekiro-practice-tool-architecture/) for
//! in-depth information about the architecture of the library.
//!
//! A [tutorial book](https://veeenu.github.io/hudhook/) is also available, with end-to-end
//! examples.
//!
//! [`darksoulsiii-practice-tool`]: https://github.com/veeenu/darksoulsiii-practice-tool
//! [`eldenring-practice-tool`]: https://github.com/veeenu/eldenring-practice-tool
//!
//! ## Fair warning
//!
//! [`hudhook`](crate) provides essential, crash-safe features for memory
//! manipulation and UI rendering. It does, alas, contain a hefty amount of FFI
//! and `unsafe` code which still has to be thoroughly tested, validated and
//! audited for soundness. It should be OK for small projects such as videogame
//! mods, but it may crash your application at this stage.
//!
//! ## Examples
//!
//! ### Hooking the render loop and drawing things with `imgui`
//!
//! Compile your crate with both a `cdylib` and an executable target. The
//! executable will be very minimal and used to inject the DLL into the
//! target process.
//!
//! #### Building the render loop
//!
//! Implement the render loop trait for your hook target.
//!
//! ##### Example
//!
//! Implement the [`ImguiRenderLoop`] trait:
//!
//! ```no_run
//! // lib.rs
//! use hudhook::*;
//!
//! pub struct MyRenderLoop;
//!
//! impl ImguiRenderLoop for MyRenderLoop {
//!     fn render(&mut self, ui: &mut imgui::Ui) {
//!         ui.window("My first render loop")
//!             .position([0., 0.], imgui::Condition::FirstUseEver)
//!             .size([320., 200.], imgui::Condition::FirstUseEver)
//!             .build(|| {
//!                 ui.text("Hello, hello!");
//!             });
//!     }
//! }
//!
//! {
//!     // Use this if hooking into a DirectX 9 application.
//!     use hudhook::hooks::dx9::ImguiDx9Hooks;
//!     hudhook!(ImguiDx9Hooks, MyRenderLoop);
//! }
//!
//! {
//!     // Use this if hooking into a DirectX 11 application.
//!     use hudhook::hooks::dx11::ImguiDx11Hooks;
//!     hudhook!(ImguiDx11Hooks, MyRenderLoop);
//! }
//!
//! {
//!     // Use this if hooking into a DirectX 12 application.
//!     use hudhook::hooks::dx12::ImguiDx12Hooks;
//!     hudhook!(ImguiDx12Hooks, MyRenderLoop);
//! }
//!
//! {
//!     // Use this if hooking into a OpenGL 3 application.
//!     use hudhook::hooks::opengl3::ImguiOpenGl3Hooks;
//!     hudhook!(ImguiOpenGl3Hooks, MyRenderLoop);
//! }
//! ```
//!
//! #### Injecting the DLL
//!
//! You can use the facilities in [`inject`] in your binaries to inject
//! the DLL in your target process.
//!
//! ```no_run
//! // main.rs
//! use hudhook::inject::Process;
//!
//! fn main() {
//!     let mut cur_exe = std::env::current_exe().unwrap();
//!     cur_exe.push("..");
//!     cur_exe.push("libmyhook.dll");
//!
//!     let cur_dll = cur_exe.canonicalize().unwrap();
//!
//!     Process::by_name("MyTargetApplication.exe").unwrap().inject(cur_dll).unwrap();
//! }
//! ```
#![allow(clippy::needless_doctest_main)]
#![allow(static_mut_refs)]
#![deny(missing_docs)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

pub use imgui;
use imgui::{Context, Io, TextureId, Ui};
use once_cell::sync::OnceCell;
pub use tracing;
use tracing::{error, trace, warn};
pub use windows;
use windows::core::Error;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, WPARAM};
use windows::Win32::System::Console::{
    AllocConsole, FreeConsole, GetConsoleMode, GetStdHandle, SetConsoleMode, CONSOLE_MODE,
    ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::LibraryLoader::FreeLibraryAndExitThread;

use crate::mh::{MH_ApplyQueued, MH_Initialize, MH_Uninitialize, MhHook, MH_STATUS};
use crate::util::HookEjectionBarrier;

pub mod hooks;
#[cfg(feature = "inject")]
pub mod inject;
pub mod mh;
pub mod process_input;
pub(crate) mod renderer;
pub mod sync_input;

pub use renderer::msg_filter::MessageFilter;

pub mod util;

// Global state objects.
static mut MODULE: OnceCell<HINSTANCE> = OnceCell::new();
static mut HUDHOOK: OnceCell<Hudhook> = OnceCell::new();
static CONSOLE_ALLOCATED: AtomicBool = AtomicBool::new(false);
static EJECT_REQUESTED: AtomicBool = AtomicBool::new(false);
static EJECT_WORKER_SCHEDULED: AtomicBool = AtomicBool::new(false);
static HOOK_EJECTION_BARRIER: HookEjectionBarrier = HookEjectionBarrier::new();

/// Guard that keeps hook-owned code and trampoline state alive while a custom
/// detour is executing.
///
/// Acquire this at the beginning of every detour that is registered alongside
/// hudhook's MinHook hooks and keep it alive until the detour has finished using
/// all hudhook or trampoline state.
#[must_use = "the guard must remain alive for the complete detour invocation"]
pub struct HookEjectionGuard {
    _guard: parking_lot::RwLockReadGuard<'static, ()>,
}

/// Acquire the process-wide hook ejection guard for a custom detour.
///
/// Hudhook disables every MinHook entry point before waiting for all guards.
/// Custom detours must use this accessor to participate in that teardown
/// barrier.
pub fn hook_ejection_guard() -> HookEjectionGuard {
    HookEjectionGuard {
        _guard: HOOK_EJECTION_BARRIER.acquire_ejection_guard(),
    }
}

/// Texture Loader for ImguiRenderLoop callbacks to load and replace textures
pub trait RenderContext {
    /// Load texture and return TextureId to use. Invoke it in your
    /// [`crate::ImguiRenderLoop::initialize`] method for setting up textures.
    fn load_texture(&mut self, data: &[u8], width: u32, height: u32) -> Result<TextureId, Error>;

    /// Upload an image to an existing texture, replacing its content. Invoke it
    /// in your [`crate::ImguiRenderLoop::before_render`] method for
    /// updating textures.
    fn replace_texture(
        &mut self,
        texture_id: TextureId,
        data: &[u8],
        width: u32,
        height: u32,
    ) -> Result<(), Error>;
}

/// Represents a control flow decision before the `wnd_proc` is executed.
///
/// See [`crate::ImguiRenderLoop::before_wnd_proc`].
#[derive(PartialEq, Eq)]
pub enum BeforeWndProc {
    /// Execute the `wnd_proc` code, and then run
    /// [`crate::ImguiRenderLoop::after_wnd_proc`].
    Continue,
    /// Skip the `wnd_proc` code, run
    /// [`crate::ImguiRenderLoop::after_wnd_proc`].
    Break,
}

/// Allocate a Windows console.
pub fn alloc_console() -> Result<(), Error> {
    if !CONSOLE_ALLOCATED.swap(true, Ordering::SeqCst) {
        unsafe { AllocConsole()? };
    }

    Ok(())
}

/// Enable console colors if the console is allocated.
pub fn enable_console_colors() {
    if CONSOLE_ALLOCATED.load(Ordering::SeqCst) {
        unsafe {
            // Get the stdout handle
            let stdout_handle = GetStdHandle(STD_OUTPUT_HANDLE).unwrap();

            // Call GetConsoleMode to get the current mode of the console
            let mut current_console_mode = CONSOLE_MODE(0);
            GetConsoleMode(stdout_handle, &mut current_console_mode).unwrap();

            // Set the new mode to include ENABLE_VIRTUAL_TERMINAL_PROCESSING for ANSI
            // escape sequences
            current_console_mode.0 |= ENABLE_VIRTUAL_TERMINAL_PROCESSING.0;

            // Call SetConsoleMode to set the new mode
            SetConsoleMode(stdout_handle, current_console_mode).unwrap();
        }
    }
}

/// Free the previously allocated Windows console.
pub fn free_console() -> Result<(), Error> {
    if CONSOLE_ALLOCATED.swap(false, Ordering::SeqCst) {
        unsafe { FreeConsole()? };
    }

    Ok(())
}

/// Disable hooks and eject the DLL.
///
/// ## Ejecting a DLL
///
/// To eject your DLL, invoke the [`eject`] method from anywhere in your
/// render loop. This will disable the hooks, free the console (if it has
/// been created before) and invoke
/// [`windows::Win32::System::LibraryLoader::FreeLibraryAndExitThread`].
///
/// Befor calling [`eject`], make sure to perform any manual cleanup (e.g.
/// dropping/resetting the contents of static mutable variables).
pub fn eject() {
    trace!("Requesting eject");
    EJECT_REQUESTED.store(true, Ordering::SeqCst);
    // The worker is safe to schedule from inside a guarded detour because this
    // call returns immediately; teardown waits only after the caller can exit.
    unsafe { perform_eject() };
}

/// Schedule ejection after the current hook invocation has returned.
unsafe fn perform_eject() {
    if EJECT_WORKER_SCHEDULED.swap(true, Ordering::AcqRel) {
        return;
    }

    trace!("Scheduling hook ejection worker");
    let worker = thread::Builder::new()
        .name("hudhook-eject".to_owned())
        .spawn(|| unsafe {
            trace!("Performing hook ejection");

            let Some(mut hudhook) = HUDHOOK.take() else {
                error!("Could not eject because the active Hudhook instance is unavailable");
                EJECT_REQUESTED.store(false, Ordering::Release);
                EJECT_WORKER_SCHEDULED.store(false, Ordering::Release);
                return;
            };

            if let Err(error) = hudhook.unapply() {
                error!(
                    ?error,
                    "Could not safely unapply hooks; keeping the module loaded"
                );
                if HUDHOOK.set(hudhook).is_err() {
                    error!("Could not restore the failed Hudhook instance");
                }
                EJECT_REQUESTED.store(false, Ordering::Release);
                EJECT_WORKER_SCHEDULED.store(false, Ordering::Release);
                return;
            }

            // Ensure the hook containers themselves are destroyed while their
            // code is still resident. Their global trampoline and pipeline state
            // has already been removed by `unapply`.
            drop(hudhook);

            if let Err(error) = free_console() {
                error!(?error, "Could not free the hudhook console before ejection");
            }

            let Some(module) = MODULE.take() else {
                warn!("Hooks were removed, but no DLL module handle was registered for ejection");
                return;
            };

            trace!("Hooks safely removed; unloading module");
            FreeLibraryAndExitThread(module.into(), 0);
        });
    if let Err(error) = worker {
        EJECT_REQUESTED.store(false, Ordering::Release);
        EJECT_WORKER_SCHEDULED.store(false, Ordering::Release);
        error!(?error, "Could not start the hudhook ejection worker");
    }
}

/// Implement your `imgui` rendering logic via this trait.
pub trait ImguiRenderLoop {
    /// Return shared process-wide mouse suppression state when this render loop
    /// needs User32 polling APIs to follow its input-ownership phases.
    ///
    /// The [`hudhook!`] entry-point macro installs the corresponding hook set
    /// together with the graphics hooks when this returns `Some`.
    fn process_mouse_suppression(&self) -> Option<Arc<process_input::ProcessMouseSuppression>> {
        None
    }

    /// Called once at the first occurrence of the hook. Implement this to
    /// initialize your data.
    /// `ctx` is the imgui context, and `render_context` is meant to access
    /// hudhook renderers' extensions such as texture management.
    fn initialize<'a>(
        &'a mut self,
        _ctx: &mut Context,
        _render_context: &'a mut dyn RenderContext,
    ) {
    }

    /// Called before rendering each frame. Use the provided `ctx` object to
    /// modify imgui settings before rendering the UI.
    /// `ctx` is the imgui context, and `render_context` is meant to access
    /// hudhook renderers' extensions such as texture management.
    fn before_render<'a>(
        &'a mut self,
        _ctx: &mut Context,
        _render_context: &'a mut dyn RenderContext,
    ) {
    }

    /// Called every frame. Use the provided `ui` object to build your UI.
    fn render(&mut self, ui: &mut Ui);

    /// Returns an optional thread-safe handler that runs inside hudhook's real
    /// replacement WndProc before the message is queued for the render thread.
    ///
    /// This is the only callback suitable for copying `WM_INPUT` data or
    /// deciding propagation synchronously. It must not access the mutable
    /// ImGui context owned by the render thread.
    fn synchronous_wnd_proc_handler(
        &self,
    ) -> Option<Arc<dyn sync_input::SynchronousWndProcHandler>> {
        None
    }

    /// Called before the window procedure.
    fn before_wnd_proc(
        &self,
        _hwnd: HWND,
        _umsg: u32,
        _wparam: WPARAM,
        _lparam: LPARAM,
    ) -> BeforeWndProc {
        BeforeWndProc::Continue
    }

    /// Called after the window procedure.
    fn after_wnd_proc(&self, _hwnd: HWND, _umsg: u32, _wparam: WPARAM, _lparam: LPARAM) {}

    /// Returns the types of window message that
    /// you do not want to propagate to the main window
    fn message_filter(&self, _io: &Io) -> MessageFilter {
        MessageFilter::empty()
    }
}

/// Generic trait for platform-specific hooks.
///
/// Implement this if you are building a custom hook for a non-supported
/// renderer.
///
/// Check out first party implementations for guidance on how to implement the
/// methods:
/// - [`ImguiDx9Hooks`](crate::hooks::dx9::ImguiDx9Hooks)
/// - [`ImguiDx11Hooks`](crate::hooks::dx11::ImguiDx11Hooks)
/// - [`ImguiDx12Hooks`](crate::hooks::dx12::ImguiDx12Hooks)
/// - [`ImguiOpenGl3Hooks`](crate::hooks::opengl3::ImguiOpenGl3Hooks)
pub trait Hooks {
    /// Construct a boxed instance of the implementor, storing the provided
    /// render loop where appropriate.
    fn from_render_loop<T>(t: T) -> Box<Self>
    where
        Self: Sized,
        T: ImguiRenderLoop + Send + Sync + 'static;

    /// Return the list of hooks to be enabled, in order.
    fn hooks(&self) -> &[MhHook];

    /// Clean up global data after all MinHook entry points have been disabled
    /// and their in-flight detours have returned.
    ///
    /// # Safety
    ///
    /// Is most definitely UB.
    unsafe fn unhook(&mut self) -> Result<(), Error>;
}

/// Error returned while safely disabling and cleaning up hudhook hooks.
#[derive(Debug)]
pub enum UnapplyError {
    /// MinHook could not queue, apply, or remove one or more raw hooks.
    MinHook(MH_STATUS),
    /// A hook backend could not restore its external state, such as a
    /// replacement window procedure.
    HookCleanup(Error),
}

impl std::fmt::Display for UnapplyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MinHook(status) => write!(formatter, "MinHook teardown failed: {status:?}"),
            Self::HookCleanup(error) => write!(formatter, "hook cleanup failed: {error}"),
        }
    }
}

impl std::error::Error for UnapplyError {}

/// Holds all the activated hooks and manages their lifetime.
pub struct Hudhook {
    hooks: Vec<Box<dyn Hooks>>,
    owns_minhook: bool,
}
unsafe impl Send for Hudhook {}
unsafe impl Sync for Hudhook {}

impl Hudhook {
    /// Create a builder object.
    pub fn builder() -> HudhookBuilder {
        HudhookBuilder(Hudhook::new())
    }

    fn new() -> Self {
        // Initialize minhook.
        let owns_minhook = match unsafe { MH_Initialize() } {
            MH_STATUS::MH_OK => true,
            MH_STATUS::MH_ERROR_ALREADY_INITIALIZED => {
                warn!("Minhook already initialized");
                false
            }
            status @ MH_STATUS::MH_ERROR_MEMORY_ALLOC => panic!("MH_Initialize: {status:?}"),
            _ => unreachable!(),
        };

        Hudhook {
            hooks: Vec::new(),
            owns_minhook,
        }
    }

    /// Return an iterator of all the activated raw hooks.
    fn hooks(&self) -> impl IntoIterator<Item = &MhHook> {
        self.hooks.iter().flat_map(|h| h.hooks())
    }

    /// Apply the hooks.
    pub fn apply(mut self) -> Result<(), MH_STATUS> {
        let apply_result = (|| {
            // Queue enabling all the hooks.
            for hook in self.hooks() {
                unsafe { hook.queue_enable()? };
            }

            // Apply the queue of enable actions.
            unsafe { MH_ApplyQueued().ok_context("MH_ApplyQueued")? };
            Ok(())
        })();

        if let Err(status) = apply_result {
            if let Err(error) = self.unapply() {
                error!(?error, "Could not roll back failed hook application");
            }
            return Err(status);
        }

        match unsafe { HUDHOOK.set(self) } {
            Ok(()) => Ok(()),
            Err(mut hudhook) => {
                if let Err(error) = hudhook.unapply() {
                    error!(?error, "Could not roll back duplicate Hudhook owner");
                }
                Err(MH_STATUS::MH_ERROR_ALREADY_CREATED)
            }
        }
    }

    /// Disable and cleanup the hooks.
    pub fn unapply(&mut self) -> Result<(), UnapplyError> {
        trace!("Unapply hook");
        // Queue disabling all the hooks.
        for hook in self.hooks() {
            unsafe { hook.queue_disable().map_err(UnapplyError::MinHook)? };
        }

        // Apply the queue of disable actions.
        unsafe {
            MH_ApplyQueued()
                .ok_context("MH_ApplyQueued")
                .map_err(UnapplyError::MinHook)?;
        }

        // No new detour can start after the queued disables have been
        // published. Wait for every invocation that already entered a detour
        // to release its guard before removing trampoline-owned state.
        HOOK_EJECTION_BARRIER.wait_for_all_guards();

        // Invoke cleanup for all hooks.
        for hook in &mut self.hooks {
            unsafe { hook.unhook().map_err(UnapplyError::HookCleanup)? };
        }

        // MinHook owns the executable trampoline buffers. They may only be
        // released after detours have drained and hook backends have stopped
        // exposing their trampoline pointers.
        if self.owns_minhook {
            unsafe {
                MH_Uninitialize()
                    .ok_context("MH_Uninitialize")
                    .map_err(UnapplyError::MinHook)?;
            }
        } else {
            for hook in self.hooks() {
                unsafe { hook.remove().map_err(UnapplyError::MinHook)? };
            }
        }
        trace!("Finished removing hook");

        Ok(())
    }
}

/// Builder object for [`Hudhook`].
///
/// Example usage:
/// ```no_run
/// use hudhook::hooks::dx12::ImguiDx12Hooks;
/// use hudhook::hooks::ImguiRenderLoop;
/// use hudhook::*;
///
/// pub struct MyRenderLoop;
///
/// impl ImguiRenderLoop for MyRenderLoop {
///     fn render(&mut self, frame: &mut imgui::Ui) {
///         // ...
///     }
/// }
///
/// #[no_mangle]
/// pub unsafe extern "stdcall" fn DllMain(
///     hmodule: HINSTANCE,
///     reason: u32,
///     _: *mut std::ffi::c_void,
/// ) {
///     if reason == DLL_PROCESS_ATTACH {
///         std::thread::spawn(move || {
///             let hooks = Hudhook::builder()
///                 .with::<ImguiDx12Hooks>(MyRenderLoop())
///                 .with_hmodule(hmodule)
///                 .build();
///             hooks.apply();
///         });
///     }
/// }
pub struct HudhookBuilder(Hudhook);

impl HudhookBuilder {
    /// Add a hook object.
    pub fn with<T: Hooks + 'static>(
        mut self,
        render_loop: impl ImguiRenderLoop + Send + Sync + 'static,
    ) -> Self {
        self.0.hooks.push(T::from_render_loop(render_loop));
        self
    }

    /// Add an already constructed hook set.
    ///
    /// This is useful when a hook set needs shared state that is also owned by
    /// the render loop, rather than constructing itself from a second render
    /// loop value through [`Self::with`].
    pub fn with_hook_set<T: Hooks + 'static>(mut self, hooks: Box<T>) -> Self {
        self.0.hooks.push(hooks);
        self
    }

    /// Return whether this builder initialized the process-wide MinHook state.
    pub fn owns_minhook(&self) -> bool {
        self.0.owns_minhook
    }

    /// Roll back hook construction before any hook set is applied.
    ///
    /// This removes hook targets created so far and releases MinHook only when
    /// this builder initialized it.
    pub fn abort(mut self) -> Result<(), UnapplyError> {
        self.0.unapply()
    }

    /// Save the DLL instance (for the [`eject`] method).
    pub fn with_hmodule(self, module: HINSTANCE) -> Self {
        unsafe { MODULE.set(module).unwrap() };
        self
    }

    /// Build the [`Hudhook`] object.
    pub fn build(self) -> Hudhook {
        self.0
    }
}

/// Entry point generator for the library.
///
/// After implementing your [render loop](crate::hooks) of choice, invoke
/// the macro to generate the `DllMain` function that will serve as entry point
/// for your hook.
///
/// Example usage:
/// ```no_run
/// use hudhook::hooks::dx12::ImguiDx12Hooks;
/// use hudhook::hooks::ImguiRenderLoop;
/// use hudhook::*;
///
/// pub struct MyRenderLoop;
///
/// impl ImguiRenderLoop for MyRenderLoop {
///     fn render(&mut self, frame: &mut imgui::Ui) {
///         // ...
///     }
/// }
///
/// hudhook::hudhook!(MyRenderLoop.into_hook::<ImguiDx12Hooks>());
/// ```
#[macro_export]
macro_rules! hudhook {
    ($t:ty, $hooks:expr) => {
        /// Entry point created by the `hudhook` library.
        #[no_mangle]
        pub unsafe extern "system" fn DllMain(
            hmodule: ::hudhook::windows::Win32::Foundation::HINSTANCE,
            reason: u32,
            _: *mut ::std::ffi::c_void,
        ) {
            use ::hudhook::*;

            if reason == ::hudhook::windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH {
                ::hudhook::tracing::trace!("DllMain()");
                let hmodule_raw = hmodule.0 as usize;
                ::std::thread::spawn(move || {
                    let hmodule =
                        ::hudhook::windows::Win32::Foundation::HINSTANCE(hmodule_raw as _);
                    let render_loop = { $hooks };
                    let process_mouse_suppression = render_loop.process_mouse_suppression();
                    let builder = ::hudhook::Hudhook::builder();
                    if process_mouse_suppression.is_some() && !builder.owns_minhook() {
                        ::hudhook::tracing::error!(
                            "Cannot install process input hooks because MinHook is already owned"
                        );
                        return;
                    }
                    let builder = if let Some(state) = process_mouse_suppression {
                        match ::hudhook::process_input::ProcessInputHooks::new(state) {
                            Ok(hooks) => builder.with_hook_set(hooks),
                            Err(e) => {
                                ::hudhook::tracing::error!(
                                    "Couldn't create process input hooks: {e:?}"
                                );
                                if let Err(rollback) = builder.abort() {
                                    ::hudhook::tracing::error!(
                                        "Couldn't roll back process input hook construction: {rollback:?}"
                                    );
                                }
                                return;
                            }
                        }
                    } else {
                        builder
                    };
                    let graphics_hooks = match ::std::panic::catch_unwind(
                        ::std::panic::AssertUnwindSafe(|| {
                            <$t as ::hudhook::Hooks>::from_render_loop(render_loop)
                        }),
                    ) {
                        Ok(hooks) => hooks,
                        Err(_) => {
                            ::hudhook::tracing::error!("Couldn't construct graphics hooks");
                            if let Err(rollback) = builder.abort() {
                                ::hudhook::tracing::error!(
                                    "Couldn't roll back graphics hook construction: {rollback:?}"
                                );
                            }
                            return;
                        }
                    };
                    if let Err(e) = builder
                        .with_hook_set(graphics_hooks)
                        .with_hmodule(hmodule)
                        .build()
                        .apply()
                    {
                        ::hudhook::tracing::error!("Couldn't apply hooks: {e:?}");
                    }
                });
            }
        }
    };
}
