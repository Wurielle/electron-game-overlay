use hudhook::hooks::dx11::ImguiDx11Hooks;
use hudhook_imgui_overlay_ui::PocRenderLoop;

hudhook::hudhook!(ImguiDx11Hooks, PocRenderLoop::new("Direct3D 11"));
