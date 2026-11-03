#pragma once

#include <cstdint>
#include <atomic>
#include <mutex>
#include <utility>

namespace ego::cooperative
{
enum class presentation_role
{
    excluded,
    logical_owner,
    replica,
};

// Multiple swap chains can present to one HWND. Each such presentation needs
// pixels, but it must not become another source of focus, input or telemetry.
constexpr presentation_role classify_presentation(std::uint64_t native_id,
    std::uint64_t hwnd, bool logical_owner, std::uint64_t primary_native_id,
    std::uint64_t primary_hwnd) noexcept
{
    if (logical_owner)
        return presentation_role::logical_owner;
    return native_id != 0 && primary_native_id != 0 && native_id != primary_native_id &&
        hwnd != 0 && hwnd == primary_hwnd
        ? presentation_role::replica : presentation_role::excluded;
}

constexpr bool drives_logical_frame(presentation_role role) noexcept
{
    return role != presentation_role::excluded;
}

// A stable target HWND does not require its first swap chain to keep presenting.
// The current presenter drives logical progress; teardown of an older presenter
// must not release a newer presenter's input policy.
class presentation_driver
{
public:
    void activate(std::uint64_t native_id) noexcept
    {
        native_id_.store(native_id, std::memory_order_release);
    }
    bool release(std::uint64_t native_id) noexcept
    {
        return native_id != 0 && native_id_.compare_exchange_strong(native_id, 0,
            std::memory_order_acq_rel, std::memory_order_acquire);
    }
    std::uint64_t native_id() const noexcept
    {
        return native_id_.load(std::memory_order_acquire);
    }
    void reset() noexcept { native_id_.store(0, std::memory_order_release); }

private:
    std::atomic<std::uint64_t> native_id_ = 0;
};

// Present holds ReShade's per-input lock, but effect-runtime destruction does
// not. Protect only logical admission/retirement and input commits here. Never
// acquire this boundary around GPU work or while broadcasting to other engines.
class logical_control
{
public:
    template <typename Action>
    decltype(auto) run(Action &&action)
    {
        const std::scoped_lock lock(mutex_);
        return std::forward<Action>(action)();
    }

private:
    std::mutex mutex_;
};

struct epoch_observation
{
    bool first = false;
    bool changed = false;
    bool stale = false;
    std::uint64_t previous = 0;
};

// Eligible Present callbacks share this logical stream. Their individual
// texture epochs must never decide retirement of the shared registrations.
class logical_epoch_tracker
{
public:
    epoch_observation observe(std::uint64_t epoch) noexcept
    {
        const epoch_observation result{!observed_, observed_ && epoch > epoch_,
            observed_ && epoch < epoch_, epoch_};
        if (!result.stale)
        {
            epoch_ = epoch;
            observed_ = true;
        }
        return result;
    }

    void reset() noexcept { observed_ = false; epoch_ = 0; }

private:
    bool observed_ = false;
    std::uint64_t epoch_ = 0;
};
} // namespace ego::cooperative
