#pragma once

#include <Windows.h>

#include <array>
#include <cstdint>
#include <cwchar>
#include <string>

class input_oracle
{
public:
    input_oracle() : mode_(detect_input_gate_mode()) {}

    bool initialize(HWND window)
    {
        if (initialized_)
            return initialization_succeeded_;

        initialized_ = true;
        if (mode_ == input_gate_mode::disabled)
            return true;

        RAWINPUTDEVICE devices[2] = {};
        devices[0].usUsagePage = 0x01;
        devices[0].usUsage = 0x02;
        devices[0].dwFlags = raw_only() ? RIDEV_NOLEGACY : 0;
        devices[0].hwndTarget = window;
        devices[1].usUsagePage = 0x01;
        devices[1].usUsage = 0x06;
        devices[1].dwFlags = raw_only() ? RIDEV_NOLEGACY : 0;
        devices[1].hwndTarget = window;
        raw_input_registered_ =
            RegisterRawInputDevices(devices, 2, sizeof(RAWINPUTDEVICE)) != FALSE;
        mouse_in_pointer_enabled_ =
            EnableMouseInPointer(TRUE) != FALSE || IsMouseInPointerEnabled() != FALSE;
        if (GetForegroundWindow() == window || GetFocus() == window)
            apply_client_clip(window);
        initialization_succeeded_ =
            raw_input_registered_ && mouse_in_pointer_enabled_;
        return initialization_succeeded_;
    }

    bool registration_before_injection_requested() const
    {
        return raw_only() && marker_present(
            executable_directory(),
            L"reshade-raw-registration-before-injection.enabled");
    }

    void shutdown()
    {
        if (mode_ == input_gate_mode::disabled)
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

    void observe_window_message(
        HWND window,
        UINT message,
        WPARAM w_param,
        LPARAM l_param)
    {
        if (mode_ == input_gate_mode::disabled)
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
            if (mode_ == input_gate_mode::raw_window_message)
                observe_raw_input_handle(w_param, l_param);
            break;
        case WM_POINTERUPDATE:
            ++pointer_update_messages_;
            break;
        case WM_POINTERDOWN:
            ++pointer_down_messages_;
            break;
        case WM_POINTERUP:
            ++pointer_up_messages_;
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

    bool peek_next_message(MSG &message)
    {
        if (mode_ != input_gate_mode::raw_buffer)
            return PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE) != FALSE;

        drain_raw_input_buffer();
        if (PeekMessageW(
                &message,
                nullptr,
                0,
                WM_INPUT - 1,
                PM_REMOVE) != FALSE)
        {
            return true;
        }
        return PeekMessageW(
                   &message,
                   nullptr,
                   WM_INPUT + 1,
                   UINT_MAX,
                   PM_REMOVE) != FALSE;
    }

    void sample_and_publish(HWND window, const wchar_t *base_title)
    {
        if (mode_ == input_gate_mode::disabled)
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
            L"%s | game input: move=%llu down=%llu up=%llu wheel=%llu key=%llu raw=%llu ptr=%llu/%llu/%llu poll-left=%llu cursor-change=%llu raw-accepted=%llu/%llu/%llu/%llu/%llu/%llu buffer=%llu buffer-error=%lu mode=%s clip=%s",
            base_title,
            static_cast<unsigned long long>(mouse_move_messages_),
            static_cast<unsigned long long>(left_button_down_messages_),
            static_cast<unsigned long long>(left_button_up_messages_),
            static_cast<unsigned long long>(mouse_wheel_messages_),
            static_cast<unsigned long long>(key_down_messages_),
            static_cast<unsigned long long>(raw_input_messages_),
            static_cast<unsigned long long>(pointer_update_messages_),
            static_cast<unsigned long long>(pointer_down_messages_),
            static_cast<unsigned long long>(pointer_up_messages_),
            static_cast<unsigned long long>(polled_left_button_frames_),
            static_cast<unsigned long long>(cursor_change_samples_),
            static_cast<unsigned long long>(raw_mouse_move_records_),
            static_cast<unsigned long long>(raw_mouse_down_records_),
            static_cast<unsigned long long>(raw_mouse_up_records_),
            static_cast<unsigned long long>(raw_mouse_wheel_records_),
            static_cast<unsigned long long>(raw_key_down_records_),
            static_cast<unsigned long long>(raw_key_up_records_),
            static_cast<unsigned long long>(raw_buffer_batches_),
            static_cast<unsigned long>(raw_buffer_error_),
            mode_name(),
            clip_active ? L"on" : L"off");
        SetWindowTextW(window, title);
    }

private:
    enum class input_gate_mode : std::uint8_t
    {
        disabled,
        legacy,
        raw_window_message,
        raw_buffer,
    };

    static std::wstring executable_directory()
    {
        wchar_t module_path[MAX_PATH] = {};
        const DWORD length = GetModuleFileNameW(nullptr, module_path, MAX_PATH);
        if (length == 0 || length >= MAX_PATH)
            return {};

        std::wstring directory(module_path, length);
        const std::size_t separator = directory.find_last_of(L"\\/");
        if (separator == std::wstring::npos)
            return {};
        directory.resize(separator + 1);
        return directory;
    }

    static bool marker_present(
        const std::wstring &directory,
        const wchar_t *name)
    {
        if (directory.empty())
            return false;
        return GetFileAttributesW((directory + name).c_str()) !=
            INVALID_FILE_ATTRIBUTES;
    }

    static input_gate_mode detect_input_gate_mode()
    {
        const std::wstring directory = executable_directory();
        if (marker_present(directory, L"reshade-raw-buffer-input-gate.enabled"))
            return input_gate_mode::raw_buffer;
        if (marker_present(directory, L"reshade-raw-wm-input-gate.enabled"))
            return input_gate_mode::raw_window_message;
        if (marker_present(directory, L"reshade-input-gate.enabled"))
            return input_gate_mode::legacy;
        return input_gate_mode::disabled;
    }

    bool raw_only() const
    {
        return mode_ == input_gate_mode::raw_window_message ||
            mode_ == input_gate_mode::raw_buffer;
    }

    const wchar_t *mode_name() const
    {
        switch (mode_)
        {
        case input_gate_mode::legacy:
            return L"legacy";
        case input_gate_mode::raw_window_message:
            return L"wm-input";
        case input_gate_mode::raw_buffer:
            return L"raw-buffer";
        default:
            return L"disabled";
        }
    }

    bool observe_raw_record(const RAWINPUT &raw)
    {
        if (GET_RAWINPUT_CODE_WPARAM(raw.header.wParam) != RIM_INPUT)
            return false;

        if (raw.header.dwType == RIM_TYPEMOUSE)
        {
            const RAWMOUSE &mouse = raw.data.mouse;
            if ((mouse.usFlags & MOUSE_MOVE_ABSOLUTE) != 0 ||
                mouse.lLastX != 0 ||
                mouse.lLastY != 0)
            {
                ++raw_mouse_move_records_;
            }
            constexpr USHORT down_flags =
                RI_MOUSE_LEFT_BUTTON_DOWN |
                RI_MOUSE_RIGHT_BUTTON_DOWN |
                RI_MOUSE_MIDDLE_BUTTON_DOWN;
            constexpr USHORT up_flags =
                RI_MOUSE_LEFT_BUTTON_UP |
                RI_MOUSE_RIGHT_BUTTON_UP |
                RI_MOUSE_MIDDLE_BUTTON_UP;
            if ((mouse.usButtonFlags & down_flags) != 0)
                ++raw_mouse_down_records_;
            if ((mouse.usButtonFlags & up_flags) != 0)
                ++raw_mouse_up_records_;
            if ((mouse.usButtonFlags &
                 (RI_MOUSE_WHEEL | RI_MOUSE_HWHEEL)) != 0)
            {
                ++raw_mouse_wheel_records_;
            }
        }
        else if (raw.header.dwType == RIM_TYPEKEYBOARD)
        {
            if (raw.data.keyboard.VKey == 0)
                return false;
            if ((raw.data.keyboard.Flags & RI_KEY_BREAK) == 0)
                ++raw_key_down_records_;
            else
                ++raw_key_up_records_;
        }
        else
        {
            return false;
        }
        return true;
    }

    void observe_raw_input_handle(WPARAM w_param, LPARAM l_param)
    {
        if (GET_RAWINPUT_CODE_WPARAM(w_param) != RIM_INPUT)
            return;
        RAWINPUT raw = {};
        UINT size = sizeof(raw);
        if (GetRawInputData(
                reinterpret_cast<HRAWINPUT>(l_param),
                RID_INPUT,
                &raw,
                &size,
                sizeof(RAWINPUTHEADER)) == UINT_MAX)
        {
            return;
        }
        static_cast<void>(observe_raw_record(raw));
    }

    void drain_raw_input_buffer()
    {
        using QWORD = UINT64;
        for (;;)
        {
            UINT bytes = static_cast<UINT>(
                raw_buffer_storage_.size() * sizeof(raw_buffer_storage_[0]));
            const UINT count = GetRawInputBuffer(
                reinterpret_cast<PRAWINPUT>(raw_buffer_storage_.data()),
                &bytes,
                sizeof(RAWINPUTHEADER));
            if (count == UINT_MAX)
            {
                raw_buffer_error_ = GetLastError();
                if (raw_buffer_error_ == ERROR_SUCCESS)
                    raw_buffer_error_ = ERROR_GEN_FAILURE;
                return;
            }
            if (count == 0)
                return;

            bool accepted = false;
            PRAWINPUT raw = reinterpret_cast<PRAWINPUT>(
                raw_buffer_storage_.data());
            for (UINT index = 0; index < count; ++index)
            {
                accepted = observe_raw_record(*raw) || accepted;
                raw = NEXTRAWINPUTBLOCK(raw);
            }
            if (accepted)
                ++raw_buffer_batches_;
        }
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
    std::uint64_t pointer_update_messages_ = 0;
    std::uint64_t pointer_down_messages_ = 0;
    std::uint64_t pointer_up_messages_ = 0;
    std::uint64_t polled_left_button_frames_ = 0;
    std::uint64_t cursor_change_samples_ = 0;
    std::uint64_t raw_mouse_move_records_ = 0;
    std::uint64_t raw_mouse_down_records_ = 0;
    std::uint64_t raw_mouse_up_records_ = 0;
    std::uint64_t raw_mouse_wheel_records_ = 0;
    std::uint64_t raw_key_down_records_ = 0;
    std::uint64_t raw_key_up_records_ = 0;
    std::uint64_t raw_buffer_batches_ = 0;
    DWORD raw_buffer_error_ = ERROR_SUCCESS;
    POINT last_cursor_ = {};
    ULONGLONG last_title_update_ = 0;
    bool cursor_initialized_ = false;
    input_gate_mode mode_ = input_gate_mode::disabled;
    bool raw_input_registered_ = false;
    bool mouse_in_pointer_enabled_ = false;
    bool initialized_ = false;
    bool initialization_succeeded_ = true;
    std::array<std::uint64_t, (64 * 1024) / sizeof(std::uint64_t)>
        raw_buffer_storage_ = {};
};
