# Elevated consumers — generation 28 candidate

An application may retain its existing Run as Administrator feature and saved
preference. The SDK does not clear that preference, relaunch the application,
lower its token, request UAC, or elevate a game. The injector inherits the
consumer's token and uses the existing per-application authenticated transport.
No privileged shared broker or elected feature implementation is introduced.

## Authorization

Before module inspection, claims or target mutation, the injector queries its
own process token and the exact retained target handle. It requires equal token
user SIDs and the same nonzero interactive session. Supported ordinary tokens
are unelevated at medium integrity or lower, or elevated at exactly high
integrity. The target may not have higher integrity than the caller. Unknown,
malformed or failed token queries fail closed.

| Caller | Target | Same user/session result |
| --- | --- | --- |
| Unelevated medium | Unelevated medium or lower | Normal lane; optional shared preloading retained |
| Elevated high | Unelevated medium or lower | Private elevated lane |
| Elevated high | Elevated high | Private elevated lane |
| Unelevated medium | Elevated high | Refused; no elevation request |
| Any | Different user/session, session zero, system or inconsistent elevation/integrity | Refused |

Windows process access, exact executable/creation identity, architecture,
ReShade enablement, existing-host preservation and ordinary attachment limits
still apply. Permission to open a target is not permission to replace its
ReShade. `EGO_TARGET_AUTHORIZATION_V1` records both actors, the selected handle
PID, policy phase and Windows error. A refusal emits the strict preflight
`target-authorization-rejected` diagnostic with `injectionStarted=false`.

## Private elevated lane

SDK preparation inspects the actual consumer token through the bundled native
manager only when both validated architecture stamps explicitly declare
`privateElevatedAuthorization:2`; a generation number is not feature proof.
Capability 1 remains readable for ordinary callers, but a high caller requires
capability 2 and its verified private staging implementation.
A high caller gets a newly created private stage with a protected
owner/System DACL and an inheritable high-integrity no-write-up label. The
manager creates that directory securely at birth, binds its actual parent PID
and creation time, and never tightens or repurposes an existing directory.
The helper changes only newly created project-owned staging objects.

The SDK retains the sealed private template's `AddonPath=.`. It omits the
registered preload filename and does not activate or scan the shared per-user
add-on inventory in that target. Registration remains available for ordinary
unelevated consumers; an elevated consumer does not unregister or rewrite it.

Native preflight checks the private directory's canonical identity, owner,
protected DACL, high label, SDK run marker, exact private configuration and
staged EGO build. Unknown add-on scan entries are refused without alteration.
The expected runtime, add-on and configuration hashes travel from the validated calling SDK in the native
request; the injector hashes its pinned images against those values. A writable
shared-cache alias cannot supply a new expected digest or change the consumed
bytes between this check and the load.
All thirteen staged payload files are exclusively reserved by the native helper
at high integrity with explicit caller ownership, then filled with verified
bytes. The helper does not use an administrator token's default group owner.
They have no hard-link aliases into the medium snapshot. Before
public `prepare()` returns, the native manager reads back every file's canonical
identity, single-link status, owner/System access list, high no-write-up label,
and expected package hash. The directory must retain its protected owner/System
access list and inheritable high label. This verification changes no files.
The configuration and selected EGO/ReShade images also stay pinned against
writes and deletion while loading begins.

Only two fixed data leaves are precreated with a medium label so a medium
target can write observability data: `ReShade.log` and
`.electron-game-overlay-runtime-startup.json`. They do not select code or grant
ownership. Code, configuration, namespace creation and SDK control markers
remain protected. A later medium app cannot rewrite a high stage to reclaim
it; authoritative cleanup is performed by its owning high application.
The manager creates these leaves with inherited high security, then changes
only `LABEL_SECURITY_INFORMATION` through the exclusively created file handle
using `WRITE_OWNER`, and reads the medium label back. It never requests a
protected/full SACL, enables a privilege, or changes an OS security policy.

Each app still supplies its own native engine and private transport. Existing
mapped ReShade and cooperative participants are reused according to the normal
ownership contract. Possibly consumed initialization ownership remains pinned
until authoritative target exit; app shutdown, disconnect, registry updates or
timeouts never authorize another ReShade injection.

An existing user-managed ReShade installation retains its runtime, configuration,
presets, effects and foreign add-ons. Its exact target configuration and disable
rules remain authoritative. Only the existing native transaction helper may
change the reserved project-owned installation artifacts.

## Context API and optional replacement API

`inspectOverlayConsumerExecutionContext()` now reports `overlaySupported=true`
for an ordinary interactive high caller as well as an eligible unelevated
caller. This is caller eligibility, not target authorization or proof of
rendering/input. Generation-26's high-to-medium Node test proved only the
explicit `launchUnelevatedOverlayConsumer` capability; it did not establish
elevated overlay support.

`launchUnelevatedOverlayConsumer` remains an explicit optional API. Overlay
preparation does not call it. Its child creation result is not an application
readiness or graphics proof. Applications supporting administrator mode should
retain their own preference and startup behavior.

## Verification boundaries

`scripts/test-cases/elevated-private-authorization-console.ps1` has its own
human-facing launcher. It queries real owned process tokens and tests pure
policy cases for high/medium combinations, user/session mismatch, unsupported
integrity, incomplete evidence and invalid handles. From an already high
caller, `-RequireElevated` additionally creates and inspects the actual protected
private stage. It never requests UAC, opens a user game, invokes the injector
entrypoint, or runs graphics. SDK staging tests separately assert that the app
is not relaunched and shared registration bytes remain unchanged.

Actual elevated Izabela rendering/input and same-user medium/high target
acceptance are separate consumer gates. A console or token-policy pass does
not establish those results. The coordinating consumer chat owns graphics and
any human-approved UAC launch.

`scripts/test-cases/elevated-public-prepare-console.ps1` separately requires an
already high caller and exercises actual public `prepare()`, all thirteen
private payload files, label readback, changed-hash and hard-link rejection,
and the unchanged caller token. It starts no target or injector. This headless
gate is separate from actual elevated overlay acceptance.

The security descriptor uses Microsoft's documented
[file/directory security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights),
[mandatory integrity labels](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control),
and [SDDL ACE syntax](https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-strings).
