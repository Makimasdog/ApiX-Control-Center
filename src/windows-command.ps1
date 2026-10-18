param([string]$JobName,[switch]$Inspect,[switch]$Terminate,[int]$OwnerPid=0,[string]$OwnerBirth='')
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-command.cs') -Raw)
if($Inspect){[ApiXCommandJob]::Inspect($JobName,$Terminate.IsPresent,$OwnerPid,$OwnerBirth);exit}
$config=[Console]::In.ReadLine() | ConvertFrom-Json
if($null -eq $config){exit 1}
[ApiXCommandJob]::Run($JobName,[string]$config.executable,[string[]]$config.args,[string]$config.cwd,[int]$config.timeoutMs)
