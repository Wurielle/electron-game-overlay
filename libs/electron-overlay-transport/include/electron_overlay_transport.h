#ifndef ELECTRON_OVERLAY_TRANSPORT_H
#define ELECTRON_OVERLAY_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

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
#define EGO_STATUS_TIMED_OUT (-INT32_C(8))
#define EGO_STATUS_NOT_CONNECTED (-INT32_C(9))

#define EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS UINT32_C(1000)
#define EGO_TRANSPORT_DIRECTORY_MAX_UTF8_BYTES UINT64_C(131068)

#define EGO_RUNTIME_DIAGNOSTIC_ABI_VERSION UINT32_C(1)
#define EGO_RUNTIME_DIAGNOSTIC_RUNTIME_READY UINT32_C(1)
#define EGO_RUNTIME_DIAGNOSTIC_SWAPCHAIN_READY UINT32_C(2)
#define EGO_RUNTIME_DIAGNOSTIC_SCENE_QUERY_FAILED UINT32_C(3)
#define EGO_RUNTIME_DIAGNOSTIC_SCENE_RENDERING_STARTED UINT32_C(4)
#define EGO_RUNTIME_DIAGNOSTIC_FRAME_REJECTED UINT32_C(5)
#define EGO_RUNTIME_DIAGNOSTIC_FRAME_UPLOAD_FAILED UINT32_C(6)
#define EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTER_RESET UINT32_C(7)
#define EGO_RUNTIME_DIAGNOSTIC_INPUT_ROUTING_FAILED UINT32_C(8)

#define EGO_GRAPHICS_API_UNKNOWN UINT32_C(0)
#define EGO_GRAPHICS_API_D3D9 UINT32_C(0x9000)
#define EGO_GRAPHICS_API_D3D10 UINT32_C(0xa000)
#define EGO_GRAPHICS_API_D3D11 UINT32_C(0xb000)
#define EGO_GRAPHICS_API_D3D12 UINT32_C(0xc000)
#define EGO_GRAPHICS_API_OPENGL UINT32_C(0x10000)
#define EGO_GRAPHICS_API_VULKAN UINT32_C(0x20000)

#define EGO_TARGET_SURFACE_FOCUSED UINT32_C(1)
#define EGO_TARGET_SURFACE_MINIMIZED UINT32_C(2)
#define EGO_TARGET_SURFACE_VISIBLE UINT32_C(4)
#define EGO_TARGET_SURFACE_FULLSCREEN UINT32_C(8)

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

typedef struct ego_target_surface_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t surface_id;
    uint64_t target_hwnd;
    uint64_t monitor_handle;
    uint64_t revision;
    uint32_t graphics_api;
    uint32_t render_width;
    uint32_t render_height;
    int32_t client_screen_x;
    int32_t client_screen_y;
    uint32_t client_width;
    uint32_t client_height;
    int32_t window_screen_x;
    int32_t window_screen_y;
    uint32_t window_width;
    uint32_t window_height;
    uint32_t dpi_x;
    uint32_t dpi_y;
    int32_t monitor_x;
    int32_t monitor_y;
    uint32_t monitor_width;
    uint32_t monitor_height;
    int32_t work_x;
    int32_t work_y;
    uint32_t work_width;
    uint32_t work_height;
    uint32_t state_flags;
} ego_target_surface_v1;

typedef struct ego_runtime_diagnostic_v1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t code;
    int32_t error_code;
} ego_runtime_diagnostic_v1;

uint32_t EGO_CALL ego_abi_version(void);

ego_status EGO_CALL ego_transport_create(
    uint32_t abi_version,
    ego_transport **out_transport);
/*
 * Participant-private discovery, independent of the target process environment.
 * directory_utf8 is an absolute Windows directory without a trailing NUL; its
 * bytes are copied synchronously. Length is in [1,
 * EGO_TRANSPORT_DIRECTORY_MAX_UTF8_BYTES] and the decoded path is at most 32767
 * UTF-16 code units. No system/global discovery fallback is permitted.
 */
ego_status EGO_CALL ego_transport_create_for_directory(
    uint32_t abi_version,
    const uint8_t *directory_utf8,
    uint64_t directory_utf8_len,
    ego_transport **out_transport);
ego_status EGO_CALL ego_transport_destroy(ego_transport *transport);
/*
 * Waits until packets published before this call are written to the current
 * loopback socket. timeout_ms must be in [1,
 * EGO_TRANSPORT_DRAIN_MAX_TIMEOUT_MS]. This is not a host acknowledgement.
 */
ego_status EGO_CALL ego_transport_drain(
    ego_transport *transport,
    uint32_t timeout_ms);

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
/* Registration identity paired with this immutable snapshot's window/pixels. */
ego_status EGO_CALL ego_scene_snapshot_window_incarnation(
    const ego_scene_snapshot *snapshot,
    uint64_t index,
    uint64_t *out_incarnation);
/* All live registrations, including those temporarily awaiting frame pixels. */
ego_status EGO_CALL ego_scene_snapshot_registration_count(
    const ego_scene_snapshot *snapshot,
    uint64_t *out_count);
ego_status EGO_CALL ego_scene_snapshot_get_registration(
    const ego_scene_snapshot *snapshot,
    uint64_t index,
    uint32_t *out_window_id,
    uint64_t *out_incarnation);

ego_status EGO_CALL ego_transport_cursor_at(const ego_transport *transport, int32_t x, int32_t y, int32_t *out_cursor);

ego_status EGO_CALL ego_transport_desired_interception(
    const ego_transport *transport,
    uint32_t *out_desired);
#define EGO_SESSION_EPOCH_ACTIVE_BIT UINT64_C(1)
/*
 * Zero is the initial dormant producer-session epoch. Every authenticated
 * session start and disconnect increments it once, so odd epochs are active
 * and even epochs are dormant.
 */
ego_status EGO_CALL ego_transport_session_epoch(
    const ego_transport *transport,
    uint64_t *out_epoch);
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
/* Atomically samples input eligibility/request state with its revision token. */
ego_status EGO_CALL ego_transport_get_cooperative_input_state(
    const ego_transport *transport,
    ego_input_state_v1 *inout_state,
    uint64_t *out_revision);

ego_status EGO_CALL ego_transport_publish_target_surface(
    ego_transport *transport,
    const ego_target_surface_v1 *surface);
ego_status EGO_CALL ego_transport_remove_target_surface(
    ego_transport *transport,
    uint64_t surface_id,
    uint64_t revision);
ego_status EGO_CALL ego_transport_publish_fps(
    ego_transport *transport,
    uint32_t fps_milli);
ego_status EGO_CALL ego_transport_publish_diagnostic(
    ego_transport *transport,
    const ego_runtime_diagnostic_v1 *diagnostic);

/* Observes/routes a copied message. The status is not an input-block decision. */
ego_status EGO_CALL ego_transport_route_window_message(
    ego_transport *transport,
    uintptr_t target_hwnd,
    uint32_t message,
    uint64_t wparam,
    int64_t lparam);

/* Owner-local geometry/alpha hit testing in physical game-client pixels. */
ego_status EGO_CALL ego_transport_hit_test_window(
    const ego_transport *transport,
    uint32_t window_id,
    uint64_t incarnation,
    int32_t x,
    int32_t y,
    uint32_t *out_hit);

/* Current registration identity, including unpainted windows; zero means absent. */
ego_status EGO_CALL ego_transport_window_incarnation(
    const ego_transport *transport,
    uint32_t window_id,
    uint64_t *out_incarnation);

/*
 * Next ordered SDK focus command after the acknowledged revision. revision==0
 * means none pending. Repeating after_revision repeats the same command; only
 * acknowledged older entries are removed. Grants/clicks do not add commands.
 */
ego_status EGO_CALL ego_transport_cooperative_focus_request(
    const ego_transport *transport,
    uint64_t after_revision,
    uint64_t *out_revision,
    uint32_t *out_window_id,
    uint64_t *out_incarnation,
    uint32_t *out_focused);

/* Applies global ownership; focused_window_id==0 blurs this participant only. */
ego_status EGO_CALL ego_transport_set_cooperative_focus(
    ego_transport *transport,
    uint32_t focused_window_id,
    uint64_t incarnation);

/* Aggregate OR routing policy; the producer's own requested flag is retained. */
ego_status EGO_CALL ego_transport_set_cooperative_interception(
    ego_transport *transport,
    uint32_t global_requested);
/* A stale token cannot acknowledge a newer producer request/eligibility state. */
ego_status EGO_CALL ego_transport_set_cooperative_interception_checked(
    ego_transport *transport,
    uint32_t global_requested,
    uint64_t sampled_revision);

/* Full participant retirement, including capture/drag cleanup and blur. */
ego_status EGO_CALL ego_transport_release_cooperative_ownership(
    ego_transport *transport);

/* Cursor belonging to the exact global hit/capture owner, with no fallback. */
ego_status EGO_CALL ego_transport_cursor_for_window(
    const ego_transport *transport,
    uint32_t window_id,
    uint64_t incarnation,
    int32_t *out_cursor);

/*
 * Routes through this owner's existing input implementation to the selected
 * local window only. window_id==0 drops without any local-stack fallback.
 */
ego_status EGO_CALL ego_transport_route_owned_window_message(
    ego_transport *transport,
    uint32_t window_id,
    uint64_t incarnation,
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
