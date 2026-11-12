#define wmain production_manager_main
#include "../../src/electron_game_overlay_reshade_manager.cpp"
#undef wmain

void require(bool condition, const char *message)
{
    if (!condition) throw std::runtime_error(message);
}

void verify_descriptor(const consumer_token_context &token, bool directory)
{
    const auto descriptor = private_storage_descriptor(token, directory);
    PSID owner = nullptr;
    BOOL defaulted = FALSE, present = FALSE;
    require(GetSecurityDescriptorOwner(descriptor.get(), &owner, &defaulted) &&
        EqualSid(owner, const_cast<BYTE *>(token.sid.data())), "wrong cache descriptor owner");
    SECURITY_DESCRIPTOR_CONTROL control{};
    DWORD revision = 0;
    require(GetSecurityDescriptorControl(descriptor.get(), &control, &revision) &&
        (control & SE_DACL_PROTECTED), "unprotected cache access list");
    PACL dacl = nullptr;
    require(GetSecurityDescriptorDacl(descriptor.get(), &present, &dacl, &defaulted) &&
        present && dacl && dacl->AceCount == 2, "wrong cache access grants");
    const BYTE flags = directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
    unsigned system_count = 0, owner_count = 0;
    for (DWORD index = 0; index < dacl->AceCount; ++index)
    {
        void *raw = nullptr;
        require(GetAce(dacl, index, &raw), "unable to read access grant");
        const auto *ace = static_cast<const ACCESS_ALLOWED_ACE *>(raw);
        const auto sid = const_cast<DWORD *>(&ace->SidStart);
        require(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == flags &&
            ace->Mask == FILE_ALL_ACCESS, "invalid cache access grant");
        if (IsWellKnownSid(sid, WinLocalSystemSid)) ++system_count;
        if (EqualSid(sid, owner)) ++owner_count;
    }
    require(system_count == 1 && owner_count == 1, "cache grants access beyond owner and System");
    PACL labels = nullptr;
    require(GetSecurityDescriptorSacl(descriptor.get(), &present, &labels, &defaulted) &&
        present && labels && labels->AceCount == 1, "missing cache mandatory label");
    void *raw = nullptr;
    require(GetAce(labels, 0, &raw), "unable to read cache mandatory label");
    const auto *label = static_cast<const SYSTEM_MANDATORY_LABEL_ACE *>(raw);
    const auto sid = const_cast<DWORD *>(&label->SidStart);
    require(label->Header.AceType == SYSTEM_MANDATORY_LABEL_ACE_TYPE && label->Header.AceFlags == flags &&
        label->Mask == SYSTEM_MANDATORY_LABEL_NO_WRITE_UP && IsWellKnownSid(sid, WinHighLabelSid),
        "wrong high no-write-up cache label");
}

int wmain(int argc, wchar_t **argv)
{
    try
    {
        require(argc == 2, "expected the owned fixture directory");
        const auto token = read_consumer_token(GetCurrentProcess(), "cache-acl-fixture");
        verify_descriptor(token, false);
        verify_descriptor(token, true);
        bool refused = false;
        try { open_private_cache_directory(argv[1], token, nullptr); }
        catch (const manager_error &) { refused = true; }
        require(refused, "an ordinary directory passed protected cache verification");
        printf("EGO_PROTECTED_CACHE_ACL_PASSED {\"descriptorChecks\":2,\"ordinaryDirectoryRefused\":true,\"actualIntegrity\":%lu}\n", token.integrity);
        return 0;
    }
    catch (const std::exception &error)
    {
        fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
