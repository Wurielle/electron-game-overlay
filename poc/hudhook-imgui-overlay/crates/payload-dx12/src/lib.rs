use hudhook::hooks::dx12::ImguiDx12Hooks;
use hudhook_imgui_overlay_ui::PocRenderLoop;

hudhook::hudhook!(ImguiDx12Hooks, PocRenderLoop::new("Direct3D 12"));
