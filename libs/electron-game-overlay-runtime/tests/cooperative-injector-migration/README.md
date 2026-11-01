# Injector source-cache migration fixture

`fixtures/pre-cooperative-injector.cpp.txt` is an immutable, noncompiled input
for the isolated CMake migration tests. It retains the ReShade source copyright
and license header. Its base is pinned ReShade commit
`4a50d1eddace85734871d91792ff214f13f66c01`, with the project's historical
pre-cooperative injector patches and build ID
`12EE788081A34E00B10862242DF38893` already applied.

Normalized SHA-256:
`E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359`.

Tests reconstruct genuine gen8–11 v3 bodies from this independently pinned input
and the tracked frozen v3 patch. The current v4 body is reconstructed separately.
No mutable build cache or authoring directory supplies required test inputs.
This fixture is not compiled, installed, shipped in the SDK, or used by the
production migration helper.
