#include <Windows.h>
#include <cstdio>
#include <stdexcept>
#include POLICY_HEADER
static unsigned assertions = 0;
static void check(bool value, const char *message) { ++assertions; if (!value) throw std::runtime_error(message); }
static HWND make(DWORD style, DWORD ex) {
    const HWND window = CreateWindowExW(ex, L"STATIC", L"Owned auxiliary lifetime probe", style, -32000, -32000, 160, 32, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    check(window != nullptr, "window creation");
    if (ex & WS_EX_LAYERED) check(SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA) != FALSE, "layered attribute");
    ShowWindow(window, SW_SHOWNOACTIVATE);
    check(IsWindowVisible(window) != FALSE, "window visibility");
    return window;
}
static void extended(HWND window, DWORD value) {
    SetLastError(ERROR_SUCCESS);
    check(SetWindowLongPtrW(window, GWL_EXSTYLE, value) != 0 || GetLastError() == ERROR_SUCCESS, "set extended style");
    if (value & WS_EX_LAYERED) check(SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA) != FALSE, "layered toggle");
    check(static_cast<DWORD>(GetWindowLongPtrW(window, GWL_EXSTYLE)) == value, "exact extended style");
}
int main() try {
    using namespace ego_owned_runtime_policy;
    const HWND foreground = GetForegroundWindow(); active = true;
    const HWND main = make(WS_OVERLAPPEDWINDOW, WS_EX_NOACTIVATE);
    window_binding binding; check(binding.resolve() == main, "initial main binding");
    const HANDLE main_cookie = GetPropW(main, property_name);
    constexpr DWORD shape = WS_POPUP | WS_BORDER | WS_CLIPSIBLINGS, plain = WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
    HWND popup = make(shape, plain | WS_EX_LAYERED);
    check(binding.resolve() == main, "layered auxiliary excluded by both generations");
    for (unsigned n = 0; n < 16; ++n) {
        extended(popup, plain);
        SetLastError(0x6835);
        check((binding.resolve() == main) == bool(PROPOSED), "same lifetime unlayered transition");
        check(GetLastError() == 0x6835, "last error retained");
        window_binding join; check((join.resolve() == main) == bool(PROPOSED), "new chain respects known auxiliary lifetime");
        ShowWindow(popup, SW_HIDE); check(binding.resolve() == main, "hide retains main");
        ShowWindow(popup, SW_SHOWNOACTIVATE); check((binding.resolve() == main) == bool(PROPOSED), "unlayered show");
        extended(popup, plain | WS_EX_LAYERED); check(binding.resolve() == main, "layered restoration");
        check(GetForegroundWindow() == foreground && GetPropW(main, property_name) == main_cookie, "foreground and main lifetime retained");
    }
    extended(popup, plain | WS_EX_APPWINDOW);
    check(binding.resolve() == nullptr, "APPWINDOW revokes remembered auxiliary");
    extended(popup, plain); check(binding.resolve() == nullptr, "revoked lifetime not relearned unlayered");
    DestroyWindow(popup); check(binding.resolve() == main, "destroyed auxiliary retires");
    popup = make(shape, plain); check(binding.resolve() == nullptr, "previously unseen identical unlayered peer remains a candidate");
    ShowWindow(main, SW_HIDE); window_binding sole; check(sole.resolve() == popup, "sole genuine unlayered tool accepted");
    ShowWindow(main, SW_SHOWNOACTIVATE); DestroyWindow(popup); check(binding.resolve() == main, "main resumes without migration");
    popup = make(shape, plain | WS_EX_LAYERED); check(binding.resolve() == main, "second lifetime observed layered");
#if PROPOSED
    check(RemovePropW(popup, auxiliary_property_name) != nullptr, "explicit lifetime-token invalidation");
#endif
    extended(popup, plain); check(binding.resolve() == nullptr, "missing auxiliary cookie refuses inheritance");
    DestroyWindow(popup); check(binding.resolve() == main, "main resumes after invalidated auxiliary gone");
    DestroyWindow(main); check(binding.resolve() == nullptr, "main lifetime retired");
    check(GetForegroundWindow() == foreground, "no activation across fixture");
    std::printf("{\"status\":\"passed\",\"proposed\":%s,\"assertions\":%u,\"transitions\":32,\"previouslyUnseenUnlayeredPeerAccepted\":true,\"activation\":false,\"input\":false,\"actualGame\":false}\n", PROPOSED ? "true" : "false", assertions);
    return 0;
} catch (const std::exception &error) { std::fprintf(stderr, "%s after %u assertions\n", error.what(), assertions); return 1; }
