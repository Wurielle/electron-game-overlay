cmake_minimum_required(VERSION 3.24)
project(preloaded_injector_policy_fixture LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This fixture requires Windows and MSVC.")
endif()
set(INJECTOR_SOURCE_FILE "" CACHE FILEPATH "Exact patched injector source under test")
if(NOT EXISTS "${INJECTOR_SOURCE_FILE}")
    message(FATAL_ERROR "Supply INJECTOR_SOURCE_FILE naming the exact candidate injector source.")
endif()
get_filename_component(INJECTOR_SOURCE_FILE "${INJECTOR_SOURCE_FILE}" REALPATH)
file(TO_CMAKE_PATH "${INJECTOR_SOURCE_FILE}" INJECTOR_SOURCE_INCLUDE)
file(READ "${INJECTOR_SOURCE_FILE}" INJECTOR_SOURCE_TEXT)
if(NOT INJECTOR_SOURCE_TEXT MATCHES "\\(ready \\|\\| adapter_ready\\) && owned_late.initializer == 0")
    message(FATAL_ERROR "Candidate does not admit a completed foreign adapter without an authenticated member.")
endif()

add_executable(preloaded_injector_policy_fixture fixture.cpp)
target_compile_features(preloaded_injector_policy_fixture PRIVATE cxx_std_17)
target_compile_definitions(preloaded_injector_policy_fixture PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN
    "EGO_INJECTOR_SOURCE=\"${INJECTOR_SOURCE_INCLUDE}\"")
target_compile_options(preloaded_injector_policy_fixture PRIVATE /EHsc /W4)
target_link_libraries(preloaded_injector_policy_fixture PRIVATE bcrypt advapi32 psapi)
target_link_options(preloaded_injector_policy_fixture PRIVATE /INCREMENTAL:NO)

enable_testing()
add_test(NAME preloaded_injector_policy COMMAND preloaded_injector_policy_fixture)
set_tests_properties(preloaded_injector_policy PROPERTIES
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
