#pragma once

#include <Windows.h>

#include <cstdint>
#include <cwchar>
#include <string>

class input_oracle
{
public:
    input_oracle() : enabled_(input_gate_marker_present()) {}

    bool initialize(HWND window)
    {
        if (!enabled_)
            return true;

        RAWINPUTDEVICE devices[2] = {};
        devices[0].usUsagePage = 0x01;
        devices[0].usUsage = 0x02;
        devices[0].hwndTarget = window;
        devices[1].usUsagePage = 0x01;
        devices[1].usUsage = 0x06;
        devices[1].hwndTarget = window;
        raw_input_registered_ =
            RegisterRawInputDevices(devices, 2, sizeof(RAWINPUTDEVICE)) != FALSE;
        if (GetForegroundWindow() == window || GetFocus() == window)
            apply_client_clip(window);
        return raw_input_registered_;
    }

    void shutdown()
    {
        if (!enabled_)
            return;

        ClipCursor(nullptr);
        if (raw_input_registered_)
        {
            RAWINPUTDEVICE devices[2] = {};
            devices[0].usUsagePage = 0x01;
            devices[0].usUsage = 0x02;
            devices[0].dwFlags = RIDEV_REMOVE;
            devices[1].usUsagePage = 0x01;
            devices[1].usUsage = 0x06;
            devices[1].dwFlags = RIDEV_REMOVE;
            RegisterRawInputDevices(devices, 2, sizeof(RAWINPUTDEVICE));
            raw_input_registered_ = false;
        }
    }

    void observe_window_message(HWND window, UINT message, WPARAM w_param)
    {
        if (!enabled_)
            return;

        switch (message)
        {
        case WM_MOUSEMOVE:
            ++mouse_move_messages_;
            break;
        case WM_LBUTTONDOWN:
            ++left_button_down_messages_;
            break;
        case WM_LBUTTONUP:
            ++left_button_up_messages_;
            break;
        case WM_MOUSEWHEEL:
        case WM_MOUSEHWHEEL:
            ++mouse_wheel_messages_;
            break;
        case WM_KEYDOWN:
        case WM_SYSKEYDOWN:
            ++key_down_messages_;
            break;
        case WM_INPUT:
            ++raw_input_messages_;
            break;
        case WM_SETFOCUS:
            apply_client_clip(window);
            break;
        case WM_ACTIVATEAPP:
            if (w_param != 0)
                apply_client_clip(window);
            else
                ClipCursor(nullptr);
            break;
        case WM_KILLFOCUS:
            ClipCursor(nullptr);
            break;
        default:
            break;
        }
    }

    void sample_and_publish(HWND window, const wchar_t *base_title)
    {
        if (!enabled_)
            return;

        if ((GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0)
            ++polled_left_button_frames_;

        POINT cursor = {};
        if (GetCursorPos(&cursor))
        {
            if (cursor_initialized_ &&
                (cursor.x != last_cursor_.x || cursor.y != last_cursor_.y))
            {
                ++cursor_change_samples_;
            }
            last_cursor_ = cursor;
            cursor_initialized_ = true;
        }

        const ULONGLONG now = GetTickCount64();
        if (now - last_title_update_ < 100)
            return;
        last_title_update_ = now;

        RECT clip = {};
        const bool clip_valid = GetClipCursor(&clip) != FALSE;
        const int virtual_left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        const int virtual_top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        const int virtual_right = virtual_left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
        const int virtual_bottom = virtual_top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
        const bool clip_active = clip_valid &&
            (clip.left > virtual_left || clip.top > virtual_top ||
             clip.right < virtual_right || clip.bottom < virtual_bottom);

        wchar_t title[512] = {};
        swprintf_s(
            title,
            L"%s | game input: move=%llu down=%llu up=%llu wheel=%llu key=%llu raw=%llu poll-left=%llu cursor-change=%llu clip=%s",
            base_title,
            static_cast<unsigned long long>(mouse_move_messages_),
            static_cast<unsigned long long>(left_button_down_messages_),
            static_cast<unsigned long long>(left_button_up_messages_),
            static_cast<unsigned long long>(mouse_wheel_messages_),
            static_cast<unsigned long long>(key_down_messages_),
            static_cast<unsigned long long>(raw_input_messages_),
            static_cast<unsigned long long>(polled_left_button_frames_),
            static_cast<unsigned long long>(cursor_change_samples_),
            clip_active ? L"on" : L"off");
        SetWindowTextW(window, title);
    }

private:
    static bool input_gate_marker_present()
    {
        wchar_t module_path[MAX_PATH] = {};
        const DWORD length = GetModuleFileNameW(nullptr, module_path, MAX_PATH);
        if (length == 0 || length >= MAX_PATH)
            return false;

        std::wstring marker(module_path, length);
        const std::size_t separator = marker.find_last_of(L"\\/");
        if (separator == std::wstring::npos)
            return false;
        marker.resize(separator + 1);
        marker += L"reshade-input-gate.enabled";
        return GetFileAttributesW(marker.c_str()) != INVALID_FILE_ATTRIBUTES;
    }

    static void apply_client_clip(HWND window)
    {
        RECT client = {};
        if (!GetClientRect(window, &client))
            return;

        POINT top_left = { client.left, client.top };
        POINT bottom_right = { client.right, client.bottom };
        if (!ClientToScreen(window, &top_left) || !ClientToScreen(window, &bottom_right))
            return;

        RECT screen = {
            top_left.x,
            top_left.y,
            bottom_right.x,
            bottom_right.y,
        };
        ClipCursor(&screen);
    }

    std::uint64_t mouse_move_messages_ = 0;
    std::uint64_t left_button_down_messages_ = 0;
    std::uint64_t left_button_up_messages_ = 0;
    std::uint64_t mouse_wheel_messages_ = 0;
    std::uint64_t key_down_messages_ = 0;
    std::uint64_t raw_input_messages_ = 0;
    std::uint64_t polled_left_button_frames_ = 0;
    std::uint64_t cursor_change_samples_ = 0;
    POINT last_cursor_ = {};
    ULONGLONG last_title_update_ = 0;
    bool cursor_initialized_ = false;
    bool enabled_ = false;
    bool raw_input_registered_ = false;
};
