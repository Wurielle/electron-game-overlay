#include <electron_overlay_transport.h>

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <type_traits>

static_assert(EGO_ABI_VERSION == 1);
static_assert(EGO_STATUS_TIMED_OUT == -8);
static_assert(EGO_STATUS_NOT_CONNECTED == -9);
static_assert(EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS == 1000);
static_assert(std::is_standard_layout_v<ego_window_frame_v1>);
static_assert(sizeof(ego_window_frame_v1) == 96);
static_assert(offsetof(ego_window_frame_v1, state_revision) == 32);
static_assert(offsetof(ego_window_frame_v1, rgba_len) == 88);
static_assert(std::is_standard_layout_v<ego_input_state_v1>);
static_assert(sizeof(ego_input_state_v1) == 64);
static_assert(offsetof(ego_input_state_v1, window_count) == 24);
static_assert(offsetof(ego_input_state_v1, captured_window_id) == 56);
static_assert(EGO_RUNTIME_DIAGNOSTIC_ABI_VERSION == 1);
static_assert(std::is_standard_layout_v<ego_runtime_diagnostic_v1>);
static_assert(sizeof(ego_runtime_diagnostic_v1) == 16);
static_assert(offsetof(ego_runtime_diagnostic_v1, code) == 8);
static_assert(offsetof(ego_runtime_diagnostic_v1, error_code) == 12);

namespace
{
bool expect_status(const char *operation, ego_status actual, ego_status expected)
{
    if (actual == expected)
        return true;

    std::fprintf(
        stderr,
        "%s returned status %d; expected %d\n",
        operation,
        static_cast<int>(actual),
        static_cast<int>(expected));
    return false;
}

bool is_boolean(uint32_t value)
{
    return value <= 1;
}

bool is_terminal_drain_status(ego_status status)
{
    return status == EGO_STATUS_OK ||
        status == EGO_STATUS_NOT_CONNECTED ||
        status == EGO_STATUS_TIMED_OUT;
}
} // namespace

int main()
{
    if (ego_abi_version() != EGO_ABI_VERSION)
    {
        std::fprintf(
            stderr,
            "ABI version mismatch: library=%u header=%u\n",
            ego_abi_version(),
            EGO_ABI_VERSION);
        return EXIT_FAILURE;
    }

    ego_transport *incompatible_transport = nullptr;
    if (!expect_status(
            "ego_transport_create with an incompatible ABI",
            ego_transport_create(EGO_ABI_VERSION + 1, &incompatible_transport),
            EGO_STATUS_ABI_MISMATCH))
    {
        if (incompatible_transport != nullptr)
            ego_transport_destroy(incompatible_transport);
        return EXIT_FAILURE;
    }
    if (incompatible_transport != nullptr)
    {
        std::fputs("ABI-mismatched create returned a non-null transport\n", stderr);
        ego_transport_destroy(incompatible_transport);
        return EXIT_FAILURE;
    }

    ego_transport *transport = nullptr;
    if (!expect_status(
            "ego_transport_create",
            ego_transport_create(EGO_ABI_VERSION, &transport),
            EGO_STATUS_OK) ||
        transport == nullptr)
    {
        std::fputs("ego_transport_create did not return a usable transport\n", stderr);
        if (transport != nullptr)
            ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    if (!expect_status(
            "ego_transport_drain with a null transport",
            ego_transport_drain(nullptr, 1),
            EGO_STATUS_INVALID_ARGUMENT) ||
        !expect_status(
            "ego_transport_drain with a zero timeout",
            ego_transport_drain(transport, 0),
            EGO_STATUS_INVALID_ARGUMENT) ||
        !expect_status(
            "ego_transport_drain above its timeout bound",
            ego_transport_drain(
                transport,
                EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS + 1),
            EGO_STATUS_INVALID_ARGUMENT))
    {
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }
    const ego_status drain_status = ego_transport_drain(transport, 25);
    if (!is_terminal_drain_status(drain_status))
    {
        std::fprintf(
            stderr,
            "ego_transport_drain returned unexpected terminal status %d\n",
            static_cast<int>(drain_status));
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    ego_runtime_diagnostic_v1 diagnostic{};
    diagnostic.struct_size = sizeof(diagnostic);
    diagnostic.abi_version = EGO_RUNTIME_DIAGNOSTIC_ABI_VERSION;
    diagnostic.code = EGO_RUNTIME_DIAGNOSTIC_RUNTIME_READY;
    if (!expect_status(
            "ego_transport_publish_diagnostic",
            ego_transport_publish_diagnostic(transport, &diagnostic),
            EGO_STATUS_OK))
    {
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    diagnostic.code = EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED;
    diagnostic.error_code = EGO_STATUS_INTERNAL_ERROR;
    if (!expect_status(
            "ego_transport_publish_diagnostic with an EGO status",
            ego_transport_publish_diagnostic(transport, &diagnostic),
            EGO_STATUS_OK))
    {
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    diagnostic.code = UINT32_MAX;
    if (!expect_status(
            "ego_transport_publish_diagnostic with an unknown code",
            ego_transport_publish_diagnostic(transport, &diagnostic),
            EGO_STATUS_INVALID_ARGUMENT))
    {
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    ego_scene_snapshot *snapshot = nullptr;
    if (!expect_status(
            "ego_transport_acquire_scene",
            ego_transport_acquire_scene(transport, &snapshot),
            EGO_STATUS_OK) ||
        snapshot == nullptr)
    {
        std::fputs("ego_transport_acquire_scene did not return a snapshot\n", stderr);
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    uint64_t window_count = 0;
    if (!expect_status(
            "ego_scene_snapshot_window_count",
            ego_scene_snapshot_window_count(snapshot, &window_count),
            EGO_STATUS_OK))
    {
        ego_scene_snapshot_release(snapshot);
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    ego_window_frame_v1 frame{};
    frame.struct_size = sizeof(frame);
    frame.abi_version = EGO_ABI_VERSION;
    const ego_status frame_status =
        ego_scene_snapshot_get_window(snapshot, 0, &frame);
    if (window_count == 0)
    {
        if (!expect_status(
                "ego_scene_snapshot_get_window on an empty scene",
                frame_status,
                EGO_STATUS_OUT_OF_RANGE))
        {
            ego_scene_snapshot_release(snapshot);
            ego_transport_destroy(transport);
            return EXIT_FAILURE;
        }
    }
    else
    {
        if (!expect_status(
                "ego_scene_snapshot_get_window",
                frame_status,
                EGO_STATUS_OK) ||
            frame.struct_size != sizeof(frame) ||
            frame.abi_version != EGO_ABI_VERSION ||
            !is_boolean(frame.transparent) ||
            frame.row_pitch < static_cast<uint64_t>(frame.raster_width) * 4 ||
            frame.rgba_len != frame.row_pitch * frame.raster_height ||
            (frame.rgba_len != 0 && frame.rgba == nullptr) ||
            (frame.name_utf8_len != 0 && frame.name_utf8 == nullptr))
        {
            std::fputs("window frame metadata is not ABI-conformant\n", stderr);
            ego_scene_snapshot_release(snapshot);
            ego_transport_destroy(transport);
            return EXIT_FAILURE;
        }
    }

    ego_input_state_v1 undersized_state{};
    undersized_state.struct_size = sizeof(undersized_state) - 1;
    undersized_state.abi_version = EGO_ABI_VERSION;
    if (!expect_status(
            "ego_transport_get_input_state with an undersized struct",
            ego_transport_get_input_state(transport, &undersized_state),
            EGO_STATUS_BUFFER_TOO_SMALL))
    {
        ego_scene_snapshot_release(snapshot);
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    ego_input_state_v1 mismatched_state{};
    mismatched_state.struct_size = sizeof(mismatched_state);
    mismatched_state.abi_version = EGO_ABI_VERSION + 1;
    if (!expect_status(
            "ego_transport_get_input_state with an incompatible ABI",
            ego_transport_get_input_state(transport, &mismatched_state),
            EGO_STATUS_ABI_MISMATCH))
    {
        ego_scene_snapshot_release(snapshot);
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    ego_input_state_v1 input_state{};
    input_state.struct_size = sizeof(input_state);
    input_state.abi_version = EGO_ABI_VERSION;
    if (!expect_status(
            "ego_transport_get_input_state",
            ego_transport_get_input_state(transport, &input_state),
            EGO_STATUS_OK) ||
        input_state.struct_size != sizeof(input_state) ||
        input_state.abi_version != EGO_ABI_VERSION ||
        !is_boolean(input_state.requested_interception) ||
        !is_boolean(input_state.desired_interception) ||
        !is_boolean(input_state.effective_interception) ||
        !is_boolean(input_state.target_focused) ||
        !is_boolean(input_state.pointer_captured) ||
        !is_boolean(input_state.has_topmost_window) ||
        !is_boolean(input_state.has_focused_window) ||
        !is_boolean(input_state.has_captured_window))
    {
        std::fputs("input state metadata is not ABI-conformant\n", stderr);
        ego_scene_snapshot_release(snapshot);
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    uint64_t session_epoch = UINT64_MAX;
    if (!expect_status(
            "ego_transport_session_epoch",
            ego_transport_session_epoch(transport, &session_epoch),
            EGO_STATUS_OK))
    {
        std::fputs("producer session epoch is not ABI-conformant\n", stderr);
        ego_scene_snapshot_release(snapshot);
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    const ego_status release_status = ego_scene_snapshot_release(snapshot);
    snapshot = nullptr;
    if (!expect_status(
            "ego_scene_snapshot_release",
            release_status,
            EGO_STATUS_OK))
    {
        ego_transport_destroy(transport);
        return EXIT_FAILURE;
    }

    const ego_status destroy_status = ego_transport_destroy(transport);
    transport = nullptr;
    if (!expect_status("ego_transport_destroy", destroy_status, EGO_STATUS_OK))
        return EXIT_FAILURE;

    std::printf(
        "electron overlay transport ABI smoke passed (version=%u, windows=%llu)\n",
        EGO_ABI_VERSION,
        static_cast<unsigned long long>(window_count));
    return EXIT_SUCCESS;
}
