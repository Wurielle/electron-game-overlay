// Compile the production helper functions directly. The renamed injector entry
// point is never called; this executable performs only token/session queries.
#define wmain ego_unused_injector_entry
#include EGO_INJECTOR_SOURCE
#undef wmain

int wmain()
{
    DWORD current = 0;
    if (process_token_session_id(GetCurrentProcess(), current) != ERROR_SUCCESS) return 1;
    bool mismatch = true;
    if (require_same_process_session(GetCurrentProcess(), mismatch) != ERROR_SUCCESS || mismatch) return 2;
    const DWORD query_error = require_same_process_session(nullptr, mismatch);
    if (query_error == ERROR_SUCCESS || mismatch) return 3;
    if (compare_process_sessions(current, current ^ 1u, mismatch) != ERROR_ACCESS_DENIED || !mismatch) return 4;
    if (compare_process_sessions(current, current, mismatch) != ERROR_SUCCESS || mismatch) return 5;
    std::printf("{\"schemaVersion\":1,\"sameTokenSessionAccepted\":true,"
        "\"invalidTargetQueryFailedClosed\":true,\"differentSessionPolicyRejected\":true}\n");
    return 0;
}
