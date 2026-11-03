cmake_minimum_required(VERSION 3.24)
project(preload_long_path_console_fixture LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "This local console fixture requires Windows, MSVC and x64.")
endif()
set(INJECTOR_SOURCE "" CACHE FILEPATH "Exact pinned injector source included by the inert console fixture")
if(NOT EXISTS "${INJECTOR_SOURCE}")
    message(FATAL_ERROR "Supply INJECTOR_SOURCE naming the exact candidate tools/injector.cpp.")
endif()
get_filename_component(INJECTOR_SOURCE "${INJECTOR_SOURCE}" REALPATH)
file(TO_CMAKE_PATH "${INJECTOR_SOURCE}" INJECTOR_SOURCE_INCLUDE)
get_filename_component(ALLOWED_TEST_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../build" ABSOLUTE)
file(TO_CMAKE_PATH "${ALLOWED_TEST_ROOT}" ALLOWED_TEST_ROOT)

add_library(preload_long_path_member SHARED member.cpp)
add_executable(preload_long_path_fixture fixture.cpp)
foreach(target IN ITEMS preload_long_path_member preload_long_path_fixture)
    target_compile_features(${target} PRIVATE cxx_std_17)
    target_compile_definitions(${target} PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_compile_options(${target} PRIVATE /W4 /EHsc /permissive-)
    target_link_options(${target} PRIVATE /INCREMENTAL:NO)
endforeach()
target_compile_definitions(preload_long_path_fixture PRIVATE
    "EGO_INJECTOR_SOURCE=\"${INJECTOR_SOURCE_INCLUDE}\""
    "EGO_ALLOWED_TEST_ROOT=L\"${ALLOWED_TEST_ROOT}\"")
target_link_libraries(preload_long_path_fixture PRIVATE psapi advapi32 bcrypt version)

# The fixture must test the ordinary target boundary without depending on the
# user's LongPathsEnabled setting or an inherited longPathAware executable.
set(FIXTURE_MANIFEST "${CMAKE_CURRENT_BINARY_DIR}/preload-long-path.manifest")
file(WRITE "${FIXTURE_MANIFEST}" [=[<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">false</longPathAware>
    </windowsSettings>
  </application>
</assembly>
]=])
target_link_options(preload_long_path_fixture PRIVATE /MANIFEST
    "/MANIFESTINPUT:${FIXTURE_MANIFEST}")

add_executable(preload_long_path_policy_fixture policy_fixture.cpp)
target_compile_features(preload_long_path_policy_fixture PRIVATE cxx_std_17)
target_compile_definitions(preload_long_path_policy_fixture PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN
    "EGO_INJECTOR_SOURCE=\"${INJECTOR_SOURCE_INCLUDE}\""
    "EGO_ALLOWED_TEST_ROOT=L\"${ALLOWED_TEST_ROOT}\"")
target_compile_options(preload_long_path_policy_fixture PRIVATE /W4 /EHsc /permissive-)
target_link_libraries(preload_long_path_policy_fixture PRIVATE psapi advapi32 bcrypt version)
target_link_options(preload_long_path_policy_fixture PRIVATE /INCREMENTAL:NO /MANIFEST
    "/MANIFESTINPUT:${FIXTURE_MANIFEST}")
