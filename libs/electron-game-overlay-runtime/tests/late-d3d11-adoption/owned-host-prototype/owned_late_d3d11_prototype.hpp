#pragma once

// SOURCE-ONLY prototype. Include exactly once from owned ReShade source/addon.cpp.
// No production target defines this switch or includes this file.
#if !defined(RESHADE_OWNED_LATE_D3D11_PROTOTYPE) && !defined(RESHADE_OWNED_LATE_D3D11_ABI_ONLY)
#error This isolated prototype requires an explicit owned-host build switch.
#endif

#include <windows.h>
#include <cstdint>
#include <type_traits>

#pragma pack(push, 8)
struct ego_owned_late_d3d11_initialize_v1
{
    std::uint32_t struct_size;
    std::uint32_t abi_version;
    wchar_t owned_config_path[32768];
};

struct ego_owned_late_d3d11_stats_v1
{
    std::uint32_t struct_size;
    std::uint32_t abi_version;
    std::uint32_t status; // 0 cold; 1 installing; 2 active; 3 failed/passive
    std::uint32_t last_win32_error;
    std::uint32_t last_hresult;
    std::uint32_t reserved;
    std::uint64_t present_calls;
    std::uint64_t adoption_attempts;
    std::uint64_t adoption_successes;
    std::uint64_t notifier_rejections;
    std::uint64_t automatic_proxy_skips;
    std::uint64_t resize_calls;
    std::uint64_t resize_successes;
    std::uint64_t retirements;
    std::uint64_t quarantines;
    std::uint64_t render_failures;
};
#pragma pack(pop)

static_assert(sizeof(wchar_t) == 2);
static_assert(sizeof(ego_owned_late_d3d11_initialize_v1) == 65544);
static_assert(sizeof(ego_owned_late_d3d11_stats_v1) == 104);
static_assert(std::is_standard_layout_v<ego_owned_late_d3d11_initialize_v1>);
static_assert(std::is_trivially_copyable_v<ego_owned_late_d3d11_initialize_v1>);
static_assert(std::is_standard_layout_v<ego_owned_late_d3d11_stats_v1>);
static_assert(std::is_trivially_copyable_v<ego_owned_late_d3d11_stats_v1>);

// Caller must already have safely registered the initial cooperative adapter.
// Call outside DllMain. The request contains no target graphics pointers.
#if !defined(RESHADE_OWNED_LATE_D3D11_ABI_ONLY)
extern "C" __declspec(dllexport) DWORD WINAPI ReShadeInitializeOwnedLateD3D11V1(
    const ego_owned_late_d3d11_initialize_v1 *request);
extern "C" __declspec(dllexport) DWORD WINAPI ReShadeQueryOwnedLateD3D11V1(
    ego_owned_late_d3d11_stats_v1 *result);

#if defined(_M_IX86)
#pragma comment(linker, "/EXPORT:ReShadeInitializeOwnedLateD3D11V1=_ReShadeInitializeOwnedLateD3D11V1@4")
#pragma comment(linker, "/EXPORT:ReShadeQueryOwnedLateD3D11V1=_ReShadeQueryOwnedLateD3D11V1@4")
#endif

#include "owned_late_d3d11_prototype.inl"
#endif
