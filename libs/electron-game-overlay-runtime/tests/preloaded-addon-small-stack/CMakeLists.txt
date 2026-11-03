cmake_minimum_required(VERSION 3.24)
project(preloaded_addon_small_stack_fixture LANGUAGES CXX)
if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This DLL notification fixture requires Windows and MSVC.")
endif()

add_executable(preloaded_addon_small_stack_fixture host.cpp)
target_compile_features(preloaded_addon_small_stack_fixture PRIVATE cxx_std_17)
target_compile_definitions(preloaded_addon_small_stack_fixture PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(preloaded_addon_small_stack_fixture PRIVATE /W4 /permissive- /EHsc)
target_link_options(preloaded_addon_small_stack_fixture PRIVATE /INCREMENTAL:NO)

# Execution deliberately requires an explicit candidate argument. This target
# does not load the real add-on as part of configuration, build, or CTest.
