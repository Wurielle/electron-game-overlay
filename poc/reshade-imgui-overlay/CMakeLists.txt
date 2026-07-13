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
find_package(Git REQUIRED)

set(RESHAPE_PINNED_COMMIT "4a50d1eddace85734871d91792ff214f13f66c01")
set(RESHAPE_SOURCE_PATCHES
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-input-observer.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-base-path.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-pointer-input-block.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-exact-pid.patch"
)
set(RESHAPE_EXPECTED_PATCHED_FILES
    "include/reshade.hpp"
    "include/reshade_api.hpp"
    "include/reshade_events.hpp"
    "source/addon_manager.cpp"
    "source/addon_manager.hpp"
    "source/input.cpp"
    "source/input.hpp"
    "tools/injector.cpp"
)
set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
    "include/reshade.hpp=CC102FA21D311B85713ED167F0E182A4EECCD40CDF3FBE360AD9F83A0CF40767"
    "include/reshade_api.hpp=80E9F0CBC06BF96943DC79CA2D133DB5D8E69D3A4CD516B6D89D675B8B965218"
    "include/reshade_events.hpp=8090912CD69854818C294F7C0F848EBAB7C712AB6D601E6889E62514249EE6A7"
    "source/addon_manager.cpp=1023CA3F0A271855CAF9B3D47B03D54443B60433B16EB0C2ED5023B26046046C"
    "source/addon_manager.hpp=C1D27EA4C9996F1EAD408FAD0D0DB3AEEAE16A4BEFEB4A0F71EC6C616116989B"
    "source/input.cpp=4C53B31266E281479348913E2911CB7182843CFCB6D4063B571BECECF3F5BB2F"
    "source/input.hpp=C772470BC1AA003E3D6BD0C6E29B01CCE3B0F6CCF4F42E60B73EA9FCA6D12B2C"
    "tools/injector.cpp=C1518DC282BDCAAB0D5F7ECA7AC9AA6042F3D9FB2AD545DE9FDD42F7DABAB5E8"
)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    ${RESHAPE_SOURCE_PATCHES}
)

function(verify_reshade_pinned_commit source_dir)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" rev-parse HEAD
        WORKING_DIRECTORY "${source_dir}"
        RESULT_VARIABLE RESHAPE_COMMIT_RESULT
        OUTPUT_VARIABLE RESHAPE_ACTUAL_COMMIT
        ERROR_VARIABLE RESHAPE_COMMIT_ERROR
        OUTPUT_STRIP_TRAILING_WHITESPACE
    )
    if(NOT RESHAPE_COMMIT_RESULT EQUAL 0 OR
        NOT RESHAPE_ACTUAL_COMMIT STREQUAL RESHAPE_PINNED_COMMIT)
        message(FATAL_ERROR
            "Fetched ReShade source is not the pinned commit "
            "${RESHAPE_PINNED_COMMIT}.\n"
            "Actual commit: '${RESHAPE_ACTUAL_COMMIT}'\n"
            "${RESHAPE_COMMIT_ERROR}"
        )
    endif()
endfunction()

function(verify_reshade_patched_source source_dir)
    verify_reshade_pinned_commit("${source_dir}")

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" status --porcelain=v1
            --untracked-files=all --ignore-submodules=none
        WORKING_DIRECTORY "${source_dir}"
        RESULT_VARIABLE RESHAPE_STATUS_RESULT
        OUTPUT_VARIABLE RESHAPE_STATUS_OUTPUT
        ERROR_VARIABLE RESHAPE_STATUS_ERROR
        OUTPUT_STRIP_TRAILING_WHITESPACE
    )
    if(NOT RESHAPE_STATUS_RESULT EQUAL 0)
        message(FATAL_ERROR
            "Unable to inspect the fetched ReShade source state.\n"
            "${RESHAPE_STATUS_ERROR}"
        )
    endif()

    string(REPLACE "\r\n" "\n" RESHAPE_STATUS_OUTPUT
        "${RESHAPE_STATUS_OUTPUT}")
    string(REPLACE "\r" "\n" RESHAPE_STATUS_OUTPUT
        "${RESHAPE_STATUS_OUTPUT}")
    set(RESHAPE_ACTUAL_PATCHED_FILES)
    if(NOT RESHAPE_STATUS_OUTPUT STREQUAL "")
        string(REPLACE "\n" ";" RESHAPE_STATUS_LINES
            "${RESHAPE_STATUS_OUTPUT}")
        foreach(RESHAPE_STATUS_LINE IN LISTS RESHAPE_STATUS_LINES)
            string(LENGTH "${RESHAPE_STATUS_LINE}" RESHAPE_STATUS_LINE_LENGTH)
            if(RESHAPE_STATUS_LINE_LENGTH LESS 4)
                message(FATAL_ERROR
                    "Unexpected entry in fetched ReShade status: "
                    "'${RESHAPE_STATUS_LINE}'"
                )
            endif()
            string(SUBSTRING "${RESHAPE_STATUS_LINE}" 3 -1
                RESHAPE_STATUS_PATH)
            list(APPEND RESHAPE_ACTUAL_PATCHED_FILES "${RESHAPE_STATUS_PATH}")
        endforeach()
    endif()

    set(RESHAPE_SORTED_EXPECTED_FILES ${RESHAPE_EXPECTED_PATCHED_FILES})
    list(SORT RESHAPE_SORTED_EXPECTED_FILES)
    list(SORT RESHAPE_ACTUAL_PATCHED_FILES)
    list(JOIN RESHAPE_SORTED_EXPECTED_FILES "\n"
        RESHAPE_EXPECTED_FILES_TEXT)
    list(JOIN RESHAPE_ACTUAL_PATCHED_FILES "\n"
        RESHAPE_ACTUAL_FILES_TEXT)
    if(NOT RESHAPE_ACTUAL_FILES_TEXT STREQUAL RESHAPE_EXPECTED_FILES_TEXT)
        message(FATAL_ERROR
            "The fetched ReShade tree does not contain exactly the eight "
            "pinned modified files.\n"
            "Expected:\n${RESHAPE_EXPECTED_FILES_TEXT}\n"
            "Actual:\n${RESHAPE_ACTUAL_FILES_TEXT}"
        )
    endif()

    foreach(RESHAPE_CONTENT_ENTRY IN LISTS
        RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256)
        string(FIND "${RESHAPE_CONTENT_ENTRY}" "=" RESHAPE_HASH_SEPARATOR)
        if(RESHAPE_HASH_SEPARATOR LESS 1)
            message(FATAL_ERROR
                "Invalid pinned ReShade content-hash entry: "
                "'${RESHAPE_CONTENT_ENTRY}'"
            )
        endif()
        math(EXPR RESHAPE_HASH_OFFSET "${RESHAPE_HASH_SEPARATOR} + 1")
        string(SUBSTRING "${RESHAPE_CONTENT_ENTRY}" 0
            ${RESHAPE_HASH_SEPARATOR} RESHAPE_PATCHED_FILE)
        string(SUBSTRING "${RESHAPE_CONTENT_ENTRY}" ${RESHAPE_HASH_OFFSET} -1
            RESHAPE_EXPECTED_CONTENT_HASH)
        set(RESHAPE_PATCHED_PATH "${source_dir}/${RESHAPE_PATCHED_FILE}")
        if(NOT EXISTS "${RESHAPE_PATCHED_PATH}")
            message(FATAL_ERROR
                "Pinned patched ReShade file is missing: "
                "${RESHAPE_PATCHED_FILE}"
            )
        endif()

        # Match build-runtime.ps1's ReadAllText behavior: discard a UTF-8 BOM,
        # normalize CRLF and bare CR to LF, then hash the resulting UTF-8 text.
        file(READ "${RESHAPE_PATCHED_PATH}" RESHAPE_CONTENT_PREFIX
            LIMIT 3 HEX)
        string(TOLOWER "${RESHAPE_CONTENT_PREFIX}" RESHAPE_CONTENT_PREFIX)
        if(RESHAPE_CONTENT_PREFIX STREQUAL "efbbbf")
            file(READ "${RESHAPE_PATCHED_PATH}" RESHAPE_PATCHED_CONTENT
                OFFSET 3)
        else()
            file(READ "${RESHAPE_PATCHED_PATH}" RESHAPE_PATCHED_CONTENT)
        endif()
        string(REPLACE "\r\n" "\n" RESHAPE_PATCHED_CONTENT
            "${RESHAPE_PATCHED_CONTENT}")
        string(REPLACE "\r" "\n" RESHAPE_PATCHED_CONTENT
            "${RESHAPE_PATCHED_CONTENT}")
        string(SHA256 RESHAPE_ACTUAL_CONTENT_HASH
            "${RESHAPE_PATCHED_CONTENT}")
        string(TOUPPER "${RESHAPE_ACTUAL_CONTENT_HASH}"
            RESHAPE_ACTUAL_CONTENT_HASH)
        if(NOT RESHAPE_ACTUAL_CONTENT_HASH STREQUAL
            RESHAPE_EXPECTED_CONTENT_HASH)
            message(FATAL_ERROR
                "Pinned patched ReShade content hash mismatch for "
                "${RESHAPE_PATCHED_FILE}.\n"
                "Expected: ${RESHAPE_EXPECTED_CONTENT_HASH}\n"
                "Actual:   ${RESHAPE_ACTUAL_CONTENT_HASH}"
            )
        endif()
    endforeach()
endfunction()

# ReShade's add-on ABI is tied to the headers from the runtime release. Its
# ImGui bridge also checks for the exact ImGui version used by that release.
# Immutable commits keep those two inputs reproducible.
FetchContent_Declare(
    reshade
    GIT_REPOSITORY https://github.com/crosire/reshade.git
    GIT_TAG ${RESHAPE_PINNED_COMMIT}
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
verify_reshade_pinned_commit("${reshade_SOURCE_DIR}")

# Apply four narrow pinned seams: the passive copied-input observer, an injector
# base-path override, coverage for Windows' second mouse projection through
# WM_POINTER, and exact-PID injector targeting. The exact-PID patch is last so
# its reverse check can migrate fetched trees that contain the prior three-patch
# stack without resetting or replacing those ignored source trees.
list(GET RESHAPE_SOURCE_PATCHES 3 RESHAPE_EXACT_PID_PATCH)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_EXACT_PID_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_PATCH_STACK_ALREADY_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)

if(RESHAPE_PATCH_STACK_ALREADY_APPLIED EQUAL 0)
    list(GET RESHAPE_SOURCE_PATCHES 2 RESHAPE_POINTER_INPUT_PATCH)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_POINTER_INPUT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_POINTER_INPUT_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(NOT RESHAPE_POINTER_INPUT_PATCH_APPLIED EQUAL 0)
        message(FATAL_ERROR
            "The terminal exact-PID patch is present without the pinned input patch."
        )
    endif()
else()
list(GET RESHAPE_SOURCE_PATCHES 1 RESHAPE_INJECTOR_BASE_PATH_PATCH)
list(GET RESHAPE_SOURCE_PATCHES 2 RESHAPE_POINTER_INPUT_PATCH)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_INJECTOR_BASE_PATH_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_BASE_PATH_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_POINTER_INPUT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_POINTER_INPUT_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)

if(RESHAPE_INJECTOR_BASE_PATH_PATCH_APPLIED EQUAL 0 AND
    RESHAPE_POINTER_INPUT_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_EXACT_PID_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_EXACT_PID_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_EXACT_PID_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_EXACT_PID_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_EXACT_PID_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned exact-PID patch cannot migrate the prior ReShade patch stack.\n"
            "${RESHAPE_EXACT_PID_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_EXACT_PID_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_EXACT_PID_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_EXACT_PID_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_EXACT_PID_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_EXACT_PID_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_EXACT_PID_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to migrate the prior ReShade patch stack with exact-PID support.\n"
            "${RESHAPE_EXACT_PID_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_EXACT_PID_PATCH_APPLY_ERROR}"
        )
    endif()
else()
foreach(RESHAPE_SOURCE_PATCH IN LISTS RESHAPE_SOURCE_PATCHES)
    get_filename_component(RESHAPE_SOURCE_PATCH_NAME
        "${RESHAPE_SOURCE_PATCH}" NAME)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_SOURCE_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHADE_SOURCE_PATCH_ALREADY_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(NOT RESHADE_SOURCE_PATCH_ALREADY_APPLIED EQUAL 0)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --check
                "${RESHAPE_SOURCE_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHADE_SOURCE_PATCH_CHECK
            OUTPUT_VARIABLE RESHADE_SOURCE_PATCH_CHECK_OUTPUT
            ERROR_VARIABLE RESHADE_SOURCE_PATCH_CHECK_ERROR
        )
        if(NOT RESHADE_SOURCE_PATCH_CHECK EQUAL 0)
            message(FATAL_ERROR
                "Pinned ReShade patch '${RESHAPE_SOURCE_PATCH_NAME}' no longer applies.\n"
                "${RESHADE_SOURCE_PATCH_CHECK_OUTPUT}"
                "${RESHADE_SOURCE_PATCH_CHECK_ERROR}"
            )
        endif()

        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
                "${RESHAPE_SOURCE_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHADE_SOURCE_PATCH_APPLY
            OUTPUT_VARIABLE RESHADE_SOURCE_PATCH_APPLY_OUTPUT
            ERROR_VARIABLE RESHADE_SOURCE_PATCH_APPLY_ERROR
        )
        if(NOT RESHADE_SOURCE_PATCH_APPLY EQUAL 0)
            message(FATAL_ERROR
                "Unable to apply pinned ReShade patch '${RESHAPE_SOURCE_PATCH_NAME}'.\n"
                "${RESHADE_SOURCE_PATCH_APPLY_OUTPUT}"
                "${RESHADE_SOURCE_PATCH_APPLY_ERROR}"
            )
        endif()
    endif()
endforeach()
endif()
endif()

# Fail configuration unless this FetchContent tree is exactly the pinned
# ordered patch stack. This runs independently for the regular and
# electron-core presets, before CMake generates any build targets.
verify_reshade_patched_source("${reshade_SOURCE_DIR}")

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
