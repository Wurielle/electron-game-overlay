// The production template and raw Present shims are extracted byte-for-byte.
// Only state/runtime and the downstream native callback are controlled seams.
#include <Windows.h>
#include <dxgi1_2.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <cstdio>
#include <stdexcept>
#include <type_traits>
namespace contract {
enum class chain_phase { ready, reset, quarantined, rejected };
struct fake_runtime { bool acquire = true; bool acquire_owned_late_d3d11_back_buffer_views() { return acquire; } };
struct chain_state {
    std::recursive_mutex mutex;
    std::shared_ptr<std::recursive_mutex> context_operation_gate = std::make_shared<std::recursive_mutex>();
    std::atomic_bool dead{false}; chain_phase phase = chain_phase::ready;
    bool still_drawing = false; void *runtime = nullptr;
};
std::atomic<unsigned> present_calls{0}, render_failures{0}, quarantines{0}, last_error{0}, last_hresult{0};
std::atomic<int> status{2};
thread_local bool g_in_dxgi_runtime = false;
thread_local unsigned native_depth = 0;
bool managed = false, throw_find = false, throw_render = false;
unsigned rendered = 0, native_calls = 0, resolved = 0;
UINT observed_interval = 0, observed_flags = 0;
const DXGI_PRESENT_PARAMETERS *observed_parameters = nullptr;
HRESULT native_result = S_OK;
std::shared_ptr<chain_state> selected;
struct depth_scope { depth_scope() { ++native_depth; } ~depth_scope() { --native_depth; } };
struct dxgi_scope { bool old = g_in_dxgi_runtime; dxgi_scope() { g_in_dxgi_runtime = true; } ~dxgi_scope() { g_in_dxgi_runtime = old; } };
struct context_scope { explicit context_scope(int *) {} };
struct release_back_buffer_views { fake_runtime *runtime; };
bool automatically_managed(IDXGISwapChain *) { return managed; }
std::shared_ptr<chain_state> find_chain(IDXGISwapChain *, bool) { if (throw_find) throw std::runtime_error("owned seam"); return selected; }
std::shared_ptr<int> retain_context(const std::shared_ptr<chain_state> &) { return std::make_shared<int>(0); }
void ReShadeUpdateAndPresentEffectRuntime(void *) { ++rendered; if (throw_render) throw std::runtime_error("owned seam"); }
HRESULT STDMETHODCALLTYPE downstream(IDXGISwapChain *, UINT interval, UINT flags) { ++native_calls; observed_interval = interval; observed_flags = flags; return native_result; }
HRESULT STDMETHODCALLTYPE downstream1(IDXGISwapChain1 *, UINT interval, UINT flags, const DXGI_PRESENT_PARAMETERS *p) { ++native_calls; observed_interval = interval; observed_flags = flags; observed_parameters = p; return native_result; }
namespace reshade { using runtime = fake_runtime; namespace hooks {
template<class T> T call(T) { ++resolved; if constexpr(std::is_same_v<T, decltype(&downstream)>) return &downstream; else return &downstream1; }
}}
#include GENERATED_PRESENT_SOURCE
}
int main()
{
    using namespace contract;
    unsigned cases = 0;
    try {
        for (int scenario = 0; scenario != 13; ++scenario) {
            status = 2; managed = throw_find = throw_render = false; g_in_dxgi_runtime = false; native_depth = 0;
            rendered = native_calls = 0; native_result = S_OK;
            fake_runtime runtime; selected = std::make_shared<chain_state>(); selected->runtime = &runtime;
            UINT flags = 0;
            if (scenario == 0) status = 4;
            if (scenario == 1) g_in_dxgi_runtime = true;
            if (scenario == 2) native_depth = 1;
            if (scenario == 3) flags = DXGI_PRESENT_TEST;
            if (scenario == 4) managed = true;
            if (scenario == 5) selected.reset();
            if (scenario == 6) selected->dead = true;
            if (scenario == 7) selected->phase = chain_phase::reset;
            if (scenario == 8) { flags = DXGI_PRESENT_DO_NOT_WAIT; selected->still_drawing = true; native_result = DXGI_ERROR_WAS_STILL_DRAWING; }
            if (scenario == 9) runtime.acquire = false;
            if (scenario == 10) throw_render = true;
            if (scenario == 11) throw_find = true;
            if (scenario == 12) native_result = DXGI_ERROR_DEVICE_REMOVED;
            const HRESULT result = present(nullptr, flags, [&] { ++native_calls; return native_result; });
            if (native_calls != 1 || result != native_result) throw std::runtime_error("native Present was skipped, duplicated or its result changed");
            if (scenario == 12 && selected->phase != chain_phase::rejected) throw std::runtime_error("device removal state changed");
            ++cases;
        }
        selected.reset(); status = 4; g_in_dxgi_runtime = false; native_depth = 0;
        for (const UINT flags : {0u, static_cast<UINT>(DXGI_PRESENT_TEST), static_cast<UINT>(DXGI_PRESENT_DO_NOT_WAIT)}) {
            native_calls = 0; native_result = DXGI_ERROR_WAS_STILL_DRAWING;
            if (raw_present(nullptr, 3, flags) != native_result || native_calls != 1 || observed_interval != 3 || observed_flags != flags) throw std::runtime_error("raw Present argument forwarding changed");
            ++cases;
            native_calls = 0; DXGI_PRESENT_PARAMETERS parameters{};
            if (raw_present1(nullptr, 2, flags, &parameters) != native_result || native_calls != 1 || observed_interval != 2 || observed_flags != flags || observed_parameters != &parameters) throw std::runtime_error("raw Present1 argument forwarding changed");
            ++cases;
        }
        std::printf("{\"status\":\"passed\",\"cases\":%u,\"nativeForwardedExactlyOnce\":true,\"actualSteam\":false,\"graphics\":false,\"input\":false}\n", cases);
        return 0;
    } catch(const std::exception &e) { std::fprintf(stderr, "%s after %u cases\n", e.what(), cases); return 1; }
}
