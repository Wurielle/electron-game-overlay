cmake_minimum_required(VERSION 3.24)
project(ini_canonicalization_probe LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This console fixture requires Windows and MSVC.")
endif()
set(RESHADE_SOURCE_DIR "" CACHE PATH "Exact pinned ReShade source root")
if(NOT EXISTS "${RESHADE_SOURCE_DIR}/source/ini_file.cpp")
    message(FATAL_ERROR "Supply RESHADE_SOURCE_DIR for the exact pinned INI implementation.")
endif()
file(TO_CMAKE_PATH "${RESHADE_SOURCE_DIR}/source/ini_file.cpp" PINNED_INI_CPP)
add_executable(ini_canonicalization_probe probe.cpp)
target_compile_features(ini_canonicalization_probe PRIVATE cxx_std_17)
target_compile_definitions(ini_canonicalization_probe PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN EGO_PINNED_INI_CPP="${PINNED_INI_CPP}")
target_include_directories(ini_canonicalization_probe PRIVATE
    "${RESHADE_SOURCE_DIR}/source" "${RESHADE_SOURCE_DIR}/deps/utfcpp/source")
target_compile_options(ini_canonicalization_probe PRIVATE /W4 /permissive- /EHsc)
target_link_options(ini_canonicalization_probe PRIVATE /INCREMENTAL:NO)
