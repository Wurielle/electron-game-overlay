#ifndef ELECTRON_OVERLAY_TRANSPORT_H
#define ELECTRON_OVERLAY_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

#if !defined(_WIN64)
#error "electron-overlay-transport supports x64 Windows only"
#endif

#if defined(_MSC_VER)
#define EGO_CALL __cdecl
#else
#define EGO_CALL
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define EGO_ABI_VERSION UINT32_C(1)

typedef int32_t ego_status;

#define EGO_STATUS_OK INT32_C(0)
#define EGO_STATUS_INVALID_ARGUMENT (-INT32_C(1))
#define EGO_STATUS_ABI_MISMATCH (-INT32_C(2))
#define EGO_STATUS_BUFFER_TOO_SMALL (-INT32_C(3))
#define EGO_STATUS_INITIALIZATION_FAILED (-INT32_C(4))
#define EGO_STATUS_OUT_OF_RANGE (-INT32_C(5))
#define EGO_STATUS_INTERNAL_ERROR (-INT32_C(6))
#define EGO_STATUS_PANIC (-INT32_C(7))

typedef struct ego_transport ego_transport;
typedef struct ego_scene_snapshot ego_scene_snapshot;

/* All pointers in this view remain valid until its snapshot is released. */
typedef struct ego_window_frame_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t window_id;
    uint32_t transparent;
    int32_t rect_x;
    int32_t rect_y;
    int32_t rect_width;
    int32_t rect_height;
    uint64_t state_revision;
    uint64_t sequence;
    uint32_t raster_width;
    uint32_t raster_height;
    uint64_t row_pitch;
    const uint8_t *name_utf8;
    uint64_t name_utf8_len;
    const uint8_t *rgba;
    uint64_t rgba_len;
} ego_window_frame_v1;

typedef struct ego_input_state_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t requested_interception;
    uint32_t desired_interception;
    uint32_t effective_interception;
    uint32_t target_focused;
    uint64_t window_count;
    uint32_t pointer_captured;
    uint32_t has_topmost_window;
    uint32_t topmost_window_id;
    uint32_t has_focused_window;
    uint32_t focused_window_id;
    uint32_t has_captured_window;
    uint32_t captured_window_id;
} ego_input_state_v1;

uint32_t EGO_CALL ego_abi_version(void);

ego_status EGO_CALL ego_transport_create(
    uint32_t abi_version,
    ego_transport **out_transport);
ego_status EGO_CALL ego_transport_destroy(ego_transport *transport);

ego_status EGO_CALL ego_transport_acquire_scene(
    const ego_transport *transport,
    ego_scene_snapshot **out_snapshot);
ego_status EGO_CALL ego_scene_snapshot_release(ego_scene_snapshot *snapshot);
ego_status EGO_CALL ego_scene_snapshot_window_count(
    const ego_scene_snapshot *snapshot,
    uint64_t *out_count);
ego_status EGO_CALL ego_scene_snapshot_get_window(
    const ego_scene_snapshot *snapshot,
    uint64_t index,
    ego_window_frame_v1 *inout_frame);

ego_status EGO_CALL ego_transport_desired_interception(
    const ego_transport *transport,
    uint32_t *out_desired);
ego_status EGO_CALL ego_transport_set_target_focused(
    ego_transport *transport,
    uint32_t focused);
ego_status EGO_CALL ego_transport_apply_input_filter(
    ego_transport *transport,
    uint32_t routing_enabled,
    uint32_t acknowledge);
ego_status EGO_CALL ego_transport_get_input_state(
    const ego_transport *transport,
    ego_input_state_v1 *inout_state);

/* Observes/routes a copied message. The status is not an input-block decision. */
ego_status EGO_CALL ego_transport_route_window_message(
    ego_transport *transport,
    uintptr_t target_hwnd,
    uint32_t message,
    uint64_t wparam,
    int64_t lparam);

/* required_size includes the trailing NUL. Passing NULL/0 queries its size. */
ego_status EGO_CALL ego_get_last_error_message(
    char *buffer,
    uint64_t buffer_size,
    uint64_t *required_size);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* ELECTRON_OVERLAY_TRANSPORT_H */
