#include <Windows.h>
#include <cstdio>
#include <string>

int wmain(int argc, wchar_t **argv)
{
    if (argc != 3) return 1;
    const std::wstring source = argv[1], root = argv[2];
    // The launcher supplies a fresh UUID-owned directory. Never overwrite paths.
    if (!CreateDirectoryW(root.c_str(), nullptr)) return 2;
    for (const wchar_t *child : { L"a", L"b", L"linked" })
        if (!CreateDirectoryW((root + L"\\" + child).c_str(), nullptr)) return 2;
    const auto a = root + L"\\a\\member.dll", b = root + L"\\b\\member.dll", linked = root + L"\\linked\\member.dll";
    if (!CopyFileW(source.c_str(), a.c_str(), TRUE) || !CopyFileW(source.c_str(), b.c_str(), TRUE) ||
        !CreateHardLinkW(linked.c_str(), a.c_str(), nullptr)) return 3;
    HMODULE ma = LoadLibraryW(a.c_str()), mb = LoadLibraryW(b.c_str()), ml = LoadLibraryW(linked.c_str());
    if (ma == nullptr || mb == nullptr || ml == nullptr) return 4;
    const auto counter = [](HMODULE module) { return reinterpret_cast<int *>(GetProcAddress(module, "ElectronGameOverlayIdentityProbeCounter")); };
    int *ca = counter(ma), *cb = counter(mb), *cl = counter(ml);
    if (ca == nullptr || cb == nullptr || cl == nullptr) return 5;
    *ca = 91;
    const bool isolated = ma != mb && ca != cb && *cb == 0;
    const bool merged_control = ma == ml && ca == cl && *cl == 91;
    FreeLibrary(ml); FreeLibrary(mb); FreeLibrary(ma);
    // Unload before deleting only these newly created fixture images.
    if (!DeleteFileW(linked.c_str()) || !DeleteFileW(a.c_str()) || !DeleteFileW(b.c_str())) return 6;
    for (const wchar_t *child : { L"a", L"b", L"linked" })
        if (!RemoveDirectoryW((root + L"\\" + child).c_str())) return 6;
    if (!RemoveDirectoryW(root.c_str())) return 6;
    printf("EGO_PRIVATE_IMAGE_IDENTITY copiesIsolated=%s hardlinksMerged=%s graphics=false\n", isolated ? "true" : "false", merged_control ? "true" : "false");
    return isolated && merged_control ? 0 : 7;
}
