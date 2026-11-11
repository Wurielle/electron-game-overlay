#pragma once
#include <Windows.h>
#include <dxgi1_3.h>
#include <cstdint>
struct renderer_state {
    std::uint32_t size=sizeof(renderer_state), factory_calls=0, factory_proxy_skips=0, native_factories=0;
    std::uint32_t present_calls=0, present1_calls=0, painted=0, disabled=0, red_readbacks=0, test_calls=0, identity_matches=0, device_matches=0, errors=0;
    std::uint64_t chain_identity=0, device_identity=0;
    std::int32_t last_result=0;
    std::uint32_t hook_engine=0; // 1: independent MinHook; 2: official Detours fixture
};
using renderer_start_fn=DWORD(WINAPI *)(void *,void *,unsigned);
using renderer_track_fn=DWORD(WINAPI *)(IDXGIFactory2 *,IDXGISwapChain1 *,IUnknown *,unsigned);
using renderer_state_fn=void(WINAPI *)(renderer_state *);
