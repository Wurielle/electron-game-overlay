cmake_minimum_required(VERSION 3.24)
project(preloaded_addon_policy_fixture LANGUAGES CXX)

set(PRELOADED_ADDON_HEADER "" CACHE FILEPATH "Exact ego_preloaded_addon.hpp under test")
if(NOT EXISTS "${PRELOADED_ADDON_HEADER}")
    message(FATAL_ERROR "Supply PRELOADED_ADDON_HEADER naming the exact header under test.")
endif()
get_filename_component(PRELOADED_ADDON_HEADER "${PRELOADED_ADDON_HEADER}" REALPATH)
file(TO_CMAKE_PATH "${PRELOADED_ADDON_HEADER}" PRELOADED_ADDON_HEADER_INCLUDE)

add_executable(preloaded_addon_policy_fixture fixture.cpp)
target_compile_features(preloaded_addon_policy_fixture PRIVATE cxx_std_17)
target_compile_definitions(preloaded_addon_policy_fixture PRIVATE
    "PRELOADED_ADDON_HEADER=\"${PRELOADED_ADDON_HEADER_INCLUDE}\"")
if(MSVC)
    target_compile_options(preloaded_addon_policy_fixture PRIVATE /W4 /permissive- /EHsc)
    target_link_options(preloaded_addon_policy_fixture PRIVATE /INCREMENTAL:NO)
else()
    target_compile_options(preloaded_addon_policy_fixture PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()
add_test(NAME preloaded_addon_policy COMMAND preloaded_addon_policy_fixture)
