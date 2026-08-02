# Repository Instructions

- Never auto-commit at the end of your turn unless the user asked you to.
- Use Conventional Commits for commit messages.
- Keep each human-facing production overlay runtime test case available through its own launcher under `libs/electron-game-overlay-runtime/scripts/test-cases`; parameterized runners may remain internal automation.
- The demo Steam auto-attacher must attempt every detected `.exe` under `steamapps` independently; do not add executable plausibility heuristics or helper-name exclusions.
- Existing ReShade installations are fail-closed: never replace or rewrite their runtime/proxy, INI, presets, effects, or foreign add-ons. Only the project-owned native transaction helper may mutate the reserved Electron Game Overlay add-on, marker, journal, and verified backups.
- Resolve official ReShade paths and enablement from the exact target process and its configuration; never substitute the Electron process environment.
- Bump the official ReShade add-on build ID whenever its mapped implementation changes; the injector and package manifest must stay exact so stale ABI-compatible add-ons cannot be accepted.
