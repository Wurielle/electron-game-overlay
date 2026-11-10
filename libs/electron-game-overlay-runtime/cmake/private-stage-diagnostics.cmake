# Failure-only injector diagnostics, independently atomic over generation 29.
function(ego_private_stage_diagnostics_tail source_dir direction)
    set(before_hash "454B5B8377548E6B99911F20A7166FAADDB10BE9FB27565E34DA0F4F5A27B62C")
    set(after_hash "7A6DC34363FF8EBD78484D8AEE6CE0463F22E90AB35DD1261FC9FBD9B09A3A3E")
    ego_read_source_cache_file("${source_dir}" "tools/injector.cpp" actual_hash ignored)
    if(direction STREQUAL "REVERSE" AND actual_hash STREQUAL before_hash)
        return() # Older recognized cache lanes retain their existing validation.
    endif()
    set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256 "${RESHAPE_ELEVATED_PRIVATE_PATCHED_CONTENT_SHA256}"
        "source/dxgi/dxgi_swapchain.cpp=A3152E13EF9651AF6406460AF605AD950D6A9867D2C7D4A2CC12835A32AD848A")
    if(NOT "source/dxgi/dxgi_swapchain.cpp" IN_LIST RESHAPE_EXPECTED_PATCHED_FILES)
        list(APPEND RESHAPE_EXPECTED_PATCHED_FILES "source/dxgi/dxgi_swapchain.cpp")
    endif()
    set(arguments)
    if(direction STREQUAL "REVERSE")
        string(REPLACE "tools/injector.cpp=${before_hash}" "tools/injector.cpp=${after_hash}"
            RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256 "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
        set(saved "${before_hash}")
        set(before_hash "${after_hash}")
        set(after_hash "${saved}")
        set(arguments REVERSE)
    elseif(NOT direction STREQUAL "FORWARD")
        message(FATAL_ERROR "Unknown private-stage diagnostic patch direction.")
    endif()
    ego_apply_terminal_source_file_tail("${source_dir}" "tools/injector.cpp"
        "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-private-stage-diagnostics.patch"
        "D73FF95608079571FC6438F8B5E280BB710AD8467F19CA31B664E371929C05F1"
        "${before_hash}" "${after_hash}" ${arguments})
endfunction()
