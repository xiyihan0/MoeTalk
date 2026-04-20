param(
    [string]$RepoRoot = "C:\Users\xiyihan\MoeTalk",
    [string]$SourceRoot = "",
    [string]$OutputRoot = "",
    [string]$ScratchRoot = "",
    [string]$FfmpegPath = "D:\xiyihan\Downloads\ffmpeg-N-116650-g7897b0beed-win64-gpl\bin\ffmpeg.exe",
    [int]$Framerate = 10,
    [int]$Crf = 35,
    [int]$CpuUsed = 4,
    [int]$FfmpegThreads = 1,
    [int]$ThrottleLimit = 16,
    [int]$MinFrameCount = 1,
    [bool]$EnableRowMt = $false
)

$ErrorActionPreference = "Stop"

if (-not $SourceRoot) {
    $SourceRoot = Join-Path $RepoRoot "GameData"
}
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $RepoRoot "webm-charface-assets"
}
if (-not $ScratchRoot) {
    $ScratchRoot = Join-Path $RepoRoot "webm-charface-scratch"
}

if (-not (Test-Path $RepoRoot)) {
    throw "RepoRoot not found: $RepoRoot"
}
if (-not (Test-Path $SourceRoot)) {
    throw "SourceRoot not found: $SourceRoot"
}
if (-not (Test-Path $FfmpegPath)) {
    throw "ffmpeg not found: $FfmpegPath"
}

function Get-OutputStem {
    param(
        [string]$RelativePath
    )

    return ($RelativePath -replace '[\\/:*?"<>|]', "_")
}

if (Test-Path $OutputRoot) {
    Remove-Item -Recurse -Force $OutputRoot
}
if (Test-Path $ScratchRoot) {
    Remove-Item -Recurse -Force $ScratchRoot
}

New-Item -ItemType Directory -Path $OutputRoot | Out-Null
New-Item -ItemType Directory -Path $ScratchRoot | Out-Null

$dirRecords = Get-ChildItem $SourceRoot -Recurse -Directory |
    Where-Object { $_.FullName -match '\\CharFace(\\|$)' } |
    ForEach-Object {
        $files = Get-ChildItem $_.FullName -File -Filter *.webp
        if ($files.Count -ge $MinFrameCount) {
            $relativePath = $_.FullName.Substring(($RepoRoot + '\').Length)
            [PSCustomObject]@{
                FullName   = $_.FullName
                Relative   = $relativePath
                OutputStem = Get-OutputStem -RelativePath $relativePath
                Count      = $files.Count
                SrcBytes   = ($files | Measure-Object Length -Sum).Sum
            }
        }
    } |
    Sort-Object Relative

$dirRecords |
    Select-Object Relative, Count, SrcBytes |
    Export-Csv (Join-Path $OutputRoot "dirs.csv") -NoTypeInformation -Encoding UTF8

$results = $dirRecords | ForEach-Object -Parallel {
    $record = $_
    $ffmpegPath = $using:FfmpegPath
    $outputRoot = $using:OutputRoot
    $scratchRoot = $using:ScratchRoot
    $framerate = $using:Framerate
    $crf = $using:Crf
    $cpuUsed = $using:CpuUsed
    $ffmpegThreads = $using:FfmpegThreads
    $enableRowMt = $using:EnableRowMt

    $ordered = Get-ChildItem $record.FullName -File -Filter *.webp |
        Sort-Object `
            @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { 0 } else { 1 } } }, `
            @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { [int]$_.BaseName } else { 0 } } }, `
            @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { "" } else { $_.BaseName } } }

    $sequenceDir = Join-Path $scratchRoot $record.OutputStem
    $outputPath = Join-Path $outputRoot ($record.OutputStem + ".webm")

    if (Test-Path $sequenceDir) {
        Remove-Item -Recurse -Force $sequenceDir
    }
    New-Item -ItemType Directory -Path $sequenceDir | Out-Null

    try {
        $index = 0
        foreach ($file in $ordered) {
            $linkPath = Join-Path $sequenceDir ($index.ToString() + ".webp")
            New-Item -ItemType HardLink -Path $linkPath -Target $file.FullName | Out-Null
            $index++
        }

        $arguments = @(
            "-loglevel", "error",
            "-y",
            "-framerate", $framerate.ToString(),
            "-i", (Join-Path $sequenceDir "%d.webp"),
            "-c:v", "libvpx-vp9",
            "-pix_fmt", "yuva420p",
            "-b:v", "0",
            "-crf", $crf.ToString(),
            "-deadline", "good",
            "-cpu-used", $cpuUsed.ToString(),
            "-threads", $ffmpegThreads.ToString(),
            $outputPath
        )
        if ($enableRowMt) {
            $arguments = @(
                $arguments[0..($arguments.Length - 2)],
                "-row-mt", "1",
                $arguments[-1]
            )
        }

        $process = Start-Process -FilePath $ffmpegPath -ArgumentList $arguments -NoNewWindow -Wait -PassThru
        $dstBytes = if (Test-Path $outputPath) { (Get-Item $outputPath).Length } else { 0 }

        [PSCustomObject]@{
            Relative = $record.Relative
            Count    = $record.Count
            SrcBytes = $record.SrcBytes
            DstBytes = $dstBytes
            ExitCode = $process.ExitCode
        }
    }
    finally {
        if (Test-Path $sequenceDir) {
            Remove-Item -Recurse -Force $sequenceDir
        }
    }
} -ThrottleLimit $ThrottleLimit

$results |
    Sort-Object Relative |
    Export-Csv (Join-Path $OutputRoot "results.csv") -NoTypeInformation -Encoding UTF8

$srcSum = ($results | Measure-Object SrcBytes -Sum).Sum
$dstSum = ($results | Measure-Object DstBytes -Sum).Sum
$successCount = @($results | Where-Object { $_.ExitCode -eq 0 -and $_.DstBytes -gt 0 }).Count
$failed = @($results | Where-Object { $_.ExitCode -ne 0 -or $_.DstBytes -eq 0 })

[PSCustomObject]@{
    DirCount       = $results.Count
    SuccessCount   = $successCount
    FailedCount    = $failed.Count
    SrcGiB         = [math]::Round($srcSum / 1GB, 3)
    DstGiB         = [math]::Round($dstSum / 1GB, 3)
    SavingPct      = if ($srcSum) { [math]::Round((1 - ($dstSum / $srcSum)) * 100, 2) } else { 0 }
    OutputRoot     = $OutputRoot
    Framerate      = $Framerate
    Crf            = $Crf
    CpuUsed        = $CpuUsed
    FfmpegThreads  = $FfmpegThreads
    ThrottleLimit  = $ThrottleLimit
    MinFrameCount  = $MinFrameCount
    EnableRowMt    = $EnableRowMt
} | Format-List

if ($failed.Count -gt 0) {
    $failed |
        Select-Object -First 20 Relative, Count, ExitCode, SrcBytes, DstBytes |
        Format-Table -AutoSize
}
