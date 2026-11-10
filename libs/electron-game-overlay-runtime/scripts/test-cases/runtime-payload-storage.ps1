$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot '..\measure-runtime-payload-storage.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Runtime payload storage gate failed.' }
