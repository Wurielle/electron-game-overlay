#include <ego_cooperative_registry.hpp>
#include <ego_cooperative_input.hpp>
#include <ego_cooperative_frame_policy.hpp>
#include <atomic>
#include <cstdio>
#include <future>
#include <stdexcept>
#include <thread>
#include <vector>

using namespace ego::cooperative;

namespace
{
void require(bool condition, const char *message)
{
    if (!condition) throw std::runtime_error(message);
}
struct owner
{
    std::uint32_t tag;
    bool transparent = false;
    std::vector<std::uint32_t> *draws;
    std::atomic<unsigned> messages{0};
    unsigned releases = 0;
};
void __cdecl draw(void *context, void *, std::uint32_t window, std::uint64_t)
{
    const auto &state = *static_cast<owner *>(context);
    state.draws->push_back(state.tag * 10 + window);
}
std::uint32_t __cdecl hit(void *context, std::uint32_t, std::uint64_t, std::int32_t x, std::int32_t)
{
    const auto &state = *static_cast<owner *>(context);
    return state.transparent && x < 50 ? 0 : hit_body;
}
void __cdecl message(void *context, const void *, std::uint32_t)
{
    static_cast<owner *>(context)->messages.fetch_add(1, std::memory_order_relaxed);
}
void __cdecl release(void *context)
{
    ++static_cast<owner *>(context)->releases;
}
window_v1 window(std::uint32_t id, std::uint64_t incarnation = 1)
{
    window_v1 result;
    result.window_id = id;
    result.incarnation = incarnation;
    result.width = result.height = 100;
    return result;
}

void frame_policy_tests()
{
    using role = presentation_role;
    static_assert(classify_presentation(10, 300, true, 10, 300) == role::logical_owner);
    static_assert(classify_presentation(20, 300, false, 10, 300) == role::replica);
    static_assert(drives_logical_frame(role::logical_owner));
    static_assert(drives_logical_frame(role::replica));
    static_assert(!drives_logical_frame(role::excluded));
    struct presentation_case
    {
        std::uint64_t native, hwnd;
        bool logical_owner;
        std::uint64_t primary_native, primary_hwnd;
        role expected;
    };
    constexpr presentation_case cases[] = {
        {10, 300, true, 10, 300, role::logical_owner},
        {10, 300, true, 0, 0, role::logical_owner}, // Unknown peer inventory never transfers an existing owner.
        {20, 300, false, 10, 300, role::replica},
        {10, 300, false, 20, 300, role::replica}, // The former owner can become a rendering peer.
        {10, 300, false, 10, 300, role::excluded}, // A replica cannot impersonate the selected native identity.
        {20, 301, false, 10, 300, role::excluded}, // Related/root-like HWNDs are not an exact HWND match.
        {20, 500, false, 10, 300, role::excluded},
        {20, 0, false, 10, 300, role::excluded},
        {0, 300, false, 10, 300, role::excluded},
        {20, 300, false, 0, 300, role::excluded},
        {20, 300, false, 10, 0, role::excluded},
        {20, 300, false, 0, 0, role::excluded},
    };
    for (const auto &test : cases)
        require(classify_presentation(test.native, test.hwnd, test.logical_owner,
            test.primary_native, test.primary_hwnd) == test.expected,
            "Presentation policy confused exact-HWND rendering with logical ownership");

    struct frame_model
    {
        logical_epoch_tracker logical;
        presentation_driver driver;
        unsigned observations = 0, cleanups = 0, progress = 0, phase_changes = 0;
        bool intercepting = false;
        epoch_observation present(role current_role, std::uint64_t native,
            std::uint64_t epoch, bool requested)
        {
            // Resource epochs remain per presenter, while every eligible
            // presentation drives this single participant control stream.
            if (!drives_logical_frame(current_role))
                return {};
            ++observations;
            const auto result = logical.observe(epoch);
            if (result.stale) return result;
            driver.activate(native);
            ++progress;
            if (result.changed) ++cleanups;
            if (intercepting != requested) { intercepting = requested; ++phase_changes; }
            return result;
        }
    };
    frame_model frames;
    frames.present(classify_presentation(30, 301, false, 10, 300), 30, 99, true);
    require(frames.observations == 0 && frames.progress == 0 && frames.driver.native_id() == 0,
        "An unrelated presenter activated or advanced the shared logical stream");
    auto observation = frames.present(classify_presentation(10, 300, true, 10, 300), 10, 1, false);
    require(observation.first && !observation.changed && !observation.stale && observation.previous == 0,
        "The first eligible presentation did not initialize the logical stream");
    require(frames.driver.native_id() == 10 && frames.progress == 1,
        "The first eligible presenter did not become the current driver");
    // A remains selected/live but stops presenting. B alone must continue
    // metadata, epoch cleanup and input progress for the same exact HWND.
    observation = frames.present(classify_presentation(20, 300, false, 10, 300), 20, 3, true);
    require(!observation.first && observation.changed && !observation.stale &&
        observation.previous == 1 && frames.cleanups == 1 && frames.driver.native_id() == 20 &&
        frames.progress == 2 && frames.phase_changes == 1 && frames.intercepting,
        "A same-HWND peer failed to advance the shared state while its anchor paused");
    observation = frames.present(role::replica, 20, 3, true);
    require(!observation.first && !observation.changed && !observation.stale &&
        observation.previous == 3 && frames.cleanups == 1 && frames.phase_changes == 1,
        "Repeated peer presentation duplicated epoch cleanup or interception transitions");
    require(!frames.driver.release(10) && frames.driver.native_id() == 20,
        "Retiring an old presenter disabled the still-active same-HWND driver");
    const auto progress_before_excluded = frames.progress;
    frames.present(classify_presentation(30, 301, false, 10, 300), 30, 5, false);
    require(frames.progress == progress_before_excluded && frames.driver.native_id() == 20 &&
        frames.cleanups == 1 && frames.phase_changes == 1 && frames.intercepting,
        "An excluded HWND stole driver identity or advanced shared metadata/input");
    observation = frames.present(role::logical_owner, 10, 2, false);
    require(observation.stale && !observation.changed && observation.previous == 3 &&
        frames.driver.native_id() == 20 && frames.progress == progress_before_excluded,
        "A delayed anchor frame rolled back the peer's active logical state");
    frames.present(role::logical_owner, 10, 3, true);
    frames.present(role::replica, 20, 3, true);
    require(frames.driver.native_id() == 20 && frames.cleanups == 1 && frames.phase_changes == 1,
        "Alternating eligible presenters created independent logical cleanup or phase state");
    observation = frames.present(classify_presentation(20, 300, true, 20, 300), 20, 3, true);
    require(!observation.changed && !observation.stale && frames.cleanups == 1,
        "Promoting the current peer repeated an already-applied shared epoch transition");
    frames.present(role::logical_owner, 20, 3, false);
    require(frames.phase_changes == 2 && !frames.intercepting && !frames.driver.release(10) &&
        frames.driver.release(20) && frames.driver.native_id() == 0 && !frames.driver.release(20),
        "Only current-driver retirement should clear the presentation driver exactly once");

    frame_model replica_first;
    observation = replica_first.present(role::replica, 20, 3, true);
    require(observation.first && replica_first.driver.native_id() == 20 && replica_first.progress == 1,
        "The first eligible same-HWND peer could not drive the shared stream");
    observation = replica_first.present(role::logical_owner, 10, 1, false);
    require(observation.stale && observation.previous == 3 && replica_first.driver.native_id() == 20,
        "A late anchor overwrote the newer logical epoch established by its peer");
    replica_first.driver.reset();
    replica_first.logical.reset();
    require(replica_first.driver.native_id() == 0 && !replica_first.driver.release(20),
        "Bridge reset retained a former presentation driver");
    observation = replica_first.present(role::logical_owner, 10, 1, false);
    require(observation.first && !observation.changed && !observation.stale && observation.previous == 0,
        "A genuinely new bridge could not restart its logical epoch at one");
}

void logical_control_concurrency_tests()
{
    constexpr std::uint64_t old_presenter = 10, next_presenter = 20;
    presentation_driver ungated_driver;
    ungated_driver.activate(old_presenter);
    std::atomic<bool> ungated_enabled = true;
    std::atomic<bool> ungated_release_succeeded = false;
    std::promise<void> ungated_released, ungated_next_enabled;
    auto ungated_released_signal = ungated_released.get_future();
    auto ungated_next_enabled_signal = ungated_next_enabled.get_future();
    std::thread old_ungated([&] {
        ungated_release_succeeded.store(ungated_driver.release(old_presenter));
        ungated_released.set_value();
        // Reproduce the actual bad ordering: A has relinquished identity, B
        // has enabled input, and only then A finishes its old disable tail.
        ungated_next_enabled_signal.wait();
        ungated_enabled.store(false);
    });
    std::thread next_ungated([&] {
        ungated_released_signal.wait();
        ungated_driver.activate(next_presenter);
        ungated_enabled.store(true);
        ungated_next_enabled.set_value();
    });
    old_ungated.join();
    next_ungated.join();
    require(ungated_release_succeeded.load() && ungated_driver.native_id() == next_presenter &&
        !ungated_enabled.load(),
        "The ungated retirement control did not reproduce stale-tail disabling of a new presenter");

    logical_control control;
    presentation_driver gated_driver;
    control.run([&] { gated_driver.activate(old_presenter); });
    std::atomic<bool> gated_enabled = true;
    std::atomic<bool> gated_release_succeeded = false;
    std::atomic<bool> retirement_finished = false;
    std::atomic<bool> next_entered_before_retirement = false;
    std::promise<void> retirement_entered, next_attempt_started;
    auto retirement_entered_signal = retirement_entered.get_future();
    auto next_attempt_started_signal = next_attempt_started.get_future();
    std::thread old_gated([&] {
        control.run([&] {
            gated_release_succeeded.store(gated_driver.release(old_presenter));
            retirement_entered.set_value();
            // B announces its admission attempt outside the boundary. A may
            // finish cleanup without waiting for B to acquire the same mutex.
            next_attempt_started_signal.wait();
            gated_enabled.store(false);
            retirement_finished.store(true);
        });
    });
    std::thread next_gated([&] {
        retirement_entered_signal.wait();
        next_attempt_started.set_value();
        control.run([&] {
            next_entered_before_retirement.store(!retirement_finished.load());
            gated_driver.activate(next_presenter);
            gated_enabled.store(true);
        });
    });
    old_gated.join();
    next_gated.join();
    require(gated_release_succeeded.load() && !next_entered_before_retirement.load() &&
        gated_driver.native_id() == next_presenter && gated_enabled.load(),
        "Control-only serialization let an old retirement tail disable the newly admitted presenter");
    const bool stale_release = control.run([&] { return gated_driver.release(old_presenter); });
    require(!stale_release && gated_driver.native_id() == next_presenter && gated_enabled.load(),
        "A stale presenter's release changed the new presenter's committed input state");
}
}

int main()
{
    try
    {
        frame_policy_tests();
        logical_control_concurrency_tests();
        registry first;
        registry second;
        require(first.open() && second.open(), "Independent registry handles did not open one target mapping");
        require(first.claim_dispatcher(), "First callback trampoline did not acquire dispatch");
        require(second.dispatcher_available() && !second.claim_dispatcher(), "Callback dispatch was registered twice");
        first.observe_source_sequence(10);
        second.observe_source_sequence(9);
        require(first.latest_source_sequence() == 10 && second.latest_source_sequence() == 10,
            "Out-of-order observer publication moved the shared capture watermark backwards");
        const auto private_cutoff_a = first.latest_source_sequence();
        const std::uint64_t private_cutoff_b = 0;
        require(10 <= private_cutoff_a && 10 > private_cutoff_b,
            "One participant's reset barrier changed another participant's record eligibility");
        second.observe_source_sequence(11);
        require(first.latest_source_sequence() == 11 && 11 > private_cutoff_a,
            "A private capture cutoff discarded a subsequently observed input source");
        source_sequence_gate source_gate;
        std::int32_t canonical_point = 100;
        const auto integrate_delta = [&source_gate, &canonical_point](std::uint64_t sequence, std::int32_t delta) {
            // Native dispatch uses this same gate before any canonical raw
            // delta/promotion state is mutated, including across batches.
            if (!source_gate.admit(sequence)) return false;
            canonical_point += delta;
            return true;
        };
        require(integrate_delta(101, 3) && canonical_point == 103,
            "A fresh canonical raw source was rejected");
        require(!integrate_delta(100, 10000) && canonical_point == 103,
            "A delayed source changed canonical position before sequence rejection");
        require(integrate_delta(102, 2) && canonical_point == 105,
            "A fresh source inherited drift from a previously rejected raw delta");
        first.observe_source_sequence(110);
        source_gate.discard_through(first.latest_source_sequence());
        require(!integrate_delta(103, 10000) && !integrate_delta(109, 10000) &&
            !integrate_delta(110, 10000) && canonical_point == 105,
            "A capture-watermark barrier admitted an older or in-flight canonical source");
        source_gate.discard_through(105);
        require(!integrate_delta(109, 10000) && integrate_delta(111, 4) && canonical_point == 109,
            "A stale barrier moved the cutoff backwards or a new source inherited stale drift");
        source_sequence_gate filtered_batch_gate;
        require(filtered_batch_gate.admit(41), "Cancellation-batch fixture admission failed");
        auto unmarked_retrograde_gate = filtered_batch_gate;
        filtered_batch_gate.discard_through(42);
        struct raw_delta { std::uint64_t sequence; std::int32_t delta; };
        const raw_delta cancelled_then_fresh[] = {{42, 10000}, {43, 7}};
        std::int32_t filtered_point = 0;
        unsigned silently_discarded = 0;
        unsigned ordering_faults = 0;
        for (const auto &record : cancelled_then_fresh)
        {
            // Match native ordering: cancellation filtering precedes the
            // monotonic-source check, so a known stale record cannot reset
            // otherwise fresh records from the same sorted batch.
            if (filtered_batch_gate.intentionally_discarded(record.sequence))
            { ++silently_discarded; continue; }
            if (!filtered_batch_gate.admit(record.sequence))
            { ++ordering_faults; continue; }
            filtered_point += record.delta;
        }
        require(silently_discarded == 1 && ordering_faults == 0 && filtered_point == 7,
            "An intentionally discarded source caused a false order fault or lost fresh same-batch movement");
        require(!unmarked_retrograde_gate.intentionally_discarded(40) &&
            !unmarked_retrograde_gate.admit(40),
            "A genuinely retrograde source without a cancellation barrier ceased to be an ordering fault");
        require(!first.has_live_surfaces() && first.observe_surface(10, 100) && first.observe_surface(20, 200),
            "Actual primary/secondary surface inventory publication failed");
        // The late engine personally observes only the primary. Inventory is
        // authoritative across copies, so it must still see the secondary.
        require(second.observe_surface(10, 100) && first.snapshot_surfaces().size() == 2,
            "An idempotent duplicate surface initialization was counted twice");
        require(first.remove_surface(10) && second.has_live_surfaces() &&
            second.snapshot_surfaces().size() == 1 && second.snapshot_surfaces()[0].native_id == 20 &&
            second.snapshot_surfaces()[0].hwnd == 200,
            "A late engine would retire transport while an unobserved secondary surface was alive");
        require(!first.remove_surface(10) && first.remove_surface(20) && !second.has_live_surfaces(),
            "Final actual surface destruction did not release the inventory hold");
        require(first.claim_primary_surface(10) && second.claim_primary_surface(10) && !second.claim_primary_surface(20),
            "A late participant selected a secondary surface as its primary");
        second.release_primary_surface(20);
        require(!first.claim_primary_surface(20), "Destroying a secondary surface released the primary");
        first.release_primary_surface(10);
        require(second.claim_primary_surface(20) && first.claim_primary_surface(20),
            "Final primary destruction did not allow a surviving surface to promote");
        require(first.primary_surface().native_id == 0 && first.primary_surface().hwnd == 0,
            "A selected native identity without inventory fabricated a target HWND");
        first.release_primary_surface(20);
        require(first.observe_surface(30, 300) && second.observe_surface(40, 300) &&
            first.observe_surface(50, 500) && first.observe_surface(60, 0),
            "Primary-window presentation query fixture setup failed");
        require(first.primary_surface().native_id == 0 && second.primary_surface().hwnd == 0,
            "Reading the primary presentation target elected an unclaimed surface");
        require(first.claim_primary_surface(30), "The logical primary could not be selected");
        auto selected_surface = second.primary_surface();
        require(selected_surface.native_id == 30 && selected_surface.hwnd == 300 &&
            second.observe_surface(30, 300) && first.primary_surface().native_id == 30,
            "Independent copies did not see the exact primary HWND across idempotent initialization");
        second.release_primary_surface(40);
        require(first.primary_surface().native_id == 30 && first.primary_surface().hwnd == 300,
            "Retiring a same-HWND rendering peer changed logical ownership");
        require(first.remove_surface(30) && second.primary_surface().native_id == 0 &&
            second.primary_surface().hwnd == 0 && !second.claim_primary_surface(40),
            "A missing selected presenter silently promoted its same-HWND peer");
        first.release_primary_surface(30);
        require(second.primary_surface().native_id == 0 && second.claim_primary_surface(40) &&
            first.primary_surface().native_id == 40 && first.primary_surface().hwnd == 300,
            "Explicit primary release/promotion lost the surviving peer's exact target HWND");
        require(first.remove_surface(50) && second.primary_surface().native_id == 40,
            "Destroying a different-HWND presenter changed the selected presentation target");
        second.release_primary_surface(40);
        require(first.claim_primary_surface(60) && second.primary_surface().native_id == 0 &&
            second.primary_surface().hwnd == 0,
            "A selected offscreen/unknown HWND authorized rendering peers");
        first.release_primary_surface(60);
        require(first.remove_surface(40) && second.remove_surface(60) && !first.has_live_surfaces(),
            "Primary presentation query fixture did not retire its live surfaces");
        std::vector<std::uint32_t> draws;
        owner a{1, false, &draws};
        owner b{2, true, &draws};
        callbacks_v1 callbacks;
        callbacks.render_window = draw;
        callbacks.hit_test = hit;
        callbacks.route_message = message;
        callbacks.release_input = release;
        const auto id_a = first.join(callbacks, &a);
        const auto id_b = second.join(callbacks, &b);
        require(id_a != 0 && id_b != 0 && id_a != id_b, "Participants did not receive isolated namespaces");
        auto a1 = window(1);
        auto b1 = window(1);
        require(first.publish_windows(id_a, &a1, 1), "A1 publication failed");
        require(second.publish_windows(id_b, &b1, 1), "B1 publication with colliding local ID failed");
        window_v1 a_windows[] = {a1, window(2)};
        require(first.publish_windows(id_a, a_windows, 2), "A2 publication failed");
        auto scene = first.snapshot_windows();
        require(scene.size() == 3 && scene[0].key.participant == id_a && scene[0].key.window_id == 1 &&
            scene[1].key.participant == id_b && scene[2].key.participant == id_a && scene[2].key.window_id == 2,
            "Per-window scenes could not interleave A1, B1, A2");
        for (const auto &entry : scene)
            entry.callbacks.render_window(entry.context, nullptr, entry.key.window_id, entry.key.incarnation);
        require(draws == std::vector<std::uint32_t>({11, 21, 12}), "Rendering did not use each window's own implementation in global order");
        window_v1 reversed_a[] = {window(2), a1};
        require(first.publish_windows(id_a, reversed_a, 2), "Producer order mutation failed");
        scene = second.snapshot_windows();
        require(scene[0].key.participant == id_a && scene[0].key.window_id == 2 &&
            scene[1].key.participant == id_b && scene[2].key.participant == id_a && scene[2].key.window_id == 1,
            "Changing one producer's order displaced a foreign participant's rank");
        require(first.publish_windows(id_a, a_windows, 2), "Producer order restoration failed");
        auto a2_only = window(2);
        require(first.publish_windows(id_a, &a2_only, 1), "Temporary raster gap publication failed");
        require(first.publish_windows(id_a, a_windows, 2), "Raster reappearance publication failed");
        scene = second.snapshot_windows();
        require(scene[0].key.participant == id_a && scene[0].key.window_id == 1 &&
            scene[1].key.participant == id_b && scene[2].key.participant == id_a && scene[2].key.window_id == 2,
            "A temporary raster gap raised an existing registration above a foreign window");
        window_v1 recreated_a[] = {window(2), window(1, 2)};
        require(first.publish_windows(id_a, recreated_a, 2), "New window incarnation publication failed");
        scene = second.snapshot_windows();
        require(scene.back().key.participant == id_a && scene.back().key.window_id == 1 && scene.back().key.incarnation == 2,
            "A new window incarnation reused a closed registration's historical rank");
        // Restore the original fixture using a separate registration epoch.
        window_v1 restored_a[] = {window(1, 3), window(2, 2)};
        require(first.publish_windows(id_a, restored_a, 2), "Order fixture reconstruction failed");
        a1 = restored_a[0];
        a_windows[0] = restored_a[0];
        a_windows[1] = restored_a[1];
        const window_key a1_key{id_a, 1, 0, 3};
        const window_key a2_key{id_a, 2, 0, 2};
        const window_key b1_key{id_b, 1, 0, 1};
        const auto rank_of = [&first](window_key key) -> std::uint64_t {
            for (const auto &entry : first.snapshot_windows()) if (entry.key == key) return entry.window.order;
            throw std::runtime_error("Expected published window rank is unavailable");
        };
        require(first.raise(a1_key) && first.publish_windows(id_a, a_windows, 2, true) &&
            rank_of(a1_key) > rank_of(a2_key),
            "An unchanged private frame snapshot undid a native global raise");
        window_v1 b_windows[] = {b1, window(2)};
        const window_key b2_key{id_b, 2, 0, 1};
        require(second.publish_windows(id_b, b_windows, 2) && first.publish_windows(id_a, a_windows, 2, true) &&
            rank_of(a1_key) > rank_of(a2_key),
            "A foreign new window and stale private frame snapshot undid native order");
        const auto foreign_rank_1 = rank_of(b1_key);
        const auto foreign_rank_2 = rank_of(b2_key);
        const window_key a_order[] = {a1_key, a2_key};
        require(first.set_focus(a1_key) && first.set_capture(a1_key, 1) &&
            first.reorder_registrations(id_a, a_order, 2) && rank_of(a1_key) < rank_of(a2_key) &&
            rank_of(b1_key) == foreign_rank_1 && rank_of(b2_key) == foreign_rank_2 &&
            first.focus() == a1_key && first.capture() == a1_key,
            "An explicit private reorder changed foreign ranks or input ownership");
        require(first.clear_capture() && first.set_focus({}), "Order-race fixture input cleanup failed");
        const window_key reversed_order[] = {a2_key, a1_key};
        require(first.publish_windows(id_a, &a_windows[1], 1, true) &&
            first.reorder_registrations(id_a, reversed_order, 2) &&
            first.publish_windows(id_a, a_windows, 2, true) && rank_of(a1_key) > rank_of(a2_key),
            "An explicit reorder lost the rank of an unframed registration");
        require(first.reorder_registrations(id_a, a_order, 2) &&
            second.reconcile_registrations(id_b, &b1_key, 1) && second.publish_windows(id_b, &b1, 1, true),
            "Order-race fixture scene cleanup failed");
        require(first.raise(b1_key), "B1 raise failed");
        require(second.hit_test(75, 10) == b1_key, "Opaque topmost owner was not selected");
        require(second.hit_test(25, 10) == a2_key, "Transparent pixels did not reveal another participant");
        require(first.set_interception(id_a, true) && second.interception_requested(), "Interception OR lost first participant");
        require(second.set_interception(id_b, true) && first.set_interception(id_a, false) && first.interception_requested(),
            "One participant disabling interception disabled a survivor");
        require(second.set_interception(id_b, false) && !first.interception_requested(), "Interception did not clear after final request");
        require(first.set_focus(a1_key) && second.focus() == a1_key, "Global keyboard focus did not cross registry views");
        require(second.set_capture(a1_key, 1) && first.hit_test(1000, 1000) == a1_key,
            "Pointer capture did not survive leaving the hit rectangle");
        require(first.clear_capture(), "Capture clear failed");
        require(first.set_interception(id_a, true) && first.set_capture(a1_key, 1) &&
            first.set_interception(id_a, false) && second.capture().participant == 0,
            "Disabling final interception left a stale global capture owner");

        require(first.decide_input(1, 0, WM_LBUTTONDOWN, 75, 10) == b1_key,
            "Global pointer-down selected wrong participant");
        require(second.decide_input(1, 0, WM_LBUTTONDOWN, 75, 10) == b1_key,
            "Second normalizer changed a committed pointer-down");
        require(first.decide_input(2, 0, WM_MOUSEMOVE, 500, 500) == b1_key,
            "Captured movement was retargeted");
        require(first.decide_input(3, 0, WM_LBUTTONUP, 500, 500) == b1_key && first.capture().participant == 0,
            "Pointer-up did not release global capture");
        require(second.decide_input(3, 0, WM_LBUTTONUP, 500, 500) == b1_key,
            "Second normalizer retargeted pointer-up after capture was released");
        require(second.decide_input(4, 0, WM_KEYDOWN, 0, 0) == b1_key,
            "Keyboard input did not use shared focus independently of hover");
        require(second.decide_input(1, 2, WM_MOUSEWHEEL, 25, 10) == b1_key && first.capture().participant == 0,
            "A later engine's additional old-source projection lost ownership or replayed global capture");
        require(first.set_focus(a1_key) && first.set_capture(a1_key, 1) && first.cancel_owned_input(id_a, true) &&
            first.focus() == a1_key && first.capture().participant == 0,
            "Private recovery did not retain an authoritatively registered logical focus owner");
        require(first.cancel_owned_input(id_a) &&
            first.focus().participant == 0 && first.capture().participant == 0,
            "A private input recovery left stale global ownership");
        require(first.decide_input(5, 0, WM_LBUTTONUP, 75, 10).participant == 0,
            "Private recovery leaked its unmatched physical up into another participant");
        require(first.set_focus(b1_key) && first.set_capture(b1_key, 1) && first.cancel_owned_input(id_a, true) &&
            first.focus() == b1_key && first.capture() == b1_key,
            "A private input recovery reset another participant's focus or capture");
        require(first.clear_capture(), "Private recovery fixture capture clear failed");
        require(first.claim_frame(reinterpret_cast<void *>(1), 1) && !second.claim_frame(reinterpret_cast<void *>(1), 1) &&
            second.claim_frame(reinterpret_cast<void *>(1), 2), "A frame was dispatched twice or the next frame was lost");
        first.retire_runtime(reinterpret_cast<void *>(1));
        require(second.claim_frame(reinterpret_cast<void *>(1), 1), "Retired runtime identity could not be reused");
        require(first.publish_windows(id_a, a_windows, 2), "Idempotent publication failed");
        require(first.snapshot_windows().back().key == b1_key, "Unchanged geometry publication overwrote native global order");
        const auto before_invalid = first.snapshot_windows();
        window_v1 duplicate[] = {a1, a1};
        require(!first.publish_windows(id_a, duplicate, 2) && first.snapshot_windows().size() == before_invalid.size(),
            "Rejected publication replaced a live scene");
        require(first.set_focus(b1_key) && first.set_capture(b1_key, 1), "Departure fixture setup failed");
        const int copied = 42;
        first.broadcast_message(&copied, sizeof(copied));
        require(a.messages == 1 && b.messages == 1, "Raw observer did not reach each owner's own normalizer queue");
        require(second.leave(id_b), "Participant departure failed");
        require(b.releases == 1 && first.focus().participant == 0 && first.capture().participant == 0,
            "Departure did not release only departed focus/capture");
        scene = second.snapshot_windows();
        require(scene.size() == 2 && scene[0].key.participant == id_a && scene[1].key.participant == id_a,
            "Participant departure removed surviving windows");
        require(first.decide_input(6, 0, WM_LBUTTONUP, 10, 10).participant == 0,
            "Departed participant's unmatched physical up leaked into survivor");
        first.broadcast_message(&copied, sizeof(copied));
        require(a.messages == 2 && b.messages == 1, "Dormant participant received later observer input");
        require(first.leave(id_a) && a.releases == 1 && first.snapshot_windows().empty(), "Final participant cleanup failed");
        owner cycling{3, false, &draws};
        const auto cycling_id = first.join(callbacks, &cycling);
        require(cycling_id != 0, "Lifetime-cycle participant admission failed");
        for (std::uint32_t cycle = 1; cycle != max_windows + 2; ++cycle)
        {
            const window_key registered{cycling_id, cycle, 0, 1};
            const auto current = window(cycle);
            require(first.reconcile_registrations(cycling_id, &registered, 1) &&
                first.publish_windows(cycling_id, &current, 1),
                "Authoritatively closed windows exhausted lifetime rank history");
        }
        require(first.reconcile_registrations(cycling_id, nullptr, 0) &&
            first.publish_windows(cycling_id, nullptr, 0) && first.leave(cycling_id),
            "Lifetime-cycle participant cleanup failed");
        owner focus_a{4, false, &draws};
        owner focus_b{5, false, &draws};
        const auto focus_a_id = first.join(callbacks, &focus_a);
        const auto focus_b_id = second.join(callbacks, &focus_b);
        const window_key focus_a_key{focus_a_id, 1, 0, 1};
        const window_key focus_b_key{focus_b_id, 1, 0, 1};
        const auto focus_frame = window(1);
        require(first.reconcile_registrations(focus_a_id, &focus_a_key, 1) && first.set_focus(focus_a_key),
            "A registered unpainted window could not accept logical focus");
        require(second.reconcile_registrations(focus_b_id, &focus_b_key, 1) &&
            second.publish_windows(focus_b_id, &focus_frame, 1) && second.set_focus(focus_b_key),
            "An unpainted earlier focus request blocked a later participant's request");
        require(first.publish_windows(focus_a_id, &focus_frame, 1), "First raster publication failed");
        scene = first.snapshot_windows();
        require(scene.size() == 2 && scene[0].key == focus_a_key && scene[1].key == focus_b_key &&
            first.focus() == focus_b_key,
            "A slow first raster changed metadata registration order or stole later focus");
        require(first.set_focus(focus_a_key) && first.set_capture(focus_a_key, 1) &&
            first.reconcile_registrations(focus_a_id, &focus_a_key, 1) &&
            first.publish_windows(focus_a_id, nullptr, 0) && first.cancel_owned_input(focus_a_id, true) &&
            first.focus() == focus_a_key &&
            first.capture().participant == 0,
            "A frameless registered window lost logical focus or retained pointer capture");
        require(first.decide_input(100, 0, WM_KEYDOWN, 0, 0).participant == 0,
            "An unpainted logical focus owner received keyboard input");
        require(first.publish_windows(focus_a_id, &focus_frame, 1) && first.focus() == focus_a_key &&
            first.decide_input(101, 0, WM_KEYDOWN, 0, 0) == focus_a_key,
            "Repainting did not restore retained focus without a new request");
        require(first.publish_windows(focus_a_id, nullptr, 0) && second.set_focus(focus_b_key) &&
            first.publish_windows(focus_a_id, &focus_frame, 1) && first.focus() == focus_b_key,
            "Repainting an older focused window stole another participant's newer focus");
        require(first.set_focus(focus_a_key) && first.reconcile_registrations(focus_a_id, nullptr, 0) &&
            first.focus().participant == 0 && !first.set_focus(focus_a_key),
            "Authoritative registration closure did not revoke logical focus");
        const window_key next_focus_a{focus_a_id, 1, 0, 2};
        require(first.reconcile_registrations(focus_a_id, &next_focus_a, 1) &&
            first.set_focus(next_focus_a) && !first.set_focus(focus_a_key),
            "Recreated unpainted registration accepted stale focus identity");
        require(first.leave(focus_a_id) && second.leave(focus_b_id), "Focus-gap fixture cleanup failed");
        owner epoch_owner{7, false, &draws}, epoch_survivor{8, false, &draws};
        const auto epoch_id = first.join(callbacks, &epoch_owner);
        const auto survivor_id = second.join(callbacks, &epoch_survivor);
        require(epoch_id != 0 && survivor_id != 0, "Epoch-retirement participants failed to join");
        const window_key old_epoch_key{epoch_id, 1, 0, 1};
        const window_key survivor_keys[]{{survivor_id, 1, 0, 1}, {survivor_id, 2, 0, 1}};
        const auto old_epoch_frame = window(1);
        const window_v1 survivor_frames[]{window(1), window(2)};
        require(first.reconcile_registrations(epoch_id, &old_epoch_key, 1) &&
            first.publish_windows(epoch_id, &old_epoch_frame, 1) &&
            second.reconcile_registrations(survivor_id, survivor_keys, 2) &&
            second.publish_windows(survivor_id, survivor_frames, 2) &&
            second.set_focus(survivor_keys[1]) && second.set_capture(survivor_keys[1], 1),
            "Epoch-retirement registration setup failed");
        const auto before_epoch_retirement = first.snapshot_windows();
        require(before_epoch_retirement.size() == 3 && first.publish_windows(epoch_id, nullptr, 0, true) &&
            first.set_focus(old_epoch_key) && second.set_focus(survivor_keys[1]),
            "A temporary raster gap incorrectly discarded its live registration");
        // Native epoch retirement must reconcile authoritative registrations:
        // empty compositable frames alone preserve rank history by design.
        require(first.reconcile_registrations(epoch_id, nullptr, 0) && !first.set_focus(old_epoch_key) &&
            first.focus() == survivor_keys[1] && first.capture() == survivor_keys[1],
            "Closed producer epoch retained registration or disturbed survivor ownership");
        auto after_epoch_retirement = first.snapshot_windows();
        require(after_epoch_retirement.size() == 2 &&
            after_epoch_retirement[0].key == survivor_keys[0] && after_epoch_retirement[1].key == survivor_keys[1] &&
            after_epoch_retirement[0].window.order == before_epoch_retirement[1].window.order &&
            after_epoch_retirement[1].window.order == before_epoch_retirement[2].window.order,
            "Producer epoch retirement reordered a surviving participant");
        const window_key next_epoch_key{epoch_id, 1, 0, 2};
        const auto next_epoch_frame = window(1, 2);
        require(first.reconcile_registrations(epoch_id, &next_epoch_key, 1) &&
            first.publish_windows(epoch_id, &next_epoch_frame, 1, true) && !first.set_focus(old_epoch_key),
            "Replacement producer epoch accepted stale registration identity");
        after_epoch_retirement = first.snapshot_windows();
        require(after_epoch_retirement.size() == 3 && after_epoch_retirement[2].key == next_epoch_key &&
            after_epoch_retirement[2].window.order > before_epoch_retirement[2].window.order &&
            first.focus() == survivor_keys[1] && first.capture() == survivor_keys[1] &&
            first.leave(epoch_id) && second.leave(survivor_id),
            "Replacement epoch revived old order or changed survivor input ownership");
        owner capture_owner{9, false, &draws};
        const auto capture_id = first.join(callbacks, &capture_owner);
        const window_key drag_key{capture_id, 1, 0, 1};
        const auto drag_frame = window(1);
        require(capture_id != 0 && first.reconcile_registrations(capture_id, &drag_key, 1) &&
            first.publish_windows(capture_id, &drag_frame, 1) && first.set_interception(capture_id, true),
            "Same-HWND capture preservation fixture setup failed");
        constexpr std::uint64_t anchor_surface = 2010, peer_surface = 2020,
            foreign_surface = 2030, offscreen_surface = 2040, shared_hwnd = 3000;
        require(first.observe_surface(anchor_surface, shared_hwnd) &&
            second.observe_surface(peer_surface, shared_hwnd) && first.observe_surface(foreign_surface, 4000) &&
            first.observe_surface(offscreen_surface, 0) && first.claim_primary_surface(anchor_surface),
            "Same-HWND driver inventory setup failed");
        std::uint64_t drag_sequence = 1000;
        const auto begin_drag = [&] {
            require(first.decide_input(drag_sequence++, 0, WM_LBUTTONDOWN, 10, 10) == drag_key &&
                first.capture() == drag_key && first.focus() == drag_key,
                "Physical down did not establish the fixture's captured drag");
        };
        begin_drag();
        const auto before_anchor_retirement = first.snapshot_windows();
        const auto retired_anchor = second.primary_surface();
        require(retired_anchor.native_id == anchor_surface && first.remove_surface(anchor_surface),
            "The retired anchor's exact HWND was not snapshotted before inventory removal");
        second.release_primary_surface(anchor_surface, peer_surface, retired_anchor.hwnd);
        const auto after_anchor_retirement = first.snapshot_windows();
        require(first.capture() == drag_key && first.focus() == drag_key &&
            before_anchor_retirement.size() == 1 && after_anchor_retirement.size() == 1 &&
            before_anchor_retirement[0].window.order == after_anchor_retirement[0].window.order &&
            second.decide_input(drag_sequence++, 0, WM_MOUSEMOVE, 500, 500) == drag_key &&
            first.decide_input(drag_sequence++, 0, WM_LBUTTONUP, 500, 500) == drag_key &&
            first.capture().participant == 0,
            "Removing an old anchor broke its live same-HWND driver's captured drag or logical scene");

        const auto expect_retirement_clears = [&](std::uint64_t surviving_driver,
            std::uint64_t retired_window, bool legacy_default = false) {
            require(first.observe_surface(anchor_surface, shared_hwnd) && first.claim_primary_surface(anchor_surface),
                "Capture cancellation fixture could not restore its anchor");
            begin_drag();
            const auto before = first.snapshot_windows();
            require(first.remove_surface(anchor_surface), "Capture cancellation fixture lost its retiring anchor");
            if (legacy_default) second.release_primary_surface(anchor_surface);
            else second.release_primary_surface(anchor_surface, surviving_driver, retired_window);
            const auto after = first.snapshot_windows();
            require(first.capture().participant == 0 && first.focus() == drag_key &&
                before.size() == 1 && after.size() == 1 && before[0].window.order == after[0].window.order &&
                first.decide_input(drag_sequence++, 0, WM_LBUTTONUP, 10, 10).participant == 0,
                "Unproven driver continuity retained capture, leaked a held release, or changed focus/order");
        };
        expect_retirement_clears(999999, shared_hwnd); // Missing driver.
        require(first.remove_surface(peer_surface), "Stale driver fixture could not remove its peer");
        expect_retirement_clears(peer_surface, shared_hwnd); // Stale inventory identity.
        require(first.observe_surface(peer_surface, shared_hwnd), "Capture fixture could not restore its live peer");
        expect_retirement_clears(foreign_surface, shared_hwnd);
        expect_retirement_clears(offscreen_surface, shared_hwnd);
        expect_retirement_clears(peer_surface, 0);
        expect_retirement_clears(anchor_surface, shared_hwnd);
        expect_retirement_clears(0, 0, true);

        require(first.observe_surface(anchor_surface, shared_hwnd) && first.claim_primary_surface(anchor_surface),
            "Current-driver cleanup fixture could not restore its anchor");
        begin_drag();
        require(first.remove_surface(anchor_surface), "Current-driver cleanup fixture lost its old anchor");
        first.release_primary_surface(anchor_surface, peer_surface, shared_hwnd);
        require(second.capture() == drag_key, "Authoritative same-HWND continuity did not retain the current drag");
        const auto before_driver_retirement = first.snapshot_windows();
        second.retire_input_driver_capture();
        const auto after_driver_retirement = first.snapshot_windows();
        require(first.capture().participant == 0 && first.focus() == drag_key &&
            before_driver_retirement[0].window.order == after_driver_retirement[0].window.order &&
            first.decide_input(drag_sequence++, 0, WM_LBUTTONUP, 10, 10).participant == 0 &&
            first.decide_input(drag_sequence++, 0, WM_MOUSEMOVE, 10, 10) == drag_key,
            "Actual current-driver cleanup failed to clear/drain preserved capture without changing logical focus");
        first.retire_input_driver_capture();
        require(first.remove_surface(peer_surface) && first.remove_surface(foreign_surface) &&
            first.remove_surface(offscreen_surface) && !first.has_live_surfaces(),
            "Capture preservation fixture left live surfaces behind");
        for (std::uint64_t surface = 1; surface <= max_surfaces; ++surface)
            require(first.observe_surface(1000 + surface, 2000 + surface), "Surface inventory bound fixture setup failed");
        require(first.claim_primary_surface(1001) && second.primary_surface().native_id == 1001 &&
            second.primary_surface().hwnd == 2001,
            "A complete bounded inventory lost its exact selected surface");
        require(!second.observe_surface(999999, 999999), "Surface inventory accepted an untracked entry beyond its bound");
        require(first.primary_surface().native_id == 0 && second.primary_surface().hwnd == 0,
            "Uncertain inventory authorized a presentation peer through a stale selected target");
        require(first.observe_surface(1001, 2001) && first.snapshot_surfaces().size() == max_surfaces,
            "A duplicate surface consumed capacity after an overflow observation");
        begin_drag();
        require(first.observe_surface(1002, 2001) && first.remove_surface(1001),
            "Uncertain same-HWND driver fixture setup failed");
        first.release_primary_surface(1001, 1002, 2001);
        require(first.capture().participant == 0 && first.focus() == drag_key &&
            first.decide_input(drag_sequence++, 0, WM_LBUTTONUP, 10, 10).participant == 0 &&
            first.observe_surface(1001, 2001),
            "Unknown inventory preserved a drag or leaked its release despite exact-looking stale metadata");
        for (std::uint64_t surface = 1; surface <= max_surfaces; ++surface)
            require(first.remove_surface(1000 + surface), "Known surface retirement after overflow failed");
        require(first.snapshot_surfaces().empty() && second.has_live_surfaces(),
            "Incomplete surface inventory was mistaken for proof of a final surface exit");
        require(first.leave(capture_id), "Capture preservation participant cleanup failed");
        registry unopened;
        require(unopened.has_live_surfaces(), "Unavailable inventory was mistaken for an empty target");
        require(unopened.primary_surface().native_id == 0 && unopened.primary_surface().hwnd == 0,
            "An unavailable registry fabricated a selected presentation target");
        std::puts("Cooperative registry protocol tests passed.");
        return 0;
    }
    catch (const std::exception &error)
    {
        std::fprintf(stderr, "Cooperative registry protocol test failed: %s\n", error.what());
        return 1;
    }
}
