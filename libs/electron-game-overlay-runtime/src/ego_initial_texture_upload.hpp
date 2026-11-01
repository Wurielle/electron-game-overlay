#pragma once

#include <reshade_api.hpp>
#include <cstdint>
#include <cstring>
#include <limits>

namespace ego::initial_texture_upload
{
// The D3D12 public command-list update capability is unavailable. Copy from an
// explicitly owned upload buffer instead of asking the device to choose a queue.
// The template permits the same operation to be exercised by the controlled
// two-queue GPU fixture without exposing a private ReShade C++ implementation.
template <typename Device, typename Queue>
bool upload_d3d12_rgba(Device *device, Queue *queue,
    reshade::api::resource destination, const reshade::api::subresource_data &pixels,
    std::uint32_t width, std::uint32_t height)
{
    using namespace reshade::api;
    if (device == nullptr || queue == nullptr || destination.handle == 0 ||
        pixels.data == nullptr || width == 0 || height == 0 ||
        !device->check_capability(device_caps::copy_buffer_to_texture))
        return false;
    auto *const commands = queue->get_immediate_command_list();
    if (commands == nullptr)
        return false;

    // D3D12_TEXTURE_DATA_PITCH_ALIGNMENT, for the fixed RGBA8 format used here.
    constexpr std::uint64_t row_alignment = 256;
    const std::uint64_t row_bytes = static_cast<std::uint64_t>(width) * 4;
    const std::uint64_t row_pitch = (row_bytes + row_alignment - 1) & ~(row_alignment - 1);
    if (pixels.row_pitch < row_bytes || row_pitch > (std::numeric_limits<std::uint32_t>::max)())
        return false;
    const std::uint64_t upload_bytes = row_pitch * height;
    if (upload_bytes > (std::numeric_limits<std::uint32_t>::max)())
        return false;

    resource upload{};
    const resource_desc description(upload_bytes, memory_heap::cpu_to_gpu, resource_usage::copy_source);
    if (!device->create_resource(description, nullptr, resource_usage::cpu_access, &upload))
        return false;
    struct owned_upload
    {
        Device *device;
        resource value;
        bool mapped = false;
        ~owned_upload()
        {
            if (mapped) device->unmap_buffer_region(value);
            device->destroy_resource(value);
        }
    } staging{device, upload};
    void *mapped = nullptr;
    if (!device->map_buffer_region(upload, 0, upload_bytes, map_access::write_only, &mapped))
        return false;
    staging.mapped = true;
    if (mapped == nullptr)
        return false;
    auto *const target = static_cast<std::uint8_t *>(mapped);
    const auto *const source = static_cast<const std::uint8_t *>(pixels.data);
    std::memset(target, 0, static_cast<std::size_t>(upload_bytes));
    for (std::uint32_t row = 0; row < height; ++row)
        std::memcpy(target + row * row_pitch,
            source + static_cast<std::uint64_t>(row) * pixels.row_pitch,
            static_cast<std::size_t>(row_bytes));
    device->unmap_buffer_region(upload);
    staging.mapped = false;

    // The destination was created in COPY_DEST. Every command, including the
    // final transition, belongs to this effect runtime's exact graphics queue.
    commands->copy_buffer_to_texture(upload, 0, width, height, destination, 0, nullptr);
    commands->barrier(destination, resource_usage::copy_dest, resource_usage::shader_resource);
    queue->flush_immediate_command_list();
    queue->wait_idle(); // The upload buffer must outlive its submitted GPU copy.
    return true;
}
} // namespace ego::initial_texture_upload
