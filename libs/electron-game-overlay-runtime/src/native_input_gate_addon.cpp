#include <Windows.h>

#include <imgui.h>
#include <reshade.hpp>

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace
{
using namespace reshade::api;

constexpr std::uint32_t kTextureWidth = 128;
constexpr std::uint32_t kTextureHeight = 128;
constexpr std::size_t kTextureChannels = 4;

struct __declspec(uuid("99890b3d-b6ef-484d-9b49-eb65de7f9fc9")) device_data
{
    resource texture = {};
    resource_view texture_view = {};
};

struct window_input_state
{
    std::atomic<std::uint64_t> rendered_frames = 0;
    std::atomic<std::uint64_t> interception_toggle_count = 0;
    std::atomic<std::uint64_t> probe_click_count = 0;
    std::atomic<bool> input_interception_enabled = false;
    std::atomic<bool> toggle_chord_armed = false;
    std::atomic<bool> i_release_consumed = false;
};

struct __declspec(uuid("91913d40-2c94-439c-96f1-85f6666c5046")) swapchain_data
{
    explicit swapchain_data(std::shared_ptr<window_input_state> shared_state) : state(std::move(shared_state)) {}

    std::shared_ptr<window_input_state> state;
    char keyboard_probe[128] = {};
    std::uint64_t text_edit_count = 0;
    float drag_probe = 0.5f;
    float wheel_total = 0.0f;
};

std::mutex g_window_states_mutex;
std::unordered_map<HWND, std::weak_ptr<window_input_state>> g_window_states;

constexpr auto make_test_pattern()
{
    std::array<std::uint8_t, kTextureWidth * kTextureHeight * kTextureChannels> pixels = {};

    for (std::uint32_t y = 0; y < kTextureHeight; ++y)
    {
        for (std::uint32_t x = 0; x < kTextureWidth; ++x)
        {
            const bool alternate = ((x / 16) + (y / 16)) % 2 == 0;
            const std::size_t offset = (static_cast<std::size_t>(y) * kTextureWidth + x) * kTextureChannels;

            pixels[offset + 0] = alternate ? 45 : 13;
            pixels[offset + 1] = alternate ? 212 : 92;
            pixels[offset + 2] = alternate ? 191 : 168;
            pixels[offset + 3] = 255;
        }
    }

    return pixels;
}

constexpr auto kTestPattern = make_test_pattern();

const char *api_name(device_api api)
{
    switch (api)
    {
    case device_api::d3d9:
        return "Direct3D 9";
    case device_api::d3d10:
        return "Direct3D 10";
    case device_api::d3d11:
        return "Direct3D 11";
    case device_api::d3d12:
        return "Direct3D 12";
    case device_api::opengl:
        return "OpenGL";
    case device_api::vulkan:
        return "Vulkan";
    default:
        return "Unknown";
    }
}

void on_init_device(device *device)
{
    auto *const data = device->create_private_data<device_data>();

    subresource_data initial_data = {};
    initial_data.data = const_cast<std::uint8_t *>(kTestPattern.data());
    initial_data.row_pitch = kTextureWidth * kTextureChannels;
    initial_data.slice_pitch = initial_data.row_pitch * kTextureHeight;

    const resource_desc texture_desc(
        kTextureWidth,
        kTextureHeight,
        1,
        1,
        format::r8g8b8a8_unorm,
        1,
        memory_heap::gpu_only,
        resource_usage::shader_resource);

    if (!device->create_resource(
            texture_desc,
            &initial_data,
            resource_usage::shader_resource,
            &data->texture))
    {
        reshade::log::message(
            reshade::log::level::error,
            "Native input gate add-on failed to create its test texture.");
        return;
    }

    if (!device->create_resource_view(
            data->texture,
            resource_usage::shader_resource,
            resource_view_desc(format::r8g8b8a8_unorm),
            &data->texture_view))
    {
        device->destroy_resource(data->texture);
        data->texture = {};

        reshade::log::message(
            reshade::log::level::error,
            "Native input gate add-on failed to create its test texture view.");
        return;
    }

    reshade::log::message(
        reshade::log::level::info,
        "Native input gate add-on initialized its GPU texture.");
}

void on_destroy_device(device *device)
{
    auto *const data = device->get_private_data<device_data>();
    if (data == nullptr)
        return;

    if (data->texture_view.handle != 0)
        device->destroy_resource_view(data->texture_view);
    if (data->texture.handle != 0)
        device->destroy_resource(data->texture);

    device->destroy_private_data<device_data>();
}

void on_init_swapchain(swapchain *swapchain, bool resize)
{
    if (resize)
        return;

    const auto window = static_cast<HWND>(swapchain->get_hwnd());
    std::shared_ptr<window_input_state> state;

    if (window != nullptr)
    {
        const std::scoped_lock lock(g_window_states_mutex);
        state = g_window_states[window].lock();
        if (state == nullptr)
        {
            state = std::make_shared<window_input_state>();
            g_window_states[window] = state;
        }
    }
    else
    {
        state = std::make_shared<window_input_state>();
    }

    swapchain->create_private_data<swapchain_data>(std::move(state));
}

void on_destroy_swapchain(swapchain *swapchain, bool resize)
{
    if (resize)
        return;

    auto *const data = swapchain->get_private_data<swapchain_data>();
    if (data == nullptr)
        return;

    const auto window = static_cast<HWND>(swapchain->get_hwnd());
    std::shared_ptr<window_input_state> state = data->state;
    swapchain->destroy_private_data<swapchain_data>();

    if (window != nullptr)
    {
        state.reset();
        const std::scoped_lock lock(g_window_states_mutex);
        const auto entry = g_window_states.find(window);
        if (entry != g_window_states.end() && entry->second.expired())
            g_window_states.erase(entry);
    }
}

void on_reshade_overlay(effect_runtime *runtime)
{
    device *const device = runtime->get_device();
    auto *const device_state = device->get_private_data<device_data>();
    auto *const swapchain_state = runtime->get_private_data<swapchain_data>();
    if (device_state == nullptr || swapchain_state == nullptr || swapchain_state->state == nullptr)
        return;

    const std::shared_ptr<window_input_state> input_state = swapchain_state->state;

    const std::uint64_t rendered_frames = input_state->rendered_frames.fetch_add(1) + 1;
    const bool is_first_frame = rendered_frames == 1;

    const bool control_down =
        runtime->is_key_down(VK_CONTROL) ||
        runtime->is_key_down(VK_LCONTROL) ||
        runtime->is_key_down(VK_RCONTROL);
    const bool control_pressed =
        runtime->is_key_pressed(VK_CONTROL) ||
        runtime->is_key_pressed(VK_LCONTROL) ||
        runtime->is_key_pressed(VK_RCONTROL);
    const bool control_released =
        runtime->is_key_released(VK_CONTROL) ||
        runtime->is_key_released(VK_LCONTROL) ||
        runtime->is_key_released(VK_RCONTROL);
    const bool i_down = runtime->is_key_down('I');
    const bool i_pressed = runtime->is_key_pressed('I');
    const bool i_released = runtime->is_key_released('I');

    if ((control_down || control_pressed) && (i_down || i_pressed))
        input_state->toggle_chord_armed = true;

    if (!i_released)
    {
        if (!i_down)
        {
            input_state->i_release_consumed = false;
            if (!control_down && !control_pressed && !control_released)
                input_state->toggle_chord_armed = false;
        }
    }
    else if (!input_state->i_release_consumed.exchange(true))
    {
        const bool chord_armed = input_state->toggle_chord_armed.exchange(false);
        if (chord_armed || control_down || control_pressed || control_released)
        {
            const bool interception_enabled =
                !input_state->input_interception_enabled.load();
            input_state->input_interception_enabled = interception_enabled;
            ++input_state->interception_toggle_count;
            reshade::log::message(
                reshade::log::level::info,
                interception_enabled
                    ? "Native input gate enabled ReShade-owned input interception."
                    : "Native input gate disabled ReShade-owned input interception.");
        }
    }

    const bool interception_enabled = input_state->input_interception_enabled.load();
    if (interception_enabled)
        runtime->block_input_next_frame();

    ImGuiIO &io = ImGui::GetIO();
    CURSORINFO cursor_info = { sizeof(CURSORINFO) };
    const bool native_cursor_visible =
        GetCursorInfo(&cursor_info) != FALSE && (cursor_info.flags & CURSOR_SHOWING) != 0;
    if (interception_enabled && !native_cursor_visible)
        io.MouseDrawCursor = true;

    ImGui::SetNextWindowPos(ImVec2(24.0f, 128.0f), ImGuiCond_Always);
    ImGui::SetNextWindowBgAlpha(0.88f);

    ImGuiWindowFlags window_flags =
        ImGuiWindowFlags_NoDecoration |
        ImGuiWindowFlags_AlwaysAutoResize |
        ImGuiWindowFlags_NoSavedSettings |
        ImGuiWindowFlags_NoFocusOnAppearing;
    if (!interception_enabled)
        window_flags |= ImGuiWindowFlags_NoInputs;

    if (ImGui::Begin("Native input gate##always_visible", nullptr, window_flags))
    {
        ImGui::TextColored(ImVec4(0.25f, 0.95f, 0.72f, 1.0f), "Hook + ImGui render path is alive");
        ImGui::Separator();
        ImGui::Text("Hook/runtime: ReShade 6.7.3");
        ImGui::Text("Graphics API: %s", api_name(device->get_api()));
        ImGui::Text("Render callbacks: %llu", static_cast<unsigned long long>(rendered_frames));
        ImGui::TextColored(
            interception_enabled
                ? ImVec4(0.25f, 0.95f, 0.72f, 1.0f)
                : ImVec4(0.85f, 0.70f, 0.35f, 1.0f),
            interception_enabled
                ? "Input: RESHADE-OWNED (game blocked)"
                : "Input: pass-through");
        ImGui::TextUnformatted("Ctrl+I toggles interception");
        ImGui::Text(
            "Mouse %.0f, %.0f | capture %s | software cursor %s",
            io.MousePos.x,
            io.MousePos.y,
            io.WantCaptureMouse ? "true" : "false",
            io.MouseDrawCursor ? "true" : "false");
        ImGui::Text(
            "Toggles: %llu | probe clicks: %llu",
            static_cast<unsigned long long>(input_state->interception_toggle_count.load()),
            static_cast<unsigned long long>(input_state->probe_click_count.load()));
        if (interception_enabled)
        {
            if (ImGui::IsMouseClicked(ImGuiMouseButton_Left))
            {
                char click_message[160] = {};
                sprintf_s(
                    click_message,
                    "Native input gate received an owned pointer click at %.0f, %.0f.",
                    io.MousePos.x,
                    io.MousePos.y);
                reshade::log::message(reshade::log::level::info, click_message);
            }

            if (ImGui::Button("CLICK RE SHADE INPUT PROBE", ImVec2(320.0f, 54.0f)))
            {
                ++input_state->probe_click_count;
                reshade::log::message(
                    reshade::log::level::info,
                    "Native input gate accepted a ReShade-owned ImGui click.");
            }

            ImGui::SetNextItemWidth(320.0f);
            if (ImGui::InputText(
                "Keyboard probe",
                swapchain_state->keyboard_probe,
                sizeof(swapchain_state->keyboard_probe)))
            {
                ++swapchain_state->text_edit_count;
                reshade::log::message(
                    reshade::log::level::info,
                    "Native input gate accepted a ReShade-owned text edit.");
            }

            ImGui::SetNextItemWidth(320.0f);
            if (ImGui::SliderFloat("Drag probe", &swapchain_state->drag_probe, 0.0f, 1.0f))
            {
                reshade::log::message(
                    reshade::log::level::info,
                    "Native input gate accepted a ReShade-owned drag update.");
            }

            if (io.MouseWheel != 0.0f)
            {
                swapchain_state->wheel_total += io.MouseWheel;
                reshade::log::message(
                    reshade::log::level::info,
                    "Native input gate accepted a ReShade-owned wheel update.");
            }
            ImGui::Text(
                "Text edits: %llu | overlay wheel: %.1f",
                static_cast<unsigned long long>(swapchain_state->text_edit_count),
                swapchain_state->wheel_total);
        }
        ImGui::Spacing();

        if (device_state->texture_view.handle != 0)
        {
            ImGui::Image(
                device_state->texture_view.handle,
                ImVec2(static_cast<float>(kTextureWidth), static_cast<float>(kTextureHeight)));
            ImGui::SameLine();
            ImGui::BeginGroup();
            ImGui::TextUnformatted("Generated RGBA texture");
            ImGui::TextUnformatted("uploaded through ReShade's");
            ImGui::TextUnformatted("graphics-agnostic resource API");
            ImGui::EndGroup();
        }
        else
        {
            ImGui::TextColored(ImVec4(1.0f, 0.35f, 0.3f, 1.0f), "Texture upload failed; inspect ReShade.log.");
        }
    }
    ImGui::End();

    if (is_first_frame)
    {
        reshade::log::message(
            reshade::log::level::info,
            "Native input gate add-on rendered its first ImGui frame.");
    }
}
} // namespace

extern "C" __declspec(dllexport) const char *NAME = "Native Input Gate Add-on";
extern "C" __declspec(dllexport) const char *DESCRIPTION =
    "Always-visible ImGui and texture proof rendered through ReShade's hook/runtime.";

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID)
{
    switch (reason)
    {
    case DLL_PROCESS_ATTACH:
        if (!reshade::register_addon(module))
            return FALSE;

        reshade::register_event<reshade::addon_event::init_device>(on_init_device);
        reshade::register_event<reshade::addon_event::destroy_device>(on_destroy_device);
        reshade::register_event<reshade::addon_event::init_swapchain>(on_init_swapchain);
        reshade::register_event<reshade::addon_event::destroy_swapchain>(on_destroy_swapchain);
        reshade::register_event<reshade::addon_event::reshade_overlay>(on_reshade_overlay);

        reshade::log::message(
            reshade::log::level::info,
            "Native input gate add-on add-on loaded.");
        break;

    case DLL_PROCESS_DETACH:
        reshade::unregister_addon(module);
        break;
    }

    return TRUE;
}
