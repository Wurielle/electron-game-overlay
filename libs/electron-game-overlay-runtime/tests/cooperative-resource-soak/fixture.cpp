// Controlled registry/resource fixture. No ReShade, injection, GPU or SDK.
#include <ego_cooperative_registry.hpp>
#include <TlHelp32.h>
#include <Psapi.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <stdexcept>
#include <thread>

#pragma comment(lib, "Psapi.lib")

namespace allocations
{
struct alignas(std::max_align_t) header { std::size_t bytes; };
std::atomic<std::size_t> blocks{0}, bytes{0};
}
void *operator new(std::size_t bytes)
{
    if (bytes > SIZE_MAX - sizeof(allocations::header)) throw std::bad_alloc();
    auto *allocation = static_cast<allocations::header *>(std::malloc(sizeof(allocations::header) + bytes));
    if (allocation == nullptr) throw std::bad_alloc();
    allocation->bytes = bytes;
    allocations::blocks.fetch_add(1, std::memory_order_relaxed);
    allocations::bytes.fetch_add(bytes, std::memory_order_relaxed);
    return allocation + 1;
}
void operator delete(void *pointer) noexcept
{
    if (pointer == nullptr) return;
    auto *allocation = static_cast<allocations::header *>(pointer) - 1;
    allocations::bytes.fetch_sub(allocation->bytes, std::memory_order_relaxed);
    allocations::blocks.fetch_sub(1, std::memory_order_relaxed);
    std::free(allocation);
}
void *operator new[](std::size_t bytes) { return ::operator new(bytes); }
void operator delete[](void *pointer) noexcept { ::operator delete(pointer); }
void operator delete(void *pointer, std::size_t) noexcept { ::operator delete(pointer); }
void operator delete[](void *pointer, std::size_t) noexcept { ::operator delete(pointer); }

using namespace ego::cooperative;
namespace
{
void require(bool condition, const char *message)
{
    if (!condition) throw std::runtime_error(message);
}
struct owner
{
    std::atomic<std::uint64_t> messages{0}, releases{0};
    std::atomic<bool> block{false}, entered{false}, resume{false};
};
void __cdecl message(void *context, const void *, std::uint32_t)
{
    auto &state = *static_cast<owner *>(context);
    state.messages.fetch_add(1);
    if (state.block.load())
    {
        state.entered.store(true);
        while (!state.resume.load()) SwitchToThread();
    }
}
void __cdecl release(void *context) { static_cast<owner *>(context)->releases.fetch_add(1); }
callbacks_v1 callbacks()
{
    callbacks_v1 result;
    result.route_message = message;
    result.release_input = release;
    return result;
}
window_v1 window(std::uint64_t incarnation)
{
    window_v1 result;
    result.window_id = 1;
    result.incarnation = incarnation;
    result.width = result.height = 8;
    return result;
}
// Test-only inspection of this fixture process's authoritative POD mapping.
// Production has no new debug API and the copied protocol remains unchanged.
class inventory
{
public:
    inventory()
    {
        FILETIME created{}, exited{}, kernel{}, user{};
        require(GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user), "process identity unavailable");
        const auto instance = (std::uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime;
        wchar_t name[160]{};
        swprintf_s(name, L"Local\\ElectronGameOverlay-Cooperative-v1-%lu-%016llx-%u",
            GetCurrentProcessId(), static_cast<unsigned long long>(instance), unsigned(sizeof(void *) * 8));
        mapping_ = OpenFileMappingW(FILE_MAP_READ, FALSE, name);
        require(mapping_ != nullptr, "fixture mapping inspection failed");
        state = static_cast<const detail::shared_state *>(MapViewOfFile(mapping_, FILE_MAP_READ, 0, 0, sizeof(detail::shared_state)));
        require(state != nullptr && state->magic == detail::magic && state->version == abi_version &&
            state->bytes == sizeof(detail::shared_state), "fixture mapping identity mismatch");
    }
    ~inventory() { if (state) UnmapViewOfFile(state); if (mapping_) CloseHandle(mapping_); }
    std::size_t active() const { std::size_t n = 0; for (const auto &p : state->participants) n += p.id != 0; return n; }
    std::size_t reserved() const { std::size_t n = 0; for (const auto &p : state->participants) n += p.reserved != 0; return n; }
    std::size_t windows() const { std::size_t n = 0; for (const auto &p : state->windows) n += p.key.participant != 0; return n; }
    std::size_t ranks() const { std::size_t n = 0; for (const auto &p : state->ranks) n += p.key.participant != 0; return n; }
    const detail::shared_state *state = nullptr;
private:
    HANDLE mapping_ = nullptr;
};
struct resource_sample
{
    std::size_t heap_blocks, heap_bytes;
    DWORD handles, threads, modules;
    SIZE_T private_bytes;
};
resource_sample plateau_before{}, plateau_after{};
bool plateau_verified = false;
resource_sample sample()
{
    resource_sample result{};
    require(GetProcessHandleCount(GetCurrentProcess(), &result.handles), "process handle inventory failed");
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    require(snapshot != INVALID_HANDLE_VALUE, "thread inventory failed");
    THREADENTRY32 thread{}; thread.dwSize = sizeof(thread);
    if (Thread32First(snapshot, &thread)) do { result.threads += thread.th32OwnerProcessID == GetCurrentProcessId(); } while (Thread32Next(snapshot, &thread));
    CloseHandle(snapshot);
    HMODULE modules[1024]{}; DWORD bytes = 0;
    require(EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &bytes) && bytes <= sizeof(modules), "module inventory failed");
    result.modules = bytes / sizeof(HMODULE);
    PROCESS_MEMORY_COUNTERS_EX memory{}; memory.cb = sizeof(memory);
    require(GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&memory), sizeof(memory)), "memory diagnostic failed");
    result.private_bytes = memory.PrivateUsage;
    result.heap_blocks = allocations::blocks.load();
    result.heap_bytes = allocations::bytes.load();
    return result;
}
void same_resources(const resource_sample &before, const resource_sample &after)
{
    require(after.heap_blocks == before.heap_blocks && after.heap_bytes == before.heap_bytes, "registry churn retained tracked C++ heap allocations");
    require(after.handles == before.handles, "registry churn changed quiescent process handle count");
    require(after.threads == before.threads, "registry churn changed quiescent process thread count");
    require(after.modules == before.modules, "registry churn changed quiescent process module count");
    plateau_before = before;
    plateau_after = after;
    plateau_verified = true;
}
void clear(registry &registry, std::uint64_t id)
{
    require(registry.cancel_owned_input(id) && registry.publish_windows(id, nullptr, 0) &&
        registry.reconcile_registrations(id, nullptr, 0) && registry.set_interception(id, false), "participant clear failed");
}
void stable(registry &registry, const inventory &view, owner &state, std::uint64_t id)
{
    // Warm allocations and OS inventory APIs before the exact plateau baseline.
    const auto frame = window(1);
    const window_key key{id, 1, 0, 1};
    require(registry.reconcile_registrations(id, &key, 1) && registry.publish_windows(id, &frame, 1), "warm registration failed");
    clear(registry, id);
    sample();
    const auto before = sample();
    const auto *slot = &view.state->participants[0];
    const auto count = max_windows + 17;
    for (std::uint64_t cycle = 1; cycle <= count; ++cycle)
    {
        const auto next_frame = window(cycle);
        const window_key next_key{id, 1, 0, cycle};
        require(registry.reconcile_registrations(id, &next_key, 1) && registry.publish_windows(id, &next_frame, 1) &&
            registry.set_focus(next_key) && registry.set_capture(next_key, 1) && registry.set_interception(id, true), "session metadata publication failed");
        clear(registry, id);
        require(registry.decide_input(cycle, 0, WM_LBUTTONUP, 0, 0).participant == 0 && view.state->draining_buttons == 0,
            "retired pointer capture did not drain its physical release");
        require(view.active() == 1 && view.reserved() == 1 && view.windows() == 0 && view.ranks() == 0 &&
            registry.focus().participant == 0 && registry.capture().participant == 0 && !registry.interception_requested(), "session clear retained ownership or consumed a lifetime slot");
        require(slot->id == id && slot->context == &state && slot->callbacks.route_message == message, "stable participant callback identity changed");
    }
    same_resources(before, sample());
    require(registry.leave(id) && view.active() == 0 && view.reserved() == 1 && state.releases == 1, "stable participant retirement reused callback storage");
    std::printf("{\"mode\":\"stable-participant\",\"cycles\":%u,\"active\":0,\"reserved\":1,", count);
}
void capacity(registry &registry, const inventory &view, owner &survivor, std::uint64_t survivor_id)
{
    owner retired[max_participants - 1];
    const auto frame = window(1);
    const window_key key{survivor_id, 1, 0, 1};
    require(registry.reconcile_registrations(survivor_id, &key, 1) && registry.publish_windows(survivor_id, &frame, 1) &&
        registry.set_focus(key) && registry.set_capture(key, 1) && registry.set_interception(survivor_id, true), "survivor setup failed");
    sample(); const auto before = sample();
    for (std::size_t index = 0; index < max_participants - 1; ++index)
    {
        const auto id = registry.join(callbacks(), &retired[index]);
        require(id != 0 && id != survivor_id && registry.leave(id), "lifetime slot admission/retirement failed");
        require(view.active() == 1 && view.reserved() == index + 2 && view.windows() == 1 && view.ranks() == 1,
            "retirement retained windows or reused lifetime callback storage");
    }
    const auto revision = view.state->revision;
    owner rejected;
    for (unsigned attempt = 0; attempt < 1024; ++attempt)
        require(registry.join(callbacks(), &rejected) == 0 && view.state->revision == revision &&
            view.active() == 1 && view.reserved() == max_participants && registry.focus() == key && registry.capture() == key &&
            registry.interception_requested(), "capacity rejection mutated the survivor or registry");
    const unsigned packet = 1;
    registry.broadcast_message(&packet, sizeof(packet));
    require(survivor.messages == 1 && rejected.messages == 0, "capacity rejection published a callback");
    for (const auto &state : retired) require(state.messages == 0 && state.releases == 1, "departed callback was reused or broadcast");
    same_resources(before, sample());
    clear(registry, survivor_id);
    require(registry.leave(survivor_id) && view.active() == 0 && view.reserved() == max_participants &&
        view.windows() == 0 && view.ranks() == 0 && registry.join(callbacks(), &rejected) == 0, "final leave reopened exhausted callback storage");
    std::printf("{\"mode\":\"lifetime-capacity\",\"admitted\":%u,\"rejectedAttempts\":1025,\"active\":0,\"reserved\":%u,", max_participants, max_participants);
}
void concurrent(registry &registry, const inventory &view, owner &state, std::uint64_t id)
{
    std::thread([] {}).join();
    sample(); const auto before = sample();
    state.block.store(true);
    const unsigned packet = 1;
    std::thread broadcast([&] { registry.broadcast_message(&packet, sizeof(packet)); });
    const auto deadline = GetTickCount64() + 5000;
    while (!state.entered.load() && GetTickCount64() < deadline) SwitchToThread();
    if (!state.entered.load())
    {
        state.resume.store(true);
        broadcast.join();
        throw std::runtime_error("broadcast did not enter the departure barrier");
    }
    // A lock-free observer already holds this context when leave publishes id=0.
    const bool left = registry.leave(id);
    owner next;
    const auto next_id = registry.join(callbacks(), &next);
    const bool immutable = left && next_id != 0 && next_id != id && view.reserved() == 2 &&
        view.state->participants[0].id == 0 && view.state->participants[0].context == &state &&
        view.state->participants[0].callbacks.route_message == message;
    state.resume.store(true);
    broadcast.join();
    require(immutable, "in-flight departure callback storage was reused");
    // The broadcaster may observe the newly published later slot during its
    // first traversal. It must always use that slot's distinct context.
    const auto next_messages = next.messages.load();
    registry.broadcast_message(&packet, sizeof(packet));
    require(state.messages == 1 && state.releases == 1 && next.messages == next_messages + 1 && registry.leave(next_id), "departed context received later broadcasts");
    same_resources(before, sample());
    std::printf("{\"mode\":\"concurrent-departure\",\"active\":0,\"reserved\":2,");
}
void admission(registry &registry, const inventory &view, owner &survivor, std::uint64_t id)
{
    std::thread([] {}).join();
    sample(); const auto before = sample();
    const auto revision = view.state->revision;
    const unsigned packet = 1;
    owner unpublished;
    for (unsigned attempt = 0; attempt < 1024; ++attempt)
    {
        {
            auto pending = registry.reserve_participant();
            require(bool(pending) && view.active() == 1 && view.reserved() == 2,
                "unpublished admission was visible or unavailable");
            registry.broadcast_message(&packet, sizeof(packet));
            require(unpublished.messages == 0 && view.state->revision == revision,
                "reservation published a callback or visible scene revision");
        }
        require(view.active() == 1 && view.reserved() == 1, "cancelled pre-pin admission leaked a lifetime slot");
    }
    owner older, published;
    {
        auto pending = registry.reserve_participant();
        std::uint64_t older_id = 0;
        std::thread old_join([&] { older_id = registry.join(callbacks(), &older); });
        old_join.join();
        require(bool(pending) && older_id != 0 && view.reserved() == 3 && registry.leave(older_id),
            "baseline join reused unpublished reservation storage");
    }
    require(view.reserved() == 2, "pending reservation cancellation cleared a different lifetime slot");
    {
        auto pending = registry.reserve_participant();
        require(bool(pending), "publication admission unavailable");
        pending.retain_if_unpublished(); // Models successful irreversible PIN.
        const auto published_id = pending.publish(callbacks(), &published);
        require(published_id != 0 && view.active() == 2 && view.reserved() == 3,
            "post-pin publication failed");
        registry.broadcast_message(&packet, sizeof(packet));
        require(published.messages == 1 && older.messages == 0 && registry.leave(published_id),
            "published admission callback identity was invalid");
    }
    {
        auto pending = registry.reserve_participant();
        require(bool(pending), "publication failure admission unavailable");
        pending.retain_if_unpublished();
        auto invalid = callbacks(); invalid.version = 0;
        require(pending.publish(invalid, &unpublished) == 0, "invalid callbacks were published");
    }
    require(view.active() == 1 && view.reserved() == 4 && unpublished.messages == 0,
        "post-pin failure reopened its lifetime slot");
    while (view.reserved() < max_participants)
    {
        auto pending = registry.reserve_participant();
        require(bool(pending), "bounded tombstone setup exhausted early");
        pending.retain_if_unpublished();
    }
    for (unsigned attempt = 0; attempt < 1024; ++attempt)
    {
        auto rejected = registry.reserve_participant();
        require(!rejected && registry.join(callbacks(), &unpublished) == 0 && view.active() == 1 &&
            view.reserved() == max_participants, "exhausted reservation admitted a module");
    }
    registry.broadcast_message(&packet, sizeof(packet));
    require(unpublished.messages == 0 && published.messages == 1 && older.messages == 0 &&
        survivor.messages == 1026, "unpublished or retired callback became visible");
    same_resources(before, sample());
    require(registry.leave(id) && view.active() == 0 && view.reserved() == max_participants,
        "survivor retirement reused a pinned admission");
    std::printf("{\"mode\":\"admission-transaction\",\"cancelledPrePin\":1024,\"unpublishedTombstones\":509,\"active\":0,\"reserved\":%u,", max_participants);
}
}
int main(int argc, char **argv)
{
    try
    {
        require(argc == 2, "expected one fixture mode");
        registry registry;
        require(registry.open(), "registry open failed");
        inventory view;
        require(view.active() == 0 && view.reserved() == 0, "fixture did not start with a fresh process mapping");
        owner state;
        const auto id = registry.join(callbacks(), &state);
        require(id != 0, "first participant admission failed");
        if (std::strcmp(argv[1], "stable-participant") == 0) stable(registry, view, state, id);
        else if (std::strcmp(argv[1], "lifetime-capacity") == 0) capacity(registry, view, state, id);
        else if (std::strcmp(argv[1], "concurrent-departure") == 0) concurrent(registry, view, state, id);
        else if (std::strcmp(argv[1], "admission-transaction") == 0) admission(registry, view, state, id);
        else throw std::runtime_error("unknown fixture mode");
        const auto resources = sample();
        require(plateau_verified, "fixture omitted its exact resource plateau check");
        std::printf("\"resourceBaseline\":{\"trackedCppHeapBlocks\":%zu,\"trackedCppHeapBytes\":%zu,\"handles\":%lu,\"threads\":%lu,\"modules\":%lu},\"resourceAfter\":{\"trackedCppHeapBlocks\":%zu,\"trackedCppHeapBytes\":%zu,\"handles\":%lu,\"threads\":%lu,\"modules\":%lu},",
            plateau_before.heap_blocks, plateau_before.heap_bytes, plateau_before.handles, plateau_before.threads, plateau_before.modules,
            plateau_after.heap_blocks, plateau_after.heap_bytes, plateau_after.handles, plateau_after.threads, plateau_after.modules);
        std::printf("\"passed\":true,\"pointerBits\":%u,\"mappingBytes\":%zu,\"maxParticipants\":%u,\"maxWindows\":%u,\"trackedCppHeapBlocks\":%zu,\"trackedCppHeapBytes\":%zu,\"handles\":%lu,\"threads\":%lu,\"modules\":%lu,\"privateBytesDiagnostic\":%zu}\n",
            unsigned(sizeof(void *) * 8), sizeof(detail::shared_state), max_participants, max_windows,
            resources.heap_blocks, resources.heap_bytes, resources.handles, resources.threads, resources.modules, resources.private_bytes);
        return 0;
    }
    catch (const std::exception &error)
    {
        std::fprintf(stderr, "Cooperative resource soak failed: %s\n", error.what());
        return 1;
    }
}
