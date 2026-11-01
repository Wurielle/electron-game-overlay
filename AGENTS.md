# Repository Instructions

- Never auto-commit at the end of your turn unless the user asked you to.
- Use Conventional Commits for commit messages.
- Keep each human-facing production overlay runtime test case available through its own launcher under `libs/electron-game-overlay-runtime/scripts/test-cases`; parameterized runners may remain internal automation.
- The demo Steam auto-attacher must baseline already-running processes without treating them as creation events, then attempt every newly detected `.exe` under `steamapps` independently; do not add executable plausibility heuristics or helper-name exclusions.
- Existing ReShade installations are fail-closed: never replace or rewrite their runtime/proxy, INI, presets, effects, or foreign add-ons. Only the project-owned native transaction helper may mutate the reserved Electron Game Overlay add-on, marker, journal, and verified backups.
- Resolve official ReShade paths and enablement from the exact target process and its configuration; never substitute the Electron process environment.
- Bump the official ReShade add-on build ID whenever its mapped implementation changes; the injector and package manifest must stay exact so stale ABI-compatible add-ons cannot be accepted.

## Multi-application implementation contract

- The user authorized a clean rewrite on 2026-11-01: no users require migration from the unreleased broker implementation. Read `doc/cooperative-addons.md` before changing the new architecture. The requirements below in the historical broker contract describe that older implementation; its election, single EGO feature-engine, catalog and frozen-wire migration requirements do not constrain the authorized replacement.
- Each app/version owns its native feature implementation and private transport. Preserve one ReShade initialization/ownership boundary, per-window cross-app order/input coordination, and surviving applications after another app exits or crashes. Never replace this with an elected EGO implementation that serves all apps' features.
- Preserve every overlay feature and required real-game E2E behavior. Keep native protocol/socket fixtures distinct from actual game acceptance, and never relabel synthetic input as the physical-key gate.
- The cooperative ABI must use explicit size/versioned fixed-layout POD and owned callback/handle boundaries; never share private C++ layouts or allocator ownership across SDK versions.
- Retain possibly consumed ReShade initialization ownership until authoritative target exit. Application shutdown, socket loss, timeouts and registry changes are not target exit or permission to inject another ReShade.

## Historical broker contract

- Read `doc/multi-application-broker.md` before changing broker discovery, election, protocol, routing, recovery, or compatibility tests. Its product contract is mandatory; its explicitly planned features are not claims of current implementation.
- Independent applications using different EGO versions must coexist on the same exact game process without coordinated application upgrades. Preserve one shared target communication/runtime ownership path, per-application window/input isolation, and continued operation when another app exits or crashes. Never reduce this to same-version-only support.
- Keep the broker/bootstrap core small, focused, stable, and backward compatible. It coordinates discovery, ownership, version negotiation, routing, and recovery; do not turn it into a UI, application-logic, or game-specific feature host.
- The highest eligible compatible runtime generation registered within the bounded election window wins. Freeze ownership once target-route publication may have begun; later arrivals, including newer versions, join without preempting or reinjecting. Distinguish the broker coordinator from the elected native-runtime provider.
- Preserve frozen v1 wire/capability and recovery-claim meanings. Add functionality through backward-compatible APIs and negotiated optional capabilities, not a new mandatory handshake field, package-version equality check, or independent version-specific owner for the same game.
- Optional advance registration is an additional discovery failsafe, never a prerequisite. Its shared per-user registry must let a catalog-aware bootstrap find the highest eligible registered standalone implementation while its supplying app is stopped. Normal unregistered startup must still work. Preserve the schema-1 catalog and distribution-manifest meanings, keep candidate discovery deadline-aware, and never let stale metadata override committed ownership.
- Coordinator startup is not native-injection ownership. The fixed OS-exclusive listener and durable target claims serve different purposes; do not turn an uncertain launcher PID or stale startup journal into a permanent startup prerequisite. Never execute per-user registered code with elevated privileges.
- Cached native providers must participate without adding a required v1 client field. Resolve missing executable identity through an authoritative read-only OS query before publication. Report post-grant attachment failures to pending callers while retaining possibly consumed claims and allowing later authentication; logging only to a detached process's stderr is insufficient.
- Never infer process exit from application shutdown, socket loss, registry changes, or timeouts. Preserve possibly consumed ownership until authoritative target exit; fallback is allowed only when proven not to duplicate an existing or indeterminate injection.
- Broker changes require mixed-version/startup-order, late-join, isolation, owner-failure/recovery, and single-injection regression coverage appropriate to the changed contract. Keep simulated load tests separate from actual mixed-package and Windows acceptance; the 500-app/500-version scenario is a design goal, not a measured capacity claim.
