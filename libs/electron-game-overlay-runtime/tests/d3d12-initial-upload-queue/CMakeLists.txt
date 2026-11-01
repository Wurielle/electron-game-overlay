cmake_minimum_required(VERSION 3.24)
project(d3d12_initial_upload_queue_fixture LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This controlled console fixture requires Windows and MSVC.")
endif()
if(NOT RESHADE_INCLUDE_DIR OR NOT EXISTS "${RESHADE_INCLUDE_DIR}/reshade_api_device.hpp")
    message(FATAL_ERROR "RESHADE_INCLUDE_DIR must identify the pinned public ReShade headers.")
endif()

set(initial_upload_helper "${CMAKE_CURRENT_SOURCE_DIR}/../../src/ego_initial_texture_upload.hpp")
file(SHA256 "${initial_upload_helper}" initial_upload_helper_sha256)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${initial_upload_helper}")

add_executable(d3d12_initial_upload_queue host.cpp)
target_compile_features(d3d12_initial_upload_queue PRIVATE cxx_std_17)
target_include_directories(d3d12_initial_upload_queue PRIVATE "${RESHADE_INCLUDE_DIR}")
target_compile_definitions(d3d12_initial_upload_queue PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN
    EGO_INITIAL_UPLOAD_HELPER_SHA256="${initial_upload_helper_sha256}")
target_compile_options(d3d12_initial_upload_queue PRIVATE /W4 /permissive- /EHsc)
target_link_options(d3d12_initial_upload_queue PRIVATE /INCREMENTAL:NO)
target_link_libraries(d3d12_initial_upload_queue PRIVATE d3d12 dxgi dxguid)
