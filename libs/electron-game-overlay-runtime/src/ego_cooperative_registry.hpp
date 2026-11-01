#pragma once

// Shared coordination data only. Every participating add-on carries this
// implementation; no add-on supplies another add-on's renderer or transport.
// The mapping contains fixed-layout POD and same-process callback addresses.
// Participants must pin their modules until target exit and retire their own
// contexts only after removal from the registry and completion of dispatch.
#include <Windows.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <type_traits>
#include <vector>

namespace ego::cooperative
{
constexpr std::uint32_t abi_version = 1;
constexpr std::uint32_t max_participants = 512;
constexpr std::uint32_t max_windows = 8192;
constexpr std::uint32_t max_surfaces = 512;
constexpr std::uint32_t hit_body = 1;
constexpr std::uint32_t hit_caption = 2;
constexpr std::uint32_t window_transparent = 1;

#pragma pack(push, 8)
struct window_key
{
    std::uint64_t participant = 0;
    std::uint32_t window_id = 0;
    std::uint32_t reserved = 0;
    std::uint64_t incarnation = 0;
};

inline bool operator==(const window_key &a, const window_key &b) noexcept
{
    return a.participant == b.participant && a.window_id == b.window_id &&
        a.incarnation == b.incarnation;
}
inline bool operator!=(const window_key &a, const window_key &b) noexcept { return !(a == b); }

struct callbacks_v1
{
    std::uint32_t struct_size = sizeof(callbacks_v1);
    std::uint32_t version = abi_version;
    void (__cdecl *prepare_frame)(void *, void *) = nullptr;
    void (__cdecl *render_window)(void *, void *, std::uint32_t, std::uint64_t) = nullptr;
    std::uint32_t (__cdecl *hit_test)(void *, std::uint32_t, std::uint64_t, std::int32_t, std::int32_t) = nullptr;
    void (__cdecl *route_message)(void *, const void *, std::uint32_t) = nullptr;
    void (__cdecl *release_input)(void *) = nullptr;
    std::int32_t (__cdecl *cursor_at)(void *, std::uint32_t, std::uint64_t, std::int32_t, std::int32_t) = nullptr;
    void (__cdecl *destroy_surface)(void *, void *, std::uint32_t) = nullptr;
    void (__cdecl *flush_input)(void *, void *) = nullptr;
};

struct window_v1
{
    std::uint32_t struct_size = sizeof(window_v1);
    std::uint32_t flags = 0;
    std::uint32_t window_id = 0;
    std::int32_t cursor = 32512;
    std::uint64_t incarnation = 1;
    // Zero allocates a new order for a new window. Existing keys retain their
    // registry order; raise() is the explicit order-only mutation.
    std::uint64_t order = 0;
    std::int32_t x = 0;
    std::int32_t y = 0;
    std::int32_t width = 0;
    std::int32_t height = 0;
    std::uint64_t cookie = 0;
};

struct participant_entry
{
    std::uint64_t id = 0;
    void *context = nullptr;
    callbacks_v1 callbacks;
    std::uint32_t interception = 0;
    std::uint32_t reserved = 0;
};

struct window_entry
{
    window_key key;
    window_v1 window;
    void *context = nullptr;
    callbacks_v1 callbacks;
};

struct surface_entry
{
    std::uint64_t native_id = 0;
    std::uint64_t hwnd = 0;
};

namespace detail
{
struct window_slot
{
    window_key key;
    window_v1 window;
};
struct frame_slot
{
    std::uint64_t runtime = 0;
    std::uint64_t epoch = 0;
};
struct input_decision
{
    std::uint64_t sequence = 0;
    std::uint32_t projection = 0;
    std::uint32_t message = 0;
    window_key recipient;
};
struct source_decision
{
    std::uint64_t sequence = 0;
    window_key recipient;
};
struct rank_slot
{
    window_key key;
    std::uint64_t order = 0;
};
struct shared_state
{
    std::uint64_t magic = 0;
    std::uint32_t version = 0;
    std::uint32_t bytes = 0;
    std::uint32_t pointer_bits = 0;
    std::uint32_t reserved = 0;
    std::uint64_t next_participant = 0;
    std::uint64_t next_order = 0;
    std::uint64_t revision = 0;
    window_key focus;
    window_key capture;
    std::uint32_t capture_buttons = 0;
    std::uint32_t draining_buttons = 0;
    std::uint32_t dispatcher = 0;
    std::uint32_t surface_inventory_uncertain = 0;
    std::uint64_t latest_input_sequence = 0;
    std::uint64_t decision_count = 0;
    std::uint64_t source_count = 0;
    std::uint64_t primary_native_surface = 0;
    participant_entry participants[max_participants];
    window_slot windows[max_windows];
    frame_slot frames[64];
    input_decision decisions[8192];
    source_decision sources[8192];
    rank_slot ranks[max_windows];
    // Capture watermark is independent of arbitrated input. Observers publish
    // it before enqueue, allowing a private session to reject records captured
    // before its join/reset barrier even if no engine has arbitrated them yet.
    alignas(8) std::uint64_t latest_captured_sequence = 0;
    surface_entry surfaces[max_surfaces];
};
constexpr std::uint64_t magic = UINT64_C(0x3147455243504f45);
static_assert(std::is_trivially_copyable_v<shared_state>);
static_assert(std::is_standard_layout_v<shared_state>);
static_assert(sizeof(window_key) == 24);
static_assert(sizeof(window_v1) == 56);
static_assert(offsetof(window_key, participant) == 0 && offsetof(window_key, window_id) == 8 && offsetof(window_key, incarnation) == 16);
static_assert(offsetof(window_v1, window_id) == 8 && offsetof(window_v1, incarnation) == 16 &&
    offsetof(window_v1, order) == 24 && offsetof(window_v1, x) == 32 && offsetof(window_v1, cookie) == 48);
static_assert(sizeof(callbacks_v1) == (sizeof(void *) == 8 ? 72 : 40));
static_assert(offsetof(callbacks_v1, prepare_frame) == 8 &&
    offsetof(callbacks_v1, destroy_surface) == 8 + 6 * sizeof(void *) &&
    offsetof(callbacks_v1, flush_input) == 8 + 7 * sizeof(void *));
static_assert(sizeof(participant_entry) == (sizeof(void *) == 8 ? 96 : 64));
static_assert(offsetof(participant_entry, id) == 0 && offsetof(participant_entry, context) == 8 &&
    offsetof(participant_entry, callbacks) == 8 + sizeof(void *));
static_assert(sizeof(window_slot) == 80 && offsetof(window_slot, window) == 24);
static_assert(sizeof(frame_slot) == 16 && sizeof(input_decision) == 40 && sizeof(source_decision) == 32);
static_assert(sizeof(rank_slot) == 32 && offsetof(rank_slot, order) == 24);
static_assert(offsetof(shared_state, next_participant) == 24 && offsetof(shared_state, focus) == 48 &&
    offsetof(shared_state, capture) == 72 && offsetof(shared_state, dispatcher) == 104 &&
    offsetof(shared_state, surface_inventory_uncertain) == 108 &&
    offsetof(shared_state, latest_input_sequence) == 112 && offsetof(shared_state, primary_native_surface) == 136 &&
    offsetof(shared_state, participants) == 144);
static_assert(offsetof(shared_state, windows) == 144 + max_participants * sizeof(participant_entry));
static_assert(offsetof(shared_state, frames) == offsetof(shared_state, windows) + max_windows * sizeof(window_slot));
static_assert(offsetof(shared_state, decisions) == offsetof(shared_state, frames) + 64 * sizeof(frame_slot));
static_assert(offsetof(shared_state, sources) == offsetof(shared_state, decisions) + 8192 * sizeof(input_decision));
static_assert(offsetof(shared_state, ranks) == offsetof(shared_state, sources) + 8192 * sizeof(source_decision));
static_assert(offsetof(shared_state, latest_captured_sequence) == offsetof(shared_state, ranks) + max_windows * sizeof(rank_slot));
static_assert(offsetof(shared_state, latest_captured_sequence) % 8 == 0);
static_assert(sizeof(surface_entry) == 16 && offsetof(surface_entry, hwnd) == 8);
static_assert(offsetof(shared_state, surfaces) == offsetof(shared_state, latest_captured_sequence) + sizeof(std::uint64_t));
static_assert(sizeof(shared_state) == offsetof(shared_state, surfaces) + max_surfaces * sizeof(surface_entry));

class lock
{
public:
    explicit lock(HANDLE mutex) noexcept : mutex_(mutex)
    {
        if (mutex_ != nullptr)
        {
            const DWORD status = WaitForSingleObject(mutex_, 1000);
            acquired_ = status == WAIT_OBJECT_0 || status == WAIT_ABANDONED;
            // An abandoned writer may have left a partial publication. Never
            // silently reset potentially live participants or reuse handles.
            valid_ = status == WAIT_OBJECT_0;
        }
    }
    ~lock() { if (acquired_) ReleaseMutex(mutex_); }
    explicit operator bool() const noexcept { return valid_; }
private:
    HANDLE mutex_ = nullptr;
    bool acquired_ = false;
    bool valid_ = false;
};
}
#pragma pack(pop)

class registry
{
public:
    // Admission is invisible to callbacks until publish(). Reserve without
    // holding the registry mutex across module pinning/loader-lock operations.
    // Only unpublished storage may be released. Once a caller has pinned its
    // module, even a failed publication retains its bounded lifetime slot.
    class participant_reservation
    {
    public:
        participant_reservation() noexcept = default;
        participant_reservation(const participant_reservation &) = delete;
        participant_reservation &operator=(const participant_reservation &) = delete;
        ~participant_reservation()
        {
            if (owner_ != nullptr && !irreversible_)
                owner_->cancel_participant_reservation(slot_);
        }
        explicit operator bool() const noexcept { return owner_ != nullptr; }
        void retain_if_unpublished() noexcept { irreversible_ = true; }
        std::uint64_t publish(const callbacks_v1 &callbacks, void *context)
        {
            if (owner_ == nullptr) return 0;
            const auto id = owner_->publish_participant_reservation(slot_, id_, callbacks, context);
            if (id != 0) owner_ = nullptr;
            return id;
        }
    private:
        friend class registry;
        participant_reservation(registry *owner, std::uint32_t slot, std::uint64_t id) noexcept :
            owner_(owner), slot_(slot), id_(id) {}
        registry *owner_ = nullptr;
        std::uint32_t slot_ = 0;
        std::uint64_t id_ = 0;
        bool irreversible_ = false;
    };

    registry() = default;
    registry(const registry &) = delete;
    registry &operator=(const registry &) = delete;
    ~registry() { close(); }

    bool open() noexcept
    {
        if (state_ != nullptr) return available();
        if (mutex_ != nullptr || mapping_ != nullptr) close();
        FILETIME created{}, exited{}, kernel{}, user{};
        if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return false;
        const std::uint64_t instance = (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
        if (instance == 0) return false;
        wchar_t name[160]{};
        swprintf_s(name, L"Local\\ElectronGameOverlay-Cooperative-v1-%lu-%016llx-%u",
            GetCurrentProcessId(), static_cast<unsigned long long>(instance), static_cast<unsigned>(sizeof(void *) * 8));
        wchar_t mutex_name[176]{};
        swprintf_s(mutex_name, L"%s-lock", name);
        mutex_ = CreateMutexW(nullptr, FALSE, mutex_name);
        if (mutex_ == nullptr) return false;
        detail::lock guard(mutex_);
        if (!guard) { close_after_lock_ = true; return false; }
        mapping_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
            0, static_cast<DWORD>(sizeof(detail::shared_state)), name);
        if (mapping_ == nullptr) { close_after_lock_ = true; return false; }
        const bool fresh = GetLastError() != ERROR_ALREADY_EXISTS;
        state_ = static_cast<detail::shared_state *>(MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS,
            0, 0, sizeof(detail::shared_state)));
        if (state_ == nullptr) { close_after_lock_ = true; return false; }
        if (fresh)
        {
            std::memset(state_, 0, sizeof(*state_));
            state_->version = abi_version;
            state_->bytes = sizeof(*state_);
            state_->pointer_bits = sizeof(void *) * 8;
            state_->magic = detail::magic;
        }
        if (state_->magic != detail::magic || state_->version != abi_version ||
            state_->bytes != sizeof(*state_) || state_->pointer_bits != sizeof(void *) * 8)
        {
            close_after_lock_ = true;
            return false;
        }
        return true;
    }

    bool available() const noexcept { return state_ != nullptr && !close_after_lock_; }

    void observe_source_sequence(std::uint64_t sequence) noexcept
    {
        if (!available() || sequence == 0) return;
        auto *watermark = reinterpret_cast<volatile LONG64 *>(&state_->latest_captured_sequence);
        LONG64 observed = InterlockedCompareExchange64(watermark, 0, 0);
        while (static_cast<std::uint64_t>(observed) < sequence)
        {
            const LONG64 previous = InterlockedCompareExchange64(watermark,
                static_cast<LONG64>(sequence), observed);
            if (previous == observed) return;
            observed = previous;
        }
    }

    std::uint64_t latest_source_sequence() noexcept
    {
        if (!available()) return 0;
        return static_cast<std::uint64_t>(InterlockedCompareExchange64(
            reinterpret_cast<volatile LONG64 *>(&state_->latest_captured_sequence), 0, 0));
    }

    // Inventory belongs to the process-wide event trampoline, not a private
    // engine's lazily observed runtime states. Late engines may not have seen
    // an existing secondary surface, but must retain their authenticated
    // transport while any actual target surface remains alive.
    bool observe_surface(std::uint64_t native_id, std::uint64_t hwnd)
    {
        if (!available() || native_id == 0) return false;
        detail::lock guard(mutex_);
        if (!guard)
        {
            InterlockedExchange(reinterpret_cast<volatile LONG *>(&state_->surface_inventory_uncertain), 1);
            return false;
        }
        surface_entry *empty = nullptr;
        for (auto &surface : state_->surfaces)
        {
            if (surface.native_id == native_id) { surface.hwnd = hwnd; return true; }
            if (surface.native_id == 0 && empty == nullptr) empty = &surface;
        }
        if (empty == nullptr)
        {
            InterlockedExchange(reinterpret_cast<volatile LONG *>(&state_->surface_inventory_uncertain), 1);
            return false;
        }
        *empty = {native_id, hwnd};
        return true;
    }

    bool remove_surface(std::uint64_t native_id)
    {
        if (!available() || native_id == 0) return false;
        detail::lock guard(mutex_);
        if (!guard) return false;
        for (auto &surface : state_->surfaces)
            if (surface.native_id == native_id) { surface = {}; return true; }
        return false;
    }

    bool has_live_surfaces()
    {
        // Unknown inventory is never proof of final surface destruction. Once
        // an initialization could not be tracked, keep the private transport
        // alive until authoritative target exit rather than infer an empty set.
        if (!available()) return true;
        detail::lock guard(mutex_);
        if (!guard) return true;
        for (const auto &surface : state_->surfaces) if (surface.native_id != 0) return true;
        return InterlockedCompareExchange(reinterpret_cast<volatile LONG *>(&state_->surface_inventory_uncertain), 0, 0) != 0;
    }

    std::vector<surface_entry> snapshot_surfaces()
    {
        std::vector<surface_entry> result;
        if (!available()) return result;
        detail::lock guard(mutex_);
        if (!guard) return result;
        for (const auto &surface : state_->surfaces) if (surface.native_id != 0) result.push_back(surface);
        return result;
    }

    // The dispatcher is only the original ReShade callback trampoline. It
    // broadcasts raw events and invokes each participant's own implementation;
    // it never supplies another participant's renderer, input normalizer or IPC.
    bool claim_dispatcher()
    {
        if (!available()) return false;
        detail::lock guard(mutex_);
        if (!guard || state_->dispatcher != 0) return false;
        state_->dispatcher = 1;
        return true;
    }
    bool dispatcher_available()
    {
        if (!available()) return false;
        detail::lock guard(mutex_);
        return guard && state_->dispatcher != 0;
    }
    void abandon_dispatcher_claim()
    {
        if (!available()) return;
        detail::lock guard(mutex_);
        if (guard) state_->dispatcher = 0;
    }

    bool claim_primary_surface(std::uint64_t native_surface)
    {
        if (!available() || native_surface == 0) return false;
        detail::lock guard(mutex_);
        if (!guard) return false;
        if (state_->primary_native_surface == 0) state_->primary_native_surface = native_surface;
        return state_->primary_native_surface == native_surface;
    }
    surface_entry primary_surface()
    {
        // Rendering peers may follow the selected HWND, but this query never
        // elects one. Unknown inventory cannot authorize another presenter.
        if (!available()) return {};
        detail::lock guard(mutex_);
        if (!guard || state_->primary_native_surface == 0 ||
            InterlockedCompareExchange(reinterpret_cast<volatile LONG *>(&state_->surface_inventory_uncertain), 0, 0) != 0)
            return {};
        for (const auto &surface : state_->surfaces)
            if (surface.native_id == state_->primary_native_surface && surface.hwnd != 0)
                return surface;
        return {};
    }
    void release_primary_surface(std::uint64_t native_surface,
        std::uint64_t surviving_driver = 0, std::uint64_t retired_hwnd = 0)
    {
        if (!available() || native_surface == 0) return;
        detail::lock guard(mutex_);
        if (!guard || state_->primary_native_surface != native_surface) return;
        state_->primary_native_surface = 0;
        bool preserve_capture = false;
        if (surviving_driver != 0 && surviving_driver != native_surface && retired_hwnd != 0 &&
            InterlockedCompareExchange(reinterpret_cast<volatile LONG *>(&state_->surface_inventory_uncertain), 0, 0) == 0)
            for (const auto &surface : state_->surfaces)
                if (surface.native_id == surviving_driver && surface.hwnd == retired_hwnd)
                { preserve_capture = true; break; }
        if (!preserve_capture)
        {
            state_->draining_buttons |= state_->capture_buttons;
            state_->capture = {};
            state_->capture_buttons = 0;
        }
        ++state_->revision;
    }
    void retire_input_driver_capture()
    {
        if (!available()) return;
        detail::lock guard(mutex_);
        if (!guard) return;
        state_->draining_buttons |= state_->capture_buttons;
        state_->capture = {};
        state_->capture_buttons = 0;
        ++state_->revision;
    }

    std::uint64_t join(const callbacks_v1 &callbacks, void *context)
    {
        if (!available() || callbacks.version != abi_version || callbacks.struct_size != sizeof(callbacks_v1)) return 0;
        detail::lock guard(mutex_);
        if (!guard) return 0;
        for (auto &participant : state_->participants)
        {
            // Published callback/context storage is immutable and never reused:
            // a lock-free observer may already have acquired a departing ID.
            if (participant.id != 0 || participant.reserved != 0) continue;
            if (state_->next_participant == (std::numeric_limits<std::uint64_t>::max)()) return 0;
            participant = {};
            participant.context = context;
            participant.callbacks = callbacks;
            participant.reserved = 1;
            const auto id = ++state_->next_participant;
            InterlockedExchange64(reinterpret_cast<volatile LONG64 *>(&participant.id), static_cast<LONG64>(id));
            ++state_->revision;
            return id;
        }
        return 0;
    }

    participant_reservation reserve_participant()
    {
        if (!available()) return {};
        detail::lock guard(mutex_);
        if (!guard || state_->next_participant == (std::numeric_limits<std::uint64_t>::max)()) return {};
        for (std::uint32_t slot = 0; slot < max_participants; ++slot)
        {
            auto &participant = state_->participants[slot];
            if (participant.id != 0 || participant.reserved != 0) continue;
            // Keep id untouched while lock-free observers load it. This slot
            // has never published a nonzero ID, so no observer owns its data.
            participant.context = nullptr;
            participant.callbacks = {};
            participant.interception = 0;
            participant.reserved = 1;
            return participant_reservation(this, slot, ++state_->next_participant);
        }
        return {};
    }

    bool leave(std::uint64_t id)
    {
        participant_entry removed;
        {
            if (!available()) return false;
            detail::lock guard(mutex_);
            if (!guard) return false;
            auto *participant = find_participant(id);
            if (participant == nullptr) return false;
            removed = *participant;
            InterlockedExchange64(reinterpret_cast<volatile LONG64 *>(&participant->id), 0);
            participant->interception = 0;
            for (auto &window : state_->windows) if (window.key.participant == id) window = {};
            for (auto &rank : state_->ranks) if (rank.key.participant == id) rank = {};
            clear_owned_input(id);
            ++state_->revision;
        }
        if (removed.callbacks.release_input != nullptr) removed.callbacks.release_input(removed.context);
        return true;
    }

    bool set_interception(std::uint64_t id, bool requested)
    {
        if (!available()) return false;
        detail::lock guard(mutex_);
        if (!guard) return false;
        auto *participant = find_participant(id);
        if (participant == nullptr) return false;
        participant->interception = requested ? 1U : 0U;
        bool any_requested = false;
        for (const auto &peer : state_->participants)
            if (peer.id != 0 && peer.interception != 0) { any_requested = true; break; }
        if (!any_requested && state_->capture_buttons != 0)
        {
            state_->draining_buttons |= state_->capture_buttons;
            state_->capture = {};
            state_->capture_buttons = 0;
            ++state_->revision;
        }
        return true;
    }

    bool interception_requested()
    {
        if (!available()) return false;
        detail::lock guard(mutex_);
        if (!guard) return false;
        for (const auto &participant : state_->participants)
            if (participant.id != 0 && participant.interception != 0) return true;
        return false;
    }

    // The owner supplies the authoritative registration set from the same
    // immutable producer snapshot used for frame publication. Registered but
    // temporarily unframed windows retain their rank; truly closed/recreated
    // registrations release only their own historical slots. Empty means an
    // authoritative empty registration set, not a missing/failed query.
    bool reconcile_registrations(std::uint64_t id, const window_key *keys, std::size_t count)
    {
        if (!available() || count > max_windows || (count != 0 && keys == nullptr)) return false;
        for (std::size_t index = 0; index < count; ++index)
        {
            if ((keys[index].participant != 0 && keys[index].participant != id) ||
                keys[index].window_id == 0 || keys[index].incarnation == 0) return false;
            for (std::size_t previous = 0; previous < index; ++previous)
                if (keys[previous].window_id == keys[index].window_id) return false;
        }
        detail::lock guard(mutex_);
        if (!guard || find_participant(id) == nullptr) return false;
        std::size_t other_count = 0;
        for (const auto &rank : state_->ranks)
            if (rank.key.participant != 0 && rank.key.participant != id) ++other_count;
        if (other_count + count > max_windows ||
            state_->next_order > (std::numeric_limits<std::uint64_t>::max)() - count) return false;
        std::vector<detail::rank_slot> next;
        next.reserve(count);
        for (std::size_t index = 0; index < count; ++index)
        {
            const window_key key{id, keys[index].window_id, 0, keys[index].incarnation};
            const auto *existing = find_rank_identity(id, key.window_id);
            // Reserve placement at metadata registration, before first paint.
            // A slow first raster must not raise an older window over a newer
            // participant whose pixels happened to arrive sooner.
            const auto order = existing != nullptr && existing->key == key ? existing->order : ++state_->next_order;
            next.push_back({key, order});
        }
        for (auto &rank : state_->ranks) if (rank.key.participant == id) rank = {};
        auto next_entry = next.begin();
        for (auto &rank : state_->ranks)
            if (rank.key.participant == 0 && next_entry != next.end()) rank = *next_entry++;
        if (state_->focus.participant == id && !registered_window(state_->focus)) state_->focus = {};
        if (state_->capture.participant == id && !registered_window(state_->capture))
        { state_->draining_buttons |= state_->capture_buttons; state_->capture = {}; state_->capture_buttons = 0; }
        ++state_->revision;
        return true;
    }

    // Explicit producer order changes permute only this participant's occupied
    // ranks, including registrations without pixels. Frame refreshes must not
    // call this: a stale producer array must not undo a native click-to-front
    // while the owner's asynchronous scene update is still being processed.
    bool reorder_registrations(std::uint64_t id, const window_key *keys, std::size_t count)
    {
        if (!available() || count > max_windows || (count != 0 && keys == nullptr)) return false;
        for (std::size_t index = 0; index < count; ++index)
        {
            if ((keys[index].participant != 0 && keys[index].participant != id) ||
                keys[index].window_id == 0 || keys[index].incarnation == 0) return false;
            for (std::size_t previous = 0; previous < index; ++previous)
                if (keys[previous].window_id == keys[index].window_id) return false;
        }
        detail::lock guard(mutex_);
        if (!guard || find_participant(id) == nullptr) return false;
        std::size_t registered_count = 0;
        for (const auto &rank : state_->ranks) if (rank.key.participant == id) ++registered_count;
        if (registered_count != count) return false;
        std::vector<std::uint64_t> ranks;
        ranks.reserve(count);
        for (std::size_t index = 0; index < count; ++index)
        {
            const window_key key{id, keys[index].window_id, 0, keys[index].incarnation};
            const auto *rank = find_rank_identity(id, key.window_id);
            if (rank == nullptr || rank->key != key || rank->order == 0) return false;
            ranks.push_back(rank->order);
        }
        std::sort(ranks.begin(), ranks.end());
        for (std::size_t index = 0; index < count; ++index)
        {
            const window_key key{id, keys[index].window_id, 0, keys[index].incarnation};
            find_rank_identity(id, key.window_id)->order = ranks[index];
            auto *window = find_window(key);
            if (window != nullptr) window->window.order = ranks[index];
        }
        ++state_->revision;
        return true;
    }

    bool publish_windows(std::uint64_t id, const window_v1 *windows, std::size_t count, bool preserve_order = false)
    {
        if (!available() || count > max_windows || (count != 0 && windows == nullptr)) return false;
        for (std::size_t index = 0; index < count; ++index)
        {
            const auto &window = windows[index];
            if (window.struct_size != sizeof(window_v1) || window.window_id == 0 ||
                window.incarnation == 0 || window.width <= 0 || window.height <= 0) return false;
            for (std::size_t previous = 0; previous < index; ++previous)
                if (windows[previous].window_id == window.window_id) return false;
        }
        detail::lock guard(mutex_);
        if (!guard || find_participant(id) == nullptr) return false;
        std::size_t other_count = 0;
        for (const auto &slot : state_->windows)
            if (slot.key.participant != 0 && slot.key.participant != id) ++other_count;
        if (other_count + count > max_windows || state_->next_order > (std::numeric_limits<std::uint64_t>::max)() - count) return false;
        std::size_t free_history = 0;
        for (const auto &rank : state_->ranks) if (rank.key.participant == 0) ++free_history;
        std::size_t required_history = 0;
        for (std::size_t index = 0; index < count; ++index)
            if (find_rank_identity(id, windows[index].window_id) == nullptr) ++required_history;
        // Never evict an absent registration's rank: omission may only mean a
        // temporary raster gap, not closure. Refuse admission before mutation
        // if preserving every admitted identity would exceed the bound.
        if (required_history > free_history) return false;
        std::vector<detail::window_slot> next;
        std::vector<std::uint64_t> ranks;
        next.reserve(count);
        ranks.reserve(count);
        for (std::size_t index = 0; index < count; ++index)
        {
            detail::window_slot slot;
            slot.key = {id, windows[index].window_id, 0, windows[index].incarnation};
            slot.window = windows[index];
            const auto *existing = find_window(slot.key);
            const auto *remembered = find_rank_identity(id, slot.key.window_id);
            slot.window.order = existing != nullptr ? existing->window.order :
                remembered != nullptr && remembered->key == slot.key && remembered->order != 0 ? remembered->order : ++state_->next_order;
            ranks.push_back(slot.window.order);
            next.push_back(slot);
        }
        // Reordering one participant only permutes its occupied global ranks.
        // Foreign windows keep their ranks, allowing A1/B1/A2 interleaving.
        // New ranks are allocated at the top, then assigned in producer order.
        if (!preserve_order)
        {
            std::sort(ranks.begin(), ranks.end());
            for (std::size_t index = 0; index < next.size(); ++index) next[index].window.order = ranks[index];
        }
        for (const auto &slot : next) remember_rank(slot.key, slot.window.order);
        for (auto &slot : state_->windows) if (slot.key.participant == id) slot = {};
        auto next_entry = next.begin();
        for (auto &slot : state_->windows)
            if (slot.key.participant == 0 && next_entry != next.end()) slot = *next_entry++;
        if (state_->focus.participant == id && !registered_window(state_->focus)) state_->focus = {};
        if (state_->capture.participant == id && find_window(state_->capture) == nullptr)
        { state_->draining_buttons |= state_->capture_buttons; state_->capture = {}; state_->capture_buttons = 0; }
        ++state_->revision;
        return true;
    }

    std::vector<participant_entry> snapshot_participants()
    {
        std::vector<participant_entry> result;
        if (!available()) return result;
        detail::lock guard(mutex_);
        if (!guard) return result;
        for (const auto &participant : state_->participants) if (participant.id != 0) result.push_back(participant);
        return result;
    }

    // Called inside ReShade's input/window locks. No allocation, mutex, IPC,
    // logging or lifetime retirement is permitted here. A callback only copies
    // the immutable payload into that participant's bounded lock-free queue.
    // An in-flight callback after leave is harmless: module/context storage is
    // pinned until process exit and the participant's session epoch rejects it.
    void broadcast_message(const void *message, std::uint32_t bytes) noexcept
    {
        if (!available() || message == nullptr || bytes == 0) return;
        for (auto &participant : state_->participants)
        {
            const auto id = InterlockedCompareExchange64(
                reinterpret_cast<volatile LONG64 *>(&participant.id), 0, 0);
            if (id == 0) continue;
            const auto callback = participant.callbacks.route_message;
            if (callback != nullptr) callback(participant.context, message, bytes);
        }
    }

    std::vector<window_entry> snapshot_windows()
    {
        std::vector<window_entry> result;
        if (!available()) return result;
        {
            detail::lock guard(mutex_);
            if (!guard) return result;
            for (const auto &slot : state_->windows)
            {
                if (slot.key.participant == 0) continue;
                const auto *participant = find_participant(slot.key.participant);
                if (participant == nullptr) continue;
                result.push_back({slot.key, slot.window, participant->context, participant->callbacks});
            }
        }
        std::sort(result.begin(), result.end(), [](const window_entry &a, const window_entry &b) {
            return a.window.order < b.window.order;
        });
        return result;
    }

    bool raise(window_key key)
    {
        if (!available()) return false;
        detail::lock guard(mutex_);
        if (!guard) return false;
        auto *window = find_window(key);
        if (window == nullptr || state_->next_order == (std::numeric_limits<std::uint64_t>::max)()) return false;
        window->window.order = ++state_->next_order;
        remember_rank(key, window->window.order);
        ++state_->revision;
        return true;
    }

    bool set_focus(window_key key)
    {
        if (!available()) return false;
        detail::lock guard(mutex_);
        if (!guard || (key.participant != 0 && !registered_window(key))) return false;
        if (state_->focus != key) { state_->focus = key; ++state_->revision; }
        return true;
    }

    bool set_capture(window_key key, std::uint32_t buttons)
    {
        if (!available()) return false;
        detail::lock guard(mutex_);
        if (!guard || (buttons != 0 && find_window(key) == nullptr)) return false;
        const auto next_capture = buttons == 0 ? window_key{} : key;
        if (state_->capture != next_capture || state_->capture_buttons != buttons)
        { state_->capture = next_capture; state_->capture_buttons = buttons; ++state_->revision; }
        return true;
    }
    bool clear_capture() { return set_capture({}, 0); }
    window_key focus() { return read_input(false); }
    window_key capture() { return read_input(true); }
    bool cancel_owned_input(std::uint64_t participant, bool preserve_logical_focus = false)
    {
        if (!available()) return false;
        detail::lock guard(mutex_);
        if (!guard || find_participant(participant) == nullptr) return false;
        const bool owned = state_->focus.participant == participant || state_->capture.participant == participant;
        const auto retained_focus = preserve_logical_focus && state_->focus.participant == participant &&
            registered_window(state_->focus) ? state_->focus : window_key{};
        clear_owned_input(participant);
        if (retained_focus.participant != 0) state_->focus = retained_focus;
        if (owned) ++state_->revision;
        return true;
    }

    window_key hit_test(std::int32_t x, std::int32_t y)
    {
        const auto captured = capture();
        if (captured.participant != 0) return captured;
        const auto windows = snapshot_windows();
        for (auto iterator = windows.rbegin(); iterator != windows.rend(); ++iterator)
        {
            const auto &entry = *iterator;
            const auto &window = entry.window;
            if (static_cast<std::int64_t>(x) < window.x || static_cast<std::int64_t>(y) < window.y ||
                static_cast<std::int64_t>(x) >= static_cast<std::int64_t>(window.x) + window.width ||
                static_cast<std::int64_t>(y) >= static_cast<std::int64_t>(window.y) + window.height) continue;
            if (entry.callbacks.hit_test != nullptr)
            {
                if (entry.callbacks.hit_test(entry.context, entry.key.window_id, entry.key.incarnation, x, y) != 0) return entry.key;
            }
            else if ((window.flags & window_transparent) == 0) return entry.key;
        }
        return {};
    }

    std::int32_t cursor_at(std::int32_t x, std::int32_t y)
    {
        const auto key = hit_test(x, y);
        if (key.participant == 0) return -1;
        const auto windows = snapshot_windows();
        const auto found = std::find_if(windows.begin(), windows.end(), [&key](const window_entry &entry) { return entry.key == key; });
        if (found == windows.end()) return -1;
        if (found->callbacks.cursor_at != nullptr)
            return found->callbacks.cursor_at(found->context, key.window_id, key.incarnation, x, y);
        return found->window.cursor;
    }

    // Every engine normalizes the same copied source record independently.
    // Cached decisions make those passes observe one focus/capture transition,
    // including mouse-up after the first pass has already released capture.
    // A stale record whose decision aged out is dropped, never reinterpreted
    // against a newer scene. No foreign engine handles another engine's input.
    window_key decide_input(std::uint64_t source_sequence,
        std::uint32_t projection_index, std::uint32_t message,
        std::int32_t x, std::int32_t y, std::uint64_t wparam = 0)
    {
        if (!available() || source_sequence == 0) return {};
        for (unsigned retry = 0; retry != 4; ++retry)
        {
            std::uint64_t revision = 0;
            {
                detail::lock guard(mutex_);
                if (!guard) return {};
                window_key cached;
                if (find_decision(source_sequence, projection_index, message, cached)) return cached;
                if (source_sequence < state_->latest_input_sequence)
                    return find_source(source_sequence, cached) ? cached : window_key{};
                revision = state_->revision;
            }
            const auto pointer_target = hit_test(x, y);
            detail::lock guard(mutex_);
            if (!guard) return {};
            window_key cached;
            if (find_decision(source_sequence, projection_index, message, cached)) return cached;
            const bool known_source = find_source(source_sequence, cached);
            if (source_sequence < state_->latest_input_sequence) return known_source ? cached : window_key{};
            if (revision != state_->revision) continue;
            window_key recipient;
            const std::uint32_t down = down_button(message, wparam);
            const std::uint32_t up = up_button(message, wparam);
            const bool pointer = message == WM_MOUSEMOVE || message == WM_MOUSEWHEEL ||
                message == WM_MOUSEHWHEEL || down != 0 || up != 0;
            if (message == WM_CANCELMODE || message == WM_CAPTURECHANGED)
            {
                recipient = known_source ? cached : state_->capture;
                state_->draining_buttons |= state_->capture_buttons;
                state_->capture = {};
                state_->capture_buttons = 0;
            }
            else if (pointer)
            {
                if (down != 0) state_->draining_buttons &= ~down;
                if (up != 0 && (state_->draining_buttons & up) != 0)
                    state_->draining_buttons &= ~up;
                else if (state_->draining_buttons == 0)
                {
                    recipient = known_source ? cached : (state_->capture.participant != 0 ? state_->capture : pointer_target);
                    if (down != 0 && recipient.participant != 0)
                    {
                        state_->focus = recipient;
                        state_->capture = recipient;
                        state_->capture_buttons |= down;
                        auto *window = find_window(recipient);
                        if (window != nullptr && state_->next_order != (std::numeric_limits<std::uint64_t>::max)())
                        { window->window.order = ++state_->next_order; remember_rank(recipient, window->window.order); ++state_->revision; }
                    }
                    if (up != 0)
                    {
                        state_->capture_buttons &= ~up;
                        if (state_->capture_buttons == 0) state_->capture = {};
                    }
                }
            }
            else
            {
                recipient = known_source ? cached : state_->focus;
                if (find_window(recipient) == nullptr) recipient = {};
            }
            if (!known_source)
                state_->sources[state_->source_count++ % 8192] = {source_sequence, recipient};
            state_->latest_input_sequence = source_sequence;
            auto &decision = state_->decisions[state_->decision_count++ % 8192];
            decision = {source_sequence, projection_index, message, recipient};
            ++state_->revision;
            return recipient;
        }
        return {};
    }

    bool claim_frame(void *runtime, std::uint64_t epoch)
    {
        if (!available() || runtime == nullptr) return false;
        detail::lock guard(mutex_);
        if (!guard) return false;
        const auto identity = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(runtime));
        detail::frame_slot *empty = nullptr;
        for (auto &frame : state_->frames)
        {
            if (frame.runtime == identity)
            {
                if (frame.epoch == epoch) return false;
                frame.epoch = epoch;
                return true;
            }
            if (frame.runtime == 0 && empty == nullptr) empty = &frame;
        }
        if (empty == nullptr) return false;
        *empty = {identity, epoch};
        return true;
    }

    void retire_runtime(void *runtime)
    {
        if (!available()) return;
        detail::lock guard(mutex_);
        if (!guard) return;
        const auto identity = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(runtime));
        for (auto &frame : state_->frames) if (frame.runtime == identity) frame = {};
    }

private:
    void cancel_participant_reservation(std::uint32_t slot) noexcept
    {
        if (!available() || slot >= max_participants) return;
        detail::lock guard(mutex_);
        if (!guard) return;
        auto &participant = state_->participants[slot];
        // The owning noncopyable reservation alone may cancel this slot.
        // Published callback/context storage is never cleared or reused.
        if (participant.id == 0)
        {
            participant.context = nullptr;
            participant.callbacks = {};
            participant.interception = 0;
            participant.reserved = 0;
        }
    }

    std::uint64_t publish_participant_reservation(std::uint32_t slot, std::uint64_t id,
        const callbacks_v1 &callbacks, void *context)
    {
        if (!available() || slot >= max_participants || id == 0 ||
            callbacks.version != abi_version || callbacks.struct_size != sizeof(callbacks_v1)) return 0;
        detail::lock guard(mutex_);
        if (!guard) return 0;
        auto &participant = state_->participants[slot];
        if (participant.id != 0 || participant.reserved == 0) return 0;
        participant.context = context;
        participant.callbacks = callbacks;
        InterlockedExchange64(reinterpret_cast<volatile LONG64 *>(&participant.id), static_cast<LONG64>(id));
        ++state_->revision;
        return id;
    }

    void close() noexcept
    {
        if (state_ != nullptr) UnmapViewOfFile(state_);
        if (mapping_ != nullptr) CloseHandle(mapping_);
        if (mutex_ != nullptr) CloseHandle(mutex_);
        state_ = nullptr;
        mapping_ = mutex_ = nullptr;
        close_after_lock_ = false;
    }
    participant_entry *find_participant(std::uint64_t id) noexcept
    {
        if (id == 0) return nullptr;
        for (auto &participant : state_->participants) if (participant.id == id) return &participant;
        return nullptr;
    }
    detail::window_slot *find_window(window_key key) noexcept
    {
        if (key.participant == 0) return nullptr;
        for (auto &window : state_->windows) if (window.key == key) return &window;
        return nullptr;
    }
    detail::rank_slot *find_rank_identity(std::uint64_t participant, std::uint32_t window_id) noexcept
    {
        for (auto &rank : state_->ranks)
            if (rank.key.participant == participant && rank.key.window_id == window_id) return &rank;
        return nullptr;
    }
    bool registered_window(window_key key) noexcept
    {
        const auto *rank = find_rank_identity(key.participant, key.window_id);
        return rank != nullptr && rank->key == key;
    }
    void remember_rank(window_key key, std::uint64_t order) noexcept
    {
        auto *rank = find_rank_identity(key.participant, key.window_id);
        if (rank == nullptr)
            for (auto &candidate : state_->ranks) if (candidate.key.participant == 0) { rank = &candidate; break; }
        if (rank != nullptr) *rank = {key, order};
    }
    void clear_owned_input(std::uint64_t id) noexcept
    {
        if (state_->focus.participant == id) state_->focus = {};
        if (state_->capture.participant == id)
        { state_->draining_buttons |= state_->capture_buttons; state_->capture = {}; state_->capture_buttons = 0; }
    }
    bool find_decision(std::uint64_t sequence, std::uint32_t projection,
        std::uint32_t message, window_key &recipient) const noexcept
    {
        const std::uint64_t count = std::min<std::uint64_t>(state_->decision_count, 8192);
        for (std::uint64_t offset = 0; offset < count; ++offset)
        {
            const auto &decision = state_->decisions[(state_->decision_count - 1 - offset) % 8192];
            if (decision.sequence < sequence) break;
            if (decision.sequence == sequence && decision.projection == projection)
            {
                recipient = decision.message == message ? decision.recipient : window_key{};
                return true;
            }
        }
        return false;
    }
    bool find_source(std::uint64_t sequence, window_key &recipient) const noexcept
    {
        const std::uint64_t count = std::min<std::uint64_t>(state_->source_count, 8192);
        for (std::uint64_t offset = 0; offset < count; ++offset)
        {
            const auto &source = state_->sources[(state_->source_count - 1 - offset) % 8192];
            if (source.sequence < sequence) break;
            if (source.sequence == sequence) { recipient = source.recipient; return true; }
        }
        return false;
    }
    static std::uint32_t down_button(std::uint32_t message, std::uint64_t wparam) noexcept
    {
        switch (message)
        {
        case WM_LBUTTONDOWN: case WM_LBUTTONDBLCLK: return 1;
        case WM_RBUTTONDOWN: case WM_RBUTTONDBLCLK: return 2;
        case WM_MBUTTONDOWN: case WM_MBUTTONDBLCLK: return 4;
        case WM_XBUTTONDOWN: case WM_XBUTTONDBLCLK: return ((wparam >> 16) & 0xffff) == XBUTTON2 ? 16 : 8;
        default: return 0;
        }
    }
    static std::uint32_t up_button(std::uint32_t message, std::uint64_t wparam) noexcept
    {
        switch (message)
        {
        case WM_LBUTTONUP: return 1;
        case WM_RBUTTONUP: return 2;
        case WM_MBUTTONUP: return 4;
        case WM_XBUTTONUP: return ((wparam >> 16) & 0xffff) == XBUTTON2 ? 16 : 8;
        default: return 0;
        }
    }
    window_key read_input(bool captured)
    {
        if (!available()) return {};
        detail::lock guard(mutex_);
        if (!guard) return {};
        return captured ? state_->capture : state_->focus;
    }
    HANDLE mutex_ = nullptr;
    HANDLE mapping_ = nullptr;
    detail::shared_state *state_ = nullptr;
    bool close_after_lock_ = false;
};
}
