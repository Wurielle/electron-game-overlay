cmake_minimum_required(VERSION 3.24)
project(early_process_bootstrap_proof LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "This isolated proof requires Windows and MSVC.")
endif()
if(CMAKE_GENERATOR_PLATFORM MATCHES "ARM")
    message(FATAL_ERROR "The isolated proof currently covers x64 and Win32 only.")
endif()
set(DETOURS_SOURCE_DIR "" CACHE PATH "Exact official Detours v4.0.1 source checkout")
if(NOT IS_DIRECTORY "${DETOURS_SOURCE_DIR}/src")
    message(FATAL_ERROR "Supply DETOURS_SOURCE_DIR; see README.md for the pinned official checkout.")
endif()

# Never compile an arbitrary registered or unverified dependency. CRLF/LF text
# normalization permits ordinary Git checkout settings; no code edits are allowed.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/detours-source-lock.json" detours_lock)
string(JSON dependency_count LENGTH "${detours_lock}" files)
math(EXPR dependency_last "${dependency_count} - 1")
foreach(index RANGE 0 ${dependency_last})
    string(JSON relative GET "${detours_lock}" files ${index} path)
    string(JSON expected GET "${detours_lock}" files ${index} lfSha256)
    file(READ "${DETOURS_SOURCE_DIR}/${relative}" body)
    string(REPLACE "\r\n" "\n" body "${body}")
    string(SHA256 actual "${body}")
    if(NOT actual STREQUAL expected)
        message(FATAL_ERROR "Official Detours source identity mismatch: ${relative}")
    endif()
endforeach()

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
add_library(early_proof_detours STATIC
    "${DETOURS_SOURCE_DIR}/src/detours.cpp"
    "${DETOURS_SOURCE_DIR}/src/modules.cpp"
    "${DETOURS_SOURCE_DIR}/src/disasm.cpp"
    "${DETOURS_SOURCE_DIR}/src/image.cpp"
    "${DETOURS_SOURCE_DIR}/src/creatwth.cpp"
    "${DETOURS_SOURCE_DIR}/src/disolx86.cpp"
    "${DETOURS_SOURCE_DIR}/src/disolx64.cpp"
    "${DETOURS_SOURCE_DIR}/src/disolia64.cpp"
    "${DETOURS_SOURCE_DIR}/src/disolarm.cpp"
    "${DETOURS_SOURCE_DIR}/src/disolarm64.cpp")
target_include_directories(early_proof_detours PUBLIC "${DETOURS_SOURCE_DIR}/src")
target_compile_definitions(early_proof_detours PRIVATE WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0601)
target_compile_options(early_proof_detours PRIVATE /W3)

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(proof_bits 64)
else()
    set(proof_bits 32)
endif()
add_library(early_process_bootstrap SHARED bootstrap.cpp trace.hpp)
set_target_properties(early_process_bootstrap PROPERTIES OUTPUT_NAME "early_process_bootstrap${proof_bits}")
target_link_libraries(early_process_bootstrap PRIVATE early_proof_detours d3d12)
# Same ordinal/helper convention as the official Detours samples. The proof
# launches with matching architectures; this remains a valid helper DLL.
target_link_options(early_process_bootstrap PRIVATE "/export:DetourFinishHelperProcess,@1,NONAME")

add_library(early_original_graphics SHARED original-graphics.cpp original-graphics.h trace.hpp)
target_link_libraries(early_original_graphics PRIVATE d3d12)
add_executable(early_process_bootstrap_host host.cpp original-graphics.h trace.hpp)
target_link_libraries(early_process_bootstrap_host PRIVATE early_original_graphics d3d12 dxgi dxguid user32)
add_executable(early_process_bootstrap_launcher launcher.cpp)
target_link_libraries(early_process_bootstrap_launcher PRIVATE early_proof_detours)

foreach(target early_process_bootstrap early_original_graphics early_process_bootstrap_host early_process_bootstrap_launcher)
    target_compile_features(${target} PRIVATE cxx_std_17)
    target_compile_definitions(${target} PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00)
    target_compile_options(${target} PRIVATE /W4 /permissive- /EHsc)
    target_link_options(${target} PRIVATE /INCREMENTAL:NO)
endforeach()

# The complete upstream license stays intact alongside every copied proof.
configure_file("${DETOURS_SOURCE_DIR}/LICENSE.md" "${CMAKE_CURRENT_BINARY_DIR}/LICENSE.Detours.md" COPYONLY)
