cmake_minimum_required(VERSION 3.24)
project(overlay_cache_graphics_fixture LANGUAGES CXX)

add_executable(cache_graphics_host host.cpp)
target_compile_features(cache_graphics_host PRIVATE cxx_std_17)
target_link_libraries(cache_graphics_host PRIVATE d3d11 dxgi gdi32 user32)
