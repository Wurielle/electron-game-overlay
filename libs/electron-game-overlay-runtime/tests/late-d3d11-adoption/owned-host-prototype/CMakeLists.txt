cmake_minimum_required(VERSION 3.24)
project(late_d3d11_generic_adoption_fixture LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This isolated prototype requires Windows and MSVC.")
endif()

add_executable(late_d3d11_generic_adoption_host WIN32 generic_host.cpp)
target_compile_features(late_d3d11_generic_adoption_host PRIVATE cxx_std_17)
target_compile_definitions(late_d3d11_generic_adoption_host PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(late_d3d11_generic_adoption_host PRIVATE /W4 /permissive- /EHsc)
target_link_options(late_d3d11_generic_adoption_host PRIVATE /INCREMENTAL:NO)
target_link_libraries(late_d3d11_generic_adoption_host PRIVATE d3d11 dxgi user32 shell32)
