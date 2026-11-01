#pragma once

// Opt-in, bounded pixel evidence only. This does not participate in rendering
// decisions and never captures a framebuffer or modifies another owner's files.
#include <Windows.h>
#include <reshade.hpp>
#include <electron_overlay_transport.h>
#include <array>
#include <atomic>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <mutex>

namespace ego::render_readback_diagnostic
{
inline constexpr wchar_t request_filename[] = L"electron-game-overlay-gpu-pixels-v1.request";
inline constexpr std::uint32_t maximum_samples = 8;
struct point { std::uint32_t x = 0, y = 0; };
struct request
{
    std::array<point, 3> points{};
    std::uint32_t samples = 0, interval_ms = 0;
};

inline bool parse_request(const char *text, std::size_t length, request &out) noexcept
{
    constexpr char magic[] = "EGO_GPU_READBACK_V1";
    if (text == nullptr || length <= sizeof(magic) || length > 255 ||
        std::memcmp(text, magic, sizeof(magic) - 1) != 0) return false;
    const auto space = [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
    const char *cursor = text + sizeof(magic) - 1, *const end = text + length;
    if (!space(*cursor)) return false;
    std::array<std::uint32_t, 8> values{};
    for (auto &value : values)
    {
        while (cursor != end && space(*cursor)) ++cursor;
        const auto parsed = std::from_chars(cursor, end, value);
        if (parsed.ec != std::errc{} || parsed.ptr == cursor ||
            (parsed.ptr != end && !space(*parsed.ptr))) return false;
        cursor = parsed.ptr;
    }
    while (cursor != end && space(*cursor)) ++cursor;
    if (cursor != end || values[6] == 0 || values[6] > maximum_samples ||
        values[7] < 250 || values[7] > 10000) return false;
    request next;
    for (std::size_t index = 0; index < next.points.size(); ++index)
    {
        if (values[index * 2] > 32767 || values[index * 2 + 1] > 32767) return false;
        next.points[index] = {values[index * 2], values[index * 2 + 1]};
        for (std::size_t previous = 0; previous < index; ++previous)
            if (next.points[previous].x == next.points[index].x &&
                next.points[previous].y == next.points[index].y) return false;
    }
    next.samples = values[6]; next.interval_ms = values[7]; out = next;
    return true;
}

struct own_window_note
{
    reshade::api::effect_runtime *runtime = nullptr;
    std::uint64_t texture = 0, srv = 0, incarnation = 0, sequence = 0, revision = 0;
    std::uint32_t window_id = 0, raster_width = 0, raster_height = 0;
    std::int32_t x = 0, y = 0, width = 0, height = 0;
    float display_width = 0, display_height = 0, framebuffer_x = 0, framebuffer_y = 0;
};

class probe
{
public:
    bool enabled() const noexcept { return enabled_.load(std::memory_order_acquire); }
    // Read exactly once, only after the caller verified its owned run marker.
    // An absent request keeps every GPU operation and allocation disabled.
    void configure(const std::filesystem::path &directory, bool verified_owned_dispatcher) noexcept
    {
        if (!verified_owned_dispatcher || configured_.exchange(true)) return;
        try
        {
            const auto path = directory / request_filename;
            const DWORD attributes = GetFileAttributesW(path.c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES) return;
            if ((attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) { report("invalid-request-file"); return; }
            HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
            if (file == INVALID_HANDLE_VALUE) { report("request-open-failed"); return; }
            std::array<char, 256> text{}; DWORD read = 0;
            const bool read_ok = ReadFile(file, text.data(), static_cast<DWORD>(text.size()), &read, nullptr) != FALSE;
            CloseHandle(file);
            if (!read_ok || !parse_request(text.data(), read, request_)) { report("invalid-request"); return; }
            enabled_.store(true, std::memory_order_release);
            report("enabled scope=first-dispatcher-own-window pixels=3 samples<=8 blocking-read-map=true");
        }
        catch (...) { report("configuration-failed"); }
    }

    void note_own_window(const own_window_note &note) noexcept
    {
        if (!enabled_.load(std::memory_order_acquire)) return;
        if (note.runtime == nullptr || note.window_id == 0 || note.width <= 0 || note.height <= 0) return;
        const std::scoped_lock lock(mutex_);
        if (selected_runtime_ == nullptr) { selected_runtime_ = note.runtime; selected_window_ = note.window_id; }
        if (selected_runtime_ != note.runtime || selected_window_ != note.window_id) return;
        note_ = note; note_ready_ = true;
    }

    // Public reshade_present runs after ImGui/final backbuffer copy and before
    // the underlying DXGI Present. Successful D3D11 read Map supplies completion;
    // this deliberately does not use ReShade's D3D11 wait_idle (a no-op).
    void after_overlay(reshade::api::effect_runtime *runtime) noexcept
    {
        if (!enabled_.load(std::memory_order_acquire) || runtime == nullptr) return;
        own_window_note note;
        std::uint32_t sample = 0;
        {
            const std::scoped_lock lock(mutex_);
            if (!note_ready_ || note_.runtime != runtime) return;
            note = note_; note_ready_ = false;
            const auto now = GetTickCount64();
            if (attempts_ >= request_.samples || now < next_sample_) return;
            sample = ++attempts_; next_sample_ = now + request_.interval_ms;
        }
        try { read_pixels(runtime, note, sample); }
        catch (...) { disable("readback-exception"); }
        if (sample >= request_.samples) enabled_.store(false, std::memory_order_release);
    }

private:
    static void report(const char *detail) noexcept
    {
        char line[512]{};
        std::snprintf(line, sizeof(line), "EGO_GPU_PIXELS_V1 %s", detail);
        reshade::log::message(reshade::log::level::info, line);
    }
    void disable(const char *detail) noexcept
    {
        enabled_.store(false, std::memory_order_release); report(detail);
    }
    void read_pixels(reshade::api::effect_runtime *runtime, const own_window_note &note, std::uint32_t sample)
    {
        using namespace reshade::api;
        device *const device = runtime->get_device();
        if (device == nullptr || device->get_api() != device_api::d3d11) { disable("unsupported-backend no-gpu-proof=true"); return; }
        const auto backbuffer = runtime->get_current_back_buffer();
        if (backbuffer.handle == 0) { disable("missing-backbuffer no-gpu-proof=true"); return; }
        const auto description = device->get_resource_desc(backbuffer);
        const auto pixel_format = description.texture.format;
        const bool rgba = pixel_format == format::r8g8b8a8_unorm || pixel_format == format::r8g8b8a8_unorm_srgb;
        const bool bgra = pixel_format == format::b8g8r8a8_unorm || pixel_format == format::b8g8r8a8_unorm_srgb;
        if (description.type != resource_type::texture_2d || description.texture.samples != 1 ||
            description.texture.depth_or_layers != 1 || description.texture.width == 0 || description.texture.height == 0 ||
            description.texture.width > 32768 || description.texture.height > 32768 || (!rgba && !bgra))
        { disable("unsupported-format-or-extent no-gpu-proof=true"); return; }
        RECT client{};
        if (!GetClientRect(static_cast<HWND>(runtime->get_hwnd()), &client) || client.right <= 0 || client.bottom <= 0 ||
            client.right > 32768 || client.bottom > 32768)
        { disable("invalid-client-extent no-gpu-proof=true"); return; }
        std::array<point, 3> source_points{};
        for (std::size_t index = 0; index < source_points.size(); ++index)
        {
            const auto &point = request_.points[index];
            if (point.x >= static_cast<std::uint32_t>(client.right) || point.y >= static_cast<std::uint32_t>(client.bottom))
            { disable("sample-outside-client no-gpu-proof=true"); return; }
            source_points[index] = {
                static_cast<std::uint32_t>(static_cast<std::uint64_t>(point.x) * description.texture.width / client.right),
                static_cast<std::uint32_t>(static_cast<std::uint64_t>(point.y) * description.texture.height / client.bottom)};
        }
        auto *const queue = runtime->get_command_queue();
        auto *const commands = queue != nullptr ? queue->get_immediate_command_list() : nullptr;
        if (commands == nullptr) { disable("missing-immediate-context no-gpu-proof=true"); return; }
        struct staging_resource
        {
            reshade::api::device *owner; resource value{}; bool mapped = false;
            ~staging_resource() { if (mapped) owner->unmap_texture_region(value, 0); if (value.handle != 0) owner->destroy_resource(value); }
        } staging{device};
        const resource_desc staging_description(3, 1, 1, 1, pixel_format, 1, memory_heap::gpu_to_cpu, resource_usage::copy_dest);
        if (!device->create_resource(staging_description, nullptr, resource_usage::copy_dest, &staging.value))
        { disable("staging-create-failed no-gpu-proof=true"); return; }
        commands->barrier(backbuffer, resource_usage::present, resource_usage::copy_source);
        {
            struct restore_source_usage
            {
                command_list *commands; resource source;
                ~restore_source_usage() { commands->barrier(source, resource_usage::copy_source, resource_usage::present); }
            } restore{commands, backbuffer};
            for (std::uint32_t index = 0; index < source_points.size(); ++index)
            {
                const auto &point = source_points[index];
                const subresource_box source_box{point.x, point.y, 0, point.x + 1, point.y + 1, 1};
                const subresource_box destination_box{index, 0, 0, index + 1, 1, 1};
                commands->copy_texture_region(backbuffer, 0, &source_box, staging.value, 0, &destination_box);
            }
        }
        queue->flush_immediate_command_list();
        subresource_data data{};
        const auto map_start = GetTickCount64();
        if (!device->map_texture_region(staging.value, 0, nullptr, map_access::read_only, &data))
        { disable("staging-map-failed no-gpu-proof=true"); return; }
        staging.mapped = true;
        if (data.data == nullptr || data.row_pitch < 12) { disable("invalid-staging-pitch no-gpu-proof=true"); return; }
        std::array<std::array<unsigned, 4>, 3> colors{};
        const auto *const bytes = static_cast<const std::uint8_t *>(data.data);
        for (std::size_t index = 0; index < colors.size(); ++index)
        {
            const auto *const pixel = bytes + index * 4;
            colors[index] = {pixel[bgra ? 2 : 0], pixel[1], pixel[bgra ? 0 : 2], pixel[3]};
        }
        const auto map_ms = GetTickCount64() - map_start;
        device->unmap_texture_region(staging.value, 0); staging.mapped = false;
        FILETIME now{}; GetSystemTimeAsFileTime(&now);
        const auto utc = (static_cast<std::uint64_t>(now.dwHighDateTime) << 32) | now.dwLowDateTime;
        char line[3072]{};
        std::snprintf(line, sizeof(line),
            "EGO_GPU_PIXELS_V1 status=read sample=%u/%u utc100ns=%llu tickMs=%llu mapMs=%llu scope=first-dispatcher-own-window "
            "runtime=0x%llx hwnd=0x%llx backbuffer=0x%llx format=%u extent=%ux%u client=%ldx%ld texture=0x%llx srv=0x%llx "
            "window=%u incarnation=%llu sequence=%llu revision=%llu rect=%d,%d,%d,%d raster=%ux%u display=%g,%g displayPos=unavailable framebufferScale=%g,%g imageGpuRect=unavailable "
            "redClient=%u,%u redGpu=%u,%u redRGBA=%u,%u,%u,%u blueClient=%u,%u blueGpu=%u,%u blueRGBA=%u,%u,%u,%u hostClient=%u,%u hostGpu=%u,%u hostRGBA=%u,%u,%u,%u",
            sample, request_.samples, static_cast<unsigned long long>(utc), static_cast<unsigned long long>(GetTickCount64()),
            static_cast<unsigned long long>(map_ms),
            static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(runtime)),
            static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(runtime->get_hwnd())), static_cast<unsigned long long>(backbuffer.handle),
            static_cast<unsigned>(pixel_format), description.texture.width, description.texture.height, client.right, client.bottom,
            static_cast<unsigned long long>(note.texture), static_cast<unsigned long long>(note.srv), note.window_id,
            static_cast<unsigned long long>(note.incarnation), static_cast<unsigned long long>(note.sequence), static_cast<unsigned long long>(note.revision),
            note.x, note.y, note.width, note.height, note.raster_width, note.raster_height,
            note.display_width, note.display_height, note.framebuffer_x, note.framebuffer_y,
            request_.points[0].x, request_.points[0].y, source_points[0].x, source_points[0].y, colors[0][0], colors[0][1], colors[0][2], colors[0][3],
            request_.points[1].x, request_.points[1].y, source_points[1].x, source_points[1].y, colors[1][0], colors[1][1], colors[1][2], colors[1][3],
            request_.points[2].x, request_.points[2].y, source_points[2].x, source_points[2].y, colors[2][0], colors[2][1], colors[2][2], colors[2][3]);
        reshade::log::message(reshade::log::level::info, line);
    }
    std::atomic<bool> configured_ = false, enabled_ = false;
    request request_{};
    std::mutex mutex_;
    own_window_note note_{};
    reshade::api::effect_runtime *selected_runtime_ = nullptr;
    std::uint32_t selected_window_ = 0;
    bool note_ready_ = false;
    std::uint32_t attempts_ = 0;
    ULONGLONG next_sample_ = 0;
};
} // namespace ego::render_readback_diagnostic
