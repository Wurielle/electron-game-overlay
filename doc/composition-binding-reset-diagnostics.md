# Composition binding and reset diagnostics

Generation 33 adds observation to the generation-32 owned host. It does not
change window eligibility, binding retention, ambiguity refusal, lifetime-token
validation, reset decisions, forwarding, configuration handling or permissions.
The feature add-on and manager implementations remain unchanged. The raw
diagnostic patch, full 26-file source vector and both architecture manifests
bind the implementation exactly.

The first actual high-PAGER 1009 run reset and recreated the same final runtime
six times, without corresponding new swap-chain creation, ResizeBuffers or
color-space calls. A separate 120-second high retry passed first/reopen keys and
resize with one eligible window and a stable token. That retry does not explain
the earlier failure. The controlled actual DirectComposition pair also passed.
No owned-popup, class-name or lifetime-policy fix is justified by those samples.

## Exact rejection point

`EGO_OWNED_COMPOSITION_BINDING_V1` records an existing binding's first rejection
in each reason state and its recovery. Initial unbound admission deferral stays
quiet. Reasons distinguish uniqueness, enumeration failure, unavailable candidate,
a different HWND, a different thread and a different lifetime token.

The record includes the binding identity, bound HWND, first/last eligible
candidates, candidate owners/style flags, expected/observed thread and token,
current bound visibility/root state, eligible count and enumeration completion.
It adds no class/title/path preference. UTC FILETIME and PID/thread identify the
sample for correlation with the external read-only window inventory. The
inventory remains useful for classifying windows but samples every 16 ms; this
native record is taken at the actual rejection decision.

Only changes of reason consume the global 24-attempt binding budget. Repeated
identical rejection and an exhausted budget perform no logging or additional
metadata reads. Logging errors are caught, and `GetLastError` is preserved.

## Reset call sites

`EGO_OWNED_RUNTIME_RESET_V1` labels each initialized reset as destruction,
ResizeBuffers, ResizeBuffers1, color-space change, composition activation or
composition binding becoming unavailable. It records cached proxy/native/impl
identities and resize/composition flags before teardown. It performs no COM
calls, callbacks or new GPU/hook lock acquisition. Its separate global budget is
24 attempts. An inactive foreign host emits neither record type.

Pair a binding rejection with the following reset label and runtime teardown.
An unavailable-binding reset with no rejection record must be interpreted with
the budget and initial-admission rules; do not infer a particular rejected
window. A normal reset label and new-chain creation must remain distinct from
unexplained same-runtime churn. A capture with no churn is a nonreproducing run.

## Verification and acceptance

The console fixture compiles the exact 1009 baseline header and the new header
against the same owned offscreen-window sequence and compares every decision.
It exercises real ambiguity, visibility, thread, HWND and token controls, a
read-only enumeration-error seam, the extracted exact logger/reset prefix,
throwing logging and both exhausted budgets. The actual production lifecycle,
Present forwarding, INI cache, process exit query and source-cache gates remain
separate. None establishes physical-key or actual game acceptance.

Use a complete new diagnostic SDK candidate for fresh root-owned high-PAGER
lifetimes. Preserve 1009 and its failed/stable samples. Capture both new record
types, the whole ReShade log, exact PID/birth and external inventory through the
first UI opening and reopen/resize. Apply a behavior correction only after the
observed rejection/reset reason and a matching generic owned reproduction
support it. No sleep, retry, permissive window heuristic or permission change
is introduced by this candidate.
