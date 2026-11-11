#pragma once
#include <Windows.h>
#include <cstdint>
struct callback_counts_v1 {
    std::uint32_t struct_size = sizeof(callback_counts_v1), version = 1;
    std::uint64_t devices = 0, destroyed_devices = 0, chains = 0, destroyed_chains = 0;
    std::uint64_t runtimes = 0, destroyed_runtimes = 0, presents = 0, runtime_presents = 0;
    std::uint64_t red_readbacks = 0, gpu_errors = 0;
    std::uint64_t runtime_hwnd = 0;
};
static_assert(sizeof(callback_counts_v1) == 96);
using query_callbacks_fn = DWORD (WINAPI *)(callback_counts_v1 *);
