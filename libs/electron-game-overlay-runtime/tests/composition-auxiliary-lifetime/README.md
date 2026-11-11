# Auxiliary layered-bit lifetime regression

Run the individual `composition-auxiliary-lifetime-console.ps1` launcher for x64
or x86. Exact generation-34 and generation-35 headers run over owned offscreen
windows. No game, activation, keyboard or pointer input runs.

Both policies initially exclude the captured layered popup/tool/topmost shape
without NOACTIVATE. Generation 34 admits it after removing LAYERED and refuses
the main binding. Generation 35 retains that already-observed auxiliary lifetime
over 32 layered-bit transitions and hide/show cycles, while accepting a newly
observed unlayered tool as a sole presenter or an ambiguous genuine peer.
APPWINDOW/style and lifetime-token invalidation revoke the remembered state.
LastError, foreground and the main window's existing lifetime token are checked.

The separate source-cache launcher exercises actual CMake tail helpers over an
isolated 26-file synthetic Git fixture. Real graphics/input testing uses the
paired source host and `--composition-swapchain --noninteractive-tool-popup`;
see `doc/composition-auxiliary-lifetime.md` for its marker contract. Actual PAGER
Close-hover and normal-startup acceptance remain separate requirements.
