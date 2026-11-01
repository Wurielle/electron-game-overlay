#ifndef INPUT_CONSUMER_HEADER
#error Supply the exact INPUT_CONSUMER_HEADER under test.
#endif
#include INPUT_CONSUMER_HEADER

#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <iostream>
#include <memory>
#include <mutex>
#include <random>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace
{
using consumer = reshade::input_frame_consumer;

// Tokens are addresses of real objects. The helper must only compare them;
// neither helper nor fixture needs to dereference a token to make progress.
struct token { std::uint64_t label = 0; };

std::uint64_t assertions = 0;

void require(bool condition, const std::string &message)
{
    ++assertions;
    if (!condition) throw std::runtime_error(message);
}

void release_is(consumer::release_result result, bool current, bool last,
                const std::string &where)
{
    require(result.current == current, where + ": wrong current-release result");
    require(result.last == last, where + ": wrong last-release result");
}

void test_empty_and_null()
{
    consumer state;
    token a;
    require(!state.acquire(&a), "empty input manager accepted a presenter");
    require(!state.acquire(nullptr), "empty input manager accepted null");
    require(!state.is_current(nullptr), "null became a current identity");
    state.register_consumer();
    require(!state.is_current(&a), "registration incorrectly elected a presenter");
    require(!state.acquire(nullptr), "active manager accepted null presenter");
    require(!state.is_current(&a), "null acquisition changed current identity");
    release_is(state.unregister_consumer(&a), false, true, "unpresented final consumer");
    require(!state.acquire(&a), "last unpresented removal left active membership");
}

void test_single_final_and_reinitialization()
{
    consumer state;
    token a;
    for (unsigned incarnation = 0; incarnation != 4; ++incarnation)
    {
        state.register_consumer();
        require(!state.is_current(&a), "reinitialization revived old current ownership");
        require(state.acquire(&a), "initialized single presenter did not acquire");
        require(state.is_current(&a), "single presenter was not current");
        release_is(state.unregister_consumer(&a), true, true, "single final destroy");
        require(!state.is_current(&a), "single final destroy retained current ownership");
        require(!state.acquire(&a), "single final destroy retained registration");
    }
}

void test_reset_with_live_peer_and_reinit()
{
    consumer state;
    token a, b;
    state.register_consumer();
    state.register_consumer();
    require(state.acquire(&a), "A did not initially acquire");
    release_is(state.unregister_consumer(&a), true, false, "A reset while B is active");
    require(!state.is_current(&a) && !state.is_current(&b), "reset implicitly elected a nonpresenting peer");
    require(state.acquire(&b), "B could not present after A reset");
    state.register_consumer(); // A on_init after its matching on_reset.
    require(state.is_current(&b), "A reinit preempted B before A presented");
    require(state.acquire(&a), "reinitialized A could not make progress");
    require(!state.is_current(&b), "B remained current after A presented");
    release_is(state.unregister_consumer(&a), true, false, "reinitialized A final destroy");
    require(state.acquire(&b), "B could not resume after A final destroy");
    release_is(state.unregister_consumer(&b), true, true, "B final destroy");
}

void test_paused_presenter_and_stale_removal()
{
    consumer state;
    token a, b;
    state.register_consumer();
    state.register_consumer();
    require(state.acquire(&a), "A did not acquire before pause");
    require(state.acquire(&b), "paused but registered A prevented B from presenting");
    require(!state.is_current(&a) && state.is_current(&b), "presenter handoff did not select B");

    // The caller clears its global poll/block state only on current or last.
    // A's stale removal must not undo B's newer decision.
    bool blocked_by_current = true;
    const auto stale_a = state.unregister_consumer(&a);
    release_is(stale_a, false, false, "stale A removal after B handoff");
    if (stale_a.current || stale_a.last) blocked_by_current = false;
    require(blocked_by_current && state.is_current(&b), "stale A removal erased B's current block decision");
    const auto final_b = state.unregister_consumer(&b);
    release_is(final_b, true, true, "current B final removal");
    if (final_b.current || final_b.last) blocked_by_current = false;
    require(!blocked_by_current && !state.is_current(&b), "current B final removal failed to clear state");
}

void test_current_removal_clears_before_peer_presents()
{
    consumer state;
    token a, b;
    state.register_consumer();
    state.register_consumer();
    require(state.acquire(&a), "A did not acquire for active-removal test");
    bool blocked = true;
    const auto removed = state.unregister_consumer(&a);
    release_is(removed, true, false, "current A removal with active B");
    if (removed.current || removed.last) blocked = false;
    require(!blocked, "current removal left stale global suppression while peer was idle");
    require(!state.is_current(&b), "idle B became owner without presenting");
    require(state.acquire(&b), "idle B could not acquire on its next presentation");
    blocked = true;
    require(state.is_current(&b) && blocked, "B could not publish its new block decision");
    release_is(state.unregister_consumer(&b), true, true, "B removal after delayed acquisition");
}

void test_retained_shared_references_do_not_count_as_consumers()
{
    struct input_storage { consumer frames; };
    auto storage = std::make_shared<input_storage>();
    auto a_reference = storage;
    auto b_reference = storage;
    std::vector<std::shared_ptr<input_storage>> retained(12, storage);
    token a, b;
    storage->frames.register_consumer();
    storage->frames.register_consumer();
    require(storage.use_count() > 2, "retained-reference test lost its negative control");
    require(storage->frames.acquire(&a), "retained-reference A did not acquire");
    release_is(storage->frames.unregister_consumer(&a), true, false, "A reset with retained references");
    require(storage->frames.acquire(&b), "retained references prevented B from acquiring");
    release_is(storage->frames.unregister_consumer(&b), true, true, "last active runtime with retained references");
    require(storage.use_count() > 2, "runtime removal unexpectedly dropped retained input references");
    require(!storage->frames.acquire(&a), "retained shared input object kept dead runtimes active");
    storage->frames.register_consumer();
    require(storage->frames.acquire(&a), "retained input object could not host a fresh runtime");
    release_is(storage->frames.unregister_consumer(&a), true, true, "fresh runtime after retained-object reuse");
}

void test_serialized_cross_thread_handoff()
{
    consumer state;
    token a, b;
    std::mutex input_mutex;
    std::condition_variable changed;
    unsigned phase = 0;
    std::exception_ptr error_a, error_b;
    auto wait_for = [&](std::unique_lock<std::mutex> &lock, unsigned desired) {
        if (!changed.wait_for(lock, std::chrono::seconds(2), [&] { return phase >= desired; }))
            throw std::runtime_error("serialized thread schedule timed out");
    };
    std::thread thread_a([&] {
        try
        {
            std::unique_lock<std::mutex> lock(input_mutex);
            state.register_consumer();
            state.register_consumer();
            require(state.acquire(&a), "thread A did not acquire");
            phase = 1; changed.notify_all();
            wait_for(lock, 2);
            require(!state.is_current(&a), "thread A saw itself current after B handoff");
            release_is(state.unregister_consumer(&a), false, false, "thread A stale removal");
            require(state.is_current(&b), "thread A removal erased B ownership");
            phase = 3; changed.notify_all();
        }
        catch (...) { error_a = std::current_exception(); changed.notify_all(); }
    });
    std::thread thread_b([&] {
        try
        {
            std::unique_lock<std::mutex> lock(input_mutex);
            wait_for(lock, 1);
            require(state.acquire(&b), "thread B could not acquire from paused A");
            phase = 2; changed.notify_all();
            wait_for(lock, 3);
            release_is(state.unregister_consumer(&b), true, true, "thread B final removal");
            require(!state.is_current(&a) && !state.is_current(&b), "threaded final removal left an owner");
        }
        catch (...) { error_b = std::current_exception(); changed.notify_all(); }
    });
    thread_a.join();
    thread_b.join();
    if (error_a) std::rethrow_exception(error_a);
    if (error_b) std::rethrow_exception(error_b);
    require(!state.acquire(&a), "serialized thread schedule leaked an active consumer");
}

class active_set_model
{
public:
    void run(std::uint64_t seed, unsigned steps)
    {
        std::mt19937_64 random(seed);
        for (unsigned step = 0; step != steps; ++step)
        {
            where_ = "seed " + std::to_string(seed) + " step " + std::to_string(step);
            const void *const id = &tokens_[static_cast<std::size_t>(random() % tokens_.size())];
            const unsigned operation = static_cast<unsigned>(random() % 100);
            if (active_.find(id) == active_.end())
            {
                if (operation < 65)
                {
                    active_.insert(id);
                    actual_.register_consumer();
                }
                else
                    require(!actual_.is_current(id), where_ + ": inactive token became current");
            }
            else if (operation < 65)
            {
                require(actual_.acquire(id), where_ + ": active presenter could not acquire");
                current_ = id;
            }
            else
                remove(id);
            verify();
            // Drain in varied order to expose count drift hidden by nonempty sets.
            if (step % 127 == 126) drain(random);
        }
        drain(random);
    }

private:
    void remove(const void *id)
    {
        const bool expected_current = current_ == id;
        require(active_.erase(id) == 1, where_ + ": invalid model removal");
        const bool expected_last = active_.empty();
        release_is(actual_.unregister_consumer(id), expected_current, expected_last, where_);
        if (expected_current || expected_last) current_ = nullptr;
    }
    void verify()
    {
        require(!actual_.acquire(nullptr), where_ + ": null acquisition succeeded");
        require(!actual_.is_current(nullptr), where_ + ": null was current");
        for (const token &entry : tokens_)
            require(actual_.is_current(&entry) == (current_ == &entry), where_ + ": current identity differs from active-set model");
        if (active_.empty())
            require(!actual_.acquire(&tokens_[0]), where_ + ": empty active set accepted a presenter");
    }
    void drain(std::mt19937_64 &random)
    {
        std::vector<const void *> order(active_.begin(), active_.end());
        std::shuffle(order.begin(), order.end(), random);
        for (const void *id : order)
        {
            remove(id);
            verify();
        }
        require(current_ == nullptr && !actual_.acquire(&tokens_[0]), where_ + ": completed drain retained membership");
    }

    consumer actual_;
    std::array<token, 16> tokens_ {};
    std::set<const void *> active_;
    const void *current_ = nullptr;
    std::string where_;
};
} // namespace

int main()
{
    try
    {
        test_empty_and_null();
        test_single_final_and_reinitialization();
        test_reset_with_live_peer_and_reinit();
        test_paused_presenter_and_stale_removal();
        test_current_removal_clears_before_peer_presents();
        test_retained_shared_references_do_not_count_as_consumers();
        test_serialized_cross_thread_handoff();
        constexpr std::array<std::uint64_t, 8> seeds {
            1, 7, 0x12345678, 0xdeadbeef, 0x243f6a8885a308d3ULL,
            0x9e3779b97f4a7c15ULL, 0xfeedfacecafebeefULL, 0xffffffffffffffffULL
        };
        for (const auto seed : seeds)
        {
            active_set_model model;
            model.run(seed, 5'000);
        }
        std::cout << "{\"status\":\"passed\",\"deterministicCases\":7,"
                     "\"randomSeeds\":8,\"randomSteps\":40000,\"assertions\":"
                  << assertions << "}\n";
        return 0;
    }
    catch (const std::exception &error)
    {
        std::cerr << "input_frame_consumer fixture failed: " << error.what() << '\n';
        return 1;
    }
}
