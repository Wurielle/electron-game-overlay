# Gen35 auxiliary lifetime tail. Recognized mixed states make each file publication restartable.
function(ego_auxiliary_lifetime_state source_dir)
    set(vector
        "source/ego_owned_late_d3d11/owned_runtime_policy.hpp=7E0DB28C5BE80D11890FDFAFC6AE018975E1F4EBA5804EF900C6E2FAAD428143"
        "source/dxgi/dxgi_swapchain.hpp=C5A155BE0321F30DB18B4FC4578A41BF728414DD0927A789D5C335041922BC55"
        "source/ini_file.cpp=08ACD295DB065D11E5A8388F074CFC6C384D29896E5DA9B20227222D8A61C688"
        "source/ego_owned_late_d3d11/compatibility_snapshot.hpp=2CE32E583C5F2D4F9C55B752675DB530A0B4007F7DB4E6CA0D264E7973DE8D93"
        "source/dxgi/dxgi.cpp=41A686B186910B4C0FAA1B631356C2D7FD0F4BE772EFB32D7328DAA2DC65B88F"
        "source/hook_manager.cpp=C62CD60C5AFD66FAFCF6F3E0659C88078685351CB20B9721742953C7D64516BB"
        "source/dxgi/dxgi_swapchain.cpp=34B2775D1F013225ACCA24AAA1C2D08400E8217B46AEC66CC2FAAAAA12AC51EF"
        "ReShade.vcxproj=9FC55C36B9B4E55E8FE9D87401CEFE69858B5FA5110023840BEAF2FC5B8D2A9C"
        "include/reshade.hpp=CC102FA21D311B85713ED167F0E182A4EECCD40CDF3FBE360AD9F83A0CF40767"
        "include/reshade_api.hpp=80E9F0CBC06BF96943DC79CA2D133DB5D8E69D3A4CD516B6D89D675B8B965218"
        "include/reshade_events.hpp=8090912CD69854818C294F7C0F848EBAB7C712AB6D601E6889E62514249EE6A7"
        "source/addon.cpp=DF69C9E8BE88244B54D92849A183B8A149A74FA959ED49A7109824EF0D8E3D9C"
        "source/addon_manager.cpp=E6524902A07A0B4E2947B372503679A84CAA0FD1840329E89564559C3160349E"
        "source/addon_manager.hpp=C1D27EA4C9996F1EAD408FAD0D0DB3AEEAE16A4BEFEB4A0F71EC6C616116989B"
        "source/d3d11/d3d11_impl_swapchain.cpp=9CC88315C5F2A4DAAA7E4AEAEBBA6584851AE565EC5D250C28BE2AE3B4347DDF"
        "source/d3d11/d3d11_impl_swapchain.hpp=D6010A43C93302C056AF62E1BBE7523E6A8D023DEDFB9D3F50DC689EAA9169B6"
        "source/ego_owned_late_d3d11/owned_config_file.hpp=98D7B1D5D55841FDDD0320378C130D61DFF688EC42C47E6C14BAC7ADDE87C8D8"
        "source/ego_owned_late_d3d11/owned_late_d3d11.hpp=99C928A9D56A8A029F0E02C354C22142A95DCDEE849359B2C31E8077F3C589B6"
        "source/ego_owned_late_d3d11/owned_late_d3d11.inl=F703E65A5BAEBA34FDD24378EC8F37E8A8B02691BCCD97CD72AC596FCBF51B13"
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
    foreach(descriptor IN LISTS EGO_AUXILIARY_LIFETIME_DESCRIPTORS)
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
            message(FATAL_ERROR "Unknown composition auxiliary lifetime source ${name}; edits were preserved.")
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

function(ego_owned_composition_auxiliary_lifetime_tail source_dir direction)
    set(EGO_AUXILIARY_LIFETIME_DESCRIPTORS
        "source/ego_owned_late_d3d11/owned_runtime_policy.hpp|7E0DB28C5BE80D11890FDFAFC6AE018975E1F4EBA5804EF900C6E2FAAD428143|A06E427C7EA2AE73F3FF90E14C204719FC247B9DE02EB5F84E066B602623F524"
        "source/ego_owned_late_d3d11/compatibility_snapshot.hpp|2CE32E583C5F2D4F9C55B752675DB530A0B4007F7DB4E6CA0D264E7973DE8D93|EF7E0B8A483D54053E2934E936DE96F8414DEF1B725D0CA131DD2121A5EA7F32"
        "source/ego_owned_late_d3d11/owned_late_d3d11.inl|F703E65A5BAEBA34FDD24378EC8F37E8A8B02691BCCD97CD72AC596FCBF51B13|7D6DCB3C8EA776EE8A4DBFC205CF0B3380AC60F57C86C00868532F2200941595"
        "source/dxgi/dxgi_swapchain.cpp|34B2775D1F013225ACCA24AAA1C2D08400E8217B46AEC66CC2FAAAAA12AC51EF|7213F5376BBEF92909910B33BA9B9F771101DA268E2AAAAECD212F1A1CBFDD2E"
    )
    set(patch "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-owned-composition-auxiliary-lifetime.patch")
    ego_read_source_cache_file("${CMAKE_CURRENT_SOURCE_DIR}/patches" "reshade-owned-composition-auxiliary-lifetime.patch" patch_hash patch_text)
    if(NOT patch_hash STREQUAL "3E80D0D05CA9F383D9E5216034E687B93CC858334B2F61514ADE91EF18573E61")
        message(FATAL_ERROR "The composition auxiliary lifetime patch changed; source was preserved.")
    endif()
    set(reverse)
    if(direction STREQUAL "REVERSE")
        set(active FALSE)
        foreach(descriptor IN LISTS EGO_AUXILIARY_LIFETIME_DESCRIPTORS)
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
        list(REVERSE EGO_AUXILIARY_LIFETIME_DESCRIPTORS)
    elseif(NOT direction STREQUAL "FORWARD")
        message(FATAL_ERROR "Unknown composition auxiliary lifetime direction.")
    endif()
    ego_auxiliary_lifetime_state("${source_dir}")
    set(scratch "${CMAKE_CURRENT_BINARY_DIR}/ego-owned-composition-auxiliary-lifetime-stage")
    file(MAKE_DIRECTORY "${scratch}/candidate")
    ego_write_lf_source_cache_file("${scratch}/snapshot.patch" "${patch_text}")
    foreach(descriptor IN LISTS EGO_AUXILIARY_LIFETIME_DESCRIPTORS)
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
                message(FATAL_ERROR "The staged composition auxiliary lifetime digest differs; source was preserved.")
            endif()
        endif()
        ego_auxiliary_lifetime_state("${source_dir}")
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
        ego_auxiliary_lifetime_state("${source_dir}")
    endforeach()
endfunction()
