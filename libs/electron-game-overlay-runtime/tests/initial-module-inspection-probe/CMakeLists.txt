cmake_minimum_required(VERSION 3.24)
project(initial_module_inspection_probe LANGUAGES CXX)
if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This read-only console probe requires Windows and MSVC.")
endif()
set(INJECTOR_SOURCE "" CACHE FILEPATH "Exact injector source whose inspection helper is exercised")
if(NOT EXISTS "${INJECTOR_SOURCE}")
    message(FATAL_ERROR "Supply INJECTOR_SOURCE naming the exact tools/injector.cpp.")
endif()
file(READ "${INJECTOR_SOURCE}" injector_source)
file(SHA256 "${INJECTOR_SOURCE}" injector_raw_sha)
string(REPLACE "\r\n" "\n" injector_normalized "${injector_source}")
string(SHA256 injector_normalized_sha "${injector_normalized}")
string(FIND "${injector_source}" "static DWORD inspect_initial_host_readonly(" recovery_helper_position)
set(has_initial_recovery 0)
if(NOT recovery_helper_position LESS 0)
    set(has_initial_recovery 1)
endif()
# Freeze this configure's input, rather than racing another source-cache build.
configure_file("${INJECTOR_SOURCE}" "${CMAKE_CURRENT_BINARY_DIR}/included-injector.cpp" COPYONLY)
file(TO_CMAKE_PATH "${CMAKE_CURRENT_BINARY_DIR}/included-injector.cpp" injector_include)
get_filename_component(allowed_build "${CMAKE_CURRENT_SOURCE_DIR}/../../../../build" ABSOLUTE)
file(TO_CMAKE_PATH "${allowed_build}" allowed_build)

add_executable(initial_module_inspection_probe probe.cpp)
add_library(initial_module_churn_member SHARED member.cpp)
target_compile_features(initial_module_churn_member PRIVATE cxx_std_17)
target_compile_definitions(initial_module_churn_member PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN)
target_link_options(initial_module_churn_member PRIVATE /INCREMENTAL:NO)
target_compile_features(initial_module_inspection_probe PRIVATE cxx_std_17)
target_compile_definitions(initial_module_inspection_probe PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN
    "EGO_INJECTOR_SOURCE=\"${injector_include}\""
    "EGO_ALLOWED_BUILD=L\"${allowed_build}\""
    "EGO_SOURCE_RAW_SHA=\"${injector_raw_sha}\""
    "EGO_SOURCE_NORMALIZED_SHA=\"${injector_normalized_sha}\""
    "EGO_HAS_INITIAL_RECOVERY=${has_initial_recovery}")
target_compile_options(initial_module_inspection_probe PRIVATE /W4 /EHsc /permissive-)
target_link_options(initial_module_inspection_probe PRIVATE /INCREMENTAL:NO)
target_link_libraries(initial_module_inspection_probe PRIVATE psapi advapi32 bcrypt version)
