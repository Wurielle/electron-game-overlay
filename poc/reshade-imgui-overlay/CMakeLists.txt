cmake_minimum_required(VERSION 3.24)

project(reshade_imgui_overlay_poc LANGUAGES CXX)

option(
    RESHADE_BUILD_ELECTRON_CORE
    "Build and link the backend-neutral Electron overlay core ABI smoke test"
    OFF
)

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

if(RESHADE_BUILD_ELECTRON_CORE)
    enable_testing()

    find_program(CARGO_EXECUTABLE cargo REQUIRED)

    set(ELECTRON_CORE_SOURCE_DIR
        "${CMAKE_CURRENT_SOURCE_DIR}/../electron-overlay-core"
    )
    set(ELECTRON_CORE_CARGO_TARGET_DIR
        "${CMAKE_CURRENT_BINARY_DIR}/cargo"
    )
    set(ELECTRON_CORE_CARGO_LIBRARY
        "${ELECTRON_CORE_CARGO_TARGET_DIR}/x86_64-pc-windows-msvc/release/electron_overlay_core.lib"
    )
    set(ELECTRON_CORE_STAGING_DIR
        "${CMAKE_CURRENT_BINARY_DIR}/electron-overlay-core"
    )
    set(ELECTRON_CORE_STAGED_LIBRARY
        "${ELECTRON_CORE_STAGING_DIR}/electron_overlay_core.lib"
    )

    file(GLOB_RECURSE ELECTRON_CORE_RUST_SOURCES CONFIGURE_DEPENDS
        "${ELECTRON_CORE_SOURCE_DIR}/src/*.rs"
    )

    add_custom_command(
        OUTPUT "${ELECTRON_CORE_STAGED_LIBRARY}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory
            "${ELECTRON_CORE_STAGING_DIR}"
        COMMAND "${CARGO_EXECUTABLE}" build
            --manifest-path "${ELECTRON_CORE_SOURCE_DIR}/Cargo.toml"
            --locked
            --release
            --target x86_64-pc-windows-msvc
            --target-dir "${ELECTRON_CORE_CARGO_TARGET_DIR}"
        COMMAND "${CMAKE_COMMAND}" -E copy
            "${ELECTRON_CORE_CARGO_LIBRARY}"
            "${ELECTRON_CORE_STAGED_LIBRARY}"
        DEPENDS
            "${ELECTRON_CORE_SOURCE_DIR}/Cargo.toml"
            "${ELECTRON_CORE_SOURCE_DIR}/Cargo.lock"
            ${ELECTRON_CORE_RUST_SOURCES}
        WORKING_DIRECTORY "${ELECTRON_CORE_SOURCE_DIR}"
        COMMENT "Building and staging the Electron overlay core Rust static library"
        USES_TERMINAL
        VERBATIM
    )

    add_custom_target(electron_overlay_core_cargo
        DEPENDS "${ELECTRON_CORE_STAGED_LIBRARY}"
    )

    add_library(electron_overlay_core STATIC IMPORTED GLOBAL)
    set_target_properties(electron_overlay_core PROPERTIES
        IMPORTED_LOCATION "${ELECTRON_CORE_STAGED_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${ELECTRON_CORE_SOURCE_DIR}/include"
        INTERFACE_LINK_LIBRARIES "kernel32;ntdll;userenv;ws2_32;dbghelp"
    )
    add_dependencies(electron_overlay_core electron_overlay_core_cargo)

    add_executable(electron_core_abi_smoke
        src/electron_core_abi_smoke.cpp
    )
    target_compile_features(electron_core_abi_smoke PRIVATE cxx_std_20)
    target_compile_definitions(electron_core_abi_smoke PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
    )
    target_compile_options(electron_core_abi_smoke PRIVATE
        /W4
        /permissive-
        /EHsc
    )
    target_link_libraries(electron_core_abi_smoke PRIVATE
        electron_overlay_core
    )
    set_target_properties(electron_core_abi_smoke PROPERTIES
        MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
    )

    add_library(electron_reshade_overlay_poc SHARED
        src/electron_overlay_addon.cpp
    )
    target_compile_features(electron_reshade_overlay_poc PRIVATE cxx_std_20)
    target_compile_definitions(electron_reshade_overlay_poc PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        UNICODE
        _UNICODE
        ImTextureID=ImU64
    )
    target_compile_options(electron_reshade_overlay_poc PRIVATE
        /W4
        /permissive-
        /EHsc
    )
    target_include_directories(electron_reshade_overlay_poc PRIVATE
        "${reshade_SOURCE_DIR}/include"
        "${imgui_SOURCE_DIR}"
    )
    target_link_libraries(electron_reshade_overlay_poc PRIVATE
        electron_overlay_core
    )
    set_target_properties(electron_reshade_overlay_poc PROPERTIES
        OUTPUT_NAME "electron_reshade_overlay_poc"
        PREFIX ""
        SUFFIX ".addon64"
        MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
    )

    add_test(
        NAME electron_core_abi_smoke
        COMMAND electron_core_abi_smoke
    )
endif()
