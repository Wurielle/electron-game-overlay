cmake_minimum_required(VERSION 3.24)
project(shared_addon_host_isolation_fixture LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This inert fixture requires Windows and MSVC.")
endif()
set(OWNED_LATE_SOURCE "" CACHE FILEPATH "Exact candidate owned_late_d3d11.inl source")
if(NOT EXISTS "${OWNED_LATE_SOURCE}")
    message(FATAL_ERROR "Supply OWNED_LATE_SOURCE naming the exact candidate host source.")
endif()
get_filename_component(OWNED_LATE_SOURCE "${OWNED_LATE_SOURCE}" REALPATH)
file(READ "${OWNED_LATE_SOURCE}" OWNED_LATE_TEXT)
file(SHA256 "${OWNED_LATE_SOURCE}" OWNED_LATE_RAW_HASH)
string(REPLACE "\r\n" "\n" OWNED_LATE_NORMALIZED "${OWNED_LATE_TEXT}")
string(SHA256 OWNED_LATE_NORMALIZED_HASH "${OWNED_LATE_NORMALIZED}")
string(FIND "${OWNED_LATE_TEXT}"
    "extern \"C\" __declspec(dllexport) DWORD WINAPI ElectronGameOverlayInitializeOwnedLateD3D11V1(" INITIALIZER_START)
string(FIND "${OWNED_LATE_TEXT}"
    "extern \"C\" __declspec(dllexport) DWORD WINAPI ElectronGameOverlayQueryOwnedLateD3D11V1(" INITIALIZER_END)
if(INITIALIZER_START LESS 0 OR INITIALIZER_END LESS INITIALIZER_START)
    message(FATAL_ERROR "Candidate host initializer boundaries are missing.")
endif()
math(EXPR INITIALIZER_LENGTH "${INITIALIZER_END} - ${INITIALIZER_START}")
string(SUBSTRING "${OWNED_LATE_TEXT}" ${INITIALIZER_START} ${INITIALIZER_LENGTH} EXACT_INITIALIZER)
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/candidate-owned-initializer.inl" "${EXACT_INITIALIZER}")

add_executable(shared_addon_host_isolation_fixture host_fixture.cpp)
target_compile_features(shared_addon_host_isolation_fixture PRIVATE cxx_std_17)
target_compile_definitions(shared_addon_host_isolation_fixture PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN
    "EGO_SOURCE_RAW_SHA256=\"${OWNED_LATE_RAW_HASH}\""
    "EGO_SOURCE_NORMALIZED_SHA256=\"${OWNED_LATE_NORMALIZED_HASH}\"")
target_include_directories(shared_addon_host_isolation_fixture PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_compile_options(shared_addon_host_isolation_fixture PRIVATE /EHsc /W4 /permissive-)
target_link_options(shared_addon_host_isolation_fixture PRIVATE /INCREMENTAL:NO)

enable_testing()
add_test(NAME shared_addon_host_isolation COMMAND shared_addon_host_isolation_fixture)
