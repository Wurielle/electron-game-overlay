#include <imgui.h>
#include <reshade.hpp>

#include <array>
#include <cstddef>
#include <cstdint>

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
    std::uint64_t rendered_frames = 0;
};

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
            "Alternative ImGui compositor POC failed to create its test texture.");
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
            "Alternative ImGui compositor POC failed to create its test texture view.");
        return;
    }

    reshade::log::message(
        reshade::log::level::info,
        "Alternative ImGui compositor POC initialized its GPU texture.");
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

void on_reshade_overlay(effect_runtime *runtime)
{
    device *const device = runtime->get_device();
    auto *const data = device->get_private_data<device_data>();
    if (data == nullptr)
        return;

    ++data->rendered_frames;
    const bool is_first_frame = data->rendered_frames == 1;

    ImGui::SetNextWindowPos(ImVec2(24.0f, 128.0f), ImGuiCond_Always);
    ImGui::SetNextWindowBgAlpha(0.88f);

    constexpr ImGuiWindowFlags window_flags =
        ImGuiWindowFlags_NoDecoration |
        ImGuiWindowFlags_AlwaysAutoResize |
        ImGuiWindowFlags_NoSavedSettings |
        ImGuiWindowFlags_NoFocusOnAppearing |
        ImGuiWindowFlags_NoNav |
        ImGuiWindowFlags_NoInputs;

    if (ImGui::Begin("Alternative compositor POC##always_visible", nullptr, window_flags))
    {
        ImGui::TextColored(ImVec4(0.25f, 0.95f, 0.72f, 1.0f), "Hook + ImGui render path is alive");
        ImGui::Separator();
        ImGui::Text("Hook/runtime: ReShade 6.7.3");
        ImGui::Text("Graphics API: %s", api_name(device->get_api()));
        ImGui::Text("Rendered frames: %llu", static_cast<unsigned long long>(data->rendered_frames));
        ImGui::TextUnformatted("Input: pass-through for this first proof");
        ImGui::Spacing();

        if (data->texture_view.handle != 0)
        {
            ImGui::Image(
                data->texture_view.handle,
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
            "Alternative ImGui compositor POC rendered its first ImGui frame.");
    }
}
} // namespace

extern "C" __declspec(dllexport) const char *NAME = "Alternative ImGui Compositor POC";
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
        reshade::register_event<reshade::addon_event::reshade_overlay>(on_reshade_overlay);

        reshade::log::message(
            reshade::log::level::info,
            "Alternative ImGui compositor POC add-on loaded.");
        break;

    case DLL_PROCESS_DETACH:
        reshade::unregister_addon(module);
        break;
    }

    return TRUE;
}
