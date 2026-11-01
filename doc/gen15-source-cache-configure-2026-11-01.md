# Generation 15 source-cache configure verification

The complete production CMake project configured successfully from an exact generation-15 source cache and from a clean pinned ReShade checkout. Repeating each configure also passed. These four checks include the historical patch stack and final 19-file source verification; they are separate from the helper-only unit tests.

The integration exposed two build-pipeline defects: raw CRLF patches did not match the normalized LF files produced by late-tail peeling, and long execution-copy names exceeded Windows Git path limits. CMake now applies independently hash-checked LF copies through short paths bounded to 240 characters. The fixes preserve original patch files, their provenance meanings, all historical source identities and the frozen mapped runtime source.

The failed canonical cache was restored only after its pinned commit, complete known pre-late/absent vector, exact Git path set and every raw preimage matched the retained snapshot. The final 19-file vector and raw copied payloads were verified after recovery. No unknown source edits were accepted or replaced.

The [portable evidence](evidence/gen15-source-cache-configure-2026-11-01.json) retains commands, output, source/patch hashes and recovery provenance. The original working artifacts are under `build/gen15-fullconfigure-regression-5aba5224-23ee-4e0a-8df7-e4b615355d73`.

These checks invoked configuration and compiler detection only; they did not build/load the overlay runtime or launch a game. The normal Nx build, sealed SDK verification and actual game acceptance remain separate checks.
