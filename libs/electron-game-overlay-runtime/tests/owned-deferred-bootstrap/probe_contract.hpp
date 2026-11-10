#pragma once
#include <Windows.h>
#include <cstdint>
#include <cstddef>
// Test-only prototype observation API. No private C++ objects or allocation
// ownership cross the module boundary; completion returns a caller-owned handle.
struct deferred_probe_v1 {
    std::uint32_t struct_size = sizeof(deferred_probe_v1), version = 1;
    std::uint32_t pending = 0, queued = 0, queue_calls = 0, worker_calls = 0;
    std::uint32_t queue_thread = 0, worker_thread = 0, queue_error = 0, result = 0, host_status = 0, reserved = 0;
    std::uint64_t module = 0;
};
static_assert(sizeof(deferred_probe_v1) == 56 && offsetof(deferred_probe_v1, module) == 48);
using query_deferred_probe_fn = DWORD (WINAPI *)(deferred_probe_v1 *);
using acquire_deferred_completion_fn = DWORD (WINAPI *)(HANDLE *);
using force_deferred_queue_failure_fn = void (WINAPI *)(BOOL);
