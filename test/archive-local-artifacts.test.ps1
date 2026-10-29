# Windows PowerShell 5.1/7：验证归档在占用失败时不会拆散目录。
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$taskFixture = Join-Path $taskTemp ('apix-archive-test-' + [guid]::NewGuid().ToString('N'))
$taskTool = Join-Path $taskFixture 'scripts/maintenance/archive-local-artifacts.ps1'
$taskLock = $null
try {
    New-Item -ItemType Directory -Path (Split-Path $taskTool),
        (Join-Path $taskFixture '.tmp-desktop'), (Join-Path $taskFixture '.tmp-fixture') | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskRoot 'scripts/maintenance/archive-local-artifacts.ps1') -Destination $taskTool
    Set-Content -LiteralPath (Join-Path $taskFixture '.tmp-fixture/a.txt') 'evidence'
    Set-Content -LiteralPath (Join-Path $taskFixture '.tmp-fixture/b.txt') 'locked'
    Set-Content -LiteralPath (Join-Path $taskFixture '.tmp-fixture.log') 'log'
    $taskHash = (Get-FileHash -LiteralPath (Join-Path $taskFixture '.tmp-fixture/a.txt')).Hash
    & $taskTool -WhatIf | Out-Null
    if (Test-Path -LiteralPath (Join-Path $taskFixture '.tmp')) { throw 'WhatIf wrote files' }

    $taskLock = [IO.File]::Open((Join-Path $taskFixture '.tmp-fixture/b.txt'),
        [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    & powershell -NoProfile -File $taskTool | Out-Null
    if ($LASTEXITCODE -ne 1) { throw 'Locked directory should fail' }
    foreach ($taskName in @('a.txt', 'b.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $taskFixture ".tmp-fixture/$taskName"))) {
            throw 'Locked move split directory'
        }
    }
    $taskJournal = Get-ChildItem -LiteralPath (Join-Path $taskFixture '.tmp/maintenance') -Filter '*.json' | Select-Object -First 1
    $taskRecords = Get-Content -LiteralPath $taskJournal.FullName -Raw | ConvertFrom-Json
    $taskFailed = @($taskRecords | Where-Object status -eq 'failed')
    if ($taskFailed.Count -ne 1 -or (Test-Path -LiteralPath (Join-Path $taskFixture $taskFailed[0].target))) {
        throw 'Failed move journal or target is invalid'
    }
    $taskLock.Dispose(); $taskLock = $null
    $taskResult = & $taskTool
    if ($taskResult.Moved -ne 1 -or $taskResult.Failed -ne 0) { throw 'Retry mismatch' }
    if ((Get-FileHash -LiteralPath (Join-Path $taskResult.Archive '.tmp-fixture/a.txt')).Hash -ne $taskHash) {
        throw 'Evidence hash changed'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $taskFixture '.tmp-desktop'))) { throw 'Desktop output moved' }
    if ((& $taskTool).Moved -ne 0) { throw 'Second run should be empty' }
    Write-Output 'PASS: WhatIf, atomic failure, journal, retry, SHA256, desktop retention, repeated no-op'
} finally {
    if ($taskLock) { $taskLock.Dispose() }
    $taskResolved = [IO.Path]::GetFullPath($taskFixture)
    if (-not $taskResolved.StartsWith($taskTemp, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $taskResolved -Leaf) -notlike 'apix-archive-test-*') { throw 'Unsafe fixture cleanup path' }
    if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force }
}
