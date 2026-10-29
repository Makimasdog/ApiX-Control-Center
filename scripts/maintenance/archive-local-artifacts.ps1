# 本机临时产物只归档，不删除；桌面构建目录保持原位。
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$taskArchive = [IO.Path]::GetFullPath((Join-Path $taskRoot ".tmp/archive/$taskStamp"))
$taskJournal = Join-Path $taskRoot ".tmp/maintenance/archive-$taskStamp.json"
$taskPrefix = $taskRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$taskEntries = @(Get-ChildItem -LiteralPath $taskRoot -Force | Where-Object {
    $_.Name.StartsWith('.tmp') -and $_.Name -notin @('.tmp', '.tmp-desktop')
})
$taskResults = @()

foreach ($taskEntry in $taskEntries) {
    $taskSource = [IO.Path]::GetFullPath($taskEntry.FullName)
    $taskTarget = [IO.Path]::GetFullPath((Join-Path $taskArchive $taskEntry.Name))
    if (-not $taskSource.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not $taskTarget.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw '归档路径越出项目目录，已停止。'
    }
    if ($taskEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Write-Warning "跳过链接：$($taskEntry.Name)"
        continue
    }
    if (Test-Path -LiteralPath $taskTarget) { throw "目标已存在：$taskTarget" }
    if (-not $PSCmdlet.ShouldProcess($taskSource, "移动到 $taskTarget")) { continue }

    # 拒绝链接形式的目标父目录，防止写入项目之外。
    foreach ($taskDir in @((Join-Path $taskRoot '.tmp'), (Join-Path $taskRoot '.tmp/archive'),
        $taskArchive, (Join-Path $taskRoot '.tmp/maintenance'))) {
        if (Test-Path -LiteralPath $taskDir) {
            if ((Get-Item -LiteralPath $taskDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "归档父目录不能是链接：$taskDir"
            }
        } else {
            New-Item -ItemType Directory -Path $taskDir | Out-Null
        }
    }
    $taskRecord = [ordered]@{ source = $taskEntry.Name; target = ".tmp/archive/$taskStamp/$($taskEntry.Name)"; status = 'pending' }
    $taskResults += $taskRecord
    ConvertTo-Json -InputObject $taskResults -Depth 4 | Set-Content -LiteralPath $taskJournal -Encoding utf8
    try {
        # 同卷原子改名；Move-Item 在目录占用时可能退回逐文件移动。
        if ($taskEntry.PSIsContainer) {
            [IO.Directory]::Move($taskSource, $taskTarget)
        } else {
            [IO.File]::Move($taskSource, $taskTarget)
        }
        $taskRecord.status = 'moved'
    } catch {
        $taskRecord.status = 'failed'
        Write-Warning "保留未能归档的项目：$($taskEntry.Name)；$($_.Exception.Message)"
    }
    ConvertTo-Json -InputObject $taskResults -Depth 4 | Set-Content -LiteralPath $taskJournal -Encoding utf8
}

[pscustomobject]@{
    Moved = @($taskResults | Where-Object status -eq 'moved').Count
    Failed = @($taskResults | Where-Object status -eq 'failed').Count
    Archive = $taskArchive
    Journal = $(if ($taskResults.Count) { $taskJournal } else { $null })
}
if (@($taskResults | Where-Object status -eq 'failed').Count) { exit 1 }
