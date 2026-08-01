#include <Windows.h>
#include <CommCtrl.h>

#include <electron_overlay_transport.h>
#include <imgui.h>
#include <reshade.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <limits>
#include <mutex>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>

#pragma comment(lib, "Comctl32.lib")

namespace
{
using namespace reshade::api;

// The add-on is compiled against public ReShade add-on API 18. The repository
// runtime carries a private, capability-negotiated input event, but that
// extension does not change any public effect_runtime vtable. Public hosts are
// accepted by capability: registration and the exact ImGui function table must
// both succeed. ReShade's exported product version is deliberately not pinned.
constexpr std::uint32_t public_reshade_api_version = 18;

HMODULE g_reshade_host_module = nullptr;
HMODULE g_addon_module = nullptr;
bool g_has_private_input_observer = false;

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
    bool pointer_primary = false;
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
std::atomic_flag g_target_surface_logged = ATOMIC_FLAG_INIT;
std::atomic_flag g_fps_logged = ATOMIC_FLAG_INIT;
std::atomic_flag g_diagnostic_publication_logged = ATOMIC_FLAG_INIT;
constexpr std::uint64_t runtime_diagnostic_failure_interval_ms = 7500;
std::array<std::atomic<std::uint64_t>, 9>
    g_runtime_diagnostic_failure_publication_ticks = {};
std::atomic<std::uint64_t> g_target_surface_revision_sequence = 0;
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
    {
        // A pointer message can be synchronously forwarded or replayed after
        // its system history has expired. Preserve an explicitly primary
        // first-button mouse-style sequence from the immutable message flags;
        // real touch/pen input still has authoritative GetPointerInfo metadata
        // and is never reclassified by this fallback.
        const WPARAM pointer_wparam =
            static_cast<WPARAM>(queued.message.wparam);
        if (!IS_POINTER_PRIMARY_WPARAM(pointer_wparam))
            return;
        queued.pointer_id = pointer_id;
        queued.pointer_type = static_cast<std::uint32_t>(PT_MOUSE);
        queued.pointer_key_states =
            IS_POINTER_FIRSTBUTTON_WPARAM(pointer_wparam)
            ? MK_LBUTTON
            : 0;
        queued.pointer_primary = true;
        queued.pointer_metadata_valid = true;
        return;
    }

    queued.pointer_id = pointer_id;
    queued.pointer_type = static_cast<std::uint32_t>(pointer_info.pointerType);
    queued.pointer_key_states = pointer_info.dwKeyStates;
    queued.pointer_primary =
        (pointer_info.pointerFlags & POINTER_FLAG_PRIMARY) != 0;
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
    const bool is_mouse =
        queued.pointer_type == static_cast<std::uint32_t>(PT_MOUSE);
    const bool is_primary_contact =
        (queued.pointer_type == static_cast<std::uint32_t>(PT_TOUCH) ||
         queued.pointer_type == static_cast<std::uint32_t>(PT_PEN)) &&
        queued.pointer_primary;
    if (!queued.pointer_metadata_valid ||
        (!is_mouse && !is_primary_contact))
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
            (is_mouse &&
             !IS_POINTER_FIRSTBUTTON_WPARAM(pointer_wparam)))
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

constexpr std::size_t official_hook_owner_capacity = 32;
constexpr std::size_t official_thread_hook_capacity = 16;
constexpr std::uint32_t invalid_official_hook_slot =
    std::numeric_limits<std::uint32_t>::max();

struct official_hook_owner
{
    // 'root_window' is the publication field. The hook callback acquires it
    // before reading the remaining immutable owner identity.
    std::atomic<std::uintptr_t> root_window = 0;
    std::atomic<std::uintptr_t> route_window = 0;
    std::atomic<std::uint32_t> thread_id = 0;
    std::atomic<std::uint64_t> primary_token = 0;
    std::atomic<input_phase> phase = input_phase::disabled;
    std::atomic<bool> hook_ready = false;
    std::atomic<bool> subclass_ready = false;
    std::uint32_t references = 0;
    std::uint32_t thread_hook_slot = invalid_official_hook_slot;
    std::atomic<DWORD> install_error = ERROR_SUCCESS;
};

struct official_thread_hook
{
    DWORD thread_id = 0;
    HHOOK hook = nullptr;
    std::uint32_t owner_references = 0;
};

std::mutex g_official_hook_mutex;
std::array<official_hook_owner, official_hook_owner_capacity>
    g_official_hook_owners = {};
std::array<official_thread_hook, official_thread_hook_capacity>
    g_official_thread_hooks = {};
std::atomic<std::uint64_t> g_official_hook_token_sequence = 0;
std::atomic<std::uint64_t> g_official_input_sequence = 0;
std::atomic<std::uint32_t> g_official_pointer_message_mask = 0;
std::atomic<std::uint32_t> g_official_hook_callbacks = 0;
std::atomic<bool> g_official_hooks_shutting_down = false;
std::atomic<bool> g_official_subclass_teardown_failed = false;
std::atomic<UINT> g_official_control_message = 0;
std::atomic_flag g_official_hook_error_logged = ATOMIC_FLAG_INIT;
std::atomic_flag g_official_pointer_sequence_logged = ATOMIC_FLAG_INIT;
std::atomic_flag g_official_hook_shutdown_timeout_logged = ATOMIC_FLAG_INIT;

struct official_hook_callback_release
{
    ~official_hook_callback_release()
    {
        g_official_hook_callbacks.fetch_sub(1, std::memory_order_release);
    }
};

bool is_official_keyboard_message(UINT message) noexcept
{
    return message >= WM_KEYFIRST && message <= WM_UNICHAR;
}

bool is_official_mouse_message(UINT message) noexcept
{
    return message >= WM_MOUSEFIRST && message <= WM_MOUSELAST;
}

bool is_official_pointer_message(UINT message) noexcept
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

bool is_official_overlay_input_message(UINT message) noexcept
{
    return message == WM_INPUT ||
        is_official_keyboard_message(message) ||
        is_official_mouse_message(message) ||
        is_official_pointer_message(message);
}

official_hook_owner *find_official_hook_owner(
    DWORD thread_id,
    HWND message_window) noexcept
{
    if (message_window == nullptr)
        return nullptr;

    HWND const message_root = [&]() {
        HWND const root = GetAncestor(message_window, GA_ROOT);
        return root != nullptr ? root : message_window;
    }();
    HWND const foreground = GetForegroundWindow();
    HWND const foreground_root = foreground != nullptr
        ? ([&]() {
              HWND const root = GetAncestor(foreground, GA_ROOT);
              return root != nullptr ? root : foreground;
          })()
        : nullptr;
    if (foreground_root == nullptr || foreground_root != message_root)
        return nullptr;

    for (official_hook_owner &owner : g_official_hook_owners)
    {
        const auto owner_root = reinterpret_cast<HWND>(
            owner.root_window.load(std::memory_order_acquire));
        if (owner_root == nullptr ||
            owner_root != message_root ||
            owner.thread_id.load(std::memory_order_relaxed) != thread_id ||
            !owner.hook_ready.load(std::memory_order_acquire) ||
            owner.phase.load(std::memory_order_acquire) == input_phase::disabled)
        {
            continue;
        }
        return &owner;
    }
    return nullptr;
}

void set_official_message_position(
    input_message &message,
    const MSG &details,
    HWND route_window) noexcept
{
    POINT client_point = details.pt;
    if (route_window != nullptr &&
        ScreenToClient(route_window, &client_point) != FALSE)
    {
        message.client_x = client_point.x;
        message.client_y = client_point.y;
        message.flags |= static_cast<std::uint32_t>(
            input_message_flags::client_point_valid);
    }
}

void mark_official_pointer_message(UINT message) noexcept
{
    switch (message)
    {
    case WM_POINTERUPDATE:
        g_official_pointer_message_mask.fetch_or(1U, std::memory_order_relaxed);
        break;
    case WM_POINTERDOWN:
        g_official_pointer_message_mask.fetch_or(2U, std::memory_order_relaxed);
        break;
    case WM_POINTERUP:
        g_official_pointer_message_mask.fetch_or(4U, std::memory_order_relaxed);
        break;
    default:
        break;
    }
}

void observe_official_window_message(
    const MSG &details,
    HWND route_window) noexcept
{
    input_message message = {};
    message.source = input_message_source::window_message;
    message.device_type =
        is_official_mouse_message(details.message) ||
            is_official_pointer_message(details.message)
        ? input_device_type::mouse
        : input_device_type::keyboard;
    message.sequence =
        g_official_input_sequence.fetch_add(1, std::memory_order_relaxed) + 1;
    message.target_window = route_window;
    message.source_window = details.hwnd;
    message.wparam = static_cast<std::uint64_t>(details.wParam);
    message.lparam = static_cast<std::int64_t>(details.lParam);
    message.flags =
        static_cast<std::uint32_t>(input_message_flags::foreground);
    message.message = details.message;
    message.time = details.time;
    set_official_message_position(message, details, route_window);
    on_input_message(message);
    mark_official_pointer_message(details.message);
}

void observe_official_raw_input(
    const MSG &details,
    HWND route_window) noexcept
{
    RAWINPUT raw = {};
    UINT raw_size = sizeof(raw);
    const UINT copied = GetRawInputData(
        reinterpret_cast<HRAWINPUT>(details.lParam),
        RID_INPUT,
        &raw,
        &raw_size,
        sizeof(RAWINPUTHEADER));
    if (copied == UINT_MAX ||
        (raw.header.dwType != RIM_TYPEMOUSE &&
         raw.header.dwType != RIM_TYPEKEYBOARD))
    {
        return;
    }

    input_message message = {};
    message.source = input_message_source::raw_input;
    message.device_type = raw.header.dwType == RIM_TYPEMOUSE
        ? input_device_type::mouse
        : input_device_type::keyboard;
    message.sequence =
        g_official_input_sequence.fetch_add(1, std::memory_order_relaxed) + 1;
    message.target_window = route_window;
    message.source_window = details.hwnd;
    message.device_handle =
        reinterpret_cast<std::uintptr_t>(raw.header.hDevice);
    message.wparam = static_cast<std::uint64_t>(raw.header.wParam);
    message.flags =
        static_cast<std::uint32_t>(input_message_flags::foreground);
    message.message = details.message;
    message.time = details.time;
    set_official_message_position(message, details, route_window);

    if (raw.header.dwType == RIM_TYPEMOUSE)
    {
        message.mouse.flags = raw.data.mouse.usFlags;
        message.mouse.button_flags = raw.data.mouse.usButtonFlags;
        message.mouse.button_data = raw.data.mouse.usButtonData;
        message.mouse.raw_buttons = raw.data.mouse.ulRawButtons;
        message.mouse.last_x = raw.data.mouse.lLastX;
        message.mouse.last_y = raw.data.mouse.lLastY;
        message.mouse.extra_information =
            raw.data.mouse.ulExtraInformation;
    }
    else
    {
        message.keyboard.make_code = raw.data.keyboard.MakeCode;
        message.keyboard.flags = raw.data.keyboard.Flags;
        message.keyboard.virtual_key = raw.data.keyboard.VKey;
        message.keyboard.message = raw.data.keyboard.Message;
        message.keyboard.extra_information =
            raw.data.keyboard.ExtraInformation;
    }
    on_input_message(message);
}

LRESULT CALLBACK official_get_message_hook(
    int code,
    WPARAM remove_mode,
    LPARAM message_pointer) noexcept
{
    g_official_hook_callbacks.fetch_add(1, std::memory_order_acquire);
    const official_hook_callback_release release_callback;

    if (code < 0 ||
        remove_mode != PM_REMOVE ||
        message_pointer == 0 ||
        g_official_hooks_shutting_down.load(std::memory_order_acquire))
    {
        return CallNextHookEx(nullptr, code, remove_mode, message_pointer);
    }

    auto *const details = reinterpret_cast<MSG *>(message_pointer);
    if (!is_official_overlay_input_message(details->message))
        return CallNextHookEx(nullptr, code, remove_mode, message_pointer);

    official_hook_owner *const owner =
        find_official_hook_owner(GetCurrentThreadId(), details->hwnd);
    if (owner == nullptr)
        return CallNextHookEx(nullptr, code, remove_mode, message_pointer);

    // Mouse and pointer input are deliberately owned by the same-thread
    // window subclass. Passing queued records through unchanged lets the
    // system perform mouse-to-pointer promotion and gives a single blocker
    // for queued and directly sent input. Keyboard/text/raw input remains
    // owned here.
    if (is_official_mouse_message(details->message) ||
        is_official_pointer_message(details->message))
        return CallNextHookEx(nullptr, code, remove_mode, message_pointer);

    const input_phase phase = owner->phase.load(std::memory_order_acquire);
    const bool route = phase == input_phase::enabled;
    HWND const route_window = reinterpret_cast<HWND>(
        owner->route_window.load(std::memory_order_relaxed));
    if (route)
    {
        if (details->message == WM_INPUT)
            observe_official_raw_input(*details, route_window);
        else
            observe_official_window_message(*details, route_window);

        // The application would ordinarily translate these after GetMessage
        // returns. Since it receives WM_NULL below, do that exactly once here
        // so layout/dead-key/Unicode text messages remain in the same queue.
        if (details->message == WM_KEYDOWN ||
            details->message == WM_SYSKEYDOWN)
        {
            TranslateMessage(details);
        }
    }

    // Mutate before continuing the chain. ReShade's own Get/PeekMessage
    // detour and any later WH_GETMESSAGE observer therefore see WM_NULL too,
    // preventing duplicate ImGui delivery while the game is intercepted.
    details->message = WM_NULL;
    details->wParam = 0;
    details->lParam = 0;
    return CallNextHookEx(nullptr, code, remove_mode, message_pointer);
}

constexpr WPARAM official_subclass_install =
    static_cast<WPARAM>(0x45474F494E535441ULL);
constexpr WPARAM official_subclass_remove =
    static_cast<WPARAM>(0x45474F52454D4F56ULL);

UINT_PTR official_subclass_id() noexcept
{
    return reinterpret_cast<UINT_PTR>(&g_official_hook_owners);
}

bool official_owner_filters_window(
    const official_hook_owner &owner,
    HWND message_window) noexcept
{
    if (message_window == nullptr ||
        !owner.hook_ready.load(std::memory_order_acquire) ||
        owner.phase.load(std::memory_order_acquire) == input_phase::disabled)
    {
        return false;
    }

    HWND const root = reinterpret_cast<HWND>(
        owner.root_window.load(std::memory_order_acquire));
    HWND const message_root = [&]() {
        HWND const ancestor = GetAncestor(message_window, GA_ROOT);
        return ancestor != nullptr ? ancestor : message_window;
    }();
    HWND const foreground = GetForegroundWindow();
    HWND const foreground_root = foreground != nullptr
        ? ([&]() {
              HWND const ancestor = GetAncestor(foreground, GA_ROOT);
              return ancestor != nullptr ? ancestor : foreground;
          })()
        : nullptr;
    return root != nullptr &&
        message_root == root &&
        foreground_root == root;
}

LRESULT CALLBACK official_window_subclass(
    HWND window,
    UINT message,
    WPARAM wparam,
    LPARAM lparam,
    UINT_PTR subclass_id,
    DWORD_PTR reference_data) noexcept
{
    g_official_hook_callbacks.fetch_add(1, std::memory_order_acquire);
    const official_hook_callback_release release_callback;

    auto *const owner =
        reinterpret_cast<official_hook_owner *>(reference_data);
    const bool owner_valid =
        owner >= g_official_hook_owners.data() &&
        owner < g_official_hook_owners.data() +
            g_official_hook_owners.size() &&
        subclass_id == official_subclass_id();
    const UINT control_message =
        g_official_control_message.load(std::memory_order_acquire);

    if (owner_valid &&
        message == control_message &&
        wparam == official_subclass_remove)
    {
        owner->hook_ready.store(false, std::memory_order_release);
        owner->subclass_ready.store(false, std::memory_order_release);
        RemoveWindowSubclass(
            window,
            official_window_subclass,
            official_subclass_id());
        return 0;
    }
    if (owner_valid &&
        message == control_message &&
        wparam == official_subclass_install)
    {
        return 0;
    }

    if (!owner_valid ||
        g_official_hooks_shutting_down.load(std::memory_order_acquire) ||
        !is_official_overlay_input_message(message) ||
        !official_owner_filters_window(*owner, window))
    {
        return DefSubclassProc(window, message, wparam, lparam);
    }

    if (owner->phase.load(std::memory_order_acquire) ==
        input_phase::enabled)
    {
        if (is_official_pointer_message(message))
            mark_official_pointer_message(message);

        MSG details = {};
        details.hwnd = window;
        details.message = message;
        details.wParam = wparam;
        details.lParam = lparam;
        details.time = static_cast<DWORD>(GetMessageTime());
        const DWORD position = GetMessagePos();
        details.pt.x = static_cast<std::int16_t>(LOWORD(position));
        details.pt.y = static_cast<std::int16_t>(HIWORD(position));
        HWND const route_window = reinterpret_cast<HWND>(
            owner->route_window.load(std::memory_order_relaxed));
        if (message == WM_INPUT)
            observe_official_raw_input(details, route_window);
        else
            observe_official_window_message(details, route_window);
    }

    // Mouse and pointer messages stay intact through WH_GETMESSAGE so Windows
    // can perform mouse-to-pointer promotion before dispatch. Returning zero
    // owns both queued and directly sent input before the game and before
    // downstream subclasses.
    return 0;
}

LRESULT CALLBACK official_subclass_setup_hook(
    int code,
    WPARAM,
    LPARAM call_window_proc_pointer) noexcept
{
    if (code >= 0 && call_window_proc_pointer != 0)
    {
        const auto *const details =
            reinterpret_cast<const CWPSTRUCT *>(call_window_proc_pointer);
        const UINT control_message =
            g_official_control_message.load(std::memory_order_acquire);
        if (details->message == control_message &&
            details->wParam == official_subclass_install &&
            details->lParam >= 0 &&
            static_cast<std::size_t>(details->lParam) <
                g_official_hook_owners.size())
        {
            official_hook_owner &owner =
                g_official_hook_owners[
                    static_cast<std::size_t>(details->lParam)];
            HWND const owner_root = reinterpret_cast<HWND>(
                owner.root_window.load(std::memory_order_acquire));
            if (owner_root == details->hwnd &&
                owner.thread_id.load(std::memory_order_acquire) ==
                    GetCurrentThreadId())
            {
                SetLastError(ERROR_SUCCESS);
                const BOOL installed = SetWindowSubclass(
                    details->hwnd,
                    official_window_subclass,
                    official_subclass_id(),
                    reinterpret_cast<DWORD_PTR>(&owner));
                DWORD error = installed != FALSE
                    ? ERROR_SUCCESS
                    : GetLastError();
                if (installed == FALSE && error == ERROR_SUCCESS)
                    error = ERROR_INVALID_HOOK_HANDLE;
                owner.install_error.store(error, std::memory_order_release);
                owner.subclass_ready.store(
                    installed != FALSE,
                    std::memory_order_release);
            }
        }
    }
    return CallNextHookEx(
        nullptr,
        code,
        0,
        call_window_proc_pointer);
}

struct electron_texture
{
    resource texture = {};
    resource_view view = {};
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint64_t state_revision = 0;
    std::uint64_t sequence = 0;
    bool upload_failure_reported = false;
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
    ego_target_surface_v1 last_target_surface = {};
    std::uint64_t target_surface_id = 0;
    std::uint64_t target_surface_revision = 0;
    std::uint64_t last_fps_publication_tick = 0;
    std::uint64_t observed_session_epoch = 0;
    std::uint64_t retired_session_textures = 0;
    bool has_target_surface = false;
    bool first_scene_logged = false;
    bool first_multiwindow_scene_logged = false;
    bool has_observed_session_epoch = false;
    bool has_observed_authenticated_session = false;
    bool scene_query_failure_active = false;
    bool frame_rejection_reported = false;
    ego_status last_focus_error = EGO_STATUS_OK;
    ego_status last_session_query_error = EGO_STATUS_OK;
    ego_status last_interception_error = EGO_STATUS_OK;
    ego_status last_filter_error = EGO_STATUS_OK;
    ego_status last_scene_query_error = EGO_STATUS_OK;
    ego_status last_target_surface_error = EGO_STATUS_OK;
    ego_status last_fps_error = EGO_STATUS_OK;
    std::uint64_t official_hook_token = 0;
    std::uint32_t official_hook_slot = invalid_official_hook_slot;
    bool official_hook_failure_reported = false;
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

bool take_runtime_diagnostic_failure_publication(std::uint32_t code) noexcept
{
    switch (code)
    {
    case EGO_RUNTIME_DIAGNOSTIC_SCENE_QUERY_FAILED:
    case EGO_RUNTIME_DIAGNOSTIC_FRAME_REJECTED:
    case EGO_RUNTIME_DIAGNOSTIC_FRAME_UPLOAD_FAILED:
    case EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTER_RESET:
    case EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED:
        break;
    default:
        return true;
    }

    if (code >= g_runtime_diagnostic_failure_publication_ticks.size())
        return false;

    const std::uint64_t now = GetTickCount64();
    auto &last_publication =
        g_runtime_diagnostic_failure_publication_ticks[code];
    std::uint64_t observed =
        last_publication.load(std::memory_order_relaxed);
    for (;;)
    {
        if (observed != 0 &&
            now >= observed &&
            now - observed < runtime_diagnostic_failure_interval_ms)
        {
            return false;
        }
        if (last_publication.compare_exchange_weak(
                observed,
                now,
                std::memory_order_relaxed,
                std::memory_order_relaxed))
        {
            return true;
        }
    }
}

void publish_runtime_diagnostic(
    ego_transport *transport,
    std::uint32_t code,
    ego_status error_code = EGO_STATUS_OK)
{
    if (transport == nullptr ||
        !take_runtime_diagnostic_failure_publication(code))
    {
        return;
    }

    ego_runtime_diagnostic_v1 diagnostic = {};
    diagnostic.struct_size =
        static_cast<std::uint32_t>(sizeof(ego_runtime_diagnostic_v1));
    diagnostic.abi_version = EGO_RUNTIME_DIAGNOSTIC_ABI_VERSION;
    diagnostic.code = code;
    diagnostic.error_code = error_code;

    const ego_status status =
        ego_transport_publish_diagnostic(transport, &diagnostic);
    if (status != EGO_STATUS_OK &&
        !g_diagnostic_publication_logged.test_and_set(std::memory_order_relaxed))
    {
        log_transport_error("runtime diagnostic publication", status);
    }
}

void publish_input_routing_failure(
    ego_transport *transport,
    ego_status error_code)
{
    publish_runtime_diagnostic(
        transport,
        EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED,
        error_code);
}

HWND official_root_window(HWND window) noexcept
{
    if (window == nullptr)
        return nullptr;
    HWND const root = GetAncestor(window, GA_ROOT);
    return root != nullptr ? root : window;
}

bool retain_official_thread_hook(
    DWORD thread_id,
    std::uint32_t &slot_index,
    DWORD &error) noexcept
{
    for (std::uint32_t index = 0;
         index < g_official_thread_hooks.size();
         ++index)
    {
        official_thread_hook &thread_hook = g_official_thread_hooks[index];
        if (thread_hook.thread_id != thread_id || thread_hook.hook == nullptr)
            continue;
        ++thread_hook.owner_references;
        slot_index = index;
        error = ERROR_SUCCESS;
        return true;
    }

    for (std::uint32_t index = 0;
         index < g_official_thread_hooks.size();
         ++index)
    {
        official_thread_hook &thread_hook = g_official_thread_hooks[index];
        if (thread_hook.thread_id != 0 || thread_hook.hook != nullptr)
            continue;

        SetLastError(ERROR_SUCCESS);
        HHOOK const hook = SetWindowsHookExW(
            WH_GETMESSAGE,
            official_get_message_hook,
            g_addon_module,
            thread_id);
        if (hook == nullptr)
        {
            error = GetLastError();
            if (error == ERROR_SUCCESS)
                error = ERROR_HOOK_NEEDS_HMOD;
            return false;
        }

        thread_hook.thread_id = thread_id;
        thread_hook.hook = hook;
        thread_hook.owner_references = 1;
        slot_index = index;
        error = ERROR_SUCCESS;
        return true;
    }

    error = ERROR_TOO_MANY_TCBS;
    return false;
}

void log_official_hook_failure(
    HWND root,
    DWORD thread_id,
    DWORD error) noexcept
{
    if (g_official_hook_error_logged.test_and_set(std::memory_order_relaxed))
        return;

    char message[320] = {};
    sprintf_s(
        message,
        "Electron game overlay could not install its official-ReShade "
        "WH_GETMESSAGE input hook for root HWND %p on thread %lu "
        "(Win32 error %lu). Interception remains inactive.",
        root,
        static_cast<unsigned long>(thread_id),
        static_cast<unsigned long>(error));
    reshade::log::message(reshade::log::level::error, message);
}

UINT ensure_official_control_message() noexcept
{
    UINT message =
        g_official_control_message.load(std::memory_order_acquire);
    if (message != 0)
        return message;

    message = RegisterWindowMessageW(
        L"ElectronGameOverlay.OfficialReShade.InputHook.v1");
    if (message != 0)
        g_official_control_message.store(message, std::memory_order_release);
    return message;
}

bool install_official_window_subclass(
    official_hook_owner &owner,
    std::uint32_t owner_index) noexcept
{
    HWND const root = reinterpret_cast<HWND>(
        owner.root_window.load(std::memory_order_acquire));
    const DWORD thread_id =
        owner.thread_id.load(std::memory_order_acquire);
    if (root == nullptr ||
        thread_id == 0 ||
        ensure_official_control_message() == 0)
    {
        owner.install_error.store(
            ERROR_INVALID_WINDOW_HANDLE,
            std::memory_order_release);
        return false;
    }

    if (GetCurrentThreadId() == thread_id)
    {
        SetLastError(ERROR_SUCCESS);
        const BOOL installed = SetWindowSubclass(
            root,
            official_window_subclass,
            official_subclass_id(),
            reinterpret_cast<DWORD_PTR>(&owner));
        DWORD error = installed != FALSE
            ? ERROR_SUCCESS
            : GetLastError();
        if (installed == FALSE && error == ERROR_SUCCESS)
            error = ERROR_INVALID_HOOK_HANDLE;
        owner.install_error.store(error, std::memory_order_release);
        owner.subclass_ready.store(
            installed != FALSE,
            std::memory_order_release);
        return installed != FALSE;
    }

    SetLastError(ERROR_SUCCESS);
    HHOOK const setup_hook = SetWindowsHookExW(
        WH_CALLWNDPROC,
        official_subclass_setup_hook,
        g_addon_module,
        thread_id);
    if (setup_hook == nullptr)
    {
        DWORD error = GetLastError();
        if (error == ERROR_SUCCESS)
            error = ERROR_HOOK_NEEDS_HMOD;
        owner.install_error.store(error, std::memory_order_release);
        return false;
    }

    DWORD_PTR ignored_result = 0;
    SetLastError(ERROR_SUCCESS);
    const LRESULT sent = SendMessageTimeoutW(
        root,
        g_official_control_message.load(std::memory_order_acquire),
        official_subclass_install,
        static_cast<LPARAM>(owner_index),
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        2000,
        &ignored_result);
    DWORD send_error = sent != 0 ? ERROR_SUCCESS : GetLastError();
    if (send_error == ERROR_SUCCESS && sent == 0)
        send_error = ERROR_TIMEOUT;
    UnhookWindowsHookEx(setup_hook);

    const bool installed =
        owner.subclass_ready.load(std::memory_order_acquire);
    if (!installed &&
        owner.install_error.load(std::memory_order_acquire) == ERROR_SUCCESS)
    {
        owner.install_error.store(send_error, std::memory_order_release);
    }
    return installed;
}

bool remove_official_window_subclass(
    official_hook_owner &owner) noexcept
{
    if (!owner.subclass_ready.load(std::memory_order_acquire))
        return true;

    owner.hook_ready.store(false, std::memory_order_release);
    HWND const root = reinterpret_cast<HWND>(
        owner.root_window.load(std::memory_order_acquire));
    const DWORD thread_id =
        owner.thread_id.load(std::memory_order_acquire);
    if (root == nullptr || IsWindow(root) == FALSE)
    {
        owner.subclass_ready.store(false, std::memory_order_release);
        return true;
    }

    if (GetCurrentThreadId() == thread_id)
    {
        const BOOL removed = RemoveWindowSubclass(
            root,
            official_window_subclass,
            official_subclass_id());
        if (removed != FALSE)
            owner.subclass_ready.store(false, std::memory_order_release);
        return removed != FALSE;
    }

    DWORD_PTR ignored_result = 0;
    const LRESULT sent = SendMessageTimeoutW(
        root,
        g_official_control_message.load(std::memory_order_acquire),
        official_subclass_remove,
        0,
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        2000,
        &ignored_result);
    return sent != 0 &&
        !owner.subclass_ready.load(std::memory_order_acquire);
}

bool retain_official_hook_owner(swapchain_data &data) noexcept
{
    if (g_has_private_input_observer ||
        data.window == nullptr ||
        g_official_hooks_shutting_down.load(std::memory_order_acquire))
    {
        return g_has_private_input_observer;
    }

    HWND const root = official_root_window(data.window);
    DWORD process_id = 0;
    const DWORD thread_id =
        root != nullptr
        ? GetWindowThreadProcessId(root, &process_id)
        : 0;
    const std::uint64_t token =
        g_official_hook_token_sequence.fetch_add(
            1,
            std::memory_order_relaxed) +
        1;

    const std::scoped_lock lock(g_official_hook_mutex);
    for (std::uint32_t index = 0;
         index < g_official_hook_owners.size();
         ++index)
    {
        official_hook_owner &owner = g_official_hook_owners[index];
        if (owner.references == 0 ||
            reinterpret_cast<HWND>(
                owner.root_window.load(std::memory_order_acquire)) != root)
        {
            continue;
        }

        ++owner.references;
        data.official_hook_slot = index;
        data.official_hook_token = token;
        std::uint64_t expected_primary = 0;
        owner.primary_token.compare_exchange_strong(
            expected_primary,
            token,
            std::memory_order_release,
            std::memory_order_relaxed);
        return owner.hook_ready.load(std::memory_order_acquire);
    }

    DWORD install_error = ERROR_SUCCESS;
    std::uint32_t thread_hook_slot = invalid_official_hook_slot;
    bool const identity_valid =
        root != nullptr &&
        thread_id != 0 &&
        process_id == GetCurrentProcessId();
    const bool message_hook_ready =
        identity_valid &&
        retain_official_thread_hook(
            thread_id,
            thread_hook_slot,
            install_error);
    if (!identity_valid)
        install_error = ERROR_INVALID_WINDOW_HANDLE;

    for (std::uint32_t index = 0;
         index < g_official_hook_owners.size();
         ++index)
    {
        official_hook_owner &owner = g_official_hook_owners[index];
        if (owner.references != 0 ||
            owner.root_window.load(std::memory_order_acquire) != 0)
        {
            continue;
        }

        owner.references = 1;
        owner.thread_hook_slot = thread_hook_slot;
        owner.install_error.store(install_error, std::memory_order_relaxed);
        owner.route_window.store(
            reinterpret_cast<std::uintptr_t>(data.window),
            std::memory_order_relaxed);
        owner.thread_id.store(thread_id, std::memory_order_relaxed);
        owner.primary_token.store(token, std::memory_order_relaxed);
        owner.phase.store(input_phase::disabled, std::memory_order_relaxed);
        owner.hook_ready.store(false, std::memory_order_relaxed);
        owner.subclass_ready.store(false, std::memory_order_relaxed);
        owner.root_window.store(
            reinterpret_cast<std::uintptr_t>(root),
            std::memory_order_release);
        data.official_hook_slot = index;
        data.official_hook_token = token;

        const bool hook_ready =
            message_hook_ready &&
            install_official_window_subclass(owner, index);
        owner.hook_ready.store(hook_ready, std::memory_order_release);
        if (hook_ready)
        {
            char message[256] = {};
            sprintf_s(
                message,
                "Electron game overlay installed its official-ReShade "
                "WH_GETMESSAGE and window-subclass input hooks for root HWND "
                "%p on thread %lu.",
                root,
                static_cast<unsigned long>(thread_id));
            reshade::log::message(reshade::log::level::info, message);
        }
        else
        {
            log_official_hook_failure(
                root,
                thread_id,
                owner.install_error.load(std::memory_order_acquire));
        }
        return hook_ready;
    }

    if (message_hook_ready &&
        thread_hook_slot < g_official_thread_hooks.size())
    {
        official_thread_hook &thread_hook =
            g_official_thread_hooks[thread_hook_slot];
        if (thread_hook.owner_references > 0)
            --thread_hook.owner_references;
        if (thread_hook.owner_references == 0)
        {
            UnhookWindowsHookEx(thread_hook.hook);
            thread_hook = {};
        }
    }
    log_official_hook_failure(root, thread_id, ERROR_TOO_MANY_TCBS);
    return false;
}

official_hook_owner *get_official_hook_owner(
    const swapchain_data &data) noexcept
{
    if (data.official_hook_slot >= g_official_hook_owners.size() ||
        data.official_hook_token == 0)
    {
        return nullptr;
    }

    official_hook_owner &owner =
        g_official_hook_owners[data.official_hook_slot];
    return owner.root_window.load(std::memory_order_acquire) != 0
        ? &owner
        : nullptr;
}

bool claim_official_input_owner(swapchain_data &data) noexcept
{
    official_hook_owner *const owner = get_official_hook_owner(data);
    if (owner == nullptr ||
        !owner->hook_ready.load(std::memory_order_acquire))
    {
        return false;
    }

    std::uint64_t primary =
        owner->primary_token.load(std::memory_order_acquire);
    if (primary == 0)
    {
        owner->primary_token.compare_exchange_strong(
            primary,
            data.official_hook_token,
            std::memory_order_acq_rel,
            std::memory_order_acquire);
        primary = owner->primary_token.load(std::memory_order_acquire);
    }
    return primary == data.official_hook_token;
}

void publish_official_hook_phase(
    const swapchain_data &data,
    input_phase phase) noexcept
{
    official_hook_owner *const owner = get_official_hook_owner(data);
    if (owner == nullptr ||
        owner->primary_token.load(std::memory_order_acquire) !=
            data.official_hook_token)
    {
        return;
    }
    owner->phase.store(phase, std::memory_order_release);
}

void release_official_hook_owner(swapchain_data &data) noexcept
{
    if (data.official_hook_slot >= g_official_hook_owners.size() ||
        data.official_hook_token == 0)
    {
        data.official_hook_slot = invalid_official_hook_slot;
        data.official_hook_token = 0;
        return;
    }

    const std::scoped_lock lock(g_official_hook_mutex);
    official_hook_owner &owner =
        g_official_hook_owners[data.official_hook_slot];
    if (owner.primary_token.load(std::memory_order_acquire) ==
        data.official_hook_token)
    {
        owner.phase.store(input_phase::disabled, std::memory_order_release);
        owner.primary_token.store(0, std::memory_order_release);
    }

    if (owner.references > 0)
        --owner.references;
    if (owner.references == 0)
    {
        owner.phase.store(input_phase::disabled, std::memory_order_release);
        owner.hook_ready.store(false, std::memory_order_release);
        const bool subclass_removed =
            remove_official_window_subclass(owner);
        if (!subclass_removed)
        {
            g_official_subclass_teardown_failed.store(
                true,
                std::memory_order_release);
        }

        if (owner.thread_hook_slot < g_official_thread_hooks.size())
        {
            official_thread_hook &thread_hook =
                g_official_thread_hooks[owner.thread_hook_slot];
            if (thread_hook.owner_references > 0)
                --thread_hook.owner_references;
            if (thread_hook.owner_references == 0)
            {
                if (thread_hook.hook != nullptr)
                    UnhookWindowsHookEx(thread_hook.hook);
                thread_hook = {};
            }
        }

        if (subclass_removed)
        {
            owner.root_window.store(0, std::memory_order_release);
            owner.route_window.store(0, std::memory_order_relaxed);
            owner.thread_id.store(0, std::memory_order_relaxed);
            owner.primary_token.store(0, std::memory_order_relaxed);
            owner.subclass_ready.store(false, std::memory_order_relaxed);
        }
        owner.thread_hook_slot = invalid_official_hook_slot;
        owner.install_error.store(ERROR_SUCCESS, std::memory_order_relaxed);
    }

    data.official_hook_slot = invalid_official_hook_slot;
    data.official_hook_token = 0;
}

void shutdown_official_message_hooks(bool wait_for_callbacks) noexcept
{
    g_official_hooks_shutting_down.store(true, std::memory_order_release);

    {
        const std::scoped_lock lock(g_official_hook_mutex);
        for (official_hook_owner &owner : g_official_hook_owners)
        {
            owner.phase.store(input_phase::disabled, std::memory_order_release);
            owner.hook_ready.store(false, std::memory_order_release);
            const bool subclass_removed =
                remove_official_window_subclass(owner);
            if (!subclass_removed)
            {
                g_official_subclass_teardown_failed.store(
                    true,
                    std::memory_order_release);
            }
            else
            {
                owner.root_window.store(0, std::memory_order_release);
                owner.route_window.store(0, std::memory_order_relaxed);
                owner.thread_id.store(0, std::memory_order_relaxed);
                owner.primary_token.store(0, std::memory_order_relaxed);
                owner.subclass_ready.store(false, std::memory_order_relaxed);
            }
            owner.references = 0;
            owner.thread_hook_slot = invalid_official_hook_slot;
            owner.install_error.store(
                ERROR_SUCCESS,
                std::memory_order_relaxed);
        }
        for (official_thread_hook &thread_hook : g_official_thread_hooks)
        {
            if (thread_hook.hook != nullptr)
                UnhookWindowsHookEx(thread_hook.hook);
            thread_hook = {};
        }
    }

    if (!wait_for_callbacks)
        return;

    const ULONGLONG deadline = GetTickCount64() + 5000;
    while (g_official_hook_callbacks.load(std::memory_order_acquire) != 0 &&
           GetTickCount64() < deadline)
    {
        Sleep(1);
    }
    const bool callback_timeout =
        g_official_hook_callbacks.load(std::memory_order_acquire) != 0;
    const bool subclass_teardown_failed =
        g_official_subclass_teardown_failed.load(std::memory_order_acquire);
    if (!callback_timeout && !subclass_teardown_failed)
        return;

    if (!g_official_hook_shutdown_timeout_logged.test_and_set(
            std::memory_order_relaxed))
    {
        reshade::log::message(
            reshade::log::level::error,
            callback_timeout
                ? "Electron game overlay timed out waiting for an "
                  "official-ReShade input callback during unload; pinning the "
                  "add-on module to avoid executing an unloaded callback."
                : "Electron game overlay could not remove an official-ReShade "
                  "window subclass during unload; pinning the add-on module "
                  "to avoid executing an unloaded callback.");
    }
    HMODULE pinned_module = nullptr;
    GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
            GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&g_addon_module),
        &pinned_module);
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
        publish_runtime_diagnostic(
            g_transport,
            EGO_RUNTIME_DIAGNOSTIC_RUNTIME_READY);
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

bool log_input_overflow_once(std::uint64_t dropped)
{
    if (g_overflow_logged.test_and_set(std::memory_order_relaxed))
        return false;

    char message[256] = {};
    sprintf_s(
        message,
        "Electron ReShade input observer queue overflowed (%llu record(s) dropped); "
        "the Electron router was reset before input delivery resumed.",
        static_cast<unsigned long long>(dropped));
    reshade::log::message(reshade::log::level::warning, message);
    return true;
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
        publish_input_routing_failure(transport, blur_status);
        g_input_recovery_pending.store(true, std::memory_order_release);
        return false;
    }

    const ego_status focus_status = ego_transport_set_target_focused(
        transport,
        any_target_focused() ? 1U : 0U);
    if (focus_status != EGO_STATUS_OK)
    {
        log_transport_error("input-loss focus restore", focus_status);
        publish_input_routing_failure(transport, focus_status);
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

    if (dropped != 0 && log_input_overflow_once(dropped))
    {
        publish_runtime_diagnostic(
            transport,
            EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTER_RESET);
    }
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
            publish_runtime_diagnostic(
                transport,
                EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTER_RESET);
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
                    publish_input_routing_failure(transport, status);
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

void discard_dormant_input()
{
    // Invalidate every in-flight producer/batch even if another render
    // callback currently owns the destructive queue reset below.
    g_input_generation.fetch_add(1, std::memory_order_acq_rel);

    if (g_input_consumer.test_and_set(std::memory_order_acquire))
        return;
    const input_consumer_release release_consumer;

    // A copied message may have raced the transport disconnect. Advance the
    // generation before competing for the consumer so a preempted producer
    // cannot republish a stale event into a later producer session.
    reset_ordered_pointer_state();
    g_pointer_route_reset_pending.store(false, std::memory_order_release);
    discard_queued_input();
    g_dropped_input_messages.store(0, std::memory_order_release);
    g_input_recovery_pending.store(false, std::memory_order_release);
    g_last_input_sequence = 0;
    g_has_last_input_sequence = false;
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

std::size_t retire_all_electron_textures(effect_runtime *runtime)
{
    device *const device = runtime->get_device();
    auto *const data = device->get_private_data<device_data>();
    if (data == nullptr)
        return 0;

    const std::scoped_lock lock(data->mutex);
    if (data->textures.empty())
        return 0;

    // ReShade keeps the add-on and graphics device loaded after a producer
    // disconnect. Wait for prior draws once, then release every producer-owned
    // resource so the dormant add-on retains no Electron framebuffers.
    const std::size_t retired_count = data->textures.size();
    runtime->get_command_queue()->wait_idle();
    for (auto &[window_id, texture] : data->textures)
    {
        static_cast<void>(window_id);
        destroy_texture(device, texture);
    }
    data->textures.clear();
    return retired_count;
}

void report_frame_upload_failure(
    ego_transport *transport,
    electron_texture &texture,
    const char *message)
{
    if (texture.upload_failure_reported)
        return;

    texture.upload_failure_reported = true;
    reshade::log::message(reshade::log::level::error, message);
    publish_runtime_diagnostic(
        transport,
        EGO_RUNTIME_DIAGNOSTIC_FRAME_UPLOAD_FAILED);
}

bool create_texture(
    device *device,
    const ego_window_frame_v1 &frame,
    electron_texture &texture,
    ego_transport *transport)
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
        report_frame_upload_failure(
            transport,
            texture,
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
        report_frame_upload_failure(
            transport,
            texture,
            "Electron game overlay runtime could not create an Electron texture view.");
        return false;
    }

    texture.width = frame.raster_width;
    texture.height = frame.raster_height;
    texture.state_revision = frame.state_revision;
    texture.sequence = frame.sequence;
    texture.upload_failure_reported = false;
    return true;
}

bool update_texture(
    effect_runtime *runtime,
    const ego_window_frame_v1 &frame,
    electron_texture &texture,
    ego_transport *transport)
{
    command_queue *const queue = runtime->get_command_queue();
    if (queue == nullptr)
    {
        report_frame_upload_failure(
            transport,
            texture,
            "Electron game overlay runtime could not acquire the texture upload queue.");
        return false;
    }

    command_list *command_list = queue->get_immediate_command_list();
    if (command_list == nullptr)
    {
        report_frame_upload_failure(
            transport,
            texture,
            "Electron game overlay runtime could not acquire the pre-upload command list.");
        return false;
    }

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
    {
        report_frame_upload_failure(
            transport,
            texture,
            "Electron game overlay runtime could not acquire the post-upload command list.");
        return false;
    }
    command_list->barrier(
        texture.texture,
        resource_usage::copy_dest,
        resource_usage::shader_resource);
    queue->flush_immediate_command_list();

    texture.state_revision = frame.state_revision;
    texture.sequence = frame.sequence;
    texture.upload_failure_reported = false;
    return true;
}

std::uint32_t transport_graphics_api(device_api api) noexcept
{
    switch (api)
    {
    case device_api::d3d9:
        return EGO_GRAPHICS_API_D3D9;
    case device_api::d3d10:
        return EGO_GRAPHICS_API_D3D10;
    case device_api::d3d11:
        return EGO_GRAPHICS_API_D3D11;
    case device_api::d3d12:
        return EGO_GRAPHICS_API_D3D12;
    case device_api::opengl:
        return EGO_GRAPHICS_API_OPENGL;
    case device_api::vulkan:
        return EGO_GRAPHICS_API_VULKAN;
    default:
        return EGO_GRAPHICS_API_UNKNOWN;
    }
}

bool positive_rect_dimensions(
    const RECT &rect,
    std::uint32_t &width,
    std::uint32_t &height) noexcept
{
    const std::int64_t signed_width =
        static_cast<std::int64_t>(rect.right) - rect.left;
    const std::int64_t signed_height =
        static_cast<std::int64_t>(rect.bottom) - rect.top;
    if (signed_width <= 0 || signed_height <= 0 ||
        signed_width > std::numeric_limits<std::uint32_t>::max() ||
        signed_height > std::numeric_limits<std::uint32_t>::max())
    {
        return false;
    }

    width = static_cast<std::uint32_t>(signed_width);
    height = static_cast<std::uint32_t>(signed_height);
    return true;
}

class scoped_thread_dpi_awareness
{
public:
    scoped_thread_dpi_awareness() noexcept
        : previous_context_(SetThreadDpiAwarenessContext(
              DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
    {
    }

    scoped_thread_dpi_awareness(const scoped_thread_dpi_awareness &) = delete;
    scoped_thread_dpi_awareness &operator=(
        const scoped_thread_dpi_awareness &) = delete;

    ~scoped_thread_dpi_awareness()
    {
        if (previous_context_ != nullptr)
            static_cast<void>(SetThreadDpiAwarenessContext(previous_context_));
    }

    [[nodiscard]] bool active() const noexcept
    {
        return previous_context_ != nullptr;
    }

private:
    DPI_AWARENESS_CONTEXT previous_context_ = nullptr;
};

std::uint64_t next_target_surface_revision() noexcept
{
    std::uint64_t current =
        g_target_surface_revision_sequence.load(std::memory_order_relaxed);
    while (current != std::numeric_limits<std::uint64_t>::max())
    {
        const std::uint64_t next = current + 1;
        if (g_target_surface_revision_sequence.compare_exchange_weak(
                current,
                next,
                std::memory_order_relaxed,
                std::memory_order_relaxed))
        {
            return next;
        }
    }

    // Do not wrap to zero or publish an event older than one already observed.
    return 0;
}

bool equivalent_target_surface(
    const ego_target_surface_v1 &left,
    const ego_target_surface_v1 &right) noexcept
{
    return left.struct_size == right.struct_size &&
        left.abi_version == right.abi_version &&
        left.surface_id == right.surface_id &&
        left.target_hwnd == right.target_hwnd &&
        left.monitor_handle == right.monitor_handle &&
        left.graphics_api == right.graphics_api &&
        left.render_width == right.render_width &&
        left.render_height == right.render_height &&
        left.client_screen_x == right.client_screen_x &&
        left.client_screen_y == right.client_screen_y &&
        left.client_width == right.client_width &&
        left.client_height == right.client_height &&
        left.window_screen_x == right.window_screen_x &&
        left.window_screen_y == right.window_screen_y &&
        left.window_width == right.window_width &&
        left.window_height == right.window_height &&
        left.dpi_x == right.dpi_x &&
        left.dpi_y == right.dpi_y &&
        left.monitor_x == right.monitor_x &&
        left.monitor_y == right.monitor_y &&
        left.monitor_width == right.monitor_width &&
        left.monitor_height == right.monitor_height &&
        left.work_x == right.work_x &&
        left.work_y == right.work_y &&
        left.work_width == right.work_width &&
        left.work_height == right.work_height &&
        left.state_flags == right.state_flags;
}

bool capture_target_surface(
    effect_runtime *runtime,
    const swapchain_data &data,
    ego_target_surface_v1 &surface) noexcept
{
    const auto surface_id = static_cast<std::uint64_t>(
        reinterpret_cast<std::uintptr_t>(runtime));
    if (surface_id == 0)
        return false;

    const scoped_thread_dpi_awareness dpi_awareness;
    if (!dpi_awareness.active())
        return false;

    const HWND runtime_window = static_cast<HWND>(runtime->get_hwnd());
    const HWND window = runtime_window != nullptr ? runtime_window : data.window;
    if (window == nullptr || IsWindow(window) == FALSE)
        return false;

    std::uint32_t render_width = 0;
    std::uint32_t render_height = 0;
    runtime->get_screenshot_width_and_height(&render_width, &render_height);
    if (render_width == 0 || render_height == 0)
        return false;

    RECT client_rect = {};
    std::uint32_t client_width = 0;
    std::uint32_t client_height = 0;
    if (GetClientRect(window, &client_rect) == FALSE ||
        !positive_rect_dimensions(client_rect, client_width, client_height))
    {
        return false;
    }

    POINT client_origin = { client_rect.left, client_rect.top };
    if (ClientToScreen(window, &client_origin) == FALSE)
        return false;

    RECT window_rect = {};
    std::uint32_t window_width = 0;
    std::uint32_t window_height = 0;
    if (GetWindowRect(window, &window_rect) == FALSE ||
        !positive_rect_dimensions(window_rect, window_width, window_height))
    {
        window_rect.left = client_origin.x;
        window_rect.top = client_origin.y;
        window_width = client_width;
        window_height = client_height;
    }

    const HMONITOR monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
    if (monitor == nullptr)
        return false;

    MONITORINFO monitor_info = {};
    monitor_info.cbSize = sizeof(monitor_info);
    std::uint32_t monitor_width = 0;
    std::uint32_t monitor_height = 0;
    std::uint32_t work_width = 0;
    std::uint32_t work_height = 0;
    if (GetMonitorInfoW(monitor, &monitor_info) == FALSE ||
        !positive_rect_dimensions(
            monitor_info.rcMonitor,
            monitor_width,
            monitor_height) ||
        !positive_rect_dimensions(
            monitor_info.rcWork,
            work_width,
            work_height))
    {
        return false;
    }

    std::uint32_t state_flags = 0;
    const HWND foreground = GetForegroundWindow();
    const HWND root = GetAncestor(window, GA_ROOT);
    if (foreground == window || (root != nullptr && foreground == root))
        state_flags |= EGO_TARGET_SURFACE_FOCUSED;
    if (IsIconic(window) != FALSE)
        state_flags |= EGO_TARGET_SURFACE_MINIMIZED;
    if (IsWindowVisible(window) != FALSE)
        state_flags |= EGO_TARGET_SURFACE_VISIBLE;

    const std::int64_t client_right =
        static_cast<std::int64_t>(client_origin.x) + client_width;
    const std::int64_t client_bottom =
        static_cast<std::int64_t>(client_origin.y) + client_height;
    if (client_origin.x <= monitor_info.rcMonitor.left &&
        client_origin.y <= monitor_info.rcMonitor.top &&
        client_right >= monitor_info.rcMonitor.right &&
        client_bottom >= monitor_info.rcMonitor.bottom)
    {
        state_flags |= EGO_TARGET_SURFACE_FULLSCREEN;
    }

    std::uint32_t dpi = GetDpiForWindow(window);
    if (dpi == 0)
        dpi = USER_DEFAULT_SCREEN_DPI;

    surface = {};
    surface.struct_size = sizeof(surface);
    surface.abi_version = EGO_ABI_VERSION;
    surface.surface_id = surface_id;
    surface.target_hwnd = static_cast<std::uint64_t>(
        reinterpret_cast<std::uintptr_t>(window));
    surface.monitor_handle = static_cast<std::uint64_t>(
        reinterpret_cast<std::uintptr_t>(monitor));
    surface.graphics_api = transport_graphics_api(runtime->get_device()->get_api());
    surface.render_width = render_width;
    surface.render_height = render_height;
    surface.client_screen_x = client_origin.x;
    surface.client_screen_y = client_origin.y;
    surface.client_width = client_width;
    surface.client_height = client_height;
    surface.window_screen_x = window_rect.left;
    surface.window_screen_y = window_rect.top;
    surface.window_width = window_width;
    surface.window_height = window_height;
    surface.dpi_x = dpi;
    surface.dpi_y = dpi;
    surface.monitor_x = monitor_info.rcMonitor.left;
    surface.monitor_y = monitor_info.rcMonitor.top;
    surface.monitor_width = monitor_width;
    surface.monitor_height = monitor_height;
    surface.work_x = monitor_info.rcWork.left;
    surface.work_y = monitor_info.rcWork.top;
    surface.work_width = work_width;
    surface.work_height = work_height;
    surface.state_flags = state_flags;
    return true;
}

void publish_target_surface(effect_runtime *runtime, swapchain_data &data)
{
    if (data.transport == nullptr)
        return;

    ego_target_surface_v1 surface = {};
    if (!capture_target_surface(runtime, data, surface))
        return;
    if (data.has_target_surface &&
        equivalent_target_surface(data.last_target_surface, surface))
    {
        return;
    }

    surface.revision = next_target_surface_revision();
    if (surface.revision == 0)
        return;
    data.target_surface_revision = surface.revision;
    const ego_status status =
        ego_transport_publish_target_surface(data.transport, &surface);
    if (status != EGO_STATUS_OK)
    {
        if (status != data.last_target_surface_error)
        {
            data.last_target_surface_error = status;
            log_transport_error("target-surface publication", status);
        }
        return;
    }

    data.last_target_surface_error = EGO_STATUS_OK;
    data.last_target_surface = surface;
    data.target_surface_id = surface.surface_id;
    data.has_target_surface = true;

    if (!g_target_surface_logged.test_and_set(std::memory_order_relaxed))
    {
        char message[256] = {};
        sprintf_s(
            message,
            "Electron game overlay runtime published its first target-surface "
            "telemetry (surface %llu, API 0x%x, render %ux%u, client %ux%u).",
            static_cast<unsigned long long>(surface.surface_id),
            surface.graphics_api,
            surface.render_width,
            surface.render_height,
            surface.client_width,
            surface.client_height);
        reshade::log::message(reshade::log::level::info, message);
    }
}

void remove_target_surface(swapchain_data &data)
{
    if (data.transport == nullptr || !data.has_target_surface ||
        data.target_surface_id == 0)
    {
        return;
    }

    const std::uint64_t removal_revision = next_target_surface_revision();
    if (removal_revision == 0)
        return;
    data.target_surface_revision = removal_revision;
    const ego_status status = ego_transport_remove_target_surface(
        data.transport,
        data.target_surface_id,
        removal_revision);
    if (status != EGO_STATUS_OK)
        log_transport_error("target-surface removal", status);

    data.has_target_surface = false;
}

void publish_render_fps(swapchain_data &data)
{
    if (data.transport == nullptr)
        return;

    constexpr std::uint64_t publication_interval_ms = 1000;
    const std::uint64_t now = GetTickCount64();
    if (data.last_fps_publication_tick != 0 &&
        now - data.last_fps_publication_tick < publication_interval_ms)
    {
        return;
    }

    const float fps = ImGui::GetIO().Framerate;
    if (!std::isfinite(fps) || fps <= 0.0f)
        return;

    const double scaled_fps = std::round(static_cast<double>(fps) * 1000.0);
    const std::uint32_t fps_milli = static_cast<std::uint32_t>(std::min(
        scaled_fps,
        static_cast<double>(std::numeric_limits<std::uint32_t>::max())));
    if (fps_milli == 0)
        return;

    data.last_fps_publication_tick = now;
    const ego_status status = ego_transport_publish_fps(data.transport, fps_milli);
    if (status != EGO_STATUS_OK)
    {
        if (status != data.last_fps_error)
        {
            data.last_fps_error = status;
            log_transport_error("injected render FPS publication", status);
        }
        return;
    }

    data.last_fps_error = EGO_STATUS_OK;
    if (!g_fps_logged.test_and_set(std::memory_order_relaxed))
    {
        char message[192] = {};
        sprintf_s(
            message,
            "Electron game overlay runtime published its first injected render FPS "
            "sample (%.3f FPS).",
            static_cast<double>(fps_milli) / 1000.0);
        reshade::log::message(reshade::log::level::info, message);
    }
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
    if (!g_has_private_input_observer &&
        !retain_official_hook_owner(*data))
    {
        data->official_hook_failure_reported = true;
        publish_input_routing_failure(
            data->transport,
            EGO_STATUS_INITIALIZATION_FAILED);
    }
    publish_runtime_diagnostic(
        data->transport,
        EGO_RUNTIME_DIAGNOSTIC_SWAPCHAIN_READY);
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
    release_official_hook_owner(*data);
    remove_target_surface(*data);
    swapchain->destroy_private_data<swapchain_data>();
    release_transport(transport, window);
}

#if 0
// Retained temporarily as compile-time-disabled reference for the API-18
// frame-state adapter. Official hosts now use the message hook below instead:
// frame polling cannot preserve a complete down/up between presentations.
bool route_official_input_message(
    swapchain_data &data,
    std::uint32_t message,
    std::uint64_t wparam,
    std::int64_t lparam)
{
    const ego_status status = ego_transport_route_window_message(
        data.transport,
        reinterpret_cast<std::uintptr_t>(data.window),
        message,
        wparam,
        lparam);
    if (status == EGO_STATUS_OK)
        return true;

    if (!g_route_error_logged.test_and_set(std::memory_order_relaxed))
        log_transport_error("official ReShade input delivery", status);
    publish_input_routing_failure(data.transport, status);
    static_cast<void>(reset_input_router(data.transport));
    data.official_input = {};
    return false;
}

std::uint32_t official_mouse_key_state(
    const ImGuiIO &io,
    const std::array<bool, 5> &mouse_down)
{
    std::uint32_t state = 0;
    if (mouse_down[ImGuiMouseButton_Left])
        state |= MK_LBUTTON;
    if (mouse_down[ImGuiMouseButton_Right])
        state |= MK_RBUTTON;
    if (mouse_down[ImGuiMouseButton_Middle])
        state |= MK_MBUTTON;
    if (io.KeyCtrl)
        state |= MK_CONTROL;
    if (io.KeyShift)
        state |= MK_SHIFT;
    return state;
}

bool is_extended_virtual_key(std::uint32_t virtual_key)
{
    switch (virtual_key)
    {
    case VK_RCONTROL:
    case VK_RMENU:
    case VK_INSERT:
    case VK_DELETE:
    case VK_HOME:
    case VK_END:
    case VK_PRIOR:
    case VK_NEXT:
    case VK_LEFT:
    case VK_UP:
    case VK_RIGHT:
    case VK_DOWN:
    case VK_NUMLOCK:
    case VK_DIVIDE:
    case VK_SNAPSHOT:
    case VK_LWIN:
    case VK_RWIN:
    case VK_APPS:
        return true;
    default:
        return false;
    }
}

std::uint32_t official_keyboard_lparam(
    std::uint32_t virtual_key,
    bool down,
    bool repeated,
    bool system_key)
{
    const std::uint32_t scan_code =
        MapVirtualKeyW(virtual_key, MAPVK_VK_TO_VSC) & 0xFFU;
    std::uint32_t lparam = 1U | (scan_code << 16U);
    if (is_extended_virtual_key(virtual_key))
        lparam |= 1U << 24U;
    if (system_key)
        lparam |= 1U << 29U;
    if (repeated || !down)
        lparam |= 1U << 30U;
    if (!down)
        lparam |= 1U << 31U;
    return lparam;
}

void route_official_reshade_input(swapchain_data &data)
{
    if (g_has_private_input_observer || data.transport == nullptr)
        return;

    official_input_state &state = data.official_input;
    const HWND foreground = GetForegroundWindow();
    const HWND root = GetAncestor(data.window, GA_ROOT);
    const bool target_focused =
        foreground != nullptr &&
        (foreground == data.window || (root != nullptr && foreground == root));
    if (data.phase != input_phase::enabled || !target_focused)
    {
        state = {};
        return;
    }

    ImGuiIO &io = ImGui::GetIO();
    std::array<bool, 5> mouse_down = {};
    for (std::size_t index = 0; index < mouse_down.size(); ++index)
        mouse_down[index] = io.MouseDown[index];

    if (ImGui::IsMousePosValid(&io.MousePos))
    {
        const auto clamp_coordinate = [](float value) {
            return static_cast<std::int32_t>(std::clamp(
                std::lround(static_cast<double>(value)),
                static_cast<long>(std::numeric_limits<std::int16_t>::min()),
                static_cast<long>(std::numeric_limits<std::int16_t>::max())));
        };
        const std::int32_t mouse_x = clamp_coordinate(io.MousePos.x);
        const std::int32_t mouse_y = clamp_coordinate(io.MousePos.y);
        if (!state.has_mouse_position ||
            state.mouse_x != mouse_x ||
            state.mouse_y != mouse_y)
        {
            if (!route_official_input_message(
                    data,
                    WM_MOUSEMOVE,
                    official_mouse_key_state(io, mouse_down),
                    encode_client_point(mouse_x, mouse_y)))
            {
                return;
            }
        }
        state.mouse_x = mouse_x;
        state.mouse_y = mouse_y;
        state.has_mouse_position = true;
    }

    struct mouse_button_message
    {
        std::size_t index;
        std::uint32_t down;
        std::uint32_t up;
    };
    constexpr mouse_button_message mouse_button_messages[] = {
        { ImGuiMouseButton_Left, WM_LBUTTONDOWN, WM_LBUTTONUP },
        { ImGuiMouseButton_Right, WM_RBUTTONDOWN, WM_RBUTTONUP },
        { ImGuiMouseButton_Middle, WM_MBUTTONDOWN, WM_MBUTTONUP },
    };
    if (state.has_mouse_position)
    {
        const std::int64_t point =
            encode_client_point(state.mouse_x, state.mouse_y);
        for (const mouse_button_message &mapping : mouse_button_messages)
        {
            const bool clicked = ImGui::IsMouseClicked(
                static_cast<ImGuiMouseButton>(mapping.index),
                false);
            const bool released = ImGui::IsMouseReleased(
                static_cast<ImGuiMouseButton>(mapping.index));
            const bool changed =
                mouse_down[mapping.index] != state.mouse_down[mapping.index];

            if (clicked)
            {
                auto event_buttons = state.mouse_down;
                event_buttons[mapping.index] = true;
                if (!route_official_input_message(
                        data,
                        mapping.down,
                        official_mouse_key_state(io, event_buttons),
                        point))
                {
                    return;
                }
            }
            if (released)
            {
                auto event_buttons = state.mouse_down;
                event_buttons[mapping.index] = false;
                if (!route_official_input_message(
                        data,
                        mapping.up,
                        official_mouse_key_state(io, event_buttons),
                        point))
                {
                    return;
                }
            }
            if (!clicked && !released && changed)
            {
                if (!route_official_input_message(
                        data,
                        mouse_down[mapping.index] ? mapping.down : mapping.up,
                        official_mouse_key_state(io, mouse_down),
                        point))
                {
                    return;
                }
            }
        }

        POINT wheel_point = { state.mouse_x, state.mouse_y };
        const bool has_wheel_screen_point =
            ClientToScreen(data.window, &wheel_point) != FALSE;
        const auto route_wheel = [&](std::uint32_t message, double units) {
            if (units == 0.0)
                return true;
            if (!has_wheel_screen_point)
                return false;
            const long scaled = std::clamp(
                std::lround(units * WHEEL_DELTA),
                static_cast<long>(std::numeric_limits<std::int16_t>::min()),
                static_cast<long>(std::numeric_limits<std::int16_t>::max()));
            const std::uint32_t wparam =
                official_mouse_key_state(io, mouse_down) |
                (static_cast<std::uint32_t>(
                     static_cast<std::uint16_t>(scaled)) << 16U);
            return route_official_input_message(
                data,
                message,
                wparam,
                encode_client_point(
                    std::clamp(
                        wheel_point.x,
                        static_cast<LONG>(
                            std::numeric_limits<std::int16_t>::min()),
                        static_cast<LONG>(
                            std::numeric_limits<std::int16_t>::max())),
                    std::clamp(
                        wheel_point.y,
                        static_cast<LONG>(
                            std::numeric_limits<std::int16_t>::min()),
                        static_cast<LONG>(
                            std::numeric_limits<std::int16_t>::max()))));
        };
        if (!route_wheel(WM_MOUSEWHEEL, io.MouseWheel) ||
            !route_wheel(WM_MOUSEHWHEEL, -static_cast<double>(io.MouseWheelH)))
        {
            return;
        }
    }

    for (std::size_t index = 0; index < std::size(official_key_mappings); ++index)
    {
        const official_key_mapping &mapping = official_key_mappings[index];
        const bool down = ImGui::IsKeyDown(mapping.key);
        const bool changed = down != state.keys_down[index];
        const bool pressed = ImGui::IsKeyPressed(mapping.key, false);
        const bool released = ImGui::IsKeyReleased(mapping.key);
        const bool repeated =
            down &&
            !pressed &&
            !released &&
            ImGui::IsKeyPressed(mapping.key, true);
        if (!changed && !pressed && !released && !repeated)
            continue;

        const bool system_key =
            io.KeyAlt ||
            mapping.virtual_key == VK_LMENU ||
            mapping.virtual_key == VK_RMENU;
        const auto route_key = [&](bool event_down, bool event_repeated) {
            return route_official_input_message(
                data,
                event_down
                    ? (system_key ? WM_SYSKEYDOWN : WM_KEYDOWN)
                    : (system_key ? WM_SYSKEYUP : WM_KEYUP),
                mapping.virtual_key,
                official_keyboard_lparam(
                    mapping.virtual_key,
                    event_down,
                    event_repeated,
                    system_key));
        };
        if (pressed && !route_key(true, false))
        {
            return;
        }
        if (released && !route_key(false, false))
            return;
        if (!pressed && !released && changed && !route_key(down, false))
            return;
        if (repeated && !route_key(true, true))
            return;
        state.keys_down[index] = down;
    }

    const std::uint32_t character_message = io.KeyAlt ? WM_SYSCHAR : WM_CHAR;
    for (int index = 0; index < io.InputQueueCharacters.Size; ++index)
    {
        if (!route_official_input_message(
                data,
                character_message,
                io.InputQueueCharacters[index],
                1))
        {
            return;
        }
    }

    state.mouse_down = mouse_down;
}

#endif

void update_input_ownership(effect_runtime *runtime, swapchain_data &data)
{
    if (data.transport == nullptr)
        return;

    if (!g_has_private_input_observer)
    {
        official_hook_owner *const owner = get_official_hook_owner(data);
        if (owner == nullptr ||
            !owner->hook_ready.load(std::memory_order_acquire))
        {
            data.phase = input_phase::disabled;
            if (!data.official_hook_failure_reported)
            {
                data.official_hook_failure_reported = true;
                publish_input_routing_failure(
                    data.transport,
                    EGO_STATUS_INITIALIZATION_FAILED);
            }
            static_cast<void>(ego_transport_apply_input_filter(
                data.transport,
                0,
                0));
            return;
        }
        if (!claim_official_input_owner(data))
            return;
    }

    ego_status status = ego_transport_set_target_focused(
        data.transport,
        any_target_focused() ? 1U : 0U);
    if (status != EGO_STATUS_OK && status != data.last_focus_error)
    {
        data.last_focus_error = status;
        log_transport_error("focus publication", status);
        publish_input_routing_failure(data.transport, status);
    }
    else if (status == EGO_STATUS_OK)
    {
        data.last_focus_error = EGO_STATUS_OK;
    }

    std::uint32_t desired = 0;
    status = ego_transport_desired_interception(data.transport, &desired);
    if (status != EGO_STATUS_OK)
    {
        if (status != data.last_interception_error)
        {
            data.last_interception_error = status;
            log_transport_error("interception query", status);
            publish_input_routing_failure(data.transport, status);
        }
        desired = 0;
    }
    else
    {
        data.last_interception_error = EGO_STATUS_OK;
    }

    data.phase = next_phase(data.phase, desired != 0);
    if (!g_has_private_input_observer)
        publish_official_hook_phase(data, data.phase);
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
    if (status != EGO_STATUS_OK && status != data.last_filter_error)
    {
        data.last_filter_error = status;
        log_transport_error("input filter publication", status);
        publish_input_routing_failure(data.transport, status);
    }
    else if (status == EGO_STATUS_OK)
    {
        data.last_filter_error = EGO_STATUS_OK;
    }

    ImGuiIO &io = ImGui::GetIO();
    CURSORINFO cursor_info = { sizeof(CURSORINFO) };
    const bool native_cursor_visible =
        GetCursorInfo(&cursor_info) != FALSE &&
        (cursor_info.flags & CURSOR_SHOWING) != 0;
    io.MouseDrawCursor = routing_enabled && !native_cursor_visible;
}

bool transport_session_epoch(
    swapchain_data &data,
    std::uint64_t &epoch)
{
    if (data.transport == nullptr)
        return false;

    const ego_status status =
        ego_transport_session_epoch(data.transport, &epoch);
    if (status != EGO_STATUS_OK)
    {
        if (status != data.last_session_query_error)
        {
            data.last_session_query_error = status;
            log_transport_error("producer-session query", status);
            publish_input_routing_failure(data.transport, status);
        }
        return false;
    }

    data.last_session_query_error = EGO_STATUS_OK;
    return true;
}

bool producer_session_active(std::uint64_t epoch)
{
    return (epoch & EGO_SESSION_EPOCH_ACTIVE_BIT) != 0;
}

void deactivate_dormant_input(swapchain_data &data)
{
    data.phase = input_phase::disabled;
    if (!g_has_private_input_observer)
        publish_official_hook_phase(data, input_phase::disabled);

    discard_dormant_input();

    const ego_status status =
        ego_transport_apply_input_filter(data.transport, 0, 1);
    if (status != EGO_STATUS_OK && status != data.last_filter_error)
    {
        data.last_filter_error = status;
        log_transport_error("dormant input release", status);
        publish_input_routing_failure(data.transport, status);
    }
    else if (status == EGO_STATUS_OK)
    {
        data.last_filter_error = EGO_STATUS_OK;
    }

    ImGui::GetIO().MouseDrawCursor = false;
}

void log_official_pointer_sequence()
{
    if (g_has_private_input_observer ||
        (g_official_pointer_message_mask.load(std::memory_order_acquire) & 7U) !=
            7U ||
        g_official_pointer_sequence_logged.test_and_set(
            std::memory_order_relaxed))
    {
        return;
    }

    reshade::log::message(
        reshade::log::level::info,
        "Electron game overlay official-host message hook observed and "
        "withheld a primary pointer update/down/up sequence.");
}

void compose_electron_scene(effect_runtime *runtime, swapchain_data &swapchain_state)
{
    if (swapchain_state.transport == nullptr)
        return;

    ego_scene_snapshot *snapshot = nullptr;
    ego_status status = ego_transport_acquire_scene(swapchain_state.transport, &snapshot);
    if (status != EGO_STATUS_OK || snapshot == nullptr)
    {
        if (!swapchain_state.scene_query_failure_active ||
            status != swapchain_state.last_scene_query_error)
        {
            swapchain_state.scene_query_failure_active = true;
            swapchain_state.last_scene_query_error = status;
            log_transport_error("scene acquisition", status);
            publish_runtime_diagnostic(
                swapchain_state.transport,
                EGO_RUNTIME_DIAGNOSTIC_SCENE_QUERY_FAILED,
                status);
        }
        return;
    }

    std::uint64_t window_count = 0;
    status = ego_scene_snapshot_window_count(snapshot, &window_count);
    if (status != EGO_STATUS_OK)
    {
        ego_scene_snapshot_release(snapshot);
        if (!swapchain_state.scene_query_failure_active ||
            status != swapchain_state.last_scene_query_error)
        {
            swapchain_state.scene_query_failure_active = true;
            swapchain_state.last_scene_query_error = status;
            log_transport_error("scene enumeration", status);
            publish_runtime_diagnostic(
                swapchain_state.transport,
                EGO_RUNTIME_DIAGNOSTIC_SCENE_QUERY_FAILED,
                status);
        }
        return;
    }
    swapchain_state.scene_query_failure_active = false;
    swapchain_state.last_scene_query_error = EGO_STATUS_OK;

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
    bool frame_rejected = false;
    for (std::uint64_t index = 0; index < window_count; ++index)
    {
        ego_window_frame_v1 frame = {};
        frame.struct_size = sizeof(frame);
        frame.abi_version = EGO_ABI_VERSION;
        status = ego_scene_snapshot_get_window(snapshot, index, &frame);
        if (status != EGO_STATUS_OK || !valid_frame(frame))
        {
            frame_rejected = true;
            if (!swapchain_state.frame_rejection_reported)
            {
                swapchain_state.frame_rejection_reported = true;
                reshade::log::message(
                    reshade::log::level::warning,
                    "Electron game overlay runtime rejected an invalid transported frame.");
                publish_runtime_diagnostic(
                    swapchain_state.transport,
                    EGO_RUNTIME_DIAGNOSTIC_FRAME_REJECTED,
                    status);
            }
            continue;
        }

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
            if (!create_texture(
                    device,
                    frame,
                    texture,
                    swapchain_state.transport))
                continue;
        }
        else if ((texture.state_revision != frame.state_revision ||
                  texture.sequence != frame.sequence) &&
                 !update_texture(
                     runtime,
                     frame,
                     texture,
                     swapchain_state.transport))
        {
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
    if (!frame_rejected)
        swapchain_state.frame_rejection_reported = false;

    bool removed_texture = false;
    std::uint64_t removed_texture_count = 0;
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
        ++removed_texture_count;
    }
    swapchain_state.retired_session_textures += removed_texture_count;

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
        publish_runtime_diagnostic(
            swapchain_state.transport,
            EGO_RUNTIME_DIAGNOSTIC_SCENE_RENDERING_STARTED);
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

    publish_target_surface(runtime, *data);
    std::uint64_t session_epoch = 0;
    if (!transport_session_epoch(*data, session_epoch))
    {
        deactivate_dormant_input(*data);
        data->retired_session_textures +=
            retire_all_electron_textures(runtime);
        return;
    }

    const bool session_active =
        producer_session_active(session_epoch);
    const bool first_session_observation =
        !data->has_observed_session_epoch;
    const std::uint64_t previous_session_epoch =
        data->observed_session_epoch;
    const bool session_epoch_changed =
        !first_session_observation &&
        previous_session_epoch != session_epoch;

    if (first_session_observation)
    {
        data->has_observed_session_epoch = true;
        data->observed_session_epoch = session_epoch;
        if (session_active)
        {
            data->has_observed_authenticated_session = true;
            data->retired_session_textures = 0;
        }
    }
    else if (session_epoch_changed)
    {
        // An epoch can advance from one odd value to another when a complete
        // disconnect/reconnect cycle occurs between Presents. Invalidate the
        // old input generation and GPU resources before touching the new
        // session's scene, regardless of the epoch's current active bit.
        data->observed_session_epoch = session_epoch;
        deactivate_dormant_input(*data);
        data->retired_session_textures +=
            retire_all_electron_textures(runtime);

        if (!session_active &&
            data->has_observed_authenticated_session)
        {
            char message[256] = {};
            sprintf_s(
                message,
                "Electron game overlay runtime deactivated its producer session, "
                "released input, and retired %llu transported texture(s); the "
                "add-on remains loaded dormant.",
                static_cast<unsigned long long>(
                    data->retired_session_textures));
            reshade::log::message(reshade::log::level::info, message);
            data->retired_session_textures = 0;
        }
        else if (session_active)
        {
            if (data->has_observed_authenticated_session)
            {
                char message[320] = {};
                sprintf_s(
                    message,
                    "Electron game overlay runtime advanced its producer "
                    "session epoch from %llu to %llu, released old input, and "
                    "retired %llu transported texture(s) before composing the "
                    "replacement session.",
                    static_cast<unsigned long long>(
                        previous_session_epoch),
                    static_cast<unsigned long long>(session_epoch),
                    static_cast<unsigned long long>(
                        data->retired_session_textures));
                reshade::log::message(
                    reshade::log::level::info,
                    message);
            }
            data->has_observed_authenticated_session = true;
            data->retired_session_textures = 0;
        }
    }

    if (!session_active)
    {
        if (!session_epoch_changed)
        {
            deactivate_dormant_input(*data);
            data->retired_session_textures +=
                retire_all_electron_textures(runtime);
        }
        return;
    }

    publish_render_fps(*data);
    update_input_ownership(runtime, *data);
    drain_input_messages(data->transport);
    log_official_pointer_sequence();
    compose_electron_scene(runtime, *data);
}

bool register_compatible_addon(HMODULE module)
{
    reshade::internal::get_current_module_handle(module);
    g_addon_module = module;
    g_official_hooks_shutting_down.store(false, std::memory_order_release);
    HMODULE const host = reshade::internal::get_reshade_module_handle();
    if (host == nullptr)
    {
        g_addon_module = nullptr;
        return false;
    }
    const auto register_addon = reinterpret_cast<bool (*)(void *, std::uint32_t)>(
        GetProcAddress(host, "ReShadeRegisterAddon"));
    const auto unregister_addon = reinterpret_cast<void (*)(void *)>(
        GetProcAddress(host, "ReShadeUnregisterAddon"));
    if (register_addon == nullptr ||
        unregister_addon == nullptr ||
        !register_addon(module, public_reshade_api_version))
    {
        g_addon_module = nullptr;
        return false;
    }

    const auto get_imgui_table =
        reinterpret_cast<const imgui_function_table *(*)(std::uint32_t)>(
            GetProcAddress(host, "ReShadeGetImGuiFunctionTable"));
    if (get_imgui_table == nullptr ||
        !(imgui_function_table_instance() = get_imgui_table(IMGUI_VERSION_NUM)))
    {
        unregister_addon(module);
        g_addon_module = nullptr;
        return false;
    }

    const auto host_abi = reinterpret_cast<const unsigned int *>(
        GetProcAddress(host, "ElectronGameOverlayReShadeHostAbi"));
    const bool has_private_gate =
        GetProcAddress(host, "ElectronGameOverlayReShadeAddonGate") != nullptr;
    g_reshade_host_module = host;
    g_has_private_input_observer =
        host_abi != nullptr && *host_abi == 1 && has_private_gate;
    return true;
}

void unregister_compatible_addon(HMODULE module)
{
    if (g_reshade_host_module != nullptr)
    {
        const auto unregister_addon = reinterpret_cast<void (*)(void *)>(
            GetProcAddress(g_reshade_host_module, "ReShadeUnregisterAddon"));
        if (unregister_addon != nullptr)
            unregister_addon(module);
    }
    g_has_private_input_observer = false;
    g_reshade_host_module = nullptr;
    g_addon_module = nullptr;
    imgui_function_table_instance() = nullptr;
}
} // namespace

extern "C" __declspec(dllexport) const char *NAME = "Electron Game Overlay Runtime";
extern "C" __declspec(dllexport) const char *DESCRIPTION =
    "Backend-neutral Electron OSR scenes rendered through ReShade.";
extern "C" __declspec(dllexport) const unsigned int
    ElectronGameOverlayReShadeAddonAbi = 1;
#ifndef ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID
#error "ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID must be provided by the build."
#endif
extern "C" __declspec(dllexport) const char
    ElectronGameOverlayReShadeAddonBuildId[] =
        ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID;
static_assert(
    sizeof(ElectronGameOverlayReShadeAddonBuildId) == 33,
    "The Electron Game Overlay add-on build ID must be 32 ASCII characters.");

extern "C" __declspec(dllexport) void AddonUninit(HMODULE, HMODULE)
{
    shutdown_official_message_hooks(true);
}

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID reserved)
{
    switch (reason)
    {
    case DLL_PROCESS_ATTACH:
        if (!register_compatible_addon(module))
            return FALSE;

        reshade::register_event<reshade::addon_event::init_device>(on_init_device);
        reshade::register_event<reshade::addon_event::destroy_device>(on_destroy_device);
        reshade::register_event<reshade::addon_event::init_swapchain>(on_init_swapchain);
        reshade::register_event<reshade::addon_event::destroy_swapchain>(on_destroy_swapchain);
        reshade::register_event<reshade::addon_event::reshade_overlay>(on_reshade_overlay);
        if (g_has_private_input_observer)
            reshade::register_event<reshade::addon_event::input_message>(on_input_message);
        break;

    case DLL_PROCESS_DETACH:
        if (reserved == nullptr)
            shutdown_official_message_hooks(false);
        else
            g_official_hooks_shutting_down.store(
                true,
                std::memory_order_release);
        unregister_compatible_addon(module);
        break;
    }

    return TRUE;
}
