cmake_minimum_required(VERSION 3.24)

project(electron_game_overlay_runtime LANGUAGES CXX)

set(ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID
    "CCE20935ADD44EF6A5A7973014B2E07F"
)
set(RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256
    "A8ECF5046DD3BEDB748B77202504B234E39444FD96A9EAFC35A5877FEBC683E6"
)
set(RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256
    "91D82243D81D2CDC082DA1AF9BFF55A13315BF59F1FE5F9ACA1DFAE8442C8A10"
)
set(RESHAPE_INITIAL_INSPECTION_RECOVERY_INJECTOR_CONTENT_SHA256
    "58ED5A9C5F0B0806D7D4AE65D060271AD8D62676A62332F0BE6FEAD88B6D8BFA"
)
set(RESHAPE_PRE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256
    "AEA939BCC391BC5C2F63683558B78A88222BD5E9C4B81EFB5069CAA346F724BE"
)
set(RESHAPE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256
    "36753053450815B934A6117B1C072A2100AA86032DF30D937F9A127CA0F7A5F0"
)
set(RESHAPE_PRE_FIRST_HOST_PRELOADED_INJECTOR_CONTENT_SHA256
    "B8E59D50F1D5D9EF54281B6B77FC034B780044C706F04C4F63B947EDE5E45191"
)
set(RESHAPE_PRE_PRELOADED_INJECTOR_CONTENT_SHA256
    "A0778FA5C2717181B6F554EBAEA81B07CF8551035A0D5FA4651373598DED3E1A"
)
set(RESHAPE_PRE_RESULT_INJECTOR_CONTENT_SHA256
    "AB207E80D364430D700375AA47FEADC4F871CF8B4767943472E9196415D79202"
)
set(RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256
    "F2007061AADE201DADFA5412E85FC78BD9EE4065D84B1ECD6E9858F9B99D12BA"
)
set(RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256
    "62816AD762635E8EAD5667EAC0C862854DFB91BE57E11C165B1F28020ABF44D7"
)
set(RESHAPE_GEN18_CURRENT_INJECTOR_CONTENT_SHA256
    "53945B0E76711393929460608B63377F43549E59B57FE02237904CDBC3E98F9B"
)
set(RESHAPE_GEN18_PRE_PRELOADED_INJECTOR_CONTENT_SHA256
    "0AD06624529D7683EF58637F0955FF565275C2FDD6FF751A37B693DA6D39390B"
)
set(RESHAPE_GEN18_PRE_RESULT_INJECTOR_CONTENT_SHA256
    "EC57285380625B70964F33106857C3EAAA55BFCB5A31D66C1177500D360853F4"
)
set(RESHAPE_GEN18_PRE_LATE_V4_INJECTOR_CONTENT_SHA256
    "FB85D69E1D6B97D9DC4E4A82C591425A588A99601F897B0F6316D1E5A81E0683"
)
set(RESHAPE_GEN18_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256
    "75FF6A30283E8147A47982C61C5ADC7F080DEED7C28345D420907753DC218C25"
)
set(RESHAPE_GEN17_CURRENT_INJECTOR_CONTENT_SHA256
    "B80C6E3BCF0C5EC499559BEDB9D829B08F664FBAD94E38BEC31C41DB5CC40849"
)
set(RESHAPE_GEN17_PRE_PRELOADED_INJECTOR_CONTENT_SHA256
    "05045D6F8824A0105B9B6E02EFF8652075E9700DFD8E656FE7EBBA34B6F13D13"
)
set(RESHAPE_GEN17_PRE_RESULT_INJECTOR_CONTENT_SHA256
    "AFE3A0C9BD7830D028A6661404DE80860CF91A35C70C4A71AE86308111B285EC"
)
set(RESHAPE_GEN17_PRE_LATE_V4_INJECTOR_CONTENT_SHA256
    "B11E61F8089802A590967C03DB358B253EEA8FE84FA3DCE2849F6EC642E9AA02"
)
set(RESHAPE_GEN17_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256
    "35BDAB091F1D93E89BC2C65E1F7853540B81931E99A1914697418E71609CC929"
)
set(RESHAPE_GEN16_CURRENT_INJECTOR_CONTENT_SHA256
    "F286CDC1B9D138E4429A50C3E82749292B39F51B42592BFD9B738C889A6FA074"
)
set(RESHAPE_GEN16_PRE_RESULT_INJECTOR_CONTENT_SHA256
    "A3C7F581069BF0A2AF77AAC8F2441AF98AB42073C56443C257586931F35F6AB5"
)
set(RESHAPE_GEN16_PRE_LATE_V4_INJECTOR_CONTENT_SHA256
    "C2F7641F12F19FD1F78ABDB608DA9EF5A8B58DB087E30552ED3EDEE42AFCDF48"
)
set(RESHAPE_GEN16_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256
    "0A452E415E4AD37B6558D0F398A2A5A7A161D752148A70B21A4E8097740CA7D9"
)
set(RESHAPE_GEN15_CURRENT_INJECTOR_CONTENT_SHA256
    "8EC5E249B34ACD0E6315AFADFB9E6FD698B5237AE36F0C4E11BB6DDEBB404F60"
)
set(RESHAPE_GEN15_PRE_RESULT_INJECTOR_CONTENT_SHA256
    "C5451CD3C3FFCA5072ED326EC585A0E77CE86CB5E1F17CDFAC42E4FAF9A9845C"
)
set(RESHAPE_GEN15_PRE_LATE_V4_INJECTOR_CONTENT_SHA256
    "F1B4EFB815F45A61BDCF31BC7C04D2B49ED8F060CD98CD03960E0BC222FD3E8B"
)
set(RESHAPE_GEN15_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256
    "3D51024529834F539601F4E2573E29591954CF5906C704C980086108DB51373B"
)
set(RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256
    "07A76311F29A7A20E54D305BCA1F384A035C84D620BF201C3CACBAC9681BA7B6"
)

option(
    ELECTRON_GAME_OVERLAY_BUILD_ADDON
    "Build the production Electron compositor add-on and transport ABI smoke test"
    OFF
)

if(NOT WIN32)
    message(FATAL_ERROR "The Electron game overlay runtime only supports Windows.")
endif()

if(NOT MSVC)
    message(FATAL_ERROR "The Electron game overlay runtime is verified with MSVC only.")
endif()

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(ELECTRON_GAME_OVERLAY_ADDON_SUFFIX ".addon64")
    set(ELECTRON_TRANSPORT_RUST_TARGET "x86_64-pc-windows-msvc")
elseif(CMAKE_SIZEOF_VOID_P EQUAL 4)
    set(ELECTRON_GAME_OVERLAY_ADDON_SUFFIX ".addon32")
    set(ELECTRON_TRANSPORT_RUST_TARGET "i686-pc-windows-msvc")
else()
    message(FATAL_ERROR "The Electron game overlay runtime requires x86 or x64.")
endif()

include(FetchContent)
find_package(Git REQUIRED)

set(RESHAPE_PINNED_COMMIT "4a50d1eddace85734871d91792ff214f13f66c01")
set(RESHAPE_SOURCE_PATCHES
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-input-observer.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-base-path.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-pointer-input-block.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-exact-pid.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-path-watcher.patch"
)
set(RESHAPE_RAW_INPUT_NORMALIZATION_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-raw-input-normalization.patch"
)
set(RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-raw-input-registration-reconciliation.patch"
)
set(RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-raw-input-focus-following-root.patch"
)
set(RESHAPE_PATH_WATCHER_IDENTITY_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-path-watcher-process-identity.patch"
)
set(RESHAPE_PROCESS_OBSERVER_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-persistent-path-observer.patch"
)
set(RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-resilient-path-observer.patch"
)
set(RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-conflict-preflight.patch"
)
set(RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-per-pid-claim.patch"
)
set(RESHAPE_SHARED_RUNTIME_HOST_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-shared-runtime-host.patch"
)
set(RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-export-read-bounds.patch"
)
set(RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-existing-installation-preflight.patch"
)
set(RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-official-addon-host.patch"
)
set(RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-global-layer-preflight.patch"
)
set(RESHAPE_SHARED_RUNTIME_HARDENING_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-shared-runtime-hardening.patch"
)
set(RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-legacy-snapshot-observer.patch"
)
set(RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-low-latency-observer.patch"
)
set(RESHAPE_SUPPRESS_SPLASH_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-suppress-splash.patch"
)
set(RESHAPE_X86_RUNTIME_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-x86-runtime.patch"
)
set(RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-x86-target-architecture-diagnostic.patch"
)
set(RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-exact-target-path.patch"
)
set(RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-name-watcher-ready.patch"
)
set(RESHAPE_FUTURE_TARGETS_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-future-targets.patch")
set(RESHAPE_PROCESS_POLICY_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-process-policy.patch")
set(RESHAPE_COOPERATIVE_MEMBERS_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-cooperative-members.patch"
)
set(RESHAPE_COOPERATIVE_MEMBERS_V3_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-cooperative-members-v3.patch"
)
set(RESHAPE_OWNED_LATE_D3D11_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-owned-late-d3d11.patch"
)
set(RESHAPE_OWNED_LATE_D3D11_PATCH_SHA256
    "51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE"
)
set(RESHAPE_FIRST_HOST_RESULT_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-first-host-result.patch"
)
set(RESHAPE_FIRST_HOST_RESULT_PATCH_SHA256
    "B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554"
)
set(RESHAPE_PRELOADED_ADDON_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-preloaded-addon.patch"
)
set(RESHAPE_PRELOADED_ADDON_PATCH_SHA256
    "E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D"
)
set(RESHAPE_PRELOADED_FIRST_HOST_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-preloaded-first-host.patch"
)
set(RESHAPE_PRELOADED_FIRST_HOST_PATCH_SHA256
    "A8C494EF02E08E5084D7EDC27ABCB73639C18D23469F244F99F090A27DB46309"
)
set(RESHAPE_PRELOAD_LONG_PATH_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-preload-long-path.patch"
)
set(RESHAPE_PRELOAD_LONG_PATH_PATCH_SHA256
    "FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B"
)
set(RESHAPE_ADAPTER_READY_LONG_PATH_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-owned-late-d3d11-adapter-ready-long-path.patch"
)
set(RESHAPE_ADAPTER_READY_LONG_PATH_PATCH_SHA256
    "BCC0F0CD455B80DB3ED6D850B63600116B1D9881F1C85602CF76CEF7B23C35A6"
)
set(RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-initial-inspection-recovery.patch"
)
set(RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256
    "5E9E7D2C8A2EE66F9A478CA193B5962C4F635943D040B121593AD70A3177D8A7"
)
set(RESHAPE_INJECTOR_PROCESS_INSTANCE_BINDING_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-process-instance-binding.patch"
)
# BEGIN EGO_SOURCE_CACHE_MIGRATION_TABLES
set(RESHAPE_PRE_LATE_PATCHED_FILES
    "include/reshade.hpp"
    "include/reshade_api.hpp"
    "include/reshade_events.hpp"
    "source/addon_manager.cpp"
    "source/addon_manager.hpp"
    "source/input.cpp"
    "source/input.hpp"
    "source/runtime_gui.cpp"
    "tools/injector.cpp"
)
set(RESHAPE_PRE_LATE_CONTENT_SHA256
    "ReShade.vcxproj=685BE751EFA61EEFDE92EF4DDFD8932A7B9E3C10BF07077099421D502BEA1C57"
    "include/reshade.hpp=CC102FA21D311B85713ED167F0E182A4EECCD40CDF3FBE360AD9F83A0CF40767"
    "include/reshade_api.hpp=80E9F0CBC06BF96943DC79CA2D133DB5D8E69D3A4CD516B6D89D675B8B965218"
    "include/reshade_events.hpp=8090912CD69854818C294F7C0F848EBAB7C712AB6D601E6889E62514249EE6A7"
    "source/addon.cpp=32A338204CF1D99C70F8769011E44DF8D9C8E94277437DD91C9002D972A8ED39"
    "source/addon_manager.cpp=28A0E7C805FC8D006E0B21BB9D3B7712ADBCDA771999F48ECD2ACAE3AC6F6488"
    "source/addon_manager.hpp=C1D27EA4C9996F1EAD408FAD0D0DB3AEEAE16A4BEFEB4A0F71EC6C616116989B"
    "source/d3d11/d3d11_impl_swapchain.cpp=6D8DCC7CD787D49C46D7244CC1E83BA8C26351BD6A65216D96C16D60296A250D"
    "source/d3d11/d3d11_impl_swapchain.hpp=FF21425B350A5005DFF6EAB2BE026245BEEA78B64CACF6478D37F6B9514C8D55"
    "source/ego_owned_late_d3d11/owned_config_file.hpp=ABSENT"
    "source/ego_owned_late_d3d11/owned_late_d3d11.hpp=ABSENT"
    "source/ego_owned_late_d3d11/owned_late_d3d11.inl=ABSENT"
    "source/input.cpp=3DCE0AB44CB798EAB7A1D61926A6FF1450015208E75A4FA1D57451AD18E7D7AF"
    "source/input.hpp=FCE52F33FE6B0865DAEBDE02037AE8A37B1BD16799CFC5E21E8C1602FA164352"
    "source/input_frame_consumer.hpp=ABSENT"
    "source/runtime.cpp=8FD6C3A54592F11CD50FC57FDB29F1181DE9F2F428ADB2133693F96C8E372628"
    "source/runtime.hpp=8599103DE7D8C0F6AD468066BCDEBC1761720A7E009CA6E4BF531BED30D87E0F"
    "source/runtime_gui.cpp=84887E6387FE9B72DB04969C953C3245F69B9471D76DCD14A05DEF18CCA80F40"
    "tools/injector.cpp=${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
)
set(RESHAPE_PRISTINE_CONTENT_SHA256
    "ReShade.vcxproj=685BE751EFA61EEFDE92EF4DDFD8932A7B9E3C10BF07077099421D502BEA1C57"
    "include/reshade.hpp=DCB22F29CA7D7B2E4A9EA2F19CF98CE2911141659E525D3417F5FFADA75899C8"
    "include/reshade_api.hpp=8D83EC8A620C48DA7A20D975BD27B3345B24D3F0D5B78AE4C4FE633D61B804EB"
    "include/reshade_events.hpp=64608864E68FAF8E01B896B7726A1B0FC5AEC3CD802B49BA19E1B58F2BCEBDFE"
    "source/addon.cpp=32A338204CF1D99C70F8769011E44DF8D9C8E94277437DD91C9002D972A8ED39"
    "source/addon_manager.cpp=822F7D151C55A40B9FAF4C9C93A5F50789422E8A164670AD5DA1DC54423B5C0F"
    "source/addon_manager.hpp=58E17E986E8A9CE007922F92C49B6144185BDEAE66627D576F674F1F6C416F2A"
    "source/d3d11/d3d11_impl_swapchain.cpp=6D8DCC7CD787D49C46D7244CC1E83BA8C26351BD6A65216D96C16D60296A250D"
    "source/d3d11/d3d11_impl_swapchain.hpp=FF21425B350A5005DFF6EAB2BE026245BEEA78B64CACF6478D37F6B9514C8D55"
    "source/ego_owned_late_d3d11/owned_config_file.hpp=ABSENT"
    "source/ego_owned_late_d3d11/owned_late_d3d11.hpp=ABSENT"
    "source/ego_owned_late_d3d11/owned_late_d3d11.inl=ABSENT"
    "source/input.cpp=AED8904412A8F54E340C64FBA09E80EA0DAB3B246C7E8969B27C2AF284442AB7"
    "source/input.hpp=8CF526402B7B0E1BF5367A865A89F92D2DE9D59C2AFD92508797A22095BFF6A1"
    "source/input_frame_consumer.hpp=ABSENT"
    "source/runtime.cpp=8FD6C3A54592F11CD50FC57FDB29F1181DE9F2F428ADB2133693F96C8E372628"
    "source/runtime.hpp=8599103DE7D8C0F6AD468066BCDEBC1761720A7E009CA6E4BF531BED30D87E0F"
    "source/runtime_gui.cpp=B6D3B8969FF2D36CC014B2E8BB2C272DA9FFA9BF973524F4A09609A024B0B157"
    "tools/injector.cpp=26CFBBFFD692ACFB24BD19CBD93B3C7F81F24555EA67B75C55FAD14861E38B00"
)
set(RESHAPE_EXPECTED_PATCHED_FILES
    "ReShade.vcxproj"
    "include/reshade.hpp"
    "include/reshade_api.hpp"
    "include/reshade_events.hpp"
    "source/addon.cpp"
    "source/addon_manager.cpp"
    "source/addon_manager.hpp"
    "source/d3d11/d3d11_impl_swapchain.cpp"
    "source/d3d11/d3d11_impl_swapchain.hpp"
    "source/ego_owned_late_d3d11/owned_config_file.hpp"
    "source/ego_owned_late_d3d11/owned_late_d3d11.hpp"
    "source/ego_owned_late_d3d11/owned_late_d3d11.inl"
    "source/input.cpp"
    "source/input.hpp"
    "source/input_frame_consumer.hpp"
    "source/runtime.cpp"
    "source/runtime.hpp"
    "source/runtime_gui.cpp"
    "tools/injector.cpp"
)
set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
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
    "source/ego_owned_late_d3d11/owned_late_d3d11.inl=AEA939BCC391BC5C2F63683558B78A88222BD5E9C4B81EFB5069CAA346F724BE"
    "source/input.cpp=B5778EA4DFD482F1E3E0C8A5337BCCFF351EA2CCF85AD0FDF565669CB9852D72"
    "source/input.hpp=6F9AF2B09AC6FF491AA2BC96A024E3B90F703985FFAD7A96C2BBB862667A4C1E"
    "source/input_frame_consumer.hpp=50808217A78ABD97417CA57694A5275895F8F0318AF6172658C087C26D3F8CA0"
    "source/runtime.cpp=96B12143E7A13B607D101AE7FD573C86334DD1BFDEEC2CA21520C74FE0200CD7"
    "source/runtime.hpp=1F2CF88559AE52D62DC3A8B236A734093E74864CAC44A069DD54440FBCCE3D11"
    "source/runtime_gui.cpp=6B8A8D3ACECE1E9C687062360FABBFAC04397222973A23565B661A7505F3187A"
    "tools/injector.cpp=${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
)
# END EGO_SOURCE_CACHE_MIGRATION_TABLES
# Preserve the frozen generation-19 migration vector above. Generation 20 owns
# only a terminal injector correction; every mapped implementation stays pinned.
string(REPLACE "tools/injector.cpp=${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
    "tools/injector.cpp=${RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256}"
    RESHAPE_PRELOAD_LONG_PATH_PATCHED_CONTENT_SHA256
    "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
# Generation 21 changes only the host's adapter discovery. Retain the exact
# generation-20 injector and derive a separate complete terminal vector.
string(REPLACE "source/ego_owned_late_d3d11/owned_late_d3d11.inl=${RESHAPE_PRE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256}"
    "source/ego_owned_late_d3d11/owned_late_d3d11.inl=${RESHAPE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256}"
    RESHAPE_ADAPTER_READY_LONG_PATH_PATCHED_CONTENT_SHA256
    "${RESHAPE_PRELOAD_LONG_PATH_PATCHED_CONTENT_SHA256}")
# Generation 22 preserves the mapped host implementation and adds only a
# terminal injector correction to the independently pinned generation-21 tree.
string(REPLACE "tools/injector.cpp=${RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256}"
    "tools/injector.cpp=${RESHAPE_INITIAL_INSPECTION_RECOVERY_INJECTOR_CONTENT_SHA256}"
    RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCHED_CONTENT_SHA256
    "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCHED_CONTENT_SHA256}")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    ${RESHAPE_SOURCE_PATCHES}
    "${RESHAPE_RAW_INPUT_NORMALIZATION_PATCH}"
    "${RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH}"
    "${RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH}"
    "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
    "${RESHAPE_PROCESS_OBSERVER_PATCH}"
    "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
    "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH}"
    "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
    "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
    "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
    "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH}"
    "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH}"
    "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
    "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH}"
    "${RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH}"
    "${RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH}"
    "${RESHAPE_SUPPRESS_SPLASH_PATCH}"
    "${RESHAPE_X86_RUNTIME_PATCH}"
    "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH}"
    "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH}"
    "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH}"
    "${RESHAPE_INJECTOR_PROCESS_INSTANCE_BINDING_PATCH}"
    "${RESHAPE_FUTURE_TARGETS_PATCH}"
    "${RESHAPE_PROCESS_POLICY_PATCH}"
    "${RESHAPE_COOPERATIVE_MEMBERS_PATCH}"
    "${RESHAPE_COOPERATIVE_MEMBERS_V3_PATCH}"
    "${RESHAPE_OWNED_LATE_D3D11_PATCH}"
    "${RESHAPE_FIRST_HOST_RESULT_PATCH}"
    "${RESHAPE_PRELOADED_ADDON_PATCH}"
    "${RESHAPE_PRELOADED_FIRST_HOST_PATCH}"
    "${RESHAPE_PRELOAD_LONG_PATH_PATCH}"
    "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCH}"
    "${RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH}"
)

function(verify_reshade_pinned_commit source_dir)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" rev-parse HEAD
        WORKING_DIRECTORY "${source_dir}"
        RESULT_VARIABLE RESHAPE_COMMIT_RESULT
        OUTPUT_VARIABLE RESHAPE_ACTUAL_COMMIT
        ERROR_VARIABLE RESHAPE_COMMIT_ERROR
        OUTPUT_STRIP_TRAILING_WHITESPACE
    )
    if(NOT RESHAPE_COMMIT_RESULT EQUAL 0 OR
        NOT RESHAPE_ACTUAL_COMMIT STREQUAL RESHAPE_PINNED_COMMIT)
        message(FATAL_ERROR
            "Fetched ReShade source is not the pinned commit "
            "${RESHAPE_PINNED_COMMIT}.\n"
            "Actual commit: '${RESHAPE_ACTUAL_COMMIT}'\n"
            "${RESHAPE_COMMIT_ERROR}"
        )
    endif()
endfunction()

function(verify_reshade_patched_source source_dir)
    verify_reshade_pinned_commit("${source_dir}")

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" status --porcelain=v1
            --untracked-files=all --ignore-submodules=none
        WORKING_DIRECTORY "${source_dir}"
        RESULT_VARIABLE RESHAPE_STATUS_RESULT
        OUTPUT_VARIABLE RESHAPE_STATUS_OUTPUT
        ERROR_VARIABLE RESHAPE_STATUS_ERROR
        OUTPUT_STRIP_TRAILING_WHITESPACE
    )
    if(NOT RESHAPE_STATUS_RESULT EQUAL 0)
        message(FATAL_ERROR
            "Unable to inspect the fetched ReShade source state.\n"
            "${RESHAPE_STATUS_ERROR}"
        )
    endif()

    string(REPLACE "\r\n" "\n" RESHAPE_STATUS_OUTPUT
        "${RESHAPE_STATUS_OUTPUT}")
    string(REPLACE "\r" "\n" RESHAPE_STATUS_OUTPUT
        "${RESHAPE_STATUS_OUTPUT}")
    set(RESHAPE_ACTUAL_PATCHED_FILES)
    if(NOT RESHAPE_STATUS_OUTPUT STREQUAL "")
        string(REPLACE "\n" ";" RESHAPE_STATUS_LINES
            "${RESHAPE_STATUS_OUTPUT}")
        foreach(RESHAPE_STATUS_LINE IN LISTS RESHAPE_STATUS_LINES)
            string(LENGTH "${RESHAPE_STATUS_LINE}" RESHAPE_STATUS_LINE_LENGTH)
            if(RESHAPE_STATUS_LINE_LENGTH LESS 4)
                message(FATAL_ERROR
                    "Unexpected entry in fetched ReShade status: "
                    "'${RESHAPE_STATUS_LINE}'"
                )
            endif()
            string(SUBSTRING "${RESHAPE_STATUS_LINE}" 3 -1
                RESHAPE_STATUS_PATH)
            list(APPEND RESHAPE_ACTUAL_PATCHED_FILES "${RESHAPE_STATUS_PATH}")
        endforeach()
    endif()

    set(RESHAPE_SORTED_EXPECTED_FILES ${RESHAPE_EXPECTED_PATCHED_FILES})
    list(SORT RESHAPE_SORTED_EXPECTED_FILES)
    list(SORT RESHAPE_ACTUAL_PATCHED_FILES)
    list(JOIN RESHAPE_SORTED_EXPECTED_FILES "\n"
        RESHAPE_EXPECTED_FILES_TEXT)
    list(JOIN RESHAPE_ACTUAL_PATCHED_FILES "\n"
        RESHAPE_ACTUAL_FILES_TEXT)
    list(LENGTH RESHAPE_EXPECTED_PATCHED_FILES RESHAPE_EXPECTED_PATCHED_FILE_COUNT)
    if(NOT RESHAPE_ACTUAL_FILES_TEXT STREQUAL RESHAPE_EXPECTED_FILES_TEXT)
        message(FATAL_ERROR
            "The fetched ReShade tree does not contain exactly the ${RESHAPE_EXPECTED_PATCHED_FILE_COUNT} "
            "pinned modified files.\n"
            "Expected:\n${RESHAPE_EXPECTED_FILES_TEXT}\n"
            "Actual:\n${RESHAPE_ACTUAL_FILES_TEXT}"
        )
    endif()

    foreach(RESHAPE_CONTENT_ENTRY IN LISTS
        RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256)
        string(FIND "${RESHAPE_CONTENT_ENTRY}" "=" RESHAPE_HASH_SEPARATOR)
        if(RESHAPE_HASH_SEPARATOR LESS 1)
            message(FATAL_ERROR
                "Invalid pinned ReShade content-hash entry: "
                "'${RESHAPE_CONTENT_ENTRY}'"
            )
        endif()
        math(EXPR RESHAPE_HASH_OFFSET "${RESHAPE_HASH_SEPARATOR} + 1")
        string(SUBSTRING "${RESHAPE_CONTENT_ENTRY}" 0
            ${RESHAPE_HASH_SEPARATOR} RESHAPE_PATCHED_FILE)
        string(SUBSTRING "${RESHAPE_CONTENT_ENTRY}" ${RESHAPE_HASH_OFFSET} -1
            RESHAPE_EXPECTED_CONTENT_HASH)
        set(RESHAPE_PATCHED_PATH "${source_dir}/${RESHAPE_PATCHED_FILE}")
        if(NOT EXISTS "${RESHAPE_PATCHED_PATH}")
            message(FATAL_ERROR
                "Pinned patched ReShade file is missing: "
                "${RESHAPE_PATCHED_FILE}"
            )
        endif()

        # Match build-reshade-runtime.ps1's ReadAllText behavior: discard a UTF-8 BOM,
        # normalize CRLF and bare CR to LF, then hash the resulting UTF-8 text.
        file(READ "${RESHAPE_PATCHED_PATH}" RESHAPE_CONTENT_PREFIX
            LIMIT 3 HEX)
        string(TOLOWER "${RESHAPE_CONTENT_PREFIX}" RESHAPE_CONTENT_PREFIX)
        if(RESHAPE_CONTENT_PREFIX STREQUAL "efbbbf")
            file(READ "${RESHAPE_PATCHED_PATH}" RESHAPE_PATCHED_CONTENT
                OFFSET 3)
        else()
            file(READ "${RESHAPE_PATCHED_PATH}" RESHAPE_PATCHED_CONTENT)
        endif()
        string(REPLACE "\r\n" "\n" RESHAPE_PATCHED_CONTENT
            "${RESHAPE_PATCHED_CONTENT}")
        string(REPLACE "\r" "\n" RESHAPE_PATCHED_CONTENT
            "${RESHAPE_PATCHED_CONTENT}")
        string(SHA256 RESHAPE_ACTUAL_CONTENT_HASH
            "${RESHAPE_PATCHED_CONTENT}")
        string(TOUPPER "${RESHAPE_ACTUAL_CONTENT_HASH}"
            RESHAPE_ACTUAL_CONTENT_HASH)
        if(NOT RESHAPE_ACTUAL_CONTENT_HASH STREQUAL
            RESHAPE_EXPECTED_CONTENT_HASH)
            message(FATAL_ERROR
                "Pinned patched ReShade content hash mismatch for "
                "${RESHAPE_PATCHED_FILE}.\n"
                "Expected: ${RESHAPE_EXPECTED_CONTENT_HASH}\n"
                "Actual:   ${RESHAPE_ACTUAL_CONTENT_HASH}"
            )
        endif()
    endforeach()
endfunction()

# ReShade's add-on ABI is tied to the headers from the runtime release. Its
# ImGui bridge also checks for the exact ImGui version used by that release.
# Immutable commits keep those two inputs reproducible.
FetchContent_Declare(
    reshade
    GIT_REPOSITORY https://github.com/crosire/reshade.git
    GIT_TAG ${RESHAPE_PINNED_COMMIT}
    GIT_SHALLOW TRUE
    GIT_PROGRESS TRUE
    GIT_SUBMODULES ""
    GIT_SUBMODULES_RECURSE FALSE
    SOURCE_SUBDIR _headers_only
)

FetchContent_Declare(
    imgui
    GIT_REPOSITORY https://github.com/ocornut/imgui.git
    GIT_TAG 3912b3d9a9c1b3f17431aebafd86d2f40ee6e59c
    GIT_SHALLOW TRUE
    GIT_PROGRESS TRUE
    SOURCE_SUBDIR _headers_only
)

FetchContent_MakeAvailable(reshade imgui)
verify_reshade_pinned_commit("${reshade_SOURCE_DIR}")

# BEGIN EGO_SOURCE_CACHE_MIGRATION_HELPERS
function(ego_write_lf_source_cache_file filename content)
    string(LENGTH "${content}" content_length)
    if(content_length LESS 1)
        message(FATAL_ERROR "Empty source-cache staging content is not permitted.")
    endif()
    math(EXPR last_offset "${content_length} - 1")
    string(SUBSTRING "${content}" ${last_offset} 1 last_character)
    if(NOT last_character STREQUAL "\n")
        message(FATAL_ERROR "Only frozen LF-terminated files may use normalized staging.")
    endif()
    # CONFIGURE selects LF explicitly on Windows. Protect every literal @ so
    # @ONLY cannot substitute source or patch text that happens to contain it.
    set(EGO_SOURCE_LITERAL_AT "@")
    string(REPLACE "@" "@EGO_SOURCE_LITERAL_AT@" escaped_content "${content}")
    file(CONFIGURE OUTPUT "${filename}" CONTENT "${escaped_content}" @ONLY NEWLINE_STYLE LF)
endfunction()

function(ego_normalize_reshade_patch_file original_path output_dir result_var)
    get_filename_component(patch_directory "${original_path}" DIRECTORY)
    get_filename_component(patch_name "${original_path}" NAME)
    ego_read_source_cache_file("${patch_directory}" "${patch_name}" patch_hash patch_text)
    get_property(copy_index GLOBAL PROPERTY EGO_PATCH_EXECUTION_COPY_INDEX)
    if(NOT DEFINED copy_index OR "${copy_index}" STREQUAL "")
        set(copy_index 0)
    endif()
    set(copy_path "${output_dir}/p${copy_index}.patch")
    string(LENGTH "${copy_path}" copy_path_length)
    if(copy_path_length GREATER 240)
        message(FATAL_ERROR "The normalized patch execution path exceeds the Windows-safe bound.")
    endif()
    math(EXPR next_copy_index "${copy_index} + 1")
    set_property(GLOBAL PROPERTY EGO_PATCH_EXECUTION_COPY_INDEX "${next_copy_index}")
    ego_write_lf_source_cache_file("${copy_path}" "${patch_text}")
    file(SHA256 "${copy_path}" copy_hash)
    string(TOUPPER "${copy_hash}" copy_hash)
    if(NOT copy_hash STREQUAL patch_hash)
        message(FATAL_ERROR "Normalized patch execution copy changed frozen content: ${patch_name}")
    endif()
    set(${result_var} "${copy_path}" PARENT_SCOPE)
endfunction()

function(ego_normalize_reshade_patch_inputs)
    # Original paths have already been captured by CMAKE_CONFIGURE_DEPENDS.
    # Build provenance continues to hash those originals; only execution paths
    # in this configure are replaced by verified, explicitly LF copies.
    string(RANDOM LENGTH 8 ALPHABET "0123456789abcdef" patch_suffix)
    set(output_dir "${CMAKE_CURRENT_BINARY_DIR}/.ep-${patch_suffix}")
    while(EXISTS "${output_dir}")
        string(RANDOM LENGTH 8 ALPHABET "0123456789abcdef" patch_suffix)
        set(output_dir "${CMAKE_CURRENT_BINARY_DIR}/.ep-${patch_suffix}")
    endwhile()
    string(LENGTH "${output_dir}/p999.patch" execution_path_bound)
    if(execution_path_bound GREATER 240)
        message(FATAL_ERROR "The normalized patch execution directory exceeds the Windows-safe bound.")
    endif()
    file(MAKE_DIRECTORY "${output_dir}")
    get_cmake_property(patch_variables VARIABLES)
    foreach(variable_name IN LISTS patch_variables)
        if(variable_name MATCHES "^RESHAPE_.*_PATCH$")
            ego_normalize_reshade_patch_file("${${variable_name}}" "${output_dir}" copy_path)
            set(${variable_name} "${copy_path}" PARENT_SCOPE)
        endif()
    endforeach()
    set(source_patch_copies)
    foreach(original_path IN LISTS RESHAPE_SOURCE_PATCHES)
        ego_normalize_reshade_patch_file("${original_path}" "${output_dir}" copy_path)
        list(APPEND source_patch_copies "${copy_path}")
    endforeach()
    set(RESHAPE_SOURCE_PATCHES "${source_patch_copies}" PARENT_SCOPE)
endfunction()

function(ego_source_cache_path source_dir relative_path result_var)
    string(REPLACE "\\" "/" normalized_path "${relative_path}")
    if(NOT normalized_path STREQUAL relative_path OR
       IS_ABSOLUTE "${relative_path}" OR relative_path MATCHES "^[A-Za-z]:" OR
       relative_path STREQUAL "" OR relative_path MATCHES "//|/$")
        message(FATAL_ERROR "Invalid source-cache relative path: ${relative_path}")
    endif()
    string(REPLACE "/" ";" components "${relative_path}")
    set(cursor "${source_dir}")
    foreach(component IN LISTS components)
        if(component STREQUAL "." OR component STREQUAL "..")
            message(FATAL_ERROR "Source-cache paths cannot escape their source root.")
        endif()
        set(cursor "${cursor}/${component}")
        if(IS_SYMLINK "${cursor}")
            message(FATAL_ERROR "Source-cache paths cannot pass through symbolic links or junctions: ${cursor}")
        endif()
    endforeach()
    set(${result_var} "${cursor}" PARENT_SCOPE)
endfunction()

function(ego_read_source_cache_file source_dir relative_path hash_var text_var)
    ego_source_cache_path("${source_dir}" "${relative_path}" filename)
    if(NOT EXISTS "${filename}" OR IS_DIRECTORY "${filename}")
        message(FATAL_ERROR "Missing regular source-cache file: ${relative_path}")
    endif()
    file(SIZE "${filename}" file_size)
    if(file_size LESS 1 OR file_size GREATER 4194304)
        message(FATAL_ERROR "Source-cache file size is out of bounds: ${relative_path}")
    endif()
    math(EXPR last_byte_offset "${file_size} - 1")
    file(READ "${filename}" last_byte OFFSET ${last_byte_offset} LIMIT 1 HEX)
    string(TOLOWER "${last_byte}" last_byte)
    if(last_byte STREQUAL "0d")
        message(FATAL_ERROR "A terminal bare CR is unsupported in source caches: ${relative_path}")
    endif()
    file(READ "${filename}" prefix LIMIT 3 HEX)
    string(TOLOWER "${prefix}" prefix)
    if(prefix STREQUAL "efbbbf")
        file(READ "${filename}" content OFFSET 3)
    else()
        file(READ "${filename}" content)
    endif()
    string(REPLACE "\r\n" "\n" content "${content}")
    string(FIND "${content}" "\r" bare_cr_index)
    if(NOT bare_cr_index EQUAL -1)
        message(FATAL_ERROR "Bare-CR source caches are unsupported: ${relative_path}")
    endif()
    string(SHA256 content_hash "${content}")
    string(TOUPPER "${content_hash}" content_hash)
    set(${hash_var} "${content_hash}" PARENT_SCOPE)
    set(${text_var} "${content}" PARENT_SCOPE)
endfunction()

function(ego_assert_source_cache_vector source_dir)
    foreach(entry IN LISTS ARGN)
        string(FIND "${entry}" "=" separator)
        if(separator LESS 1)
            message(FATAL_ERROR "Invalid source-cache vector entry.")
        endif()
        string(SUBSTRING "${entry}" 0 ${separator} relative_path)
        math(EXPR offset "${separator} + 1")
        string(SUBSTRING "${entry}" ${offset} -1 expected_hash)
        ego_source_cache_path("${source_dir}" "${relative_path}" filename)
        if(expected_hash STREQUAL "ABSENT")
            if(EXISTS "${filename}")
                message(FATAL_ERROR "A foreign or partial source-cache file must remain absent: ${relative_path}")
            endif()
        else()
            ego_read_source_cache_file("${source_dir}" "${relative_path}" actual_hash ignored_text)
            if(NOT actual_hash STREQUAL expected_hash)
                message(FATAL_ERROR
                    "Unknown source-cache edit before historical patch peeling: ${relative_path}\n"
                    "Expected: ${expected_hash}\nActual: ${actual_hash}")
            endif()
        endif()
    endforeach()
endfunction()

function(ego_recover_owned_late_source_cache source_root journal_path)
    if(NOT EXISTS "${journal_path}")
        return()
    endif()
    if(IS_SYMLINK "${journal_path}" OR IS_DIRECTORY "${journal_path}")
        message(FATAL_ERROR "Unknown source-cache recovery record; no files were changed.")
    endif()
    file(SIZE "${journal_path}" journal_size)
    if(journal_size LESS 1 OR journal_size GREATER 65536)
        message(FATAL_ERROR "Invalid source-cache recovery record size.")
    endif()
    file(READ "${journal_path}" journal)
    file(SHA256 "${journal_path}" journal_raw_hash)
    string(JSON schema GET "${journal}" schemaVersion)
    string(JSON recorded_source GET "${journal}" sourceRoot)
    string(JSON scratch GET "${journal}" scratchRoot)
    string(JSON recorded_pin GET "${journal}" finalInjectorHash)
    string(JSON before_count LENGTH "${journal}" before)
    string(JSON after_count LENGTH "${journal}" after)
    # Legacy records always published the generation-15 pre-late body. New
    # cross-generation records identify a fixed before/after pair explicitly;
    # neither JSON hash can authorize an arbitrary source image.
    set(legacy_before_pins
        "${RESHAPE_GEN15_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN15_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
    set(generation16_before_pins ${legacy_before_pins}
        "${RESHAPE_GEN16_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN16_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
    set(generation17_before_pins ${generation16_before_pins}
        "${RESHAPE_GEN17_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN17_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN17_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
    set(generation18_before_pins ${generation17_before_pins}
        "${RESHAPE_GEN18_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN18_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN18_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
    set(current_before_pins ${generation18_before_pins}
        "${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_PRE_FIRST_HOST_PRELOADED_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
    if(schema EQUAL 1 AND recorded_pin IN_LIST legacy_before_pins)
        set(post_injector_hash "${RESHAPE_GEN15_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}")
    elseif(schema EQUAL 2)
        string(JSON post_injector_hash GET "${journal}" postInjectorHash)
        if(post_injector_hash STREQUAL RESHAPE_GEN16_PRE_LATE_V4_INJECTOR_CONTENT_SHA256 AND
           recorded_pin IN_LIST generation16_before_pins)
            # Retain the exact meaning of journals written by generation 16.
        elseif(post_injector_hash STREQUAL RESHAPE_GEN17_PRE_LATE_V4_INJECTOR_CONTENT_SHA256 AND
               recorded_pin IN_LIST generation17_before_pins)
            # Retain the exact meaning of journals written by generation 17.
        elseif(post_injector_hash STREQUAL RESHAPE_GEN18_PRE_LATE_V4_INJECTOR_CONTENT_SHA256 AND
               recorded_pin IN_LIST generation18_before_pins)
            # Retain the exact meaning of journals written by generation 18.
        elseif(post_injector_hash STREQUAL RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256 AND
               recorded_pin IN_LIST current_before_pins)
            # New records may migrate a known old complete preimage to the
            # current pre-late body, but never form an arbitrary cross product.
        else()
            message(FATAL_ERROR "Unknown source-cache recovery before/after pair; no files were changed.")
        endif()
    else()
        message(FATAL_ERROR "Unknown source-cache recovery schema or injector pair; no files were changed.")
    endif()
    string(REPLACE "tools/injector.cpp=${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
        "tools/injector.cpp=${recorded_pin}" RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
        "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
    string(REPLACE "tools/injector.cpp=${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
        "tools/injector.cpp=${post_injector_hash}" recovery_after_vector
        "${RESHAPE_PRE_LATE_CONTENT_SHA256}")
    list(LENGTH RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256 expected_count)
    get_filename_component(scratch_name "${scratch}" NAME)
    string(REGEX REPLACE "^ego-owned-late-peel-" "" scratch_suffix "${scratch_name}")
    string(LENGTH "${scratch_suffix}" suffix_length)
    if(NOT recorded_source STREQUAL source_root OR
       NOT before_count EQUAL expected_count OR NOT after_count EQUAL expected_count OR
       NOT IS_ABSOLUTE "${scratch}" OR IS_SYMLINK "${scratch}" OR
       NOT scratch_name MATCHES "^ego-owned-late-peel-[0-9a-f]+$" OR
       NOT suffix_length EQUAL 24 OR IS_SYMLINK "${scratch}/before")
        message(FATAL_ERROR "The source-cache recovery record is not bound to this exact implementation.")
    endif()
    ego_assert_source_cache_vector("${scratch}/before" ${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256})
    execute_process(COMMAND "${GIT_EXECUTABLE}" status --porcelain=v1
        --untracked-files=all --ignore-submodules=none WORKING_DIRECTORY "${source_root}"
        RESULT_VARIABLE status_result OUTPUT_VARIABLE status_text ERROR_VARIABLE status_error)
    if(NOT status_result EQUAL 0)
        message(FATAL_ERROR "Unable to inspect source-cache recovery ownership: ${status_error}")
    endif()
    string(REPLACE "\r\n" "\n" status_text "${status_text}")
    string(REPLACE "\n" ";" status_lines "${status_text}")
    foreach(line IN LISTS status_lines)
        if(line STREQUAL "")
            continue()
        endif()
        string(SUBSTRING "${line}" 3 -1 relative_path)
        if(NOT relative_path IN_LIST RESHAPE_EXPECTED_PATCHED_FILES)
            message(FATAL_ERROR "Unknown source edit blocks recovery; no files were changed: ${relative_path}")
        endif()
    endforeach()
    # Validate every backup and current image before restoring even one file.
    set(index 0)
    foreach(entry IN LISTS RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256)
        string(FIND "${entry}" "=" separator)
        string(SUBSTRING "${entry}" 0 ${separator} relative_path)
        string(JSON before_hash GET "${journal}" before ${index})
        string(JSON after_hash GET "${journal}" after ${index})
        file(SHA256 "${scratch}/before/${relative_path}" backup_hash)
        if(NOT backup_hash STREQUAL before_hash)
            message(FATAL_ERROR "A recovery preimage changed; no files were restored.")
        endif()
        ego_source_cache_path("${source_root}" "${relative_path}" target)
        if(EXISTS "${target}")
            if(IS_DIRECTORY "${target}")
                message(FATAL_ERROR "A foreign recovery target is not a file; no files were restored.")
            endif()
            file(SHA256 "${target}" current_hash)
        else()
            set(current_hash "ABSENT")
        endif()
        if(NOT current_hash STREQUAL before_hash AND NOT current_hash STREQUAL after_hash)
            message(FATAL_ERROR "Unknown source edit blocks recovery; no files were restored: ${relative_path}")
        endif()
        if(NOT current_hash STREQUAL before_hash)
            list(GET recovery_after_vector ${index} base_entry)
            string(FIND "${base_entry}" "=" base_separator)
            math(EXPR base_offset "${base_separator} + 1")
            string(SUBSTRING "${base_entry}" ${base_offset} -1 expected_base_hash)
            if(current_hash STREQUAL "ABSENT")
                if(NOT expected_base_hash STREQUAL "ABSENT")
                    message(FATAL_ERROR "A required recovery target is missing; no files were restored.")
                endif()
            else()
                ego_read_source_cache_file("${source_root}" "${relative_path}" current_normalized ignored_text)
                if(NOT current_normalized STREQUAL expected_base_hash)
                    message(FATAL_ERROR "An unknown recovery postimage was preserved; no files were restored.")
                endif()
            endif()
        endif()
        set("recover_before_${index}" "${before_hash}")
        set("recover_current_${index}" "${current_hash}")
        math(EXPR index "${index} + 1")
    endforeach()
    string(RANDOM LENGTH 24 ALPHABET "0123456789abcdef" recovery_suffix)
    set(recovery_stage "${CMAKE_CURRENT_BINARY_DIR}/ego-source-recovery-${recovery_suffix}")
    set(index 0)
    foreach(entry IN LISTS RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256)
        string(FIND "${entry}" "=" separator)
        string(SUBSTRING "${entry}" 0 ${separator} relative_path)
        if(NOT recover_current_${index} STREQUAL recover_before_${index})
            ego_source_cache_path("${source_root}" "${relative_path}" target)
            if(EXISTS "${target}")
                file(SHA256 "${target}" current_hash)
            else()
                set(current_hash "ABSENT")
            endif()
            if(NOT current_hash STREQUAL recover_current_${index})
                message(FATAL_ERROR "Source changed during recovery; unknown edits were preserved.")
            endif()
            get_filename_component(parent "${recovery_stage}/${relative_path}" DIRECTORY)
            file(MAKE_DIRECTORY "${parent}")
            file(COPY_FILE "${scratch}/before/${relative_path}" "${recovery_stage}/${relative_path}")
            file(RENAME "${recovery_stage}/${relative_path}" "${target}" RESULT recovery_result)
            if(NOT recovery_result STREQUAL "0")
                message(FATAL_ERROR "Source-cache recovery remains journaled: ${recovery_result}")
            endif()
        endif()
        math(EXPR index "${index} + 1")
    endforeach()
    ego_assert_source_cache_vector("${source_root}" ${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256})
    verify_reshade_patched_source("${source_root}")
    file(SHA256 "${journal_path}" current_journal_hash)
    if(NOT current_journal_hash STREQUAL journal_raw_hash)
        message(FATAL_ERROR "The recovery record changed; it was not removed.")
    endif()
    file(REMOVE "${journal_path}")
endfunction()

function(ego_prepare_owned_late_source_cache source_dir)
    if(NOT IS_ABSOLUTE "${source_dir}" OR NOT IS_DIRECTORY "${source_dir}" OR
       IS_SYMLINK "${source_dir}")
        message(FATAL_ERROR "An absolute regular source-cache directory is required.")
    endif()
    file(REAL_PATH "${source_dir}" source_root)
    get_filename_component(source_parent "${source_root}" DIRECTORY)
    string(SHA256 lock_key "${source_root}")
    # This lock is outside the fetched Git tree and remains held through the
    # complete configure, including the legacy patch replay after this helper.
    get_property(already_locked GLOBAL PROPERTY "EGO_SOURCE_CACHE_LOCK_${lock_key}")
    if(NOT already_locked)
        file(LOCK "${source_parent}/.ego-source-cache-${lock_key}.lock"
            GUARD PROCESS TIMEOUT 30 RESULT_VARIABLE lock_result)
        if(NOT lock_result STREQUAL "0")
            message(FATAL_ERROR "Unable to lock the exact source cache: ${lock_result}")
        endif()
        set_property(GLOBAL PROPERTY "EGO_SOURCE_CACHE_LOCK_${lock_key}" TRUE)
    endif()
    verify_reshade_pinned_commit("${source_root}")
    set(journal_path "${source_parent}/.ego-source-cache-${lock_key}.journal.json")
    ego_recover_owned_late_source_cache("${source_root}" "${journal_path}")
    ego_read_source_cache_file("${source_root}" "tools/injector.cpp" injector_hash ignored_text)
    get_filename_component(late_patch_dir "${RESHAPE_OWNED_LATE_D3D11_PATCH}" DIRECTORY)
    get_filename_component(late_patch_name "${RESHAPE_OWNED_LATE_D3D11_PATCH}" NAME)
    ego_read_source_cache_file("${late_patch_dir}" "${late_patch_name}" late_patch_hash late_patch_text)
    if(NOT late_patch_hash STREQUAL RESHAPE_OWNED_LATE_D3D11_PATCH_SHA256)
        message(FATAL_ERROR "The terminal owned-late patch hash is not the frozen implementation.")
    endif()
    get_filename_component(result_patch_dir "${RESHAPE_FIRST_HOST_RESULT_PATCH}" DIRECTORY)
    get_filename_component(result_patch_name "${RESHAPE_FIRST_HOST_RESULT_PATCH}" NAME)
    ego_read_source_cache_file("${result_patch_dir}" "${result_patch_name}" result_patch_hash result_patch_text)
    if(NOT result_patch_hash STREQUAL RESHAPE_FIRST_HOST_RESULT_PATCH_SHA256)
        message(FATAL_ERROR "The first-host result patch hash is not the frozen implementation.")
    endif()
    get_filename_component(preloaded_patch_dir "${RESHAPE_PRELOADED_ADDON_PATCH}" DIRECTORY)
    get_filename_component(preloaded_patch_name "${RESHAPE_PRELOADED_ADDON_PATCH}" NAME)
    ego_read_source_cache_file("${preloaded_patch_dir}" "${preloaded_patch_name}" preloaded_patch_hash preloaded_patch_text)
    if(NOT preloaded_patch_hash STREQUAL RESHAPE_PRELOADED_ADDON_PATCH_SHA256)
        message(FATAL_ERROR "The preloaded add-on patch hash is not the frozen implementation.")
    endif()
    get_filename_component(first_host_patch_dir "${RESHAPE_PRELOADED_FIRST_HOST_PATCH}" DIRECTORY)
    get_filename_component(first_host_patch_name "${RESHAPE_PRELOADED_FIRST_HOST_PATCH}" NAME)
    ego_read_source_cache_file("${first_host_patch_dir}" "${first_host_patch_name}" first_host_patch_hash first_host_patch_text)
    if(NOT first_host_patch_hash STREQUAL RESHAPE_PRELOADED_FIRST_HOST_PATCH_SHA256)
        message(FATAL_ERROR "The preloaded first-host patch hash is not the frozen implementation.")
    endif()
    if(DEFINED RESHAPE_PRELOAD_LONG_PATH_PATCH)
        get_filename_component(long_path_patch_dir "${RESHAPE_PRELOAD_LONG_PATH_PATCH}" DIRECTORY)
        get_filename_component(long_path_patch_name "${RESHAPE_PRELOAD_LONG_PATH_PATCH}" NAME)
        ego_read_source_cache_file("${long_path_patch_dir}" "${long_path_patch_name}" long_path_patch_hash ignored_text)
        if(NOT long_path_patch_hash STREQUAL RESHAPE_PRELOAD_LONG_PATH_PATCH_SHA256)
            message(FATAL_ERROR "The preload long-path patch hash is not the frozen implementation.")
        endif()
    endif()
    if(DEFINED RESHAPE_ADAPTER_READY_LONG_PATH_PATCH)
        get_filename_component(adapter_patch_dir "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCH}" DIRECTORY)
        get_filename_component(adapter_patch_name "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCH}" NAME)
        ego_read_source_cache_file("${adapter_patch_dir}" "${adapter_patch_name}" adapter_patch_hash ignored_text)
        if(NOT adapter_patch_hash STREQUAL RESHAPE_ADAPTER_READY_LONG_PATH_PATCH_SHA256)
            message(FATAL_ERROR "The adapter-ready long-path patch hash is not the frozen implementation.")
        endif()
    endif()
    if(DEFINED RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH)
        get_filename_component(inspection_patch_dir "${RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH}" DIRECTORY)
        get_filename_component(inspection_patch_name "${RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH}" NAME)
        ego_read_source_cache_file("${inspection_patch_dir}" "${inspection_patch_name}" inspection_patch_hash ignored_text)
        if(NOT inspection_patch_hash STREQUAL RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256)
            message(FATAL_ERROR "The initial-inspection recovery patch hash is not the frozen implementation.")
        endif()
    endif()
    # Generation 22 must restore the complete generation-21 vector before
    # either older terminal file is peeled. Every supplied patch pin above is
    # checked before this first atomic publication.
    if(injector_hash STREQUAL RESHAPE_INITIAL_INSPECTION_RECOVERY_INJECTOR_CONTENT_SHA256)
        ego_apply_initial_inspection_recovery_source_tail("${source_root}" REVERSE)
        ego_read_source_cache_file("${source_root}" "tools/injector.cpp" injector_hash ignored_text)
    endif()
    if(DEFINED RESHAPE_ADAPTER_READY_LONG_PATH_PATCH)
        set(adapter_source_relative_path "source/ego_owned_late_d3d11/owned_late_d3d11.inl")
        if(EXISTS "${source_root}/${adapter_source_relative_path}" OR
           IS_SYMLINK "${source_root}/${adapter_source_relative_path}")
            ego_read_source_cache_file("${source_root}" "${adapter_source_relative_path}" adapter_source_hash ignored_text)
            if(adapter_source_hash STREQUAL RESHAPE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256)
                # Restore the exact generation-20 vector before its injector
                # tail is peeled. Mixed generation-21/older bodies fail the
                # complete-vector proof before either source file is changed.
                ego_apply_adapter_ready_long_path_source_tail("${source_root}" REVERSE)
            endif()
        endif()
    endif()
    # Peel only the exact generation-20 terminal body under the existing cache
    # lock, after every supplied terminal patch has passed its frozen pin. The
    # shared helper validates the complete vector and stages one atomic rename.
    if(injector_hash STREQUAL RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256)
        ego_apply_terminal_injector_source_tail("${source_root}"
            "${RESHAPE_PRELOAD_LONG_PATH_PATCH}" "${RESHAPE_PRELOAD_LONG_PATH_PATCH_SHA256}"
            "${RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}" REVERSE)
        ego_read_source_cache_file("${source_root}" "tools/injector.cpp" injector_hash ignored_text)
    endif()

    if(injector_hash STREQUAL "26CFBBFFD692ACFB24BD19CBD93B3C7F81F24555EA67B75C55FAD14861E38B00")
        ego_assert_source_cache_vector("${source_root}" ${RESHAPE_PRISTINE_CONTENT_SHA256})
        execute_process(COMMAND "${GIT_EXECUTABLE}" status --porcelain=v1
            --untracked-files=all --ignore-submodules=none
            WORKING_DIRECTORY "${source_root}" RESULT_VARIABLE status_result
            OUTPUT_VARIABLE status_text ERROR_VARIABLE status_error
            OUTPUT_STRIP_TRAILING_WHITESPACE)
        if(NOT status_result EQUAL 0 OR NOT status_text STREQUAL "")
            message(FATAL_ERROR "The pristine source cache contains unknown edits; it was not changed.\n${status_text}\n${status_error}")
        endif()
        return()
    endif()

    set(terminal_injector_pins
        "${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_PRE_FIRST_HOST_PRELOADED_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_PRE_RESULT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN18_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN18_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN18_PRE_RESULT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN17_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN17_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN17_PRE_RESULT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN16_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN16_PRE_RESULT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN15_CURRENT_INJECTOR_CONTENT_SHA256}"
        "${RESHAPE_GEN15_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
    if(NOT injector_hash IN_LIST terminal_injector_pins)
        set(known_old_injectors
            "246B4B1DC7259C2EBF4BC4C4278B03B5083507FAE8BDB071B264692F73730135"
            "88E5980C5737539918CDFD0A4070802780B44FA5FBCA2BB251B79952F180C621"
            "5F4C08D04AB5E720851326EB72DED1D59D9E1924036B866CAC6E56602417C377"
            "5265F91C9308F755CF585EA7C3083E60DF48AED6CDC435C25518B7130A748F5B"
            "D0A885F093B5364FF7ED1D84761E758E7544579185E9EEA8517B4058D7C29B94"
            "C436078556B22BDAD9DFCD662A745E73339758E227F0178234B41D1392956974"
            "3A58324E3AE6CE96F3F312D965A384CB825B27B64CE3E4E95CF4B4194032946C"
            "EB8B4AD906DC0AC144EF2EF71DD3A9714C4C4325C01D42B66D22B48EE69060F1"
            "007B4DF39CEB0C7E6777B990A9A24D352DBC399C79DCA8488E9F4E49C58FB166"
            "956A8530DD5C4C9F73C3372CE6C25A13E1AB230746B6A8CC26E7EC349CE50309"
            "816BF5F33495D3B280A2E319D565FA2D310BF10A409FDC580B6ED8B4358B71C8"
            "1903E98A0462431D4A355A3CCE0E3B69AB8E5C67B7895080DA9F9EF8D75CA410"
            "0BAE44EE68E401993FA662BAF8BE79F985F6BCB87DC3A0818BFD80FD9574DDEB"
            "4EEA17F39E3BFF425CCD08246DDA121FE256A61B37D0FD5D93565FC83E9DAA7D"
            "AEFCC8D76B43277DDE2C0D29B3F98A6EEF03B06E99868F36B027A922CE2CA1A4"
            "E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359"
            "${RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_GEN15_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_GEN15_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_GEN16_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_GEN16_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_GEN17_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_GEN17_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_GEN18_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
            "${RESHAPE_GEN18_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256}")
        if(NOT injector_hash IN_LIST known_old_injectors)
            message(FATAL_ERROR "Unrecognized complete source-cache state; no files were changed.")
        endif()
        string(REPLACE "tools/injector.cpp=${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
            "tools/injector.cpp=${injector_hash}" old_vector "${RESHAPE_PRE_LATE_CONTENT_SHA256}")
        ego_assert_source_cache_vector("${source_root}" ${old_vector})
        set(old_content)
        foreach(entry IN LISTS old_vector)
            string(FIND "${entry}" "=" separator)
            string(SUBSTRING "${entry}" 0 ${separator} relative_path)
            if(relative_path IN_LIST RESHAPE_PRE_LATE_PATCHED_FILES)
                list(APPEND old_content "${entry}")
            endif()
        endforeach()
        set(RESHAPE_EXPECTED_PATCHED_FILES "${RESHAPE_PRE_LATE_PATCHED_FILES}")
        set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256 "${old_content}")
        verify_reshade_patched_source("${source_root}")
        return()
    endif()

    # A matching injector is not sufficient. Every host file, owned header and
    # Git status entry must match this one complete terminal implementation.
    string(REPLACE "tools/injector.cpp=${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
        "tools/injector.cpp=${injector_hash}" RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
        "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
    ego_assert_source_cache_vector("${source_root}" ${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256})
    verify_reshade_patched_source("${source_root}")
    string(RANDOM LENGTH 24 ALPHABET "0123456789abcdef" scratch_suffix)
    set(scratch "${CMAKE_CURRENT_BINARY_DIR}/ego-owned-late-peel-${scratch_suffix}")
    file(MAKE_DIRECTORY "${scratch}/candidate" "${scratch}/before" "${scratch}/removed")
    set(index 0)
    foreach(entry IN LISTS RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256)
        string(FIND "${entry}" "=" separator)
        string(SUBSTRING "${entry}" 0 ${separator} relative_path)
        ego_read_source_cache_file("${source_root}" "${relative_path}" ignored_hash content)
        get_filename_component(parent "${scratch}/candidate/${relative_path}" DIRECTORY)
        file(MAKE_DIRECTORY "${parent}")
        ego_write_lf_source_cache_file("${scratch}/candidate/${relative_path}" "${content}")
        get_filename_component(parent "${scratch}/before/${relative_path}" DIRECTORY)
        file(MAKE_DIRECTORY "${parent}")
        file(COPY_FILE "${source_root}/${relative_path}" "${scratch}/before/${relative_path}")
        file(SHA256 "${source_root}/${relative_path}" "original_raw_${index}")
        math(EXPR index "${index} + 1")
    endforeach()
    if(injector_hash STREQUAL RESHAPE_GEN15_CURRENT_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN15_PRE_RESULT_INJECTOR_CONTENT_SHA256)
        set(host_injector_hash "${RESHAPE_GEN15_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
        set(pre_late_injector_hash "${RESHAPE_GEN15_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}")
    elseif(injector_hash STREQUAL RESHAPE_GEN16_CURRENT_INJECTOR_CONTENT_SHA256 OR
           injector_hash STREQUAL RESHAPE_GEN16_PRE_RESULT_INJECTOR_CONTENT_SHA256)
        set(host_injector_hash "${RESHAPE_GEN16_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
        set(pre_late_injector_hash "${RESHAPE_GEN16_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}")
    elseif(injector_hash STREQUAL RESHAPE_GEN17_CURRENT_INJECTOR_CONTENT_SHA256 OR
           injector_hash STREQUAL RESHAPE_GEN17_PRE_PRELOADED_INJECTOR_CONTENT_SHA256 OR
           injector_hash STREQUAL RESHAPE_GEN17_PRE_RESULT_INJECTOR_CONTENT_SHA256)
        set(host_injector_hash "${RESHAPE_GEN17_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
        set(pre_late_injector_hash "${RESHAPE_GEN17_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}")
        set(pre_preloaded_injector_hash "${RESHAPE_GEN17_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}")
    elseif(injector_hash STREQUAL RESHAPE_GEN18_CURRENT_INJECTOR_CONTENT_SHA256 OR
           injector_hash STREQUAL RESHAPE_GEN18_PRE_PRELOADED_INJECTOR_CONTENT_SHA256 OR
           injector_hash STREQUAL RESHAPE_GEN18_PRE_RESULT_INJECTOR_CONTENT_SHA256)
        set(host_injector_hash "${RESHAPE_GEN18_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
        set(pre_late_injector_hash "${RESHAPE_GEN18_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}")
        set(pre_preloaded_injector_hash "${RESHAPE_GEN18_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}")
    else()
        set(host_injector_hash "${RESHAPE_PRE_RESULT_INJECTOR_CONTENT_SHA256}")
        set(pre_late_injector_hash "${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}")
        set(pre_preloaded_injector_hash "${RESHAPE_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}")
    endif()
    if(injector_hash STREQUAL RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256)
        ego_write_lf_source_cache_file("${scratch}/first-host-preloaded.patch" "${first_host_patch_text}")
        foreach(check_argument IN ITEMS "--check" "--apply")
            execute_process(COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR
                --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE
                "GIT_CEILING_DIRECTORIES=${scratch}"
                "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply --whitespace=nowarn --reverse
                "${check_argument}" "${scratch}/first-host-preloaded.patch"
                WORKING_DIRECTORY "${scratch}/candidate"
                RESULT_VARIABLE first_host_peel OUTPUT_VARIABLE first_host_output ERROR_VARIABLE first_host_error)
            if(NOT first_host_peel EQUAL 0)
                message(FATAL_ERROR "The frozen preloaded first-host tail cannot be peeled in scratch; live source was not changed.\n${first_host_output}${first_host_error}")
            endif()
        endforeach()
        string(REPLACE "tools/injector.cpp=${injector_hash}"
            "tools/injector.cpp=${RESHAPE_PRE_FIRST_HOST_PRELOADED_INJECTOR_CONTENT_SHA256}"
            first_host_base_vector "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
        ego_assert_source_cache_vector("${scratch}/candidate" ${first_host_base_vector})
    endif()
    if(injector_hash STREQUAL RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_PRE_FIRST_HOST_PRELOADED_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN18_CURRENT_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN17_CURRENT_INJECTOR_CONTENT_SHA256)
        ego_write_lf_source_cache_file("${scratch}/preloaded.patch" "${preloaded_patch_text}")
        foreach(check_argument IN ITEMS "--check" "--apply")
            execute_process(COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR
                --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE
                "GIT_CEILING_DIRECTORIES=${scratch}"
                "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply --whitespace=nowarn --reverse
                "${check_argument}" "${scratch}/preloaded.patch"
                WORKING_DIRECTORY "${scratch}/candidate"
                RESULT_VARIABLE preload_peel OUTPUT_VARIABLE preload_output ERROR_VARIABLE preload_error)
            if(NOT preload_peel EQUAL 0)
                message(FATAL_ERROR "The frozen preloaded add-on tail cannot be peeled in scratch; live source was not changed.\n${preload_output}${preload_error}")
            endif()
        endforeach()
        string(REPLACE "tools/injector.cpp=${injector_hash}"
            "tools/injector.cpp=${pre_preloaded_injector_hash}"
            preloaded_base_vector "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
        ego_assert_source_cache_vector("${scratch}/candidate" ${preloaded_base_vector})
    endif()
    if(injector_hash STREQUAL RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_PRE_FIRST_HOST_PRELOADED_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_PRE_PRELOADED_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN18_CURRENT_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN18_PRE_PRELOADED_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN17_CURRENT_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN17_PRE_PRELOADED_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN16_CURRENT_INJECTOR_CONTENT_SHA256 OR
       injector_hash STREQUAL RESHAPE_GEN15_CURRENT_INJECTOR_CONTENT_SHA256)
        ego_write_lf_source_cache_file("${scratch}/result.patch" "${result_patch_text}")
        foreach(check_argument IN ITEMS "--check" "--apply")
            execute_process(COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR
                --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE
                "GIT_CEILING_DIRECTORIES=${scratch}"
                "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply --whitespace=nowarn --reverse
                "${check_argument}" "${scratch}/result.patch"
                WORKING_DIRECTORY "${scratch}/candidate"
                RESULT_VARIABLE result_peel OUTPUT_VARIABLE result_output ERROR_VARIABLE result_error)
            if(NOT result_peel EQUAL 0)
                message(FATAL_ERROR "The frozen first-host result tail cannot be peeled in scratch; live source was not changed.\n${result_output}${result_error}")
            endif()
        endforeach()
    endif()
    string(REPLACE "tools/injector.cpp=${injector_hash}"
        "tools/injector.cpp=${host_injector_hash}"
        host_vector "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
    ego_assert_source_cache_vector("${scratch}/candidate" ${host_vector})
    ego_write_lf_source_cache_file("${scratch}/late.patch" "${late_patch_text}")
    foreach(check_argument IN ITEMS "--check" "--apply")
        execute_process(COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR
            --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE
            "GIT_CEILING_DIRECTORIES=${scratch}"
            "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply --whitespace=nowarn --reverse
            "${check_argument}" "${scratch}/late.patch"
            WORKING_DIRECTORY "${scratch}/candidate"
            RESULT_VARIABLE peel_result OUTPUT_VARIABLE peel_output ERROR_VARIABLE peel_error)
        if(NOT peel_result EQUAL 0)
            message(FATAL_ERROR "The frozen owned-late tail cannot be peeled in scratch; live source was not changed.\n${peel_output}${peel_error}")
        endif()
    endforeach()
    string(REPLACE "tools/injector.cpp=${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}"
        "tools/injector.cpp=${pre_late_injector_hash}" peeled_vector
        "${RESHAPE_PRE_LATE_CONTENT_SHA256}")
    ego_assert_source_cache_vector("${scratch}/candidate" ${peeled_vector})
    # Normalize an old identity only after all complete terminal seams have
    # been proved and peeled in scratch. The shared rollover guard validates
    # the exact old v4 body and the unique ID declaration before replacement.
    ego_rollover_known_addon_build_id("${scratch}/candidate/tools/injector.cpp")
    ego_assert_source_cache_vector("${scratch}/candidate" ${RESHAPE_PRE_LATE_CONTENT_SHA256})

    # Recheck all raw preimages before publishing any verified replacement.
    set(index 0)
    foreach(entry IN LISTS RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256)
        string(FIND "${entry}" "=" separator)
        string(SUBSTRING "${entry}" 0 ${separator} relative_path)
        file(SHA256 "${source_root}/${relative_path}" raw_hash)
        if(NOT raw_hash STREQUAL original_raw_${index})
            message(FATAL_ERROR "The source cache changed during staged peeling; live source was not replaced.")
        endif()
        math(EXPR index "${index} + 1")
    endforeach()
    verify_reshade_patched_source("${source_root}")
    set(journal_before "")
    set(journal_after "")
    set(index 0)
    foreach(entry IN LISTS RESHAPE_PRE_LATE_CONTENT_SHA256)
        string(FIND "${entry}" "=" separator)
        string(SUBSTRING "${entry}" 0 ${separator} relative_path)
        math(EXPR offset "${separator} + 1")
        string(SUBSTRING "${entry}" ${offset} -1 base_hash)
        if(base_hash STREQUAL "ABSENT")
            set(after_hash "ABSENT")
        else()
            ego_read_source_cache_file("${source_root}" "${relative_path}" current_hash ignored_text)
            if(current_hash STREQUAL base_hash)
                set(after_hash "${original_raw_${index}}")
            else()
                file(SHA256 "${scratch}/candidate/${relative_path}" after_hash)
            endif()
        endif()
        if(index GREATER 0)
            string(APPEND journal_before ",")
            string(APPEND journal_after ",")
        endif()
        string(APPEND journal_before "\"${original_raw_${index}}\"")
        string(APPEND journal_after "\"${after_hash}\"")
        math(EXPR index "${index} + 1")
    endforeach()
    # Valid Windows/CMake paths are forward-slashed here; quote backslashes
    # and quotes as well so the recovery record remains data, never CMake code.
    string(REPLACE "\\" "\\\\" journal_source "${source_root}")
    string(REPLACE "\"" "\\\"" journal_source "${journal_source}")
    string(REPLACE "\\" "\\\\" journal_scratch "${scratch}")
    string(REPLACE "\"" "\\\"" journal_scratch "${journal_scratch}")
    file(WRITE "${scratch}/journal.tmp"
        "{\"schemaVersion\":2,\"sourceRoot\":\"${journal_source}\",\"scratchRoot\":\"${journal_scratch}\",\"finalInjectorHash\":\"${injector_hash}\",\"postInjectorHash\":\"${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}\",\"before\":[${journal_before}],\"after\":[${journal_after}]}\n")
    file(RENAME "${scratch}/journal.tmp" "${journal_path}" NO_REPLACE RESULT journal_result)
    if(NOT journal_result STREQUAL "0")
        message(FATAL_ERROR "Unable to retain source-cache recovery preimages before publication: ${journal_result}")
    endif()
    file(SHA256 "${journal_path}" published_journal_hash)
    set(index 0)
    set(published_indices)
    set(publication_error "")
    foreach(entry IN LISTS RESHAPE_PRE_LATE_CONTENT_SHA256)
        string(FIND "${entry}" "=" separator)
        string(SUBSTRING "${entry}" 0 ${separator} relative_path)
        math(EXPR offset "${separator} + 1")
        string(SUBSTRING "${entry}" ${offset} -1 base_hash)
        ego_source_cache_path("${source_root}" "${relative_path}" target)
        file(SHA256 "${target}" raw_hash)
        if(NOT raw_hash STREQUAL original_raw_${index})
            set(publication_error "Source changed before publication: ${relative_path}")
            break()
        endif()
        if(base_hash STREQUAL "ABSENT")
            get_filename_component(parent "${scratch}/removed/${relative_path}" DIRECTORY)
            file(MAKE_DIRECTORY "${parent}")
            file(RENAME "${target}" "${scratch}/removed/${relative_path}" RESULT publish_result)
            set("published_raw_${index}" "ABSENT")
        else()
            ego_read_source_cache_file("${source_root}" "${relative_path}" current_hash ignored_text)
            if(current_hash STREQUAL base_hash)
                math(EXPR index "${index} + 1")
                continue()
            endif()
            file(SHA256 "${scratch}/candidate/${relative_path}" "published_raw_${index}")
            file(RENAME "${scratch}/candidate/${relative_path}" "${target}" RESULT publish_result)
        endif()
        if(NOT publish_result STREQUAL "0")
            set(publication_error "Unable to publish ${relative_path}: ${publish_result}")
            break()
        endif()
        list(APPEND published_indices "${index}")
        math(EXPR index "${index} + 1")
    endforeach()
    if(NOT publication_error STREQUAL "")
        message(FATAL_ERROR "${publication_error}; validated preimages remain journaled for the next attempt, unknown edits were preserved.")
    endif()
    ego_assert_source_cache_vector("${source_root}" ${RESHAPE_PRE_LATE_CONTENT_SHA256})
    file(SHA256 "${journal_path}" current_journal_hash)
    if(NOT current_journal_hash STREQUAL published_journal_hash)
        message(FATAL_ERROR "The publication recovery record changed; it was not removed.")
    endif()
    file(REMOVE "${journal_path}")
endfunction()

function(ego_apply_owned_late_source_tail source_dir)
    ego_assert_source_cache_vector("${source_dir}" ${RESHAPE_PRE_LATE_CONTENT_SHA256})
    get_filename_component(patch_directory "${RESHAPE_OWNED_LATE_D3D11_PATCH}" DIRECTORY)
    get_filename_component(patch_name "${RESHAPE_OWNED_LATE_D3D11_PATCH}" NAME)
    ego_read_source_cache_file("${patch_directory}" "${patch_name}" patch_hash patch_text)
    if(NOT patch_hash STREQUAL RESHAPE_OWNED_LATE_D3D11_PATCH_SHA256)
        message(FATAL_ERROR "The owned-late patch changed before final replay.")
    endif()
    string(RANDOM LENGTH 24 ALPHABET "0123456789abcdef" replay_suffix)
    set(replay_patch "${CMAKE_CURRENT_BINARY_DIR}/ego-owned-late-replay-${replay_suffix}.patch")
    ego_write_lf_source_cache_file("${replay_patch}" "${patch_text}")
    foreach(apply_argument IN ITEMS "--check" "--apply")
        execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf
            apply --whitespace=nowarn "${apply_argument}" "${replay_patch}"
            WORKING_DIRECTORY "${source_dir}"
            RESULT_VARIABLE replay_result OUTPUT_VARIABLE replay_output ERROR_VARIABLE replay_error)
        if(NOT replay_result EQUAL 0)
            message(FATAL_ERROR "Unable to replay the frozen owned-late tail.\n${replay_output}${replay_error}")
        endif()
    endforeach()
    string(REPLACE "tools/injector.cpp=${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
        "tools/injector.cpp=${RESHAPE_PRE_RESULT_INJECTOR_CONTENT_SHA256}"
        host_vector "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
    ego_assert_source_cache_vector("${source_dir}" ${host_vector})
endfunction()

function(ego_apply_terminal_source_file_tail source_dir source_relative_path patch_path expected_patch_hash expected_before_hash expected_after_hash)
    set(apply_direction)
    if(ARGC GREATER 6)
        if(NOT ARGC EQUAL 7 OR NOT ARGV6 STREQUAL "REVERSE")
            message(FATAL_ERROR "Unknown terminal source patch direction; no source files were changed.")
        endif()
        set(apply_direction "--reverse")
    endif()
    get_filename_component(patch_directory "${patch_path}" DIRECTORY)
    get_filename_component(patch_name "${patch_path}" NAME)
    ego_read_source_cache_file("${patch_directory}" "${patch_name}" patch_hash patch_text)
    if(NOT patch_hash STREQUAL expected_patch_hash)
        message(FATAL_ERROR "The terminal source patch changed before replay.")
    endif()
    ego_read_source_cache_file("${source_dir}" "${source_relative_path}" source_hash source_text)
    if(NOT source_hash STREQUAL expected_before_hash AND
       NOT source_hash STREQUAL expected_after_hash)
        message(FATAL_ERROR "Unknown terminal source preimage; no source files were changed.")
    endif()
    list(FIND RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
        "${source_relative_path}=${expected_before_hash}" before_entry_index)
    if(before_entry_index EQUAL -1)
        message(FATAL_ERROR "The terminal source preimage is absent from its pinned vector; no source files were changed.")
    endif()
    string(REPLACE "${source_relative_path}=${expected_before_hash}"
        "${source_relative_path}=${expected_after_hash}" final_vector
        "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
    string(REPLACE "${source_relative_path}=${expected_after_hash}"
        "${source_relative_path}=${source_hash}" RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
        "${final_vector}")
    ego_assert_source_cache_vector("${source_dir}" ${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256})
    verify_reshade_patched_source("${source_dir}")
    if(source_hash STREQUAL expected_after_hash)
        return()
    endif()

    # This terminal patch owns exactly one source file. Stage and validate the
    # complete transformed body, then publish it with one atomic rename; a
    # stopped configure therefore leaves either recognized terminal state.
    string(RANDOM LENGTH 12 ALPHABET "0123456789abcdef" result_suffix)
    set(scratch "${CMAKE_CURRENT_BINARY_DIR}/ego-terminal-${result_suffix}")
    get_filename_component(candidate_directory "${scratch}/candidate/${source_relative_path}" DIRECTORY)
    file(MAKE_DIRECTORY "${candidate_directory}")
    ego_write_lf_source_cache_file("${scratch}/candidate/${source_relative_path}" "${source_text}")
    ego_write_lf_source_cache_file("${scratch}/result.patch" "${patch_text}")
    ego_source_cache_path("${source_dir}" "${source_relative_path}" target)
    file(SHA256 "${target}" original_raw_hash)
    foreach(apply_argument IN ITEMS "--check" "--apply")
        execute_process(COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR
            --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE
            "GIT_CEILING_DIRECTORIES=${scratch}"
            "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply --whitespace=nowarn
            ${apply_direction} "${apply_argument}" "${scratch}/result.patch"
            WORKING_DIRECTORY "${scratch}/candidate"
            RESULT_VARIABLE result_apply OUTPUT_VARIABLE result_output ERROR_VARIABLE result_error)
        if(NOT result_apply EQUAL 0)
            message(FATAL_ERROR "Unable to stage the frozen terminal source tail; live source was not changed.\n${result_output}${result_error}")
        endif()
    endforeach()
    ego_read_source_cache_file("${scratch}/candidate" "${source_relative_path}" candidate_hash ignored_text)
    if(NOT candidate_hash STREQUAL expected_after_hash)
        message(FATAL_ERROR "The staged terminal source body has an unexpected hash; live source was not changed.")
    endif()
    ego_assert_source_cache_vector("${source_dir}" ${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256})
    verify_reshade_patched_source("${source_dir}")
    file(SHA256 "${target}" current_raw_hash)
    if(NOT current_raw_hash STREQUAL original_raw_hash)
        message(FATAL_ERROR "The source changed before terminal publication; unknown edits were preserved.")
    endif()
    file(RENAME "${scratch}/candidate/${source_relative_path}" "${target}" RESULT publish_result)
    if(NOT publish_result STREQUAL "0")
        message(FATAL_ERROR "Unable to publish the verified terminal source body: ${publish_result}")
    endif()
    ego_assert_source_cache_vector("${source_dir}" ${final_vector})
    set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256 "${final_vector}")
    verify_reshade_patched_source("${source_dir}")
endfunction()

function(ego_apply_terminal_injector_source_tail source_dir patch_path expected_patch_hash expected_before_hash expected_after_hash)
    # Preserve the frozen injector-tail API and its generation-19 base vector.
    string(REPLACE "tools/injector.cpp=${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}"
        "tools/injector.cpp=${expected_before_hash}" RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
        "${RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256}")
    ego_apply_terminal_source_file_tail("${source_dir}" "tools/injector.cpp"
        "${patch_path}" "${expected_patch_hash}" "${expected_before_hash}" "${expected_after_hash}" ${ARGN})
endfunction()

function(ego_apply_first_host_result_source_tail source_dir)
    ego_apply_terminal_injector_source_tail("${source_dir}"
        "${RESHAPE_FIRST_HOST_RESULT_PATCH}" "${RESHAPE_FIRST_HOST_RESULT_PATCH_SHA256}"
        "${RESHAPE_PRE_RESULT_INJECTOR_CONTENT_SHA256}" "${RESHAPE_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}")
endfunction()

function(ego_apply_preloaded_addon_source_tail source_dir)
    ego_apply_terminal_injector_source_tail("${source_dir}"
        "${RESHAPE_PRELOADED_ADDON_PATCH}" "${RESHAPE_PRELOADED_ADDON_PATCH_SHA256}"
        "${RESHAPE_PRE_PRELOADED_INJECTOR_CONTENT_SHA256}" "${RESHAPE_PRE_FIRST_HOST_PRELOADED_INJECTOR_CONTENT_SHA256}")
endfunction()

function(ego_apply_preloaded_first_host_source_tail source_dir)
    ego_apply_terminal_injector_source_tail("${source_dir}"
        "${RESHAPE_PRELOADED_FIRST_HOST_PATCH}" "${RESHAPE_PRELOADED_FIRST_HOST_PATCH_SHA256}"
        "${RESHAPE_PRE_FIRST_HOST_PRELOADED_INJECTOR_CONTENT_SHA256}" "${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}")
endfunction()

function(ego_apply_preload_long_path_source_tail source_dir)
    ego_apply_terminal_injector_source_tail("${source_dir}"
        "${RESHAPE_PRELOAD_LONG_PATH_PATCH}" "${RESHAPE_PRELOAD_LONG_PATH_PATCH_SHA256}"
        "${RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256}" "${RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256}")
endfunction()

function(ego_apply_adapter_ready_long_path_source_tail source_dir)
    set(before_hash "${RESHAPE_PRE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256}")
    set(after_hash "${RESHAPE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256}")
    set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
        "${RESHAPE_PRELOAD_LONG_PATH_PATCHED_CONTENT_SHA256}")
    set(apply_direction)
    if(ARGC GREATER 1)
        if(NOT ARGC EQUAL 2 OR NOT ARGV1 STREQUAL "REVERSE")
            message(FATAL_ERROR "Unknown adapter-ready patch direction; no source files were changed.")
        endif()
        set(before_hash "${RESHAPE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256}")
        set(after_hash "${RESHAPE_PRE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256}")
        set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
            "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCHED_CONTENT_SHA256}")
        set(apply_direction REVERSE)
    endif()
    ego_apply_terminal_source_file_tail("${source_dir}"
        "source/ego_owned_late_d3d11/owned_late_d3d11.inl"
        "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCH}" "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCH_SHA256}"
        "${before_hash}" "${after_hash}" ${apply_direction})
endfunction()

function(ego_apply_initial_inspection_recovery_source_tail source_dir)
    set(before_hash "${RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256}")
    set(after_hash "${RESHAPE_INITIAL_INSPECTION_RECOVERY_INJECTOR_CONTENT_SHA256}")
    set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
        "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCHED_CONTENT_SHA256}")
    set(apply_direction)
    if(ARGC GREATER 1)
        if(NOT ARGC EQUAL 2 OR NOT ARGV1 STREQUAL "REVERSE")
            message(FATAL_ERROR "Unknown initial-inspection patch direction; no source files were changed.")
        endif()
        set(before_hash "${RESHAPE_INITIAL_INSPECTION_RECOVERY_INJECTOR_CONTENT_SHA256}")
        set(after_hash "${RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256}")
        set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
            "${RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCHED_CONTENT_SHA256}")
        set(apply_direction REVERSE)
    endif()
    ego_apply_terminal_source_file_tail("${source_dir}" "tools/injector.cpp"
        "${RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH}" "${RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256}"
        "${before_hash}" "${after_hash}" ${apply_direction})
endfunction()

# Recognize the complete injector before any live historical patch is peeled.
# A v3 body must migrate its terminal implementation before its identity can
# match the current v4 pin. Every transformation stays in private scratch space
# until the complete new body is verified; unknown edits are never rewritten.
function(ego_rollover_known_addon_build_id source_path)
    if(NOT IS_ABSOLUTE "${source_path}" OR NOT EXISTS "${source_path}" OR
       IS_DIRECTORY "${source_path}" OR IS_SYMLINK "${source_path}")
        message(FATAL_ERROR "The injector migration requires an existing absolute regular source path.")
    endif()
    file(SIZE "${source_path}" source_size)
    if(source_size LESS 1 OR source_size GREATER 4194304)
        message(FATAL_ERROR "The injector migration source size is out of bounds.")
    endif()
    file(SHA256 "${source_path}" original_file_hash)
    file(READ "${source_path}" source_prefix LIMIT 3 HEX)
    string(TOLOWER "${source_prefix}" source_prefix)
    if(source_prefix STREQUAL "efbbbf")
        file(READ "${source_path}" source_text OFFSET 3)
    else()
        file(READ "${source_path}" source_text)
    endif()
    string(REPLACE "\r\n" "\n" source_text "${source_text}")
    # Source caches use LF or CRLF. CMake text reads can drop a terminal bare
    # CR, so reject that unsupported format instead of hashing altered bytes.
    string(FIND "${source_text}" "\r" bare_cr_index)
    if(NOT bare_cr_index EQUAL -1)
        message(FATAL_ERROR "Bare-CR injector source caches are unsupported; source was not changed.")
    endif()
    string(SHA256 source_hash "${source_text}")
    string(TOUPPER "${source_hash}" source_hash)

    # These exact historical lower-stack forms have no cooperative tail. Leave
    # their fixed meanings to the existing ordered historical migration below.
    if(source_hash STREQUAL "26CFBBFFD692ACFB24BD19CBD93B3C7F81F24555EA67B75C55FAD14861E38B00" OR
       source_hash STREQUAL RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256 OR
       source_hash STREQUAL RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256 OR
       source_hash STREQUAL RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256)
        return()
    endif()

    set(previous_v3_full
        "246B4B1DC7259C2EBF4BC4C4278B03B5083507FAE8BDB071B264692F73730135"
        "88E5980C5737539918CDFD0A4070802780B44FA5FBCA2BB251B79952F180C621"
        "5F4C08D04AB5E720851326EB72DED1D59D9E1924036B866CAC6E56602417C377"
        "5265F91C9308F755CF585EA7C3083E60DF48AED6CDC435C25518B7130A748F5B")
    set(previous_pre_cooperative
        "007B4DF39CEB0C7E6777B990A9A24D352DBC399C79DCA8488E9F4E49C58FB166"
        "956A8530DD5C4C9F73C3372CE6C25A13E1AB230746B6A8CC26E7EC349CE50309"
        "816BF5F33495D3B280A2E319D565FA2D310BF10A409FDC580B6ED8B4358B71C8"
        "1903E98A0462431D4A355A3CCE0E3B69AB8E5C67B7895080DA9F9EF8D75CA410"
        "0BAE44EE68E401993FA662BAF8BE79F985F6BCB87DC3A0818BFD80FD9574DDEB"
        "4EEA17F39E3BFF425CCD08246DDA121FE256A61B37D0FD5D93565FC83E9DAA7D"
        "AEFCC8D76B43277DDE2C0D29B3F98A6EEF03B06E99868F36B027A922CE2CA1A4"
        "3D51024529834F539601F4E2573E29591954CF5906C704C980086108DB51373B"
        "0A452E415E4AD37B6558D0F398A2A5A7A161D752148A70B21A4E8097740CA7D9"
        "35BDAB091F1D93E89BC2C65E1F7853540B81931E99A1914697418E71609CC929"
        "75FF6A30283E8147A47982C61C5ADC7F080DEED7C28345D420907753DC218C25")
    list(FIND previous_v3_full "${source_hash}" previous_v3_index)
    set(replacement "${source_text}")
    if(NOT previous_v3_index EQUAL -1)
        list(GET previous_pre_cooperative ${previous_v3_index} expected_previous_pre_hash)
        set(expected_hash "${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}")
    elseif(source_hash IN_LIST previous_pre_cooperative OR
           source_hash STREQUAL "E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359")
        set(expected_hash "${RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256}")
    elseif(source_hash STREQUAL "D0A885F093B5364FF7ED1D84761E758E7544579185E9EEA8517B4058D7C29B94" OR
           source_hash STREQUAL "C436078556B22BDAD9DFCD662A745E73339758E227F0178234B41D1392956974" OR
           source_hash STREQUAL "3A58324E3AE6CE96F3F312D965A384CB825B27B64CE3E4E95CF4B4194032946C" OR
           source_hash STREQUAL "EB8B4AD906DC0AC144EF2EF71DD3A9714C4C4325C01D42B66D22B48EE69060F1" OR
           source_hash STREQUAL "F1B4EFB815F45A61BDCF31BC7C04D2B49ED8F060CD98CD03960E0BC222FD3E8B" OR
           source_hash STREQUAL "C2F7641F12F19FD1F78ABDB608DA9EF5A8B58DB087E30552ED3EDEE42AFCDF48" OR
           source_hash STREQUAL "B11E61F8089802A590967C03DB358B253EEA8FE84FA3DCE2849F6EC642E9AA02" OR
           source_hash STREQUAL "FB85D69E1D6B97D9DC4E4A82C591425A588A99601F897B0F6316D1E5A81E0683")
        # Frozen v4 bodies with the generation-11 through generation-18 identities.
        set(expected_hash "${RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256}")
    else()
        message(FATAL_ERROR
            "Unrecognized injector source hash before historical patch peeling; source was not changed.\n"
            "Actual: ${source_hash}")
    endif()

    string(RANDOM LENGTH 24 ALPHABET "0123456789abcdef" scratch_suffix)
    set(scratch "${CMAKE_CURRENT_BINARY_DIR}/ego-injector-rollover-${scratch_suffix}")
    file(MAKE_DIRECTORY "${scratch}/tools")
    set(candidate "${scratch}/tools/injector.cpp")
    ego_write_lf_source_cache_file("${candidate}" "${replacement}")

    if(NOT previous_v3_index EQUAL -1)
        if(DEFINED RESHAPE_COOPERATIVE_MEMBERS_V3_PATCH)
            set(v3_patch "${RESHAPE_COOPERATIVE_MEMBERS_V3_PATCH}")
        else()
            set(v3_patch "${CMAKE_CURRENT_SOURCE_DIR}/patches/reshade-injector-cooperative-members-v3.patch")
        endif()
        set(v4_patch "${RESHAPE_COOPERATIVE_MEMBERS_PATCH}")
        # Hash and use the same normalized bytes. This remains exact under a
        # CRLF checkout and cannot use a modified migration or current patch.
        foreach(version IN ITEMS v3 v4)
            if(version STREQUAL "v3")
                set(expected_patch_hash "B3A49BAF2B7BC5AC22D3C63A40E64F37C526FEB17ECE9E2C2AF127AF3674FBC4")
            else()
                set(expected_patch_hash "D4FC9A85D26C8458B7D22424402018579477205317E10A38DD0B7E472A448E56")
            endif()
            file(READ "${${version}_patch}" patch_prefix LIMIT 3 HEX)
            string(TOLOWER "${patch_prefix}" patch_prefix)
            if(patch_prefix STREQUAL "efbbbf")
                file(READ "${${version}_patch}" patch_text OFFSET 3)
            else()
                file(READ "${${version}_patch}" patch_text)
            endif()
            string(REPLACE "\r\n" "\n" patch_text "${patch_text}")
            string(REPLACE "\r" "\n" patch_text "${patch_text}")
            string(SHA256 patch_hash "${patch_text}")
            string(TOUPPER "${patch_hash}" patch_hash)
            if(NOT patch_hash STREQUAL expected_patch_hash)
                message(FATAL_ERROR "The exact ${version} cooperative injector migration patch hash does not match; source was not changed.")
            endif()
            ego_write_lf_source_cache_file("${scratch}/${version}.patch" "${patch_text}")
        endforeach()

        # Ceiling the scratch tree so Git cannot discover the enclosing SDK
        # repository and interpret patch paths relative to that working tree.
        execute_process(
            COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR --unset=GIT_WORK_TREE
                --unset=GIT_INDEX_FILE "GIT_CEILING_DIRECTORIES=${CMAKE_CURRENT_BINARY_DIR}"
                "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply --reverse --check "${scratch}/v3.patch"
            WORKING_DIRECTORY "${scratch}"
            RESULT_VARIABLE reverse_check OUTPUT_VARIABLE reverse_output ERROR_VARIABLE reverse_error)
        if(NOT reverse_check EQUAL 0)
            message(FATAL_ERROR "The exact historical v3 injector tail cannot be peeled in scratch; source was not changed.\n${reverse_output}${reverse_error}")
        endif()
        execute_process(
            COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR --unset=GIT_WORK_TREE
                --unset=GIT_INDEX_FILE "GIT_CEILING_DIRECTORIES=${CMAKE_CURRENT_BINARY_DIR}"
                "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply --reverse "${scratch}/v3.patch"
            WORKING_DIRECTORY "${scratch}"
            RESULT_VARIABLE reverse_result OUTPUT_VARIABLE reverse_output ERROR_VARIABLE reverse_error)
        if(NOT reverse_result EQUAL 0)
            message(FATAL_ERROR "The historical v3 injector tail could not be peeled in scratch; source was not changed.\n${reverse_output}${reverse_error}")
        endif()
        file(READ "${candidate}" peeled_text)
        string(SHA256 peeled_hash "${peeled_text}")
        string(TOUPPER "${peeled_hash}" peeled_hash)
        if(NOT peeled_hash STREQUAL expected_previous_pre_hash)
            message(FATAL_ERROR "The peeled historical injector does not match its exact pre-cooperative hash; source was not changed.")
        endif()
        execute_process(
            COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR --unset=GIT_WORK_TREE
                --unset=GIT_INDEX_FILE "GIT_CEILING_DIRECTORIES=${CMAKE_CURRENT_BINARY_DIR}"
                "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply --check "${scratch}/v4.patch"
            WORKING_DIRECTORY "${scratch}"
            RESULT_VARIABLE apply_check OUTPUT_VARIABLE apply_output ERROR_VARIABLE apply_error)
        if(NOT apply_check EQUAL 0)
            message(FATAL_ERROR "The exact current v4 injector tail cannot apply in scratch; source was not changed.\n${apply_output}${apply_error}")
        endif()
        execute_process(
            COMMAND "${CMAKE_COMMAND}" -E env --unset=GIT_DIR --unset=GIT_WORK_TREE
                --unset=GIT_INDEX_FILE "GIT_CEILING_DIRECTORIES=${CMAKE_CURRENT_BINARY_DIR}"
                "${GIT_EXECUTABLE}" -c core.autocrlf=false -c core.eol=lf apply "${scratch}/v4.patch"
            WORKING_DIRECTORY "${scratch}"
            RESULT_VARIABLE apply_result OUTPUT_VARIABLE apply_output ERROR_VARIABLE apply_error)
        if(NOT apply_result EQUAL 0)
            message(FATAL_ERROR "The current v4 injector tail could not apply in scratch; source was not changed.\n${apply_output}${apply_error}")
        endif()
        file(READ "${candidate}" replacement)
    endif()

    string(REGEX MATCHALL
        "constexpr char expected_addon_build_id\\[\\] =[\t\r\n ]*\"[0-9A-F]+\""
        build_id_declarations "${replacement}")
    list(LENGTH build_id_declarations declaration_count)
    if(NOT declaration_count EQUAL 1)
        message(FATAL_ERROR "Known injector body has no unique add-on build-ID declaration; source was not changed.")
    endif()
    list(GET build_id_declarations 0 declaration)
    string(REGEX MATCH "\"[0-9A-F]+\"$" previous_id_quoted "${declaration}")
    string(LENGTH "${previous_id_quoted}" previous_id_length)
    if(NOT previous_id_length EQUAL 34)
        message(FATAL_ERROR "Known injector body has an invalid add-on build-ID length; source was not changed.")
    endif()
    string(REPLACE "${previous_id_quoted}" "\"${ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID}\""
        new_declaration "${declaration}")
    string(REPLACE "${declaration}" "${new_declaration}" replacement "${replacement}")
    string(SHA256 replacement_hash "${replacement}")
    string(TOUPPER "${replacement_hash}" replacement_hash)
    if(NOT replacement_hash STREQUAL expected_hash)
        message(FATAL_ERROR "Known injector migration does not match the new pinned source hash; source was not changed.")
    endif()
    ego_write_lf_source_cache_file("${candidate}" "${replacement}")
    file(SHA256 "${source_path}" current_file_hash)
    if(NOT current_file_hash STREQUAL original_file_hash)
        message(FATAL_ERROR "The injector source changed during staged migration; the live source was not replaced.")
    endif()
    file(RENAME "${candidate}" "${source_path}" RESULT migration_rename_result)
    if(NOT migration_rename_result STREQUAL "0")
        message(FATAL_ERROR "Unable to publish the verified injector migration: ${migration_rename_result}")
    endif()
endfunction()
# END EGO_SOURCE_CACHE_MIGRATION_HELPERS
ego_normalize_reshade_patch_inputs()
ego_prepare_owned_late_source_cache("${reshade_SOURCE_DIR}")
ego_rollover_known_addon_build_id("${reshade_SOURCE_DIR}/tools/injector.cpp")

# Member attachment is the terminal injector seam. Peel it before the existing
# independently verified historical stack is replayed on repeated configure.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check "${RESHAPE_COOPERATIVE_MEMBERS_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE EGO_COOPERATIVE_MEMBERS_PRESENT OUTPUT_QUIET ERROR_QUIET
)
if(EGO_COOPERATIVE_MEMBERS_PRESENT EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse "${RESHAPE_COOPERATIVE_MEMBERS_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}" COMMAND_ERROR_IS_FATAL ANY
    )
endif()

# Normalize only an exact prior terminal injector before peeling the stack.
# The terminal future-target patch also pins the add-on build ID. Historical
# lower-stack migration cannot recognize it until this terminal seam is peeled.
set(EGO_TERMINAL_INJECTOR "${reshade_SOURCE_DIR}/tools/injector.cpp")
file(READ "${EGO_TERMINAL_INJECTOR}" EGO_TERMINAL_CONTENT)
string(REPLACE "\r\n" "\n" EGO_TERMINAL_CONTENT "${EGO_TERMINAL_CONTENT}")
string(REGEX REPLACE
    "(constexpr char expected_addon_build_id\\[\\] =[\t\r\n ]*\")[0-9A-F]+(\")"
    "\\1${ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID}\\2"
    EGO_TERMINAL_NORMALIZED "${EGO_TERMINAL_CONTENT}")
string(SHA256 EGO_TERMINAL_HASH "${EGO_TERMINAL_NORMALIZED}")
string(TOUPPER "${EGO_TERMINAL_HASH}" EGO_TERMINAL_HASH)
if((EGO_TERMINAL_HASH STREQUAL RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256 OR
    EGO_TERMINAL_HASH STREQUAL RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256) AND
   NOT EGO_TERMINAL_CONTENT STREQUAL EGO_TERMINAL_NORMALIZED)
    file(WRITE "${EGO_TERMINAL_INJECTOR}" "${EGO_TERMINAL_NORMALIZED}")
endif()

# The policy seam is terminal. Peel it before older future/binding migrations.
execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check "${RESHAPE_PROCESS_POLICY_PATCH}" WORKING_DIRECTORY "${reshade_SOURCE_DIR}" RESULT_VARIABLE POLICY_PRESENT OUTPUT_QUIET ERROR_QUIET)
if(POLICY_PRESENT EQUAL 0)
    execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse "${RESHAPE_PROCESS_POLICY_PATCH}" WORKING_DIRECTORY "${reshade_SOURCE_DIR}" COMMAND_ERROR_IS_FATAL ANY)
endif()

# Peel the watcher-readiness marker and exact-target path proof first, then the
# architecture diagnostic and architecture patch, from an existing fetched
# tree before migrating or validating the historical stack below. They are
# reapplied in the opposite order after those patches, so repeated configure
# runs and earlier trees remain idempotent.
execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check "${RESHAPE_FUTURE_TARGETS_PATCH}" WORKING_DIRECTORY "${reshade_SOURCE_DIR}" RESULT_VARIABLE FUTURE_PRESENT OUTPUT_QUIET ERROR_QUIET)
if(FUTURE_PRESENT EQUAL 0)
    execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse "${RESHAPE_FUTURE_TARGETS_PATCH}" WORKING_DIRECTORY "${reshade_SOURCE_DIR}" COMMAND_ERROR_IS_FATAL ANY)
endif()

# Peel the new terminal seam before replaying historical migrations.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_PROCESS_INSTANCE_BINDING_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_BINDING_PRESENT
    OUTPUT_QUIET ERROR_QUIET
)
if(RESHAPE_BINDING_PRESENT EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse
            "${RESHAPE_INJECTOR_PROCESS_INSTANCE_BINDING_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_BINDING_PEEL
    )
    if(NOT RESHAPE_BINDING_PEEL EQUAL 0)
        message(FATAL_ERROR "Unable to peel process-instance binding patch.")
    endif()
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_PRESENT_AT_ENTRY
    OUTPUT_QUIET
    ERROR_QUIET
)
if(RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_PRESENT_AT_ENTRY EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_PEEL
        OUTPUT_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_PEEL_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_PEEL_ERROR
    )
    if(NOT RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_PEEL EQUAL 0)
        message(FATAL_ERROR
            "Unable to peel the terminal name-watcher readiness patch.\n"
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_PEEL_OUTPUT}"
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_PEEL_ERROR}"
        )
    endif()
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_PRESENT_AT_ENTRY
    OUTPUT_QUIET
    ERROR_QUIET
)
if(RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_PRESENT_AT_ENTRY EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_PEEL
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_PEEL_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_PEEL_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_PEEL EQUAL 0)
        message(FATAL_ERROR
            "Unable to peel the terminal exact-target path patch.\n"
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_PEEL_OUTPUT}"
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_PEEL_ERROR}"
        )
    endif()
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_PRESENT_AT_ENTRY
    OUTPUT_QUIET
    ERROR_QUIET
)
if(RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_PRESENT_AT_ENTRY EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_PEEL
        OUTPUT_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_PEEL_OUTPUT
        ERROR_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_PEEL_ERROR
    )
    if(NOT RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_PEEL EQUAL 0)
        message(FATAL_ERROR
            "Unable to peel the terminal target-architecture diagnostic patch.\n"
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_PEEL_OUTPUT}"
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_PEEL_ERROR}"
        )
    endif()
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_X86_RUNTIME_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_X86_RUNTIME_PATCH_PRESENT_AT_ENTRY
    OUTPUT_QUIET
    ERROR_QUIET
)
if(RESHAPE_X86_RUNTIME_PATCH_PRESENT_AT_ENTRY EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse
            "${RESHAPE_X86_RUNTIME_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_X86_RUNTIME_PATCH_PEEL
        OUTPUT_VARIABLE RESHAPE_X86_RUNTIME_PATCH_PEEL_OUTPUT
        ERROR_VARIABLE RESHAPE_X86_RUNTIME_PATCH_PEEL_ERROR
    )
    if(NOT RESHAPE_X86_RUNTIME_PATCH_PEEL EQUAL 0)
        message(FATAL_ERROR
            "Unable to peel the terminal x86 runtime patch.\n"
            "${RESHAPE_X86_RUNTIME_PATCH_PEEL_OUTPUT}"
            "${RESHAPE_X86_RUNTIME_PATCH_PEEL_ERROR}"
        )
    endif()
endif()

# Apply twenty-four narrow pinned seams: the passive copied-input observer, raw-input
# target normalization and pre-injection registration reconciliation, an injector
# base-path override, coverage for Windows' second mouse projection through
# WM_POINTER, exact-PID targeting, one-shot and persistent prearmed path
# observation, loaded and inactive ReShade conflict preflight, official add-on
# discovery, per-PID injection ownership, compatible shared-runtime registration
# plus its bounded export and loader hardening, and startup splash suppression. The watcher patches are terminal so existing
# exact-PID and original watcher trees can migrate without replacing those
# ignored source trees.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)

# A build-ID bump changes one literal in the terminal injector patch. That
# makes neither the new terminal patch nor its lower superseded patches
# independently reversible in an existing fetched tree. Replace a prior
# 32-hex build ID only when the resulting normalized file is byte-for-byte
# the current pinned injector. Only the recognized older lower-stack bodies
# reach this point; unknown entry hashes were rejected before live peeling.
if(NOT RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED EQUAL 0)
    set(RESHAPE_FETCHED_INJECTOR_PATH
        "${reshade_SOURCE_DIR}/tools/injector.cpp")
    if(EXISTS "${RESHAPE_FETCHED_INJECTOR_PATH}")
        file(READ "${RESHAPE_FETCHED_INJECTOR_PATH}"
            RESHAPE_FETCHED_INJECTOR_CONTENT)
        string(REGEX MATCHALL
            "constexpr char expected_addon_build_id\\[\\] =[\t\r\n ]*\"[0-9A-F]+\""
            RESHAPE_ADDON_BUILD_ID_DECLARATIONS
            "${RESHAPE_FETCHED_INJECTOR_CONTENT}"
        )
        list(LENGTH RESHAPE_ADDON_BUILD_ID_DECLARATIONS
            RESHAPE_ADDON_BUILD_ID_DECLARATION_COUNT)
        if(RESHAPE_ADDON_BUILD_ID_DECLARATION_COUNT EQUAL 1)
            list(GET RESHAPE_ADDON_BUILD_ID_DECLARATIONS 0
                RESHAPE_ADDON_BUILD_ID_DECLARATION)
            string(REGEX MATCH "\"[0-9A-F]+\"$"
                RESHAPE_PREVIOUS_ADDON_BUILD_ID_QUOTED
                "${RESHAPE_ADDON_BUILD_ID_DECLARATION}"
            )
            string(REGEX REPLACE "^\"|\"$" ""
                RESHAPE_PREVIOUS_ADDON_BUILD_ID
                "${RESHAPE_PREVIOUS_ADDON_BUILD_ID_QUOTED}"
            )
            string(LENGTH "${RESHAPE_PREVIOUS_ADDON_BUILD_ID}"
                RESHAPE_PREVIOUS_ADDON_BUILD_ID_LENGTH)
            if(RESHAPE_PREVIOUS_ADDON_BUILD_ID_LENGTH EQUAL 32 AND
                NOT RESHAPE_PREVIOUS_ADDON_BUILD_ID STREQUAL
                    ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID)
                string(REPLACE
                    "${RESHAPE_PREVIOUS_ADDON_BUILD_ID_QUOTED}"
                    "\"${ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID}\""
                    RESHAPE_MIGRATED_ADDON_BUILD_ID_DECLARATION
                    "${RESHAPE_ADDON_BUILD_ID_DECLARATION}"
                )
                string(REPLACE
                    "${RESHAPE_ADDON_BUILD_ID_DECLARATION}"
                    "${RESHAPE_MIGRATED_ADDON_BUILD_ID_DECLARATION}"
                    RESHAPE_MIGRATED_INJECTOR_CONTENT
                    "${RESHAPE_FETCHED_INJECTOR_CONTENT}"
                )

                set(RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT
                    "${RESHAPE_MIGRATED_INJECTOR_CONTENT}")
                string(REPLACE "\r\n" "\n"
                    RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT
                    "${RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT}")
                string(REPLACE "\r" "\n"
                    RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT
                    "${RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT}")
                string(SHA256 RESHAPE_MIGRATED_INJECTOR_CONTENT_SHA256
                    "${RESHAPE_NORMALIZED_MIGRATED_INJECTOR_CONTENT}")
                string(TOUPPER
                    "${RESHAPE_MIGRATED_INJECTOR_CONTENT_SHA256}"
                    RESHAPE_MIGRATED_INJECTOR_CONTENT_SHA256)

                if(RESHAPE_MIGRATED_INJECTOR_CONTENT_SHA256 STREQUAL
                    RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256)
                    string(RANDOM LENGTH 16
                        ALPHABET "0123456789abcdef"
                        RESHAPE_INJECTOR_MIGRATION_SUFFIX)
                    string(CONCAT RESHAPE_INJECTOR_MIGRATION_TEMP_PATH
                        "${RESHAPE_FETCHED_INJECTOR_PATH}."
                        "electron-game-overlay-"
                        "${RESHAPE_INJECTOR_MIGRATION_SUFFIX}.tmp")
                    file(WRITE "${RESHAPE_INJECTOR_MIGRATION_TEMP_PATH}"
                        "${RESHAPE_MIGRATED_INJECTOR_CONTENT}")
                    file(RENAME
                        "${RESHAPE_INJECTOR_MIGRATION_TEMP_PATH}"
                        "${RESHAPE_FETCHED_INJECTOR_PATH}"
                        RESULT RESHAPE_INJECTOR_MIGRATION_RENAME_RESULT)
                    if(NOT RESHAPE_INJECTOR_MIGRATION_RENAME_RESULT
                        STREQUAL "0")
                        file(REMOVE
                            "${RESHAPE_INJECTOR_MIGRATION_TEMP_PATH}")
                    endif()

                    # Recheck even when rename reported failure: another
                    # concurrent configure may have completed the same
                    # idempotent migration.
                    execute_process(
                        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
                            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
                        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
                        RESULT_VARIABLE
                            RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED
                        OUTPUT_QUIET
                        ERROR_QUIET
                    )
                    if(NOT
                        RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED
                        EQUAL 0)
                        message(FATAL_ERROR
                            "Unable to migrate the exact pinned ReShade "
                            "injector add-on build ID.\n"
                            "${RESHAPE_INJECTOR_MIGRATION_RENAME_RESULT}"
                        )
                    endif()
                endif()
            endif()
        endif()
    endif()
endif()

if(NOT RESHAPE_TERMINAL_GLOBAL_LAYER_PREFLIGHT_APPLIED EQUAL 0)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_TERMINAL_PROCESS_OBSERVER_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_TERMINAL_PROCESS_OBSERVER_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(RESHAPE_TERMINAL_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    # The persistent observer adds headers next to the identity patch's include
    # hunk, so that lower patch is no longer independently reverse-applicable.
    set(RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED EQUAL 0)
list(GET RESHAPE_SOURCE_PATCHES 4 RESHAPE_PATH_WATCHER_PATCH)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_PATH_WATCHER_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)

if(RESHAPE_PATH_WATCHER_PATCH_APPLIED EQUAL 0)
    list(GET RESHAPE_SOURCE_PATCHES 2 RESHAPE_POINTER_INPUT_PATCH)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_POINTER_INPUT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_POINTER_INPUT_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(NOT RESHAPE_POINTER_INPUT_PATCH_APPLIED EQUAL 0)
        message(FATAL_ERROR
            "The terminal path-watcher patch is present without the pinned input patch."
        )
    endif()
else()
# Migrate the previous exact-PID/base-path states before applying the new
# terminal watcher patch.
list(GET RESHAPE_SOURCE_PATCHES 3 RESHAPE_EXACT_PID_PATCH)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_EXACT_PID_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_PATCH_STACK_ALREADY_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)

if(RESHAPE_PATCH_STACK_ALREADY_APPLIED EQUAL 0)
    list(GET RESHAPE_SOURCE_PATCHES 2 RESHAPE_POINTER_INPUT_PATCH)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_POINTER_INPUT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_POINTER_INPUT_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(NOT RESHAPE_POINTER_INPUT_PATCH_APPLIED EQUAL 0)
        message(FATAL_ERROR
            "The terminal exact-PID patch is present without the pinned input patch."
        )
    endif()
else()
list(GET RESHAPE_SOURCE_PATCHES 1 RESHAPE_INJECTOR_BASE_PATH_PATCH)
list(GET RESHAPE_SOURCE_PATCHES 2 RESHAPE_POINTER_INPUT_PATCH)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_BASE_PATH_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_BASE_PATH_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_POINTER_INPUT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_POINTER_INPUT_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)

if(RESHAPE_INJECTOR_BASE_PATH_PATCH_APPLIED EQUAL 0 AND
    RESHAPE_POINTER_INPUT_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_EXACT_PID_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_EXACT_PID_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_EXACT_PID_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_EXACT_PID_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_EXACT_PID_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned exact-PID patch cannot migrate the prior ReShade patch stack.\n"
            "${RESHAPE_EXACT_PID_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_EXACT_PID_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_EXACT_PID_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_EXACT_PID_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_EXACT_PID_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_EXACT_PID_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_EXACT_PID_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to migrate the prior ReShade patch stack with exact-PID support.\n"
            "${RESHAPE_EXACT_PID_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_EXACT_PID_PATCH_APPLY_ERROR}"
        )
    endif()
else()
foreach(RESHAPE_SOURCE_PATCH IN LISTS RESHAPE_SOURCE_PATCHES)
    get_filename_component(RESHAPE_SOURCE_PATCH_NAME
        "${RESHAPE_SOURCE_PATCH}" NAME)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_SOURCE_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHADE_SOURCE_PATCH_ALREADY_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(NOT RESHADE_SOURCE_PATCH_ALREADY_APPLIED EQUAL 0)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
                "${RESHAPE_SOURCE_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHADE_SOURCE_PATCH_CHECK
            OUTPUT_VARIABLE RESHADE_SOURCE_PATCH_CHECK_OUTPUT
            ERROR_VARIABLE RESHADE_SOURCE_PATCH_CHECK_ERROR
        )
        if(NOT RESHADE_SOURCE_PATCH_CHECK EQUAL 0)
            message(FATAL_ERROR
                "Pinned ReShade patch '${RESHAPE_SOURCE_PATCH_NAME}' no longer applies.\n"
                "${RESHADE_SOURCE_PATCH_CHECK_OUTPUT}"
                "${RESHADE_SOURCE_PATCH_CHECK_ERROR}"
            )
        endif()

        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
                "${RESHAPE_SOURCE_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHADE_SOURCE_PATCH_APPLY
            OUTPUT_VARIABLE RESHADE_SOURCE_PATCH_APPLY_OUTPUT
            ERROR_VARIABLE RESHADE_SOURCE_PATCH_APPLY_ERROR
        )
        if(NOT RESHADE_SOURCE_PATCH_APPLY EQUAL 0)
            message(FATAL_ERROR
                "Unable to apply pinned ReShade patch '${RESHAPE_SOURCE_PATCH_NAME}'.\n"
                "${RESHADE_SOURCE_PATCH_APPLY_OUTPUT}"
                "${RESHADE_SOURCE_PATCH_APPLY_ERROR}"
            )
        endif()
    endif()
endforeach()
endif()
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_PATH_WATCHER_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_PATH_WATCHER_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_PATH_WATCHER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_PATH_WATCHER_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_PATH_WATCHER_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned path-watcher patch cannot migrate the exact-PID ReShade patch stack.\n"
            "${RESHAPE_PATH_WATCHER_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_PATH_WATCHER_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_PATH_WATCHER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_PATH_WATCHER_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_PATH_WATCHER_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to migrate the ReShade patch stack with path-watcher support.\n"
            "${RESHAPE_PATH_WATCHER_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_PATH_WATCHER_PATCH_APPLY_ERROR}"
        )
    endif()
endif()
endif()

endif()

# The process-identity patch is deliberately layered after the original path
# watcher so existing ignored build trees migrate without resetting fetched
# source. It retains handles for startup-baseline processes, so exited process
# objects are distinguishable from later processes even if Windows reuses a PID.
if(RESHAPE_TERMINAL_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned path-watcher process-identity patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to migrate the ReShade path watcher to process identities.\n"
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_PATH_WATCHER_IDENTITY_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# The persistent observer reports every path match to its supervising client
# without performing injection itself. The current implementation uses one
# compact EnumProcesses PID snapshot per cadence, resolves each executable path
# once, and retries temporarily inaccessible paths with bounded backoff. Migrate
# the previous full-Toolhelp snapshot observer in place before applying it.
set(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED FALSE)
set(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED FALSE)
set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE FALSE)
macro(restore_reshade_legacy_process_observer)
    if(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE
            OUTPUT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE_OUTPUT
            ERROR_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE_ERROR
        )
        if(NOT RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE EQUAL 0)
            message(FATAL_ERROR
                "Observer migration failed and the legacy full-snapshot observer could not be restored.\n"
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE_OUTPUT}"
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_RESTORE_ERROR}"
            )
        endif()
        set(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED FALSE)
    endif()

    if(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
                "${RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE
            OUTPUT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE_OUTPUT
            ERROR_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE_ERROR
        )
        if(NOT RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE EQUAL 0)
            message(FATAL_ERROR
                "Observer migration failed and the legacy 5 ms cadence could not be restored.\n"
                "${RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE_OUTPUT}"
                "${RESHAPE_LEGACY_OBSERVER_CADENCE_RESTORE_ERROR}"
            )
        endif()
        set(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED FALSE)
    endif()
endmacro()

macro(rollback_reshade_resilient_observer_migration)
    if(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse
                "${RESHAPE_PROCESS_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK
            OUTPUT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK_OUTPUT
            ERROR_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK_ERROR
        )
        if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK EQUAL 0)
            message(FATAL_ERROR
                "Resilient observer migration failed and the newly applied persistent observer could not be removed.\n"
                "${RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK_OUTPUT}"
                "${RESHAPE_PROCESS_OBSERVER_PATCH_ROLLBACK_ERROR}"
            )
        endif()
        set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE FALSE)
    endif()
    restore_reshade_legacy_process_observer()
endmacro()

if(RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(RESHAPE_LEGACY_OBSERVER_CADENCE_APPLIED EQUAL 0)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse
                "${RESHAPE_LEGACY_LOW_LATENCY_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE
            OUTPUT_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE_OUTPUT
            ERROR_VARIABLE RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE_ERROR
        )
        if(NOT RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE EQUAL 0)
            message(FATAL_ERROR
                "Unable to remove the legacy 5 ms observer overlay.\n"
                "${RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE_OUTPUT}"
                "${RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSE_ERROR}"
            )
        endif()
        set(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED TRUE)
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(RESHAPE_LEGACY_PROCESS_OBSERVER_APPLIED EQUAL 0)
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE
            OUTPUT_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE_OUTPUT
            ERROR_VARIABLE RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE_ERROR
        )
        if(NOT RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE EQUAL 0)
            restore_reshade_legacy_process_observer()
            message(FATAL_ERROR
                "Unable to remove the legacy full-snapshot process observer.\n"
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE_OUTPUT}"
                "${RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSE_ERROR}"
            )
        endif()
        set(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED TRUE)
    elseif(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED)
        restore_reshade_legacy_process_observer()
        message(FATAL_ERROR
            "The legacy observer cadence was present without the pinned "
            "legacy full-snapshot observer."
        )
    endif()
endif()

if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_CHECK EQUAL 0)
        restore_reshade_legacy_process_observer()
        message(FATAL_ERROR
            "Pinned persistent process-observer patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_PROCESS_OBSERVER_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_PROCESS_OBSERVER_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_PROCESS_OBSERVER_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_PROCESS_OBSERVER_PATCH_APPLY EQUAL 0)
        restore_reshade_legacy_process_observer()
        message(FATAL_ERROR
            "Unable to add persistent process observation to the ReShade injector.\n"
            "${RESHAPE_PROCESS_OBSERVER_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_PROCESS_OBSERVER_PATCH_APPLY_ERROR}"
        )
    endif()
    set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE TRUE)
endif()

# Layer resilient identity retention and retry backoff over both freshly applied
# and previously fetched persistent-observer trees.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK EQUAL 0)
        rollback_reshade_resilient_observer_migration()
        message(FATAL_ERROR
            "Pinned resilient process-observer patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY EQUAL 0)
        rollback_reshade_resilient_observer_migration()
        message(FATAL_ERROR
            "Unable to harden persistent ReShade process observation.\n"
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_RESILIENT_PROCESS_OBSERVER_PATCH_APPLY_ERROR}"
        )
    endif()
endif()
set(RESHAPE_PROCESS_OBSERVER_PATCH_APPLIED_BY_CONFIGURE FALSE)
set(RESHAPE_LEGACY_PROCESS_OBSERVER_REVERSED FALSE)
set(RESHAPE_LEGACY_OBSERVER_CADENCE_REVERSED FALSE)

# Inspect loaded ReShade instances before allocating or writing target memory.
# The export-read bounds patch is terminal over shared-runtime hosting,
# conflict preflight, and the per-PID claim, so it proves all lower injector
# patches are present in an existing fetched tree.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED 0)
    set(RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED 0)
    set(RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED EQUAL 0)
        set(RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED 0)
        set(RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED 0)
    else()
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
                "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
            WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
            RESULT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED
            OUTPUT_QUIET
            ERROR_QUIET
        )
        if(RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED EQUAL 0)
            set(RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED 0)
        else()
            execute_process(
                COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
                    "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH}"
                WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
                RESULT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED
                OUTPUT_QUIET
                ERROR_QUIET
            )
        endif()
    endif()
endif()
if(NOT RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned ReShade injector conflict-preflight patch cannot migrate "
            "the patch stack.\n"
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add loaded-ReShade conflict preflight to the injector.\n"
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_CONFLICT_PREFLIGHT_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Serialize injectors targeting the same selected PID before either can inspect
# or mutate that process. This deliberately layers after conflict preflight so
# existing fetched source trees can migrate by applying one terminal patch.
if(NOT RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED EQUAL 0 AND
    NOT RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned ReShade injector per-PID claim patch cannot migrate "
            "the patch stack.\n"
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to serialize ReShade injection per target PID.\n"
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_PER_PID_CLAIM_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# The product renders its own startup/status UI. Keep ReShade's full GUI and
# add-on callback path enabled, but suppress only its built-in splash window.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_SUPPRESS_SPLASH_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_SUPPRESS_SPLASH_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_SUPPRESS_SPLASH_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned ReShade splash-suppression patch cannot migrate the patch stack.\n"
            "${RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_SUPPRESS_SPLASH_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_SUPPRESS_SPLASH_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to suppress the pinned ReShade splash window.\n"
            "${RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_SUPPRESS_SPLASH_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# A project-compatible loaded runtime exposes an ABI marker and an atomic
# pre-initialization gate. The injector can then load only the staged Electron
# add-on while unknown or already-active ReShade runtimes remain fail-closed.
if(RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED EQUAL 0)
    set(RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED 0)
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
endif()
if(NOT RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned shared-runtime host patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add compatible shared-runtime hosting to ReShade.\n"
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_SHARED_RUNTIME_HOST_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Bound each remote export-name read to the requested symbol length. This
# terminal hardening avoids crossing sparse PE image pages while retaining the
# lexical binary search used by shared-runtime capability inspection.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned injector export-read bounds patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to bound ReShade injector export reads.\n"
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_EXPORT_READ_BOUNDS_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Make the shared registration hand-off low-CPU and re-entrancy-safe, and
# measure the copied x64 loader thunk from unwind metadata instead of relying
# on an unchecked byte-count estimate.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned shared-runtime hardening patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to harden compatible shared-runtime hosting.\n"
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_SHARED_RUNTIME_HARDENING_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Before injecting the private runtime, inspect bounded top-level DLL/ASI PE
# exports beside the selected executable. A validated inactive ReShade install
# takes precedence and remains untouched for its next normal launch.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned inactive ReShade installation-preflight patch cannot migrate "
            "the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add inactive ReShade installation preflight to the injector.\n"
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_EXISTING_INSTALLATION_PREFLIGHT_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# A stock full-add-on ReShade may already have loaded this project's add-on at
# normal startup. Recognize its exact exported ABI marker as a no-mutation
# success while keeping the private compatible-host path authoritative.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned official ReShade add-on-host patch cannot migrate "
            "the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add official ReShade add-on hosting to the injector.\n"
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_OFFICIAL_ADDON_HOST_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Preserve applicable x64 ReShade Vulkan/OpenXR layers before any injection
# mutation. The same terminal preflight also resolves target-owned
# [INSTALL] BasePath compatibility installs without following reparse points.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned global ReShade layer-preflight patch cannot migrate "
            "the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add global ReShade layer preservation to the injector.\n"
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_GLOBAL_LAYER_PREFLIGHT_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# A reverse-applicable terminal patch plus exact per-file hashes below proves
# the complete lower patch stack in an existing fetched tree. Skipping lower
# migration checks here avoids asking those superseded hunks to reverse through
# the terminal injector changes.
endif()

# The focused-root patch is terminal over the raw-input stack. Detect it first
# so an existing final tree does not have to reverse-check superseded lower
# hunks. A tree from the previous build-stamp schema remains exactly at the
# reconciliation layer and can accept this incremental patch directly.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_APPLIED EQUAL 0)
# The reconciliation patch is terminal over the lower normalized raw-input
# stack. Detect it before asking superseded normalization hunks to reverse.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLIED EQUAL 0)
# The observer patch now produces the current normalized raw-input tree on a
# clean fetch. This terminal delta migrates an exact older fetched tree without
# deleting user/build caches; on a clean tree it is already reverse-applicable.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply -p2 --reverse --check
        "${RESHAPE_RAW_INPUT_NORMALIZATION_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply -p2 --check
            "${RESHAPE_RAW_INPUT_NORMALIZATION_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned raw-input normalization patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply -p2 --whitespace=nowarn
            "${RESHAPE_RAW_INPUT_NORMALIZATION_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add raw-input target normalization to the pinned ReShade runtime.\n"
            "${RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_RAW_INPUT_NORMALIZATION_PATCH_APPLY_ERROR}"
        )
    endif()
endif()
endif()

# The observer patch and normalization migration establish the raw-input event
# path. This terminal reconciliation layer seeds registrations that predate
# injection and then mirrors each completed process-global registration call.
if(NOT RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned raw-input registration reconciliation patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to reconcile raw-input registrations in the pinned ReShade runtime.\n"
            "${RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_RAW_INPUT_REGISTRATION_RECONCILIATION_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Constrain focus-following registrations to their focused foreground window
# root while retaining the established process-wide explicit-HWND fallback.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
        "${RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_CHECK
    OUTPUT_VARIABLE RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_CHECK_OUTPUT
    ERROR_VARIABLE RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_CHECK_ERROR
)
if(NOT RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_CHECK EQUAL 0)
    message(FATAL_ERROR
        "Pinned raw-input focus-following root patch cannot migrate the ReShade patch stack.\n"
        "${RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_CHECK_OUTPUT}"
        "${RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_CHECK_ERROR}"
    )
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
        "${RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_APPLY
    OUTPUT_VARIABLE RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_APPLY_OUTPUT
    ERROR_VARIABLE RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_APPLY_ERROR
)
if(NOT RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_APPLY EQUAL 0)
    message(FATAL_ERROR
        "Unable to constrain focus-following raw input to its source root.\n"
        "${RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_APPLY_OUTPUT}"
        "${RESHAPE_RAW_INPUT_FOCUS_FOLLOWING_ROOT_PATCH_APPLY_ERROR}"
    )
endif()
endif()

# Apply the final architecture seam after the historical injector patch stack.
# Keeping it terminal lets existing fetched trees migrate without rewriting the
# already-audited x64 patches, while making both Win32 and x64 builds consume
# the same target-width-aware injector source.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_X86_RUNTIME_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_X86_RUNTIME_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_X86_RUNTIME_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_X86_RUNTIME_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_X86_RUNTIME_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_X86_RUNTIME_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_X86_RUNTIME_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_X86_RUNTIME_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned x86 runtime patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_X86_RUNTIME_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_X86_RUNTIME_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_X86_RUNTIME_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_X86_RUNTIME_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_X86_RUNTIME_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_X86_RUNTIME_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_X86_RUNTIME_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to apply target-width-aware ReShade injector support.\n"
            "${RESHAPE_X86_RUNTIME_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_X86_RUNTIME_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Keep the architecture mismatch record separate from the target-width seam so
# fetched trees built before this diagnostic can migrate without deleting their
# pinned ReShade checkout. This is terminal over the x86 runtime patch.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned target-architecture diagnostic patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add target-architecture mismatch diagnostics.\n"
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_X86_TARGET_ARCHITECTURE_DIAGNOSTIC_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Require an exact executable path whenever an exact-PID caller supplies one.
# This closes the architecture hand-off identity window before the x86 injector
# can claim or mutate a replacement process.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned exact-target path patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to require exact target paths for exact-PID injection.\n"
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_EXACT_TARGET_PATH_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Emit a stable, flushed marker only after the name-only injector has entered
# its watcher branch. SDK consumers use this terminal seam to launch a process
# without racing the native watcher's first scan.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --reverse --check
        "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_APPLIED
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_APPLIED EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_CHECK
        OUTPUT_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_CHECK_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_CHECK_ERROR
    )
    if(NOT RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_CHECK EQUAL 0)
        message(FATAL_ERROR
            "Pinned name-watcher readiness patch cannot migrate the ReShade patch stack.\n"
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_CHECK_OUTPUT}"
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_CHECK_ERROR}"
        )
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --whitespace=nowarn
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH}"
        WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
        RESULT_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_APPLY
        OUTPUT_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_APPLY_ERROR
    )
    if(NOT RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_APPLY EQUAL 0)
        message(FATAL_ERROR
            "Unable to add the native name-watcher readiness marker.\n"
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_APPLY_OUTPUT}"
            "${RESHAPE_INJECTOR_NAME_WATCHER_READY_PATCH_APPLY_ERROR}"
        )
    endif()
endif()

# Binding is terminal over the complete pinned historical stack for both widths.
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply --check
        "${RESHAPE_INJECTOR_PROCESS_INSTANCE_BINDING_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_BINDING_CHECK
)
if(NOT RESHAPE_BINDING_CHECK EQUAL 0)
    message(FATAL_ERROR "Pinned process-instance binding patch cannot apply.")
endif()
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply
        "${RESHAPE_INJECTOR_PROCESS_INSTANCE_BINDING_PATCH}"
    WORKING_DIRECTORY "${reshade_SOURCE_DIR}"
    RESULT_VARIABLE RESHAPE_BINDING_APPLY
)
if(NOT RESHAPE_BINDING_APPLY EQUAL 0)
    message(FATAL_ERROR "Unable to apply process-instance binding patch.")
endif()

execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply "${RESHAPE_FUTURE_TARGETS_PATCH}" WORKING_DIRECTORY "${reshade_SOURCE_DIR}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply "${RESHAPE_PROCESS_POLICY_PATCH}" WORKING_DIRECTORY "${reshade_SOURCE_DIR}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=true -c core.eol=crlf apply "${RESHAPE_COOPERATIVE_MEMBERS_PATCH}" WORKING_DIRECTORY "${reshade_SOURCE_DIR}" COMMAND_ERROR_IS_FATAL ANY)

ego_apply_owned_late_source_tail("${reshade_SOURCE_DIR}")
ego_apply_first_host_result_source_tail("${reshade_SOURCE_DIR}")
ego_apply_preloaded_addon_source_tail("${reshade_SOURCE_DIR}")
ego_apply_preloaded_first_host_source_tail("${reshade_SOURCE_DIR}")
ego_apply_preload_long_path_source_tail("${reshade_SOURCE_DIR}")
set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
    "${RESHAPE_PRELOAD_LONG_PATH_PATCHED_CONTENT_SHA256}")
ego_apply_adapter_ready_long_path_source_tail("${reshade_SOURCE_DIR}")
set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
    "${RESHAPE_ADAPTER_READY_LONG_PATH_PATCHED_CONTENT_SHA256}")
ego_apply_initial_inspection_recovery_source_tail("${reshade_SOURCE_DIR}")
set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256
    "${RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCHED_CONTENT_SHA256}")

# Fail configuration unless this FetchContent tree is exactly the pinned
# ordered patch stack. This runs independently for the regular and
# native-host and production presets, before CMake generates build targets.
verify_reshade_patched_source("${reshade_SOURCE_DIR}")

add_library(native_input_gate_addon SHARED
    src/native_input_gate_addon.cpp
)

target_compile_features(native_input_gate_addon PRIVATE cxx_std_20)
target_compile_definitions(native_input_gate_addon PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
    ImTextureID=ImU64
)
target_compile_options(native_input_gate_addon PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_include_directories(native_input_gate_addon PRIVATE
    "${reshade_SOURCE_DIR}/include"
    "${imgui_SOURCE_DIR}"
)
set_target_properties(native_input_gate_addon PROPERTIES
    OUTPUT_NAME "native_input_gate_addon"
    PREFIX ""
    SUFFIX "${ELECTRON_GAME_OVERLAY_ADDON_SUFFIX}"
)

add_executable(d3d9_overlay_test_host WIN32
    src/legacy_direct3d_test_host.cpp
    src/input_oracle.hpp
)

target_compile_features(d3d9_overlay_test_host PRIVATE cxx_std_20)
target_compile_definitions(d3d9_overlay_test_host PRIVATE
    EGO_CONTROLLED_D3D9
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
)
target_compile_options(d3d9_overlay_test_host PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_link_libraries(d3d9_overlay_test_host PRIVATE
    d3d9
)

add_custom_command(TARGET d3d9_overlay_test_host POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "$<TARGET_FILE:native_input_gate_addon>"
        "$<TARGET_FILE_DIR:d3d9_overlay_test_host>"
    COMMENT "Copying the ReShade add-on next to the controlled D3D9 host"
)
add_dependencies(d3d9_overlay_test_host native_input_gate_addon)

add_executable(d3d10_overlay_test_host WIN32
    src/legacy_direct3d_test_host.cpp
    src/input_oracle.hpp
)

target_compile_features(d3d10_overlay_test_host PRIVATE cxx_std_20)
target_compile_definitions(d3d10_overlay_test_host PRIVATE
    EGO_CONTROLLED_D3D10
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
)
target_compile_options(d3d10_overlay_test_host PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_link_libraries(d3d10_overlay_test_host PRIVATE
    d3d10
    dxgi
)

add_custom_command(TARGET d3d10_overlay_test_host POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "$<TARGET_FILE:native_input_gate_addon>"
        "$<TARGET_FILE_DIR:d3d10_overlay_test_host>"
    COMMENT "Copying the ReShade add-on next to the controlled D3D10 host"
)
add_dependencies(d3d10_overlay_test_host native_input_gate_addon)

add_executable(d3d11_overlay_test_host WIN32
    src/d3d11_test_host.cpp
    src/input_oracle.hpp
)

target_compile_features(d3d11_overlay_test_host PRIVATE cxx_std_20)
target_compile_definitions(d3d11_overlay_test_host PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
)
target_compile_options(d3d11_overlay_test_host PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_link_libraries(d3d11_overlay_test_host PRIVATE
    d3d11
    dxgi
)

add_custom_command(TARGET d3d11_overlay_test_host POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "$<TARGET_FILE:native_input_gate_addon>"
        "$<TARGET_FILE_DIR:d3d11_overlay_test_host>"
    COMMENT "Copying the ReShade add-on next to the controlled D3D11 host"
)
add_dependencies(d3d11_overlay_test_host native_input_gate_addon)

add_executable(d3d12_overlay_test_host WIN32
    src/d3d12_test_host.cpp
    src/input_oracle.hpp
)

target_compile_features(d3d12_overlay_test_host PRIVATE cxx_std_20)
target_compile_definitions(d3d12_overlay_test_host PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
)
target_compile_options(d3d12_overlay_test_host PRIVATE
    /W4
    /permissive-
    /EHsc
)
target_link_libraries(d3d12_overlay_test_host PRIVATE
    d3d12
    dxgi
)

add_custom_command(TARGET d3d12_overlay_test_host POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "$<TARGET_FILE:native_input_gate_addon>"
        "$<TARGET_FILE_DIR:d3d12_overlay_test_host>"
    COMMENT "Copying the ReShade add-on next to the controlled D3D12 host"
)
add_dependencies(d3d12_overlay_test_host native_input_gate_addon)

if(ELECTRON_GAME_OVERLAY_BUILD_ADDON)
    enable_testing()

    find_program(CARGO_EXECUTABLE cargo REQUIRED)

    add_executable(electron_game_overlay_reshade_manager
        src/electron_game_overlay_reshade_manager.cpp
    )
    target_compile_features(
        electron_game_overlay_reshade_manager
        PRIVATE
        cxx_std_20
    )
    target_compile_definitions(
        electron_game_overlay_reshade_manager
        PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        UNICODE
        _UNICODE
    )
    target_compile_options(
        electron_game_overlay_reshade_manager
        PRIVATE
        /W4
        /permissive-
        /EHsc
    )
    target_link_libraries(
        electron_game_overlay_reshade_manager
        PRIVATE
        bcrypt
    )
    set_target_properties(
        electron_game_overlay_reshade_manager
        PROPERTIES
        OUTPUT_NAME "electron_game_overlay_reshade_manager"
        MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
    )

    set(ELECTRON_TRANSPORT_SOURCE_DIR
        "${CMAKE_CURRENT_SOURCE_DIR}/../electron-overlay-transport"
    )
    set(ELECTRON_TRANSPORT_CARGO_TARGET_DIR
        "${CMAKE_CURRENT_SOURCE_DIR}/../../build/electron-overlay-transport/cargo"
    )
    set(ELECTRON_TRANSPORT_CARGO_LIBRARY
        "${ELECTRON_TRANSPORT_CARGO_TARGET_DIR}/${ELECTRON_TRANSPORT_RUST_TARGET}/release/electron_overlay_transport.lib"
    )
    set(ELECTRON_TRANSPORT_STAGING_DIR
        "${CMAKE_CURRENT_BINARY_DIR}/electron-overlay-transport"
    )
    set(ELECTRON_TRANSPORT_STAGED_LIBRARY
        "${ELECTRON_TRANSPORT_STAGING_DIR}/electron_overlay_transport.lib"
    )

    file(GLOB_RECURSE ELECTRON_TRANSPORT_RUST_SOURCES CONFIGURE_DEPENDS
        "${ELECTRON_TRANSPORT_SOURCE_DIR}/src/*.rs"
    )

    add_custom_command(
        OUTPUT "${ELECTRON_TRANSPORT_STAGED_LIBRARY}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory
            "${ELECTRON_TRANSPORT_STAGING_DIR}"
        COMMAND "${CARGO_EXECUTABLE}" build
            --manifest-path "${ELECTRON_TRANSPORT_SOURCE_DIR}/Cargo.toml"
            --locked
            --release
            --target "${ELECTRON_TRANSPORT_RUST_TARGET}"
            --target-dir "${ELECTRON_TRANSPORT_CARGO_TARGET_DIR}"
        COMMAND "${CMAKE_COMMAND}" -E copy
            "${ELECTRON_TRANSPORT_CARGO_LIBRARY}"
            "${ELECTRON_TRANSPORT_STAGED_LIBRARY}"
        DEPENDS
            "${ELECTRON_TRANSPORT_SOURCE_DIR}/Cargo.toml"
            "${ELECTRON_TRANSPORT_SOURCE_DIR}/Cargo.lock"
            ${ELECTRON_TRANSPORT_RUST_SOURCES}
        WORKING_DIRECTORY "${ELECTRON_TRANSPORT_SOURCE_DIR}"
        COMMENT "Building and staging the Electron overlay transport Rust static library"
        USES_TERMINAL
        VERBATIM
    )

    add_custom_target(electron_overlay_transport_cargo
        DEPENDS "${ELECTRON_TRANSPORT_STAGED_LIBRARY}"
    )

    add_library(electron_overlay_transport STATIC IMPORTED GLOBAL)
    set_target_properties(electron_overlay_transport PROPERTIES
        IMPORTED_LOCATION "${ELECTRON_TRANSPORT_STAGED_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${ELECTRON_TRANSPORT_SOURCE_DIR}/include"
        INTERFACE_LINK_LIBRARIES "kernel32;ntdll;userenv;ws2_32;dbghelp"
    )
    add_dependencies(electron_overlay_transport electron_overlay_transport_cargo)

    add_executable(electron_overlay_transport_abi_smoke
        src/electron_overlay_transport_abi_smoke.cpp
    )
    target_compile_features(electron_overlay_transport_abi_smoke PRIVATE cxx_std_20)
    target_compile_definitions(electron_overlay_transport_abi_smoke PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
    )
    target_compile_options(electron_overlay_transport_abi_smoke PRIVATE
        /W4
        /permissive-
        /EHsc
    )
    target_link_libraries(electron_overlay_transport_abi_smoke PRIVATE
        electron_overlay_transport
    )
    set_target_properties(electron_overlay_transport_abi_smoke PROPERTIES
        MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
    )

    add_library(electron_game_overlay SHARED
        src/electron_game_overlay_addon.cpp
        src/ego_cooperative_registry.hpp
        src/ego_cooperative_input.hpp
        src/ego_cooperative_frame_policy.hpp
        src/ego_preloaded_addon.hpp
    )
    target_compile_features(electron_game_overlay PRIVATE cxx_std_20)
    target_compile_definitions(electron_game_overlay PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        UNICODE
        _UNICODE
        ImTextureID=ImU64
        ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID="${ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID}"
    )
    target_compile_options(electron_game_overlay PRIVATE
        /W4
        /permissive-
        /EHsc
    )
    target_include_directories(electron_game_overlay PRIVATE
        "${reshade_SOURCE_DIR}/include"
        "${imgui_SOURCE_DIR}"
    )
    target_link_libraries(electron_game_overlay PRIVATE
        electron_overlay_transport
    )
    set_target_properties(electron_game_overlay PROPERTIES
        OUTPUT_NAME "electron_game_overlay"
        PREFIX ""
        SUFFIX "${ELECTRON_GAME_OVERLAY_ADDON_SUFFIX}"
        MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
    )

    add_test(
        NAME electron_overlay_transport_abi_smoke
        COMMAND electron_overlay_transport_abi_smoke
    )
endif()
