#pragma once
#include <Windows.h>
#include <cstdint>
#include <cstddef>
struct device_counts_v1 {
    std::uint32_t struct_size = sizeof(device_counts_v1), version = 1;
    std::uint64_t initialized = 0, destroyed = 0;
};
static_assert(sizeof(device_counts_v1) == 24 && offsetof(device_counts_v1, initialized) == 8 && offsetof(device_counts_v1, destroyed) == 16);
using query_device_counts_fn = DWORD (WINAPI *)(device_counts_v1 *);
