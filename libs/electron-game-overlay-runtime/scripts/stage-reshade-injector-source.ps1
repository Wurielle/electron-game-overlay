[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ($output.Equals($source, [StringComparison]::OrdinalIgnoreCase) -or
    $output.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $source.StartsWith($output.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Stage the injector outside the pinned ReShade source directory."
}
$patch = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\patches\reshade-injector-policy-stdin.patch")).Path
$cachePatch = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\patches\reshade-injector-cache-bootstrap.patch")).Path
$sourceLeaf = "tools\injector.cpp"
$beforeHash = "7A6DC34363FF8EBD78484D8AEE6CE0463F22E90AB35DD1261FC9FBD9B09A3A3E"
$afterHash = "D6CA0095198F8A15668E34CC80F9A43AFC7C1D2960FBFB4C9BCFAD3368CC5C3C"
$patchHash = "8997956192A384FE83D6E8470D63E8BFBE02D7973469E8ACFD1BE6ECB5269111"
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$inputText = [IO.File]::ReadAllText((Join-Path $source $sourceLeaf), $utf8).Replace("`r`n", "`n")
$normalized = $utf8.GetBytes($inputText)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $inputHash = [BitConverter]::ToString($sha256.ComputeHash($normalized)).Replace('-', '')
} finally {
    $sha256.Dispose()
}
if ($inputHash -cne $beforeHash -or (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash -cne $patchHash) {
    throw "Unexpected pinned injector source or policy-input patch hash."
}

New-Item -ItemType Directory -Force -Path (Join-Path $output "tools"), (Join-Path $output "deps") | Out-Null
$headers = [ordered]@{
    '..\src\ego_runtime_cache_bootstrap.hpp' = '39F0CD25DABAA8F43DF5FF58BF0AA291B5C102A2EDA4822EC2CCF602C4714BC5'
    '..\src\ego_runtime_cache_lease.hpp' = '56F79613E7937AB89B6791FE4E664E1C2154D2EF5F93BB55E9A595CA77A2D121'
    '..\..\electron-overlay-transport\include\electron_overlay_transport.h' = '74198AA0A64E72A09FF225284044D7FE26C387BD8672F1D05A3C3EC116B59959'
}
$headerLeaves = @($headers.Keys | ForEach-Object { Join-Path 'tools' (Split-Path -Leaf $_) })
foreach ($leaf in @('', 'tools', 'deps', 'tools\injector.cpp', 'ReShadeInject.vcxproj', 'Common.props', 'deps\Windows.props') + $headerLeaves) {
    $destination = if ($leaf) { Join-Path $output $leaf } else { $output }
    $item = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing a reparse point in the injector build stage: $destination"
    }
}
foreach ($leaf in @("ReShadeInject.vcxproj", "Common.props", "deps\Windows.props")) {
    Copy-Item -LiteralPath (Join-Path $source $leaf) -Destination (Join-Path $output $leaf)
}
$stagedSource = Join-Path $output $sourceLeaf
[IO.File]::WriteAllBytes($stagedSource, $normalized)
& cmake.exe -E env --unset=GIT_DIR --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE `
    "GIT_CEILING_DIRECTORIES=$(Split-Path -Parent $output)" `
    git.exe -C $output -c core.autocrlf=false -c core.eol=lf apply $patch
if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $stagedSource -Algorithm SHA256).Hash -cne $afterHash) {
    throw "Could not stage the pinned policy-input injector implementation."
}
$injectorText = [IO.File]::ReadAllText($stagedSource, $utf8).Replace(
    '"CCE20935ADD44EF6A5A7973014B2E07F"', '"D61AF72954C64C77A5FA6FF30F57AF13"')
[IO.File]::WriteAllText($stagedSource, $injectorText, $utf8)
if ((Get-FileHash -LiteralPath $stagedSource -Algorithm SHA256).Hash -cne "D6CD0796B512CDF55AF09FF2D7511A477A847CC33CA40B950F449251CA0EB312") {
    throw "Could not stage the injector with the exact mapped add-on build ID."
}

if ((Get-FileHash -LiteralPath $cachePatch -Algorithm SHA256).Hash -cne "708EF9AA8824580E74C999131CF353B62B955421E0A93078E800D2927F74B5EF") {
    throw "Unexpected injector cache bootstrap patch hash."
}
foreach ($entry in $headers.GetEnumerator()) {
    $body = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $entry.Key), $utf8).Replace("`r`n", "`n")
    $bytes = $utf8.GetBytes($body)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '') }
    finally { $hasher.Dispose() }
    if ($hash -cne $entry.Value) { throw "Unexpected injector cache bootstrap header hash: $($entry.Key)" }
    [IO.File]::WriteAllBytes((Join-Path $output (Join-Path 'tools' (Split-Path -Leaf $entry.Key))), $bytes)
}
& cmake.exe -E env --unset=GIT_DIR --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE `
    "GIT_CEILING_DIRECTORIES=$(Split-Path -Parent $output)" `
    git.exe -C $output -c core.autocrlf=false -c core.eol=lf apply $cachePatch
if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $stagedSource -Algorithm SHA256).Hash -cne "E98D227525DF1C18C1FA6F4ECA9E5B454689EB80B4DB0DD938AF1AA2CEC52AD4") {
    throw "Could not stage the pinned cache bootstrap injector implementation."
}
$elevatedCachePatch = Join-Path $PSScriptRoot '..\patches\reshade-injector-elevated-cache.patch'
if ((Get-FileHash -LiteralPath $elevatedCachePatch -Algorithm SHA256).Hash -cne '2169F9131F3BBC10D5D5BDC2FB7B0973E7D531B1391A65C171DE1D91544D044E') {
    throw 'Unexpected protected elevated cache injector patch hash.'
}
& cmake.exe -E env --unset=GIT_DIR --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE `
    "GIT_CEILING_DIRECTORIES=$(Split-Path -Parent $output)" `
    git.exe -C $output -c core.autocrlf=false -c core.eol=lf apply $elevatedCachePatch
if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $stagedSource -Algorithm SHA256).Hash -cne 'F817A7DF8EE6A9C6011786ACB18FE2767A3C62E06CFB3EC3C23305DA85E800B8') {
    throw 'Could not stage the pinned protected elevated cache injector implementation.'
}
$cachePreloadPatch = Join-Path $PSScriptRoot '..\patches\reshade-injector-cache-preload.patch'
if ((Get-FileHash -LiteralPath $cachePreloadPatch -Algorithm SHA256).Hash -cne '4F24691BB837C1C84A9C919331B82C187DEA9562545414FC36D1B3F96974C67E') {
    throw 'Unexpected registered add-on cache injector patch hash.'
}
& cmake.exe -E env --unset=GIT_DIR --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE `
    "GIT_CEILING_DIRECTORIES=$(Split-Path -Parent $output)" `
    git.exe -C $output -c core.autocrlf=false -c core.eol=lf apply $cachePreloadPatch
if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $stagedSource -Algorithm SHA256).Hash -cne '27B94E939EA2CFE1805272B51D1FF613EEA8A4322352300A11641B81046B9609') {
    throw 'Could not stage the pinned registered add-on cache injector implementation.'
}
$cacheOfficialPatch = Join-Path $PSScriptRoot '..\patches\reshade-injector-cache-official.patch'
if ((Get-FileHash -LiteralPath $cacheOfficialPatch -Algorithm SHA256).Hash -cne '6523409BF4DF938278B217C2141619FD52836A159C132FDF93C321575A36F451') {
    throw 'Unexpected official cache inspection injector patch hash.'
}
& cmake.exe -E env --unset=GIT_DIR --unset=GIT_WORK_TREE --unset=GIT_INDEX_FILE `
    "GIT_CEILING_DIRECTORIES=$(Split-Path -Parent $output)" `
    git.exe -C $output -c core.autocrlf=false -c core.eol=lf apply $cacheOfficialPatch
if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $stagedSource -Algorithm SHA256).Hash -cne '332B9F81DA2C3EEB944F3B4D75FEAC3ACE02B6903676AC1A2EB486812F69756D') {
    throw 'Could not stage the pinned official cache inspection injector implementation.'
}
