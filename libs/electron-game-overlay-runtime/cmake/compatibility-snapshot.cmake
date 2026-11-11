# Gen31 diagnostic tail. Recognized mixed states make each file publication restartable.
function(ego_snapshot_state source_dir)
    set(vector
        "source/hook_manager.cpp=D3DF8D3B7A1B5762579F9813EF90BA9087D8647BC8333CD0E786E1526A9A8126"
        "source/dxgi/dxgi_swapchain.cpp=A3152E13EF9651AF6406460AF605AD950D6A9867D2C7D4A2CC12835A32AD848A"
        "ReShade.vcxproj=9FC55C36B9B4E55E8FE9D87401CEFE69858B5FA5110023840BEAF2FC5B8D2A9C"
        "include/reshade.hpp=CC102FA21D311B85713ED167F0E182A4EECCD40CDF3FBE360AD9F83A0CF40767"
        "include/reshade_api.hpp=80E9F0CBC06BF96943DC79CA2D133DB5D8E69D3A4CD516B6D89D675B8B965218"
        "include/reshade_events.hpp=8090912CD69854818C294F7C0F848EBAB7C712AB6D601E6889E62514249EE6A7"
        "source/addon.cpp=DF69C9E8BE88244B54D92849A183B8A149A74FA959ED49A7109824EF0D8E3D9C"
        "source/addon_manager.cpp=E6524902A07A0B4E2947B372503679A84CAA0FD1840329E89564559C3160349E"
        "source/addon_manager.hpp=C1D27EA4C9996F1EAD408FAD0D0DB3AEEAE16A4BEFEB4A0F71EC6C616116989B"
        "source/d3d11/d3d11_impl_swapchain.cpp=6F9EA10B4621F37F2D4DAFA2E3F3575973DFDB6B566725BBD8B0BC8187DB52D3"
        "source/d3d11/d3d11_impl_swapchain.hpp=60B7409A9D8123D2092792C2C510B0B5741764A1195C332FE9949245A9B9BB70"
        "source/ego_owned_late_d3d11/owned_config_file.hpp=98D7B1D5D55841FDDD0320378C130D61DFF688EC42C47E6C14BAC7ADDE87C8D8"
        "source/ego_owned_late_d3d11/owned_late_d3d11.hpp=99C928A9D56A8A029F0E02C354C22142A95DCDEE849359B2C31E8077F3C589B6"
        "source/ego_owned_late_d3d11/owned_late_d3d11.inl=8265E994A31EEFBE806EA7775E165F1EFB556967DAA5AC5ABF428307F26A9F71"
        "source/input_frame_consumer.hpp=50808217A78ABD97417CA57694A5275895F8F0318AF6172658C087C26D3F8CA0"
        "source/input.cpp=B5778EA4DFD482F1E3E0C8A5337BCCFF351EA2CCF85AD0FDF565669CB9852D72"
        "source/input.hpp=6F9AF2B09AC6FF491AA2BC96A024E3B90F703985FFAD7A96C2BBB862667A4C1E"
        "source/runtime.cpp=96B12143E7A13B607D101AE7FD573C86334DD1BFDEEC2CA21520C74FE0200CD7"
        "source/runtime.hpp=1F2CF88559AE52D62DC3A8B236A734093E74864CAC44A069DD54440FBCCE3D11"
        "source/runtime_gui.cpp=6B8A8D3ACECE1E9C687062360FABBFAC04397222973A23565B661A7505F3187A"
        "tools/injector.cpp=7A6DC34363FF8EBD78484D8AEE6CE0463F22E90AB35DD1261FC9FBD9B09A3A3E"
    )
    set(files)
    foreach(entry IN LISTS vector)
        string(REGEX REPLACE "=.*$" "" name "${entry}")
        list(APPEND files "${name}")
    endforeach()
    foreach(descriptor IN LISTS EGO_SNAPSHOT_DESCRIPTORS)
        string(REPLACE "|" ";" fields "${descriptor}")
        list(GET fields 0 name)
        list(GET fields 1 before)
        list(GET fields 2 after)
        if(EXISTS "${source_dir}/${name}" OR IS_SYMLINK "${source_dir}/${name}")
            ego_read_source_cache_file("${source_dir}" "${name}" actual ignored)
        else()
            set(actual "ABSENT")
        endif()
        if(NOT actual STREQUAL before AND NOT actual STREQUAL after)
            message(FATAL_ERROR "Unknown compatibility snapshot source ${name}; edits were preserved.")
        endif()
        if(name IN_LIST files)
            string(REPLACE "${name}=${before}" "${name}=${actual}" vector "${vector}")
        elseif(NOT actual STREQUAL "ABSENT")
            list(APPEND vector "${name}=${actual}")
            if(actual STREQUAL after)
                list(APPEND files "${name}")
            endif()
        endif()
    endforeach()
    set(RESHAPE_EXPECTED_PATCHED_FILES "${files}")
    set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256 "${vector}")
    ego_assert_source_cache_vector("${source_dir}" ${vector})
    verify_reshade_patched_source("${source_dir}")
endfunction()

function(ego_compatibility_snapshot_tail source_dir direction)
    set(EGO_SNAPSHOT_DESCRIPTORS
        "source/hook_manager.cpp|D3DF8D3B7A1B5762579F9813EF90BA9087D8647BC8333CD0E786E1526A9A8126|C62CD60C5AFD66FAFCF6F3E0659C88078685351CB20B9721742953C7D64516BB"
        "source/dxgi/dxgi.cpp|3CF6937434A3FC962FDFB75DEF8BB17CB3C35350870576F60692663135ECF7E5|41A686B186910B4C0FAA1B631356C2D7FD0F4BE772EFB32D7328DAA2DC65B88F"
        "source/dxgi/dxgi_swapchain.cpp|A3152E13EF9651AF6406460AF605AD950D6A9867D2C7D4A2CC12835A32AD848A|43213ED06E440CC33D854718E872934C92294A7FF7CB597AC110CFBCBD13A3E5"
        "source/ego_owned_late_d3d11/owned_late_d3d11.inl|8265E994A31EEFBE806EA7775E165F1EFB556967DAA5AC5ABF428307F26A9F71|E9D57C1E5501DF5474EBF9AF9A9F1059489BD60AB4C4633CF6C4586DBF498D67"
        "source/ego_owned_late_d3d11/compatibility_snapshot.hpp|ABSENT|B6C215B7780483A6B859759F088A565BE9F5AF023115935441F373E81A1DCDEE"
    )
    set(patch "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-compatibility-snapshot.patch")
    ego_read_source_cache_file("${CMAKE_CURRENT_SOURCE_DIR}/patches" "reshade-compatibility-snapshot.patch" patch_hash patch_text)
    if(NOT patch_hash STREQUAL "C63E22F1768770469C770FB6D4124AE1A293A6D5ACD8402E8EC86F33B1CA1C66")
        message(FATAL_ERROR "The compatibility snapshot patch changed; source was preserved.")
    endif()
    set(reverse)
    if(direction STREQUAL "REVERSE")
        set(active FALSE)
        foreach(descriptor IN LISTS EGO_SNAPSHOT_DESCRIPTORS)
            string(REPLACE "|" ";" fields "${descriptor}")
            list(GET fields 0 name)
            list(GET fields 1 before)
            list(GET fields 2 after)
            if(EXISTS "${source_dir}/${name}" OR IS_SYMLINK "${source_dir}/${name}")
                ego_read_source_cache_file("${source_dir}" "${name}" actual ignored)
                if(actual STREQUAL after OR before STREQUAL "ABSENT")
                    set(active TRUE)
                endif()
            endif()
        endforeach()
        if(NOT active)
            return() # Existing historical vector guards remain authoritative.
        endif()
        set(reverse "--reverse")
        list(REVERSE EGO_SNAPSHOT_DESCRIPTORS)
    elseif(NOT direction STREQUAL "FORWARD")
        message(FATAL_ERROR "Unknown compatibility snapshot direction.")
    endif()
    ego_snapshot_state("${source_dir}")
    set(scratch "${CMAKE_CURRENT_BINARY_DIR}/ego-compatibility-snapshot-stage")
    file(MAKE_DIRECTORY "${scratch}/candidate")
    ego_write_lf_source_cache_file("${scratch}/snapshot.patch" "${patch_text}")
    foreach(descriptor IN LISTS EGO_SNAPSHOT_DESCRIPTORS)
        string(REPLACE "|" ";" fields "${descriptor}")
        list(GET fields 0 name)
        list(GET fields 1 before)
        list(GET fields 2 after)
        if(direction STREQUAL "REVERSE")
            set(desired "${before}")
        else()
            set(desired "${after}")
        endif()
        if(EXISTS "${source_dir}/${name}")
            ego_read_source_cache_file("${source_dir}" "${name}" actual source_text)
            file(SHA256 "${source_dir}/${name}" raw_hash)
        else()
            set(actual "ABSENT")
        endif()
        if(actual STREQUAL desired)
            continue()
        endif()
        get_filename_component(parent "${scratch}/candidate/${name}" DIRECTORY)
        file(MAKE_DIRECTORY "${parent}")
        if(actual STREQUAL "ABSENT")
            file(REMOVE "${scratch}/candidate/${name}")
        else()
            ego_write_lf_source_cache_file("${scratch}/candidate/${name}" "${source_text}")
        endif()
        foreach(action IN ITEMS "--check" "--apply")
            execute_process(COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE
                "GIT_CEILING_DIRECTORIES=${scratch}" "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf
                apply --whitespace=nowarn ${reverse} "${action}" "--include=${name}" "${scratch}/snapshot.patch"
                WORKING_DIRECTORY "${scratch}/candidate" COMMAND_ERROR_IS_FATAL ANY)
        endforeach()
        if(desired STREQUAL "ABSENT")
            if(EXISTS "${scratch}/candidate/${name}")
                message(FATAL_ERROR "The staged diagnostic header was not removed.")
            endif()
        else()
            ego_read_source_cache_file("${scratch}/candidate" "${name}" staged ignored)
            if(NOT staged STREQUAL desired)
                message(FATAL_ERROR "The staged compatibility snapshot digest differs; source was preserved.")
            endif()
        endif()
        ego_snapshot_state("${source_dir}")
        if(NOT actual STREQUAL "ABSENT")
            file(SHA256 "${source_dir}/${name}" current_raw_hash)
            if(NOT current_raw_hash STREQUAL raw_hash)
                message(FATAL_ERROR "Source changed during diagnostic staging; edits were preserved.")
            endif()
        elseif(EXISTS "${source_dir}/${name}" OR IS_SYMLINK "${source_dir}/${name}")
            message(FATAL_ERROR "Source appeared during diagnostic staging; edits were preserved.")
        endif()
        if(desired STREQUAL "ABSENT")
            file(REMOVE "${source_dir}/${name}")
        else()
            file(RENAME "${scratch}/candidate/${name}" "${source_dir}/${name}" RESULT result)
            if(NOT result STREQUAL "0")
                message(FATAL_ERROR "Cannot publish verified diagnostic source: ${result}")
            endif()
        endif()
        ego_snapshot_state("${source_dir}")
    endforeach()
endfunction()
