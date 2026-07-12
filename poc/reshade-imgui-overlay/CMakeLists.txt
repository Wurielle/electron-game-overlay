cmake_minimum_required(VERSION 3.24)

project(reshade_imgui_overlay_poc LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "The ReShade ImGui overlay POC only supports Windows.")
endif()

if(NOT MSVC)
    message(FATAL_ERROR "The POC is currently verified with MSVC only.")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "The first POC is intentionally x64-only.")
endif()

include(FetchContent)

# ReShade's add-on ABI is tied to the headers from the runtime release. Its
# ImGui bridge also checks for the exact ImGui version used by that release.
# Immutable commits keep those two inputs reproducible.
FetchContent_Declare(
    reshade
    GIT_REPOSITORY https://github.com/crosire/reshade.git
    GIT_TAG 4a50d1eddace85734871d91792ff214f13f66c01
    GIT_SHALLOW TRUE
    GIT_PROGRESS TRUE
    GIT_SUBMODULES ""
    GIT_SUBMODULES_RECURSE FALSE
    SOURCE_SUBDIR _headers_only
)

FetchContent_Declare(
    imgui
    GIT_REPOSITORY https://github.com/ocornut/imgui.git
    GIT_TAG 3912b3d9a9c1b3f17431aebafd86d2f40ee6e59c
    GIT_SHALLOW TRUE
    GIT_PROGRESS TRUE
    SOURCE_SUBDIR _headers_only
)

FetchContent_MakeAvailable(reshade imgui)

add_library(alternative_imgui_overlay_poc SHARED
    src/overlay_addon.cpp
)

target_compile_features(alternative_imgui_overlay_poc PRIVATE cxx_std_20)
target_compile_definitions(alternative_imgui_overlay_poc PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
    ImTextureID=ImU64
)
target_compile_options(alternative_imgui_overlay_poc PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_include_directories(alternative_imgui_overlay_poc PRIVATE
    "${reshade_SOURCE_DIR}/include"
    "${imgui_SOURCE_DIR}"
)
set_target_properties(alternative_imgui_overlay_poc PROPERTIES
    OUTPUT_NAME "alternative_imgui_overlay_poc"
    PREFIX ""
    SUFFIX ".addon64"
)

add_executable(d3d11_overlay_test_host WIN32
    src/d3d11_test_host.cpp
    src/input_oracle.hpp
)

target_compile_features(d3d11_overlay_test_host PRIVATE cxx_std_20)
target_compile_definitions(d3d11_overlay_test_host PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
)
target_compile_options(d3d11_overlay_test_host PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_link_libraries(d3d11_overlay_test_host PRIVATE
    d3d11
    dxgi
)

add_custom_command(TARGET d3d11_overlay_test_host POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "$<TARGET_FILE:alternative_imgui_overlay_poc>"
        "$<TARGET_FILE_DIR:d3d11_overlay_test_host>"
    COMMENT "Copying the ReShade add-on next to the controlled D3D11 host"
)
add_dependencies(d3d11_overlay_test_host alternative_imgui_overlay_poc)

add_executable(d3d12_overlay_test_host WIN32
    src/d3d12_test_host.cpp
    src/input_oracle.hpp
)

target_compile_features(d3d12_overlay_test_host PRIVATE cxx_std_20)
target_compile_definitions(d3d12_overlay_test_host PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
)
target_compile_options(d3d12_overlay_test_host PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_link_libraries(d3d12_overlay_test_host PRIVATE
    d3d12
    dxgi
)

add_custom_command(TARGET d3d12_overlay_test_host POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "$<TARGET_FILE:alternative_imgui_overlay_poc>"
        "$<TARGET_FILE_DIR:d3d12_overlay_test_host>"
    COMMENT "Copying the ReShade add-on next to the controlled D3D12 host"
)
add_dependencies(d3d12_overlay_test_host alternative_imgui_overlay_poc)
