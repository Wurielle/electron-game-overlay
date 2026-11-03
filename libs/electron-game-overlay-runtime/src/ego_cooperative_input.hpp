#pragma once

#include <cstdint>
#include <cstddef>
#include <type_traits>

namespace ego::cooperative
{
// Frozen copied-input wire record. Private ReShade API and queue layouts never
// cross the module boundary. Handles identify target-process objects only;
// neither transient RAWINPUT pointers nor a producer's queue generation appear.
#pragma pack(push, 8)
struct input_record_v1
{
    std::uint32_t struct_size = sizeof(input_record_v1);
    std::uint32_t version = 1;
    std::uint32_t source = 0, device_type = 0;
    std::uint64_t sequence = 0, target_window = 0, source_window = 0, device_handle = 0;
    std::uint64_t wparam = 0;
    std::int64_t lparam = 0;
    std::uint32_t flags = 0, message = 0, time = 0;
    std::int32_t client_x = 0, client_y = 0;
    std::uint16_t mouse_flags = 0, mouse_button_flags = 0, mouse_button_data = 0, mouse_reserved = 0;
    std::uint32_t mouse_raw_buttons = 0;
    std::int32_t mouse_last_x = 0, mouse_last_y = 0;
    std::uint32_t mouse_extra_information = 0;
    std::uint16_t keyboard_make_code = 0, keyboard_flags = 0, keyboard_virtual_key = 0, keyboard_reserved = 0;
    std::uint32_t keyboard_message = 0, keyboard_extra_information = 0;
    std::uint16_t text[4] = {};
    std::uint32_t text_length = 0;
    std::uint32_t pointer_id = 0, pointer_type = 0, pointer_key_states = 0;
    std::uint32_t pointer_primary = 0, pointer_metadata_valid = 0;
    std::uint64_t owner_participant = 0, owner_incarnation = 0;
    std::uint32_t owner_window = 0, ownership_valid = 0;
    std::uint64_t focus_participant = 0, focus_incarnation = 0;
    std::uint32_t focus_window = 0, routing_reserved = 0;
    std::int32_t canonical_x = 0, canonical_y = 0;
    std::uint32_t canonical_point_valid = 0, canonical_reserved = 0;
};
#pragma pack(pop)
static_assert(std::is_standard_layout_v<input_record_v1>);
static_assert(std::is_trivially_copyable_v<input_record_v1>);
static_assert(sizeof(input_record_v1) == 224);
static_assert(offsetof(input_record_v1, sequence) == 16);
static_assert(offsetof(input_record_v1, owner_participant) == 160);
static_assert(offsetof(input_record_v1, focus_participant) == 184);

// Private dispatcher state, not part of the copied ABI. A delayed source from
// an earlier batch must be rejected before integrating canonical raw deltas.
class source_sequence_gate
{
public:
    bool admit(std::uint64_t sequence) noexcept
    {
        if (sequence == 0 || sequence <= latest_) return false;
        latest_ = sequence;
        return true;
    }
    void discard_through(std::uint64_t sequence) noexcept
    {
        if (sequence > discarded_) discarded_ = sequence;
        if (sequence > latest_) latest_ = sequence;
    }
    bool intentionally_discarded(std::uint64_t sequence) const noexcept
    {
        return sequence <= discarded_;
    }
private:
    std::uint64_t latest_ = 0;
    std::uint64_t discarded_ = 0;
};
} // namespace ego::cooperative
