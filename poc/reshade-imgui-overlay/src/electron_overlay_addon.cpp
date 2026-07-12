#include <Windows.h>

#include <electron_overlay_core.h>
#include <imgui.h>
#include <reshade.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <mutex>
#include <unordered_map>
#include <unordered_set>

namespace
{
using namespace reshade::api;

enum class input_phase : std::uint8_t
{
    disabled,
    arming,
    enabled,
    disarming,
};

struct electron_texture
{
    resource texture = {};
    resource_view view = {};
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint64_t state_revision = 0;
    std::uint64_t sequence = 0;
};

struct __declspec(uuid("c170f82c-00e6-4447-89aa-ca7fbb6fc081")) device_data
{
    std::mutex mutex;
    std::unordered_map<std::uint32_t, electron_texture> textures;
};

struct __declspec(uuid("f56d61dd-7b2b-4ad0-ab1b-9dc40f0efe4a")) swapchain_data
{
    ego_core *core = nullptr;
    HWND window = nullptr;
    input_phase phase = input_phase::disabled;
    bool first_scene_logged = false;
    ego_status last_error = EGO_STATUS_OK;
};

std::mutex g_core_mutex;
ego_core *g_core = nullptr;
std::uint32_t g_core_references = 0;
std::unordered_map<HWND, std::uint32_t> g_target_windows;

void log_core_error(const char *operation, ego_status status)
{
    char detail[512] = {};
    std::uint64_t required = 0;
    const ego_status detail_status =
        ego_get_last_error_message(detail, sizeof(detail), &required);

    char message[768] = {};
    if ((detail_status == EGO_STATUS_OK || detail_status == EGO_STATUS_BUFFER_TOO_SMALL) &&
        detail[0] != '\0')
    {
        sprintf_s(
            message,
            "Electron ReShade compositor %s failed (status %d): %s",
            operation,
            static_cast<int>(status),
            detail);
    }
    else
    {
        sprintf_s(
            message,
            "Electron ReShade compositor %s failed (status %d).",
            operation,
            static_cast<int>(status));
    }
    reshade::log::message(reshade::log::level::error, message);
}

ego_core *retain_core(HWND window)
{
    const std::scoped_lock lock(g_core_mutex);
    if (g_core == nullptr)
    {
        const ego_status status = ego_core_create(EGO_ABI_VERSION, &g_core);
        if (status != EGO_STATUS_OK)
        {
            log_core_error("core initialization", status);
            g_core = nullptr;
            return nullptr;
        }
        reshade::log::message(
            reshade::log::level::info,
            "Electron ReShade compositor initialized its transport/router core.");
    }

    ++g_core_references;
    if (window != nullptr)
        ++g_target_windows[window];
    return g_core;
}

void release_core(ego_core *core, HWND window)
{
    ego_core *destroy = nullptr;
    {
        const std::scoped_lock lock(g_core_mutex);
        if (window != nullptr)
        {
            const auto entry = g_target_windows.find(window);
            if (entry != g_target_windows.end())
            {
                if (entry->second <= 1)
                    g_target_windows.erase(entry);
                else
                    --entry->second;
            }
        }
        if (core == nullptr || core != g_core || g_core_references == 0)
            return;

        --g_core_references;
        if (g_core_references == 0)
        {
            destroy = g_core;
            g_core = nullptr;
            g_target_windows.clear();
        }
    }

    if (destroy != nullptr)
    {
        const ego_status status = ego_core_destroy(destroy);
        if (status != EGO_STATUS_OK)
            log_core_error("core shutdown", status);
    }
}

bool any_target_focused()
{
    const HWND foreground = GetForegroundWindow();
    if (foreground == nullptr)
        return false;

    const std::scoped_lock lock(g_core_mutex);
    for (const auto &[window, references] : g_target_windows)
    {
        static_cast<void>(references);
        const HWND root = GetAncestor(window, GA_ROOT);
        if (foreground == window || (root != nullptr && foreground == root))
            return true;
    }
    return false;
}

input_phase next_phase(input_phase current, bool desired)
{
    switch (current)
    {
    case input_phase::disabled:
        return desired ? input_phase::arming : input_phase::disabled;
    case input_phase::arming:
        return desired ? input_phase::enabled : input_phase::disarming;
    case input_phase::enabled:
        return desired ? input_phase::enabled : input_phase::disarming;
    case input_phase::disarming:
        return desired ? input_phase::arming : input_phase::disabled;
    default:
        return input_phase::disabled;
    }
}

bool valid_frame(const ego_window_frame_v1 &frame)
{
    if (frame.struct_size != sizeof(frame) ||
        frame.abi_version != EGO_ABI_VERSION ||
        frame.raster_width == 0 ||
        frame.raster_height == 0 ||
        frame.rect_width <= 0 ||
        frame.rect_height <= 0 ||
        frame.rgba == nullptr)
    {
        return false;
    }

    const std::uint64_t minimum_row_pitch =
        static_cast<std::uint64_t>(frame.raster_width) * 4;
    return frame.row_pitch >= minimum_row_pitch &&
        frame.row_pitch <= std::numeric_limits<std::uint32_t>::max() &&
        frame.rgba_len <= std::numeric_limits<std::uint32_t>::max() &&
        frame.rgba_len >= frame.row_pitch * frame.raster_height;
}

void destroy_texture(device *device, electron_texture &texture)
{
    if (texture.view.handle != 0)
        device->destroy_resource_view(texture.view);
    if (texture.texture.handle != 0)
        device->destroy_resource(texture.texture);
    texture = {};
}

bool create_texture(
    device *device,
    const ego_window_frame_v1 &frame,
    electron_texture &texture)
{
    subresource_data initial_data = {};
    initial_data.data = const_cast<std::uint8_t *>(frame.rgba);
    initial_data.row_pitch = static_cast<std::uint32_t>(frame.row_pitch);
    initial_data.slice_pitch = static_cast<std::uint32_t>(frame.rgba_len);

    const resource_desc desc(
        frame.raster_width,
        frame.raster_height,
        1,
        1,
        format::r8g8b8a8_unorm,
        1,
        memory_heap::gpu_only,
        resource_usage::shader_resource | resource_usage::copy_dest);

    if (!device->create_resource(
            desc,
            &initial_data,
            resource_usage::shader_resource,
            &texture.texture))
    {
        reshade::log::message(
            reshade::log::level::error,
            "Electron ReShade compositor could not create an Electron texture.");
        return false;
    }

    if (!device->create_resource_view(
            texture.texture,
            resource_usage::shader_resource,
            resource_view_desc(format::r8g8b8a8_unorm),
            &texture.view))
    {
        device->destroy_resource(texture.texture);
        texture.texture = {};
        reshade::log::message(
            reshade::log::level::error,
            "Electron ReShade compositor could not create an Electron texture view.");
        return false;
    }

    texture.width = frame.raster_width;
    texture.height = frame.raster_height;
    texture.state_revision = frame.state_revision;
    texture.sequence = frame.sequence;
    return true;
}

bool update_texture(
    effect_runtime *runtime,
    const ego_window_frame_v1 &frame,
    electron_texture &texture)
{
    command_queue *const queue = runtime->get_command_queue();
    if (queue == nullptr)
        return false;

    command_list *command_list = queue->get_immediate_command_list();
    if (command_list == nullptr)
        return false;

    subresource_data pixels = {};
    pixels.data = const_cast<std::uint8_t *>(frame.rgba);
    pixels.row_pitch = static_cast<std::uint32_t>(frame.row_pitch);
    pixels.slice_pitch = static_cast<std::uint32_t>(frame.rgba_len);

    command_list->barrier(
        texture.texture,
        resource_usage::shader_resource,
        resource_usage::copy_dest);
    queue->flush_immediate_command_list();

    runtime->get_device()->update_texture_region(pixels, texture.texture, 0);

    command_list = queue->get_immediate_command_list();
    if (command_list == nullptr)
        return false;
    command_list->barrier(
        texture.texture,
        resource_usage::copy_dest,
        resource_usage::shader_resource);
    queue->flush_immediate_command_list();

    texture.state_revision = frame.state_revision;
    texture.sequence = frame.sequence;
    return true;
}

void on_init_device(device *device)
{
    device->create_private_data<device_data>();
}

void on_destroy_device(device *device)
{
    auto *const data = device->get_private_data<device_data>();
    if (data == nullptr)
        return;

    {
        const std::scoped_lock lock(data->mutex);
        for (auto &[window_id, texture] : data->textures)
        {
            static_cast<void>(window_id);
            destroy_texture(device, texture);
        }
        data->textures.clear();
    }
    device->destroy_private_data<device_data>();
}

void on_init_swapchain(swapchain *swapchain, bool resize)
{
    if (resize)
        return;

    auto *const data = swapchain->create_private_data<swapchain_data>();
    data->window = static_cast<HWND>(swapchain->get_hwnd());
    data->core = retain_core(data->window);
}

void on_destroy_swapchain(swapchain *swapchain, bool resize)
{
    if (resize)
        return;

    auto *const data = swapchain->get_private_data<swapchain_data>();
    if (data == nullptr)
        return;

    ego_core *const core = data->core;
    const HWND window = data->window;
    swapchain->destroy_private_data<swapchain_data>();
    release_core(core, window);
}

void update_input_ownership(effect_runtime *runtime, swapchain_data &data)
{
    if (data.core == nullptr)
        return;

    ego_status status = ego_core_set_target_focused(
        data.core,
        any_target_focused() ? 1U : 0U);
    if (status != EGO_STATUS_OK && status != data.last_error)
    {
        data.last_error = status;
        log_core_error("focus publication", status);
    }

    std::uint32_t desired = 0;
    status = ego_core_desired_interception(data.core, &desired);
    if (status != EGO_STATUS_OK)
    {
        if (status != data.last_error)
        {
            data.last_error = status;
            log_core_error("interception query", status);
        }
        desired = 0;
    }

    data.phase = next_phase(data.phase, desired != 0);
    if (data.phase != input_phase::disabled)
        runtime->block_input_next_frame();

    const bool routing_enabled = data.phase == input_phase::enabled;
    const bool acknowledge =
        data.phase == input_phase::disabled || data.phase == input_phase::enabled;
    status = ego_core_apply_input_filter(
        data.core,
        routing_enabled ? 1U : 0U,
        acknowledge ? 1U : 0U);
    if (status != EGO_STATUS_OK && status != data.last_error)
    {
        data.last_error = status;
        log_core_error("input filter publication", status);
    }
    else if (status == EGO_STATUS_OK)
    {
        data.last_error = EGO_STATUS_OK;
    }

    ImGuiIO &io = ImGui::GetIO();
    CURSORINFO cursor_info = { sizeof(CURSORINFO) };
    const bool native_cursor_visible =
        GetCursorInfo(&cursor_info) != FALSE &&
        (cursor_info.flags & CURSOR_SHOWING) != 0;
    io.MouseDrawCursor = routing_enabled && !native_cursor_visible;
}

void compose_electron_scene(effect_runtime *runtime, swapchain_data &swapchain_state)
{
    if (swapchain_state.core == nullptr)
        return;

    ego_scene_snapshot *snapshot = nullptr;
    ego_status status = ego_core_acquire_scene(swapchain_state.core, &snapshot);
    if (status != EGO_STATUS_OK || snapshot == nullptr)
    {
        if (status != swapchain_state.last_error)
        {
            swapchain_state.last_error = status;
            log_core_error("scene acquisition", status);
        }
        return;
    }

    std::uint64_t window_count = 0;
    status = ego_scene_snapshot_window_count(snapshot, &window_count);
    if (status != EGO_STATUS_OK)
    {
        ego_scene_snapshot_release(snapshot);
        if (status != swapchain_state.last_error)
        {
            swapchain_state.last_error = status;
            log_core_error("scene enumeration", status);
        }
        return;
    }

    device *const device = runtime->get_device();
    auto *const data = device->get_private_data<device_data>();
    if (data == nullptr)
    {
        ego_scene_snapshot_release(snapshot);
        return;
    }

    std::unordered_set<std::uint32_t> active_windows;
    active_windows.reserve(static_cast<std::size_t>(window_count));

    const std::scoped_lock lock(data->mutex);
    ImDrawList *const draw_list = ImGui::GetBackgroundDrawList();
    for (std::uint64_t index = 0; index < window_count; ++index)
    {
        ego_window_frame_v1 frame = {};
        frame.struct_size = sizeof(frame);
        frame.abi_version = EGO_ABI_VERSION;
        status = ego_scene_snapshot_get_window(snapshot, index, &frame);
        if (status != EGO_STATUS_OK || !valid_frame(frame))
            continue;

        active_windows.insert(frame.window_id);
        auto [entry, inserted] = data->textures.try_emplace(frame.window_id);
        electron_texture &texture = entry->second;

        if (inserted || texture.texture.handle == 0 ||
            texture.width != frame.raster_width ||
            texture.height != frame.raster_height)
        {
            if (!inserted && texture.texture.handle != 0)
            {
                runtime->get_command_queue()->wait_idle();
                destroy_texture(device, texture);
            }
            if (!create_texture(device, frame, texture))
                continue;
        }
        else if ((texture.state_revision != frame.state_revision ||
                  texture.sequence != frame.sequence) &&
                 !update_texture(runtime, frame, texture))
        {
            reshade::log::message(
                reshade::log::level::error,
                "Electron ReShade compositor could not update an Electron texture.");
            continue;
        }

        const ImVec2 top_left(
            static_cast<float>(frame.rect_x),
            static_cast<float>(frame.rect_y));
        const ImVec2 bottom_right(
            static_cast<float>(frame.rect_x) + static_cast<float>(frame.rect_width),
            static_cast<float>(frame.rect_y) + static_cast<float>(frame.rect_height));
        draw_list->AddImage(texture.view.handle, top_left, bottom_right);
    }

    bool removed_texture = false;
    for (auto iterator = data->textures.begin(); iterator != data->textures.end();)
    {
        if (active_windows.contains(iterator->first))
        {
            ++iterator;
            continue;
        }
        if (!removed_texture)
        {
            runtime->get_command_queue()->wait_idle();
            removed_texture = true;
        }
        destroy_texture(device, iterator->second);
        iterator = data->textures.erase(iterator);
    }

    ego_scene_snapshot_release(snapshot);
    if (window_count != 0 && !swapchain_state.first_scene_logged)
    {
        swapchain_state.first_scene_logged = true;
        char message[160] = {};
        sprintf_s(
            message,
            "Electron ReShade compositor rendered its first transported scene (%llu window(s)).",
            static_cast<unsigned long long>(window_count));
        reshade::log::message(reshade::log::level::info, message);
    }
}

void on_reshade_overlay(effect_runtime *runtime)
{
    auto *const data = runtime->get_private_data<swapchain_data>();
    if (data == nullptr)
        return;

    update_input_ownership(runtime, *data);
    compose_electron_scene(runtime, *data);
}
} // namespace

extern "C" __declspec(dllexport) const char *NAME = "Electron ReShade Compositor POC";
extern "C" __declspec(dllexport) const char *DESCRIPTION =
    "Backend-neutral Electron OSR scenes rendered through ReShade.";

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
            "Electron ReShade compositor add-on loaded.");
        break;

    case DLL_PROCESS_DETACH:
        reshade::unregister_addon(module);
        break;
    }

    return TRUE;
}
