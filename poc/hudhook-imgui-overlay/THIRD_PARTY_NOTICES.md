# Third-party notices for the hudhook POC

This proof of concept statically links third-party Rust and native code. Its exact dependency versions are recorded in `Cargo.lock`.

The primary components are:

- [`hudhook` 0.9.1](https://github.com/veeenu/hudhook/tree/0.9.1), MIT License.
- [`imgui-rs` 0.12.0](https://github.com/imgui-rs/imgui-rs/tree/v0.12.0), MIT OR Apache-2.0.
- [Dear ImGui](https://github.com/ocornut/imgui), MIT License, bundled through `imgui-rs`.
- [MinHook](https://github.com/TsudaKageyu/minhook), 2-Clause BSD License, vendored by `hudhook`.
- Hacker Disassembler Engine 32/64, 2-Clause BSD-style licenses, vendored with MinHook by `hudhook`.

The MinHook/HDE binary-redistribution notice is reproduced below. Before redistributing POC binaries outside the repository, generate and review a complete license inventory for every transitive crate in `Cargo.lock`.

## MinHook

> MinHook - The Minimalistic API Hooking Library for x64/x86
> Copyright (C) 2009-2017 Tsuda Kageyu. All rights reserved.
>
> Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Portions of MinHook include Hacker Disassembler Engine 32/64 code copyright (c) 2008-2009 Vyacheslav Patkov, distributed under the same redistribution conditions and warranty disclaimer.
