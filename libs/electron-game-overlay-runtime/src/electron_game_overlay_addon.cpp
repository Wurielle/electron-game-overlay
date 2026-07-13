#include <Windows.h>

#include <electron_overlay_transport.h>
#include <imgui.h>
#include <reshade.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <mutex>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>

namespace
{
using namespace reshade::api;

constexpr std::size_t input_queue_capacity = 4096;
static_assert((input_queue_capacity & (input_queue_capacity - 1)) == 0);
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);
static_assert(std::atomic<bool>::is_always_lock_free);
static_assert(std::is_trivially_copyable_v<input_message>);

struct queued_input_message
{
    std::uint64_t generation = 0;
    input_message message = {};
    std::uint32_t pointer_id = 0;
    std::uint32_t pointer_type = PT_POINTER;
    std::uint32_t pointer_key_states = 0;
    bool pointer_metadata_valid = false;
};
static_assert(std::is_trivially_copyable_v<queued_input_message>);

/// Bounded Vyukov queue. Producers are the arbitrary threads on which ReShade
/// observes input; the render callback is the only consumer (guarded below).
/// Callback publication performs no allocation, IPC, logging, or mutex wait.
template <std::size_t Capacity>
class bounded_input_queue
{
    static_assert((Capacity & (Capacity - 1)) == 0);

    struct slot
    {
        std::atomic<std::uint64_t> sequence = 0;
        queued_input_message message = {};
    };

public:
    bounded_input_queue() noexcept
    {
        for (std::uint64_t index = 0; index < Capacity; ++index)
            slots_[index].sequence.store(index, std::memory_order_relaxed);
    }

    bounded_input_queue(const bounded_input_queue &) = delete;
    bounded_input_queue &operator=(const bounded_input_queue &) = delete;

    bool try_push(const queued_input_message &message) noexcept
    {
        std::uint64_t position = enqueue_position_.load(std::memory_order_relaxed);
        slot *target = nullptr;

        for (;;)
        {
            target = &slots_[position & (Capacity - 1)];
            const std::uint64_t sequence =
                target->sequence.load(std::memory_order_acquire);
            const std::int64_t difference =
                static_cast<std::int64_t>(sequence - position);
            if (difference == 0)
            {
                if (enqueue_position_.compare_exchange_weak(
                        position,
                        position + 1,
                        std::memory_order_relaxed,
                        std::memory_order_relaxed))
                    break;
            }
            else if (difference < 0)
            {
                return false;
            }
            else
            {
                position = enqueue_position_.load(std::memory_order_relaxed);
            }
        }

        target->message = message;
        target->sequence.store(position + 1, std::memory_order_release);
        return true;
    }

    bool try_pop(queued_input_message &message) noexcept
    {
        slot &source = slots_[dequeue_position_ & (Capacity - 1)];
        const std::uint64_t sequence =
            source.sequence.load(std::memory_order_acquire);
        const std::int64_t difference =
            static_cast<std::int64_t>(sequence - (dequeue_position_ + 1));
        if (difference != 0)
            return false;

        message = source.message;
        source.sequence.store(
            dequeue_position_ + Capacity,
            std::memory_order_release);
        ++dequeue_position_;
        return true;
    }

private:
    std::array<slot, Capacity> slots_ = {};
    std::atomic<std::uint64_t> enqueue_position_ = 0;
    std::uint64_t dequeue_position_ = 0;
};

bounded_input_queue<input_queue_capacity> g_input_queue;
std::array<queued_input_message, input_queue_capacity> g_input_batch = {};
std::atomic_flag g_input_consumer = ATOMIC_FLAG_INIT;
std::atomic<std::uint64_t> g_input_generation = 1;
std::atomic<std::uint64_t> g_dropped_input_messages = 0;
std::atomic<bool> g_input_recovery_pending = false;
std::atomic_flag g_overflow_logged = ATOMIC_FLAG_INIT;
std::atomic_flag g_order_fault_logged = ATOMIC_FLAG_INIT;
std::atomic_flag g_raw_deferred_logged = ATOMIC_FLAG_INIT;
std::atomic_flag g_route_error_logged = ATOMIC_FLAG_INIT;
std::uint64_t g_last_input_sequence = 0;
bool g_has_last_input_sequence = false;
std::uint64_t g_deferred_raw_input_messages = 0;
std::uint64_t g_deferred_raw_buffer_messages = 0;
std::uint64_t g_deferred_window_raw_messages = 0;
std::atomic<bool> g_pointer_route_reset_pending = false;

struct ordered_pointer_state
{
    std::uintptr_t target_window = 0;
    std::uint32_t pointer_id = 0;
    bool primary_down = false;
};

ordered_pointer_state g_ordered_pointer_state = {};

bool is_pointer_mouse_message(std::uint32_t message) noexcept
{
    switch (message)
    {
    case WM_POINTERUPDATE:
    case WM_POINTERDOWN:
    case WM_POINTERUP:
    case WM_POINTERENTER:
    case WM_POINTERLEAVE:
    case WM_POINTERWHEEL:
    case WM_POINTERHWHEEL:
        return true;
    default:
        return false;
    }
}

std::int64_t encode_client_point(std::int32_t x, std::int32_t y) noexcept
{
    const std::uint32_t packed =
        static_cast<std::uint16_t>(x) |
        (static_cast<std::uint32_t>(static_cast<std::uint16_t>(y)) << 16U);
    return static_cast<std::int64_t>(packed);
}

void capture_pointer_metadata(queued_input_message &queued) noexcept
{
    if (queued.message.source != input_message_source::window_message ||
        !is_pointer_mouse_message(queued.message.message))
    {
        return;
    }

    const std::uint32_t pointer_id = GET_POINTERID_WPARAM(
        static_cast<WPARAM>(queued.message.wparam));
    POINTER_INFO pointer_info = {};
    if (GetPointerInfo(pointer_id, &pointer_info) == FALSE)
        return;

    queued.pointer_id = pointer_id;
    queued.pointer_type = static_cast<std::uint32_t>(pointer_info.pointerType);
    queued.pointer_key_states = pointer_info.dwKeyStates;
    queued.pointer_metadata_valid = true;
}

void reset_ordered_pointer_state() noexcept
{
    g_ordered_pointer_state = {};
}

bool translate_pointer_mouse_message(
    const queued_input_message &queued,
    input_message &message) noexcept
{
    if (!is_pointer_mouse_message(message.message))
        return true;
    if (!queued.pointer_metadata_valid ||
        queued.pointer_type != static_cast<std::uint32_t>(PT_MOUSE))
    {
        return false;
    }

    const bool client_point_valid =
        (message.flags & static_cast<std::uint32_t>(
                             input_message_flags::client_point_valid)) != 0;
    const WPARAM pointer_wparam = static_cast<WPARAM>(message.wparam);
    const std::uint64_t mouse_modifiers = queued.pointer_key_states &
        static_cast<std::uint32_t>(MK_CONTROL | MK_SHIFT);
    const std::uintptr_t target_window =
        reinterpret_cast<std::uintptr_t>(message.target_window);

    switch (message.message)
    {
    case WM_POINTERUPDATE:
        if (!client_point_valid)
            return false;
        message.message = WM_MOUSEMOVE;
        message.wparam = mouse_modifiers;
        if (g_ordered_pointer_state.primary_down &&
            g_ordered_pointer_state.pointer_id == queued.pointer_id &&
            g_ordered_pointer_state.target_window == target_window)
        {
            message.wparam |= MK_LBUTTON;
        }
        message.lparam = encode_client_point(message.client_x, message.client_y);
        return true;

    case WM_POINTERDOWN:
        if (!client_point_valid ||
            !IS_POINTER_FIRSTBUTTON_WPARAM(pointer_wparam))
        {
            return false;
        }
        g_ordered_pointer_state = {
            target_window,
            queued.pointer_id,
            true,
        };
        message.message = WM_LBUTTONDOWN;
        message.wparam = mouse_modifiers | MK_LBUTTON;
        message.lparam = encode_client_point(message.client_x, message.client_y);
        return true;

    case WM_POINTERUP:
        if (!client_point_valid ||
            !g_ordered_pointer_state.primary_down ||
            g_ordered_pointer_state.pointer_id != queued.pointer_id ||
            g_ordered_pointer_state.target_window != target_window)
        {
            return false;
        }
        reset_ordered_pointer_state();
        message.message = WM_LBUTTONUP;
        message.wparam = mouse_modifiers;
        message.lparam = encode_client_point(message.client_x, message.client_y);
        return true;

    default:
        // Enter/leave and pointer-wheel records are suppressed for the game but
        // are not part of the production Electron route. Non-client pointer
        // activation is deliberately left outside the ReShade patch entirely.
        return false;
    }
}

void on_input_message(const input_message &message) noexcept
{
    queued_input_message queued = {};
    queued.generation = g_input_generation.load(std::memory_order_acquire);
    queued.message = message;
    capture_pointer_metadata(queued);
    if (g_input_queue.try_push(queued))
        return;

    g_dropped_input_messages.fetch_add(1, std::memory_order_relaxed);
    g_input_recovery_pending.store(true, std::memory_order_release);
}

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
    ego_transport *transport = nullptr;
    HWND window = nullptr;
    input_phase phase = input_phase::disabled;
    bool first_scene_logged = false;
    bool first_multiwindow_scene_logged = false;
    ego_status last_error = EGO_STATUS_OK;
};

std::mutex g_transport_mutex;
ego_transport *g_transport = nullptr;
std::uint32_t g_transport_references = 0;
std::unordered_map<HWND, std::uint32_t> g_target_windows;

void log_transport_error(const char *operation, ego_status status)
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
            "Electron game overlay runtime %s failed (status %d): %s",
            operation,
            static_cast<int>(status),
            detail);
    }
    else
    {
        sprintf_s(
            message,
            "Electron game overlay runtime %s failed (status %d).",
            operation,
            static_cast<int>(status));
    }
    reshade::log::message(reshade::log::level::error, message);
}

ego_transport *retain_transport(HWND window)
{
    const std::scoped_lock lock(g_transport_mutex);
    if (g_transport == nullptr)
    {
        const ego_status status = ego_transport_create(EGO_ABI_VERSION, &g_transport);
        if (status != EGO_STATUS_OK)
        {
            log_transport_error("transport initialization", status);
            g_transport = nullptr;
            return nullptr;
        }
        reshade::log::message(
            reshade::log::level::info,
            "Electron game overlay runtime initialized its transport and input router.");
    }

    ++g_transport_references;
    if (window != nullptr)
        ++g_target_windows[window];
    return g_transport;
}

void release_transport(ego_transport *transport, HWND window)
{
    ego_transport *destroy = nullptr;
    {
        const std::scoped_lock lock(g_transport_mutex);
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
        if (transport == nullptr || transport != g_transport || g_transport_references == 0)
            return;

        --g_transport_references;
        if (g_transport_references == 0)
        {
            destroy = g_transport;
            g_transport = nullptr;
            g_target_windows.clear();
        }
    }

    if (destroy != nullptr)
    {
        const ego_status status = ego_transport_destroy(destroy);
        if (status != EGO_STATUS_OK)
            log_transport_error("transport shutdown", status);
    }
}

bool any_target_focused()
{
    const HWND foreground = GetForegroundWindow();
    if (foreground == nullptr)
        return false;

    const std::scoped_lock lock(g_transport_mutex);
    for (const auto &[window, references] : g_target_windows)
    {
        static_cast<void>(references);
        const HWND root = GetAncestor(window, GA_ROOT);
        if (foreground == window || (root != nullptr && foreground == root))
            return true;
    }
    return false;
}

struct input_consumer_release
{
    ~input_consumer_release()
    {
        g_input_consumer.clear(std::memory_order_release);
    }
};

void log_input_overflow_once(std::uint64_t dropped)
{
    if (g_overflow_logged.test_and_set(std::memory_order_relaxed))
        return;

    char message[256] = {};
    sprintf_s(
        message,
        "Electron ReShade input observer queue overflowed (%llu record(s) dropped); "
        "the Electron router was reset before input delivery resumed.",
        static_cast<unsigned long long>(dropped));
    reshade::log::message(reshade::log::level::warning, message);
}

void discard_queued_input()
{
    queued_input_message discarded = {};
    while (g_input_queue.try_pop(discarded))
    {
    }
}

bool reset_input_router(ego_transport *transport)
{
    // Advancing the generation makes a producer that was preempted before this
    // reset harmless: its late publication is recognized and discarded.
    g_input_generation.fetch_add(1, std::memory_order_acq_rel);
    reset_ordered_pointer_state();
    g_pointer_route_reset_pending.store(false, std::memory_order_release);
    discard_queued_input();

    const ego_status blur_status = ego_transport_set_target_focused(transport, 0);
    if (blur_status != EGO_STATUS_OK)
    {
        log_transport_error("input-loss blur reset", blur_status);
        g_input_recovery_pending.store(true, std::memory_order_release);
        return false;
    }

    const ego_status focus_status = ego_transport_set_target_focused(
        transport,
        any_target_focused() ? 1U : 0U);
    if (focus_status != EGO_STATUS_OK)
    {
        log_transport_error("input-loss focus restore", focus_status);
        g_input_recovery_pending.store(true, std::memory_order_release);
        return false;
    }

    g_last_input_sequence = 0;
    g_has_last_input_sequence = false;
    return true;
}

bool recover_dropped_input(ego_transport *transport)
{
    const bool recovery_requested =
        g_input_recovery_pending.exchange(false, std::memory_order_acq_rel);
    const std::uint64_t dropped =
        g_dropped_input_messages.exchange(0, std::memory_order_acq_rel);
    if (!recovery_requested && dropped == 0)
        return true;

    if (dropped != 0)
        log_input_overflow_once(dropped);
    if (!reset_input_router(transport))
        return false;

    // An overflow that raced the reset belongs to a newer generation. Leave it
    // for the next render callback and do not route anything in this one.
    return !g_input_recovery_pending.load(std::memory_order_acquire) &&
        g_dropped_input_messages.load(std::memory_order_acquire) == 0;
}

void drain_input_messages(ego_transport *transport)
{
    if (transport == nullptr ||
        g_input_consumer.test_and_set(std::memory_order_acquire))
    {
        return;
    }
    const input_consumer_release release_consumer;

    if (g_pointer_route_reset_pending.exchange(false, std::memory_order_acq_rel))
        reset_ordered_pointer_state();

    if (!recover_dropped_input(transport))
        return;

    std::size_t count = 0;
    while (count < g_input_batch.size() &&
           g_input_queue.try_pop(g_input_batch[count]))
    {
        ++count;
    }
    if (count == 0)
        return;

    if (g_input_recovery_pending.load(std::memory_order_acquire) ||
        g_dropped_input_messages.load(std::memory_order_acquire) != 0)
    {
        static_cast<void>(recover_dropped_input(transport));
        return;
    }

    std::sort(
        g_input_batch.begin(),
        g_input_batch.begin() + count,
        [](const queued_input_message &left, const queued_input_message &right) {
            return left.message.sequence < right.message.sequence;
        });

    const std::uint64_t generation =
        g_input_generation.load(std::memory_order_acquire);
    std::uint64_t previous_sequence = g_last_input_sequence;
    bool has_previous_sequence = g_has_last_input_sequence;
    bool ordering_fault = false;
    for (std::size_t index = 0; index < count; ++index)
    {
        const queued_input_message &queued = g_input_batch[index];
        if (queued.generation != generation)
            continue;
        if (has_previous_sequence &&
            queued.message.sequence <= previous_sequence)
        {
            ordering_fault = true;
            break;
        }
        previous_sequence = queued.message.sequence;
        has_previous_sequence = true;
    }

    if (ordering_fault)
    {
        if (!g_order_fault_logged.test_and_set(std::memory_order_relaxed))
        {
            reshade::log::message(
                reshade::log::level::warning,
                "Electron ReShade input records arrived out of global sequence; "
                "the Electron router was reset before delivery resumed.");
        }
        static_cast<void>(reset_input_router(transport));
        return;
    }

    for (std::size_t index = 0; index < count; ++index)
    {
        const queued_input_message &queued = g_input_batch[index];
        if (queued.generation != generation)
            continue;
        if (g_input_recovery_pending.load(std::memory_order_acquire) ||
            g_dropped_input_messages.load(std::memory_order_acquire) != 0)
        {
            static_cast<void>(recover_dropped_input(transport));
            return;
        }

        input_message routed_message = queued.message;
        if (routed_message.source == input_message_source::window_message &&
            !translate_pointer_mouse_message(queued, routed_message))
        {
            g_last_input_sequence = queued.message.sequence;
            g_has_last_input_sequence = true;
            continue;
        }

        const input_message &message = routed_message;
        switch (message.source)
        {
        case input_message_source::window_message:
            if (message.message == WM_INPUT)
            {
                ++g_deferred_window_raw_messages;
                break;
            }
            else
            {
                const ego_status status = ego_transport_route_window_message(
                    transport,
                    reinterpret_cast<std::uintptr_t>(message.target_window),
                    message.message,
                    message.wparam,
                    message.lparam);
                if (status != EGO_STATUS_OK)
                {
                    if (!g_route_error_logged.test_and_set(std::memory_order_relaxed))
                        log_transport_error("copied input delivery", status);
                    static_cast<void>(reset_input_router(transport));
                    return;
                }
                break;
            }

        case input_message_source::raw_input:
            ++g_deferred_raw_input_messages;
            break;

        case input_message_source::raw_input_buffer:
            ++g_deferred_raw_buffer_messages;
            break;

        default:
            static_cast<void>(reset_input_router(transport));
            return;
        }

        if (message.source != input_message_source::window_message ||
            message.message == WM_INPUT)
        {
            if (!g_raw_deferred_logged.test_and_set(std::memory_order_relaxed))
            {
                reshade::log::message(
                    reshade::log::level::info,
                    "Electron game overlay runtime is retaining and counting copied "
                    "raw-input records; exact raw normalization is deferred.");
            }
        }

        g_last_input_sequence = message.sequence;
        g_has_last_input_sequence = true;
    }
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
            "Electron game overlay runtime could not create an Electron texture.");
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
            "Electron game overlay runtime could not create an Electron texture view.");
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
    data->transport = retain_transport(data->window);
}

void on_destroy_swapchain(swapchain *swapchain, bool resize)
{
    if (resize)
        return;

    auto *const data = swapchain->get_private_data<swapchain_data>();
    if (data == nullptr)
        return;

    ego_transport *const transport = data->transport;
    const HWND window = data->window;
    swapchain->destroy_private_data<swapchain_data>();
    release_transport(transport, window);
}

void update_input_ownership(effect_runtime *runtime, swapchain_data &data)
{
    if (data.transport == nullptr)
        return;

    ego_status status = ego_transport_set_target_focused(
        data.transport,
        any_target_focused() ? 1U : 0U);
    if (status != EGO_STATUS_OK && status != data.last_error)
    {
        data.last_error = status;
        log_transport_error("focus publication", status);
    }

    std::uint32_t desired = 0;
    status = ego_transport_desired_interception(data.transport, &desired);
    if (status != EGO_STATUS_OK)
    {
        if (status != data.last_error)
        {
            data.last_error = status;
            log_transport_error("interception query", status);
        }
        desired = 0;
    }

    data.phase = next_phase(data.phase, desired != 0);
    if (data.phase != input_phase::disabled)
        runtime->block_input_next_frame();

    const bool routing_enabled = data.phase == input_phase::enabled;
    if (!routing_enabled)
        g_pointer_route_reset_pending.store(true, std::memory_order_release);
    const bool acknowledge =
        data.phase == input_phase::disabled || data.phase == input_phase::enabled;
    status = ego_transport_apply_input_filter(
        data.transport,
        routing_enabled ? 1U : 0U,
        acknowledge ? 1U : 0U);
    if (status != EGO_STATUS_OK && status != data.last_error)
    {
        data.last_error = status;
        log_transport_error("input filter publication", status);
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
    if (swapchain_state.transport == nullptr)
        return;

    ego_scene_snapshot *snapshot = nullptr;
    ego_status status = ego_transport_acquire_scene(swapchain_state.transport, &snapshot);
    if (status != EGO_STATUS_OK || snapshot == nullptr)
    {
        if (status != swapchain_state.last_error)
        {
            swapchain_state.last_error = status;
            log_transport_error("scene acquisition", status);
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
            log_transport_error("scene enumeration", status);
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
    std::uint64_t rendered_window_count = 0;
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
                "Electron game overlay runtime could not update an Electron texture.");
            continue;
        }

        const ImVec2 top_left(
            static_cast<float>(frame.rect_x),
            static_cast<float>(frame.rect_y));
        const ImVec2 bottom_right(
            static_cast<float>(frame.rect_x) + static_cast<float>(frame.rect_width),
            static_cast<float>(frame.rect_y) + static_cast<float>(frame.rect_height));
        draw_list->AddImage(texture.view.handle, top_left, bottom_right);
        ++rendered_window_count;
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
    if (rendered_window_count != 0 && !swapchain_state.first_scene_logged)
    {
        swapchain_state.first_scene_logged = true;
        char message[160] = {};
        sprintf_s(
            message,
            "Electron game overlay runtime rendered its first transported scene (%llu window(s)).",
            static_cast<unsigned long long>(rendered_window_count));
        reshade::log::message(reshade::log::level::info, message);
    }
    if (rendered_window_count >= 2 && !swapchain_state.first_multiwindow_scene_logged)
    {
        swapchain_state.first_multiwindow_scene_logged = true;
        char message[176] = {};
        sprintf_s(
            message,
            "Electron game overlay runtime rendered its first transported multi-window scene (%llu window(s)).",
            static_cast<unsigned long long>(rendered_window_count));
        reshade::log::message(reshade::log::level::info, message);
    }
}

void on_reshade_overlay(effect_runtime *runtime)
{
    auto *const data = runtime->get_private_data<swapchain_data>();
    if (data == nullptr)
        return;

    update_input_ownership(runtime, *data);
    drain_input_messages(data->transport);
    compose_electron_scene(runtime, *data);
}
} // namespace

extern "C" __declspec(dllexport) const char *NAME = "Electron Game Overlay Runtime";
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
        reshade::register_event<reshade::addon_event::input_message>(on_input_message);
        break;

    case DLL_PROCESS_DETACH:
        reshade::unregister_addon(module);
        break;
    }

    return TRUE;
}
