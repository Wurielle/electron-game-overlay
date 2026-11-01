cmake_minimum_required(VERSION 3.24)
project(owned_late_d3d11_overlay_fixture LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This owned-runtime fixture requires Windows and MSVC.")
endif()

add_executable(owned_late_d3d11_overlay_test_host WIN32 host.cpp)
target_compile_features(owned_late_d3d11_overlay_test_host PRIVATE cxx_std_17)
target_compile_definitions(owned_late_d3d11_overlay_test_host PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(owned_late_d3d11_overlay_test_host PRIVATE /W4 /permissive- /EHsc)
target_link_options(owned_late_d3d11_overlay_test_host PRIVATE /INCREMENTAL:NO)
target_link_libraries(owned_late_d3d11_overlay_test_host PRIVATE d3d11 dxgi user32 shell32)
