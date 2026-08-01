cmake_minimum_required(VERSION 3.24)

project(electron_game_overlay_runtime LANGUAGES CXX)

set(ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID
    "CDDCB683DA724B149BEA818760F10354"
)
set(RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256
    "2FD5C82AC601AECB839EFCE3F8F2FB191627D379EA697612AD91C76CBA4F166A"
)

option(
    ELECTRON_GAME_OVERLAY_BUILD_ADDON
    "Build the production Electron compositor add-on and transport ABI smoke test"
    OFF
)

if(NOT WIN32)
    message(FATAL_ERROR "The Electron game overlay runtime only supports Windows.")
endif()

if(NOT MSVC)
    message(FATAL_ERROR "The Electron game overlay runtime is verified with MSVC only.")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "The Electron game overlay runtime is x64-only.")
endif()

include(FetchContent)
find_package(Git REQUIRED)

set(RESHAPE_PINNED_COMMIT "4a50d1eddace85734871d91792ff214f13f66c01")
set(RESHAPE_SOURCE_PATCHES
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-input-observer.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-base-path.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-pointer-input-block.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-exact-pid.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-path-watcher.patch"
)
set(RESHAPE_PATH_WATCHER_IDENTITY_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-path-watcher-process-identity.patch"
)
set(RESHAPE_PROCESS_OBSERVER_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-persistent-path-observer.patch"
)
set(RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-resilient-path-observer.patch"
)
set(RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-conflict-preflight.patch"
)
set(RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-per-pid-claim.patch"
)
set(RESHAPE_SHARED_RUNTIME_HOST_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-shared-runtime-host.patch"
)
set(RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-export-read-bounds.patch"
)
set(RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-existing-installation-preflight.patch"
)
set(RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-official-addon-host.patch"
)
set(RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-global-layer-preflight.patch"
)
set(RESHAPE_SHARED_RUNTIME_HARDENING_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-shared-runtime-hardening.patch"
)
set(RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-legacy-snapshot-observer.patch"
)
set(RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-low-latency-observer.patch"
)
set(RESHAPE_SUPPRESS_SPLASH_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-suppress-splash.patch"
)
set(RESHAPE_EXPECTED_PATCHED_FILES
    "include/reshade.hpp"
    "include/reshade_api.hpp"
    "include/reshade_events.hpp"
    "source/addon_manager.cpp"
    "source/addon_manager.hpp"
    "source/input.cpp"
    "source/input.hpp"
    "source/runtime_gui.cpp"
    "tools/injector.cpp"
)
set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
    "include/reshade.hpp=CC102FA21D311B85713ED167F0E182A4EECCD40CDF3FBE360AD9F83A0CF40767"
    "include/reshade_api.hpp=80E9F0CBC06BF96943DC79CA2D133DB5D8E69D3A4CD516B6D89D675B8B965218"
    "include/reshade_events.hpp=8090912CD69854818C294F7C0F848EBAB7C712AB6D601E6889E62514249EE6A7"
    "source/addon_manager.cpp=28A0E7C805FC8D006E0B21BB9D3B7712ADBCDA771999F48ECD2ACAE3AC6F6488"
    "source/addon_manager.hpp=C1D27EA4C9996F1EAD408FAD0D0DB3AEEAE16A4BEFEB4A0F71EC6C616116989B"
    "source/input.cpp=4C53B31266E281479348913E2911CB7182843CFCB6D4063B571BECECF3F5BB2F"
    "source/input.hpp=C772470BC1AA003E3D6BD0C6E29B01CCE3B0F6CCF4F42E60B73EA9FCA6D12B2C"
    "source/runtime_gui.cpp=84887E6387FE9B72DB04969C953C3245F69B9471D76DCD14A05DEF18CCA80F40"
    "tools/injector.cpp=${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    ${RESHAPE_SOURCE_PATCHES}
    "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
    "${RESHAPE_PROCESS_OBSERVER_PATCH}"
    "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
    "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH}"
    "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
    "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
    "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
    "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH}"
    "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH}"
    "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
    "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH}"
    "${RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH}"
    "${RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH}"
    "${RESHAPE_SUPPRESS_SPLASH_PATCH}"
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
            "The fetched ReShade tree does not contain exactly the nine "
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

        # Match build-reshade-runtime.ps1's ReadAllText behavior: discard a UTF-8 BOM,
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

# Apply seventeen narrow pinned seams: the passive copied-input observer, an injector
# base-path override, coverage for Windows' second mouse projection through
# WM_POINTER, exact-PID targeting, one-shot and persistent prearmed path
# observation, loaded and inactive ReShade conflict preflight, official add-on
# discovery, per-PID injection ownership, compatible shared-runtime registration
# plus its bounded export and loader hardening, and startup splash suppression. The watcher patches are terminal so existing
# exact-PID and original watcher trees can migrate without replacing those
# ignored source trees.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)

# A build-ID bump changes one literal in the terminal injector patch. That
# makes neither the new terminal patch nor its lower superseded patches
# independently reversible in an existing fetched tree. Replace a prior
# 32-hex build ID only when the resulting normalized file is byte-for-byte
# the current pinned injector. Arbitrary or locally modified trees continue
# into the normal fail-closed checks below.
if(NOT RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED EQUAL 0)
    set(RESHAPE_FETCHED_INJECTOR_PATH
        "${reshade_SOURCE_DIR}/tools/injector.cpp")
    if(EXISTS "${RESHAPE_FETCHED_INJECTOR_PATH}")
        file(READ "${RESHAPE_FETCHED_INJECTOR_PATH}"
            RESHAPE_FETCHED_INJECTOR_CONTENT)
        string(REGEX MATCHALL
            "constexpr char expected_addon_build_id\\[\\] =[\t\r\n ]*\"[0-9A-F]+\""
            RESHAPE_ADDON_BUILD_ID_DECLARATIONS
            "${RESHAPE_FETCHED_INJECTOR_CONTENT}"
        )
        list(LENGTH RESHAPE_ADDON_BUILD_ID_DECLARATIONS
            RESHAPE_ADDON_BUILD_ID_DECLARATION_COUNT)
        if(RESHAPE_ADDON_BUILD_ID_DECLARATION_COUNT EQUAL 1)
            list(GET RESHAPE_ADDON_BUILD_ID_DECLARATIONS 0
                RESHAPE_ADDON_BUILD_ID_DECLARATION)
            string(REGEX MATCH "\"[0-9A-F]+\"$"
                RESHAPE_PREVIOUS_ADDON_BUILD_ID_QUOTED
                "${RESHAPE_ADDON_BUILD_ID_DECLARATION}"
            )
            string(REGEX REPLACE "^\"|\"$" ""
                RESHAPE_PREVIOUS_ADDON_BUILD_ID
                "${RESHAPE_PREVIOUS_ADDON_BUILD_ID_QUOTED}"
            )
            string(LENGTH "${RESHAPE_PREVIOUS_ADDON_BUILD_ID}"
                RESHAPE_PREVIOUS_ADDON_BUILD_ID_LENGTH)
            if(RESHAPE_PREVIOUS_ADDON_BUILD_ID_LENGTH EQUAL 32 AND
                NOT RESHAPE_PREVIOUS_ADDON_BUILD_ID STREQUAL
                    ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID)
                string(REPLACE
                    "${RESHAPE_PREVIOUS_ADDON_BUILD_ID_QUOTED}"
                    "\"${ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID}\""
                    RESHAPE_MIGRATED_ADDON_BUILD_ID_DECLARATION
                    "${RESHAPE_ADDON_BUILD_ID_DECLARATION}"
                )
                string(REPLACE
                    "${RESHAPE_ADDON_BUILD_ID_DECLARATION}"
                    "${RESHAPE_MIGRATED_ADDON_BUILD_ID_DECLARATION}"
                    RESHAPE_MIGRATED_INJECTOR_CONTENT
                    "${RESHAPE_FETCHED_INJECTOR_CONTENT}"
                )

                set(RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT
                    "${RESHAPE_MIGRATED_INJECTOR_CONTENT}")
                string(REPLACE "\r\n" "\n"
                    RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT
                    "${RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT}")
                string(REPLACE "\r" "\n"
                    RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT
                    "${RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT}")
                string(SHA256 RESHAPE_MIGRATED_INJECTOR_CONTENT_SHA256
                    "${RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT}")
                string(TOUPPER
                    "${RESHAPE_MIGRATED_INJECTOR_CONTENT_SHA256}"
                    RESHAPE_MIGRATED_INJECTOR_CONTENT_SHA256)

                if(RESHAPE_MIGRATED_INJECTOR_CONTENT_SHA256 STREQUAL
                    RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256)
                    string(RANDOM LENGTH 16
                        ALPHABET "0123456789abcdef"
                        RESHAPE_INJECTOR_MIGRATION_SUFFIX)
                    string(CONCAT RESHAPE_INJECTOR_MIGRATION_TEMP_PATH
                        "${RESHAPE_FETCHED_INJECTOR_PATH}."
                        "electron-game-overlay-"
                        "${RESHAPE_INJECTOR_MIGRATION_SUFFIX}.tmp")
                    file(WRITE "${RESHAPE_INJECTOR_MIGRATION_TEMP_PATH}"
                        "${RESHAPE_MIGRATED_INJECTOR_CONTENT}")
                    file(RENAME
                        "${RESHAPE_INJECTOR_MIGRATION_TEMP_PATH}"
                        "${RESHAPE_FETCHED_INJECTOR_PATH}"
                        RESULT RESHAPE_INJECTOR_MIGRATION_RENAME_RESULT)
                    if(NOT RESHAPE_INJECTOR_MIGRATION_RENAME_RESULT
                        STREQUAL "0")
                        file(REMOVE
                            "${RESHAPE_INJECTOR_MIGRATION_TEMP_PATH}")
                    endif()

                    # Recheck even when rename reported failure: another
                    # concurrent configure may have completed the same
                    # idempotent migration.
                    execute_process(
                        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
                            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
                        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
                        RESULT_VARIABLE
                            RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED
                        OUTPUT_QUIET
                        ERROR_QUIET
                    )
                    if(NOT
                        RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED
                        EQUAL 0)
                        message(FATAL_ERROR
                            "Unable to migrate the exact pinned ReShade "
                            "injector add-on build ID.\n"
                            "${RESHAPE_INJECTOR_MIGRATION_RENAME_RESULT}"
                        )
                    endif()
                endif()
            endif()
        endif()
    endif()
endif()

if(NOT RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED EQUAL 0)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_TERMINAL_PROCESS_OBSERVER_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_TERMINAL_PROCESS_OBSERVER_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(RESHAPE_TERMINAL_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    # The persistent observer adds headers next to the identity patch's include
    # hunk, so that lower patch is no longer independently reverse-applicable.
    set(RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED EQUAL 0)
list(GET RESHAPE_SOURCE_PATCHES 4 RESHAPE_PATH_WATCHER_PATCH)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_PATH_WATCHER_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)

if(RESHAPE_PATH_WATCHER_PATCH_APPLIED EQUAL 0)
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
            "The terminal path-watcher patch is present without the pinned input patch."
        )
    endif()
else()
# Migrate the previous exact-PID/base-path states before applying the new
# terminal watcher patch.
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

execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_PATH_WATCHER_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_PATH_WATCHER_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_PATH_WATCHER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_PATH_WATCHER_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_PATH_WATCHER_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned path-watcher patch cannot migrate the exact-PID ReShade patch stack.\n"
            "${RESHAPE_PATH_WATCHER_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_PATH_WATCHER_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_PATH_WATCHER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_PATH_WATCHER_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to migrate the ReShade patch stack with path-watcher support.\n"
            "${RESHAPE_PATH_WATCHER_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_PATH_WATCHER_PATCH_APPLY_ERROR}"
        )
    endif()
endif()
endif()

endif()

# The process-identity patch is deliberately layered after the original path
# watcher so existing ignored build trees migrate without resetting fetched
# source. It retains handles for startup-baseline processes, so exited process
# objects are distinguishable from later processes even if Windows reuses a PID.
if(RESHAPE_TERMINAL_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned path-watcher process-identity patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to migrate the ReShade path watcher to process identities.\n"
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# The persistent observer reports every path match to its supervising client
# without performing injection itself. The current implementation uses one
# compact EnumProcesses PID snapshot per cadence, resolves each executable path
# once, and retries temporarily inaccessible paths with bounded backoff. Migrate
# the previous full-Toolhelp snapshot observer in place before applying it.
set(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED FALSE)
set(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED FALSE)
set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE FALSE)
macro(restore_reshade_legacy_process_observer)
    if(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE
            OUTPUT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE_OUTPUT
            ERROR_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE_ERROR
        )
        if(NOT RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE EQUAL 0)
            message(FATAL_ERROR
                "Observer migration failed and the legacy full-snapshot observer could not be restored.\n"
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE_OUTPUT}"
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE_ERROR}"
            )
        endif()
        set(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED FALSE)
    endif()

    if(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
                "${RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE
            OUTPUT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE_OUTPUT
            ERROR_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE_ERROR
        )
        if(NOT RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE EQUAL 0)
            message(FATAL_ERROR
                "Observer migration failed and the legacy 5 ms cadence could not be restored.\n"
                "${RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE_OUTPUT}"
                "${RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE_ERROR}"
            )
        endif()
        set(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED FALSE)
    endif()
endmacro()

macro(rollback_reshade_resilient_observer_migration)
    if(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --reverse
                "${RESHAPE_PROCESS_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK
            OUTPUT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK_OUTPUT
            ERROR_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK_ERROR
        )
        if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK EQUAL 0)
            message(FATAL_ERROR
                "Resilient observer migration failed and the newly applied persistent observer could not be removed.\n"
                "${RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK_OUTPUT}"
                "${RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK_ERROR}"
            )
        endif()
        set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE FALSE)
    endif()
    restore_reshade_legacy_process_observer()
endmacro()

if(RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(RESHAPE_LEGACY_OBSERVER_CADENCE_APPLIED EQUAL 0)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --reverse
                "${RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE
            OUTPUT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE_OUTPUT
            ERROR_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE_ERROR
        )
        if(NOT RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE EQUAL 0)
            message(FATAL_ERROR
                "Unable to remove the legacy 5 ms observer overlay.\n"
                "${RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE_OUTPUT}"
                "${RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE_ERROR}"
            )
        endif()
        set(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED TRUE)
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(RESHAPE_LEGACY_PROCESS_OBSERVER_APPLIED EQUAL 0)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --reverse
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE
            OUTPUT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE_OUTPUT
            ERROR_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE_ERROR
        )
        if(NOT RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE EQUAL 0)
            restore_reshade_legacy_process_observer()
            message(FATAL_ERROR
                "Unable to remove the legacy full-snapshot process observer.\n"
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE_OUTPUT}"
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE_ERROR}"
            )
        endif()
        set(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED TRUE)
    elseif(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED)
        restore_reshade_legacy_process_observer()
        message(FATAL_ERROR
            "The legacy observer cadence was present without the pinned "
            "legacy full-snapshot observer."
        )
    endif()
endif()

if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_CHECK EQUAL 0)
        restore_reshade_legacy_process_observer()
        message(FATAL_ERROR
            "Pinned persistent process-observer patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_PROCESS_OBSERVER_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_PROCESS_OBSERVER_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_APPLY EQUAL 0)
        restore_reshade_legacy_process_observer()
        message(FATAL_ERROR
            "Unable to add persistent process observation to the ReShade injector.\n"
            "${RESHAPE_PROCESS_OBSERVER_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_PROCESS_OBSERVER_PATCH_APPLY_ERROR}"
        )
    endif()
    set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE TRUE)
endif()

# Layer resilient identity retention and retry backoff over both freshly applied
# and previously fetched persistent-observer trees.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK EQUAL 0)
        rollback_reshade_resilient_observer_migration()
        message(FATAL_ERROR
            "Pinned resilient process-observer patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY EQUAL 0)
        rollback_reshade_resilient_observer_migration()
        message(FATAL_ERROR
            "Unable to harden persistent ReShade process observation.\n"
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY_ERROR}"
        )
    endif()
endif()
set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE FALSE)
set(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED FALSE)
set(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED FALSE)

# Inspect loaded ReShade instances before allocating or writing target memory.
# The export-read bounds patch is terminal over shared-runtime hosting,
# conflict preflight, and the per-PID claim, so it proves all lower injector
# patches are present in an existing fetched tree.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED 0)
    set(RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED 0)
    set(RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED EQUAL 0)
        set(RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED 0)
        set(RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED 0)
    else()
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
                "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED
            OUTPUT_QUIET
            ERROR_QUIET
        )
        if(RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED EQUAL 0)
            set(RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED 0)
        else()
            execute_process(
                COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
                    "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH}"
                WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
                RESULT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED
                OUTPUT_QUIET
                ERROR_QUIET
            )
        endif()
    endif()
endif()
if(NOT RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned ReShade injector conflict-preflight patch cannot migrate "
            "the patch stack.\n"
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add loaded-ReShade conflict preflight to the injector.\n"
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Serialize injectors targeting the same selected PID before either can inspect
# or mutate that process. This deliberately layers after conflict preflight so
# existing fetched source trees can migrate by applying one terminal patch.
if(NOT RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED EQUAL 0 AND
    NOT RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned ReShade injector per-PID claim patch cannot migrate "
            "the patch stack.\n"
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to serialize ReShade injection per target PID.\n"
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# The product renders its own startup/status UI. Keep ReShade's full GUI and
# add-on callback path enabled, but suppress only its built-in splash window.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_SUPPRESS_SPLASH_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_SUPPRESS_SPLASH_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_SUPPRESS_SPLASH_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned ReShade splash-suppression patch cannot migrate the patch stack.\n"
            "${RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_SUPPRESS_SPLASH_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to suppress the pinned ReShade splash window.\n"
            "${RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# A project-compatible loaded runtime exposes an ABI marker and an atomic
# pre-initialization gate. The injector can then load only the staged Electron
# add-on while unknown or already-active ReShade runtimes remain fail-closed.
if(RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned shared-runtime host patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add compatible shared-runtime hosting to ReShade.\n"
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Bound each remote export-name read to the requested symbol length. This
# terminal hardening avoids crossing sparse PE image pages while retaining the
# lexical binary search used by shared-runtime capability inspection.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned injector export-read bounds patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to bound ReShade injector export reads.\n"
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Make the shared registration hand-off low-CPU and re-entrancy-safe, and
# measure the copied x64 loader thunk from unwind metadata instead of relying
# on an unchecked byte-count estimate.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned shared-runtime hardening patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to harden compatible shared-runtime hosting.\n"
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Before injecting the private runtime, inspect bounded top-level DLL/ASI PE
# exports beside the selected executable. A validated inactive ReShade install
# takes precedence and remains untouched for its next normal launch.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned inactive ReShade installation-preflight patch cannot migrate "
            "the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add inactive ReShade installation preflight to the injector.\n"
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# A stock full-add-on ReShade may already have loaded this project's add-on at
# normal startup. Recognize its exact exported ABI marker as a no-mutation
# success while keeping the private compatible-host path authoritative.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned official ReShade add-on-host patch cannot migrate "
            "the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add official ReShade add-on hosting to the injector.\n"
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Preserve applicable x64 ReShade Vulkan/OpenXR layers before any injection
# mutation. The same terminal preflight also resolves target-owned
# [INSTALL] BasePath compatibility installs without following reparse points.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --reverse --check
        "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --check
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned global ReShade layer-preflight patch cannot migrate "
            "the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add global ReShade layer preservation to the injector.\n"
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# A reverse-applicable terminal patch plus exact per-file hashes below proves
# the complete lower patch stack in an existing fetched tree. Skipping lower
# migration checks here avoids asking those superseded hunks to reverse through
# the terminal injector changes.
endif()

# Fail configuration unless this FetchContent tree is exactly the pinned
# ordered patch stack. This runs independently for the regular and
# native-host and production presets, before CMake generates build targets.
verify_reshade_patched_source("${reshade_SOURCE_DIR}")

add_library(native_input_gate_addon SHARED
    src/native_input_gate_addon.cpp
)

target_compile_features(native_input_gate_addon PRIVATE cxx_std_20)
target_compile_definitions(native_input_gate_addon PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
    ImTextureID=ImU64
)
target_compile_options(native_input_gate_addon PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_include_directories(native_input_gate_addon PRIVATE
    "${reshade_SOURCE_DIR}/include"
    "${imgui_SOURCE_DIR}"
)
set_target_properties(native_input_gate_addon PROPERTIES
    OUTPUT_NAME "native_input_gate_addon"
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
        "$<TARGET_FILE:native_input_gate_addon>"
        "$<TARGET_FILE_DIR:d3d11_overlay_test_host>"
    COMMENT "Copying the ReShade add-on next to the controlled D3D11 host"
)
add_dependencies(d3d11_overlay_test_host native_input_gate_addon)

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
        "$<TARGET_FILE:native_input_gate_addon>"
        "$<TARGET_FILE_DIR:d3d12_overlay_test_host>"
    COMMENT "Copying the ReShade add-on next to the controlled D3D12 host"
)
add_dependencies(d3d12_overlay_test_host native_input_gate_addon)

if(ELECTRON_GAME_OVERLAY_BUILD_ADDON)
    enable_testing()

    find_program(CARGO_EXECUTABLE cargo REQUIRED)

    add_executable(electron_game_overlay_reshade_manager
        src/electron_game_overlay_reshade_manager.cpp
    )
    target_compile_features(
        electron_game_overlay_reshade_manager
        PRIVATE
        cxx_std_20
    )
    target_compile_definitions(
        electron_game_overlay_reshade_manager
        PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        UNICODE
        _UNICODE
    )
    target_compile_options(
        electron_game_overlay_reshade_manager
        PRIVATE
        /W4
        /permissive-
        /EHsc
    )
    target_link_libraries(
        electron_game_overlay_reshade_manager
        PRIVATE
        bcrypt
    )
    set_target_properties(
        electron_game_overlay_reshade_manager
        PROPERTIES
        OUTPUT_NAME "electron_game_overlay_reshade_manager"
        MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
    )

    set(ELECTRON_TRANSPORT_SOURCE_DIR
        "${CMAKE_CURRENT_SOURCE_DIR}/../electron-overlay-transport"
    )
    set(ELECTRON_TRANSPORT_CARGO_TARGET_DIR
        "${CMAKE_CURRENT_SOURCE_DIR}/../../build/electron-overlay-transport/cargo"
    )
    set(ELECTRON_TRANSPORT_CARGO_LIBRARY
        "${ELECTRON_TRANSPORT_CARGO_TARGET_DIR}/x86_64-pc-windows-msvc/release/electron_overlay_transport.lib"
    )
    set(ELECTRON_TRANSPORT_STAGING_DIR
        "${CMAKE_CURRENT_BINARY_DIR}/electron-overlay-transport"
    )
    set(ELECTRON_TRANSPORT_STAGED_LIBRARY
        "${ELECTRON_TRANSPORT_STAGING_DIR}/electron_overlay_transport.lib"
    )

    file(GLOB_RECURSE ELECTRON_TRANSPORT_RUST_SOURCES CONFIGURE_DEPENDS
        "${ELECTRON_TRANSPORT_SOURCE_DIR}/src/*.rs"
    )

    add_custom_command(
        OUTPUT "${ELECTRON_TRANSPORT_STAGED_LIBRARY}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory
            "${ELECTRON_TRANSPORT_STAGING_DIR}"
        COMMAND "${CARGO_EXECUTABLE}" build
            --manifest-path "${ELECTRON_TRANSPORT_SOURCE_DIR}/Cargo.toml"
            --locked
            --release
            --target x86_64-pc-windows-msvc
            --target-dir "${ELECTRON_TRANSPORT_CARGO_TARGET_DIR}"
        COMMAND "${CMAKE_COMMAND}" -E copy
            "${ELECTRON_TRANSPORT_CARGO_LIBRARY}"
            "${ELECTRON_TRANSPORT_STAGED_LIBRARY}"
        DEPENDS
            "${ELECTRON_TRANSPORT_SOURCE_DIR}/Cargo.toml"
            "${ELECTRON_TRANSPORT_SOURCE_DIR}/Cargo.lock"
            ${ELECTRON_TRANSPORT_RUST_SOURCES}
        WORKING_DIRECTORY "${ELECTRON_TRANSPORT_SOURCE_DIR}"
        COMMENT "Building and staging the Electron overlay transport Rust static library"
        USES_TERMINAL
        VERBATIM
    )

    add_custom_target(electron_overlay_transport_cargo
        DEPENDS "${ELECTRON_TRANSPORT_STAGED_LIBRARY}"
    )

    add_library(electron_overlay_transport STATIC IMPORTED GLOBAL)
    set_target_properties(electron_overlay_transport PROPERTIES
        IMPORTED_LOCATION "${ELECTRON_TRANSPORT_STAGED_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${ELECTRON_TRANSPORT_SOURCE_DIR}/include"
        INTERFACE_LINK_LIBRARIES "kernel32;ntdll;userenv;ws2_32;dbghelp"
    )
    add_dependencies(electron_overlay_transport electron_overlay_transport_cargo)

    add_executable(electron_overlay_transport_abi_smoke
        src/electron_overlay_transport_abi_smoke.cpp
    )
    target_compile_features(electron_overlay_transport_abi_smoke PRIVATE cxx_std_20)
    target_compile_definitions(electron_overlay_transport_abi_smoke PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
    )
    target_compile_options(electron_overlay_transport_abi_smoke PRIVATE
        /W4
        /permissive-
        /EHsc
    )
    target_link_libraries(electron_overlay_transport_abi_smoke PRIVATE
        electron_overlay_transport
    )
    set_target_properties(electron_overlay_transport_abi_smoke PROPERTIES
        MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
    )

    add_library(electron_game_overlay SHARED
        src/electron_game_overlay_addon.cpp
    )
    target_compile_features(electron_game_overlay PRIVATE cxx_std_20)
    target_compile_definitions(electron_game_overlay PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        UNICODE
        _UNICODE
        ImTextureID=ImU64
        ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID="${ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID}"
    )
    target_compile_options(electron_game_overlay PRIVATE
        /W4
        /permissive-
        /EHsc
    )
    target_include_directories(electron_game_overlay PRIVATE
        "${reshade_SOURCE_DIR}/include"
        "${imgui_SOURCE_DIR}"
    )
    target_link_libraries(electron_game_overlay PRIVATE
        electron_overlay_transport
    )
    set_target_properties(electron_game_overlay PROPERTIES
        OUTPUT_NAME "electron_game_overlay"
        PREFIX ""
        SUFFIX ".addon64"
        MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
    )

    add_test(
        NAME electron_overlay_transport_abi_smoke
        COMMAND electron_overlay_transport_abi_smoke
    )
endif()
