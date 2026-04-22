param(
    [string]$RepoRoot = "C:\Users\xiyihan\MoeTalk",
    [string]$SourceRoot = "",
    [string]$OutputRoot = "",
    [string]$ScratchRoot = "",
    [string]$FfmpegPath = "D:\xiyihan\Downloads\ffmpeg-N-116650-g7897b0beed-win64-gpl\bin\ffmpeg.exe",
    [string]$MagickPath = "C:\Program Files\ImageMagick-7.1.2-Q16-HDRI\magick.exe",
    [int]$Framerate = 10,
    [int]$Crf = 28,
    [string]$Preset = "medium",
    [ValidateSet("libx265", "hevc_nvenc")]
    [string]$Encoder = "libx265",
    [int]$FfmpegThreads = 1,
    [int]$ThrottleLimit = 8,
    [int]$MinFrameCount = 1,
    [int]$LimitDirs = 0
)

$ErrorActionPreference = "Stop"

function Test-ContainsCharFaceFrames {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return $false
    }

    return [bool](Get-ChildItem -Path $Path -Recurse -File -Filter *.webp -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\CharFace\\' } |
        Select-Object -First 1)
}

function Get-OutputStem {
    param(
        [string]$RelativePath
    )

    return ($RelativePath -replace '[\\/:*?"<>|]', "_")
}

if (-not (Test-Path $RepoRoot)) {
    throw "RepoRoot not found: $RepoRoot"
}

if (-not $SourceRoot) {
    $candidateRoots = @(
        (Join-Path $RepoRoot "GameData"),
        (Join-Path (Split-Path $RepoRoot -Parent) "MoeTalk-work\GameData")
    )

    $SourceRoot = $candidateRoots | Where-Object { Test-ContainsCharFaceFrames $_ } | Select-Object -First 1
}

if (-not $SourceRoot) {
    throw "Unable to locate a GameData source root with CharFace frames."
}
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $RepoRoot "hevc-charface-assets-whitebg"
}
if (-not $ScratchRoot) {
    $ScratchRoot = Join-Path $RepoRoot "hevc-charface-scratch-whitebg"
}

if (-not (Test-Path $SourceRoot)) {
    throw "SourceRoot not found: $SourceRoot"
}
if (-not (Test-Path $FfmpegPath)) {
    throw "ffmpeg not found: $FfmpegPath"
}
if (-not (Test-Path $MagickPath)) {
    throw "magick not found: $MagickPath"
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
            $relativePath = $_.FullName.Substring(($SourceRoot + '\').Length)
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

if ($LimitDirs -gt 0) {
    $dirRecords = @($dirRecords | Select-Object -First $LimitDirs)
}

$dirRecords |
    Select-Object Relative, Count, SrcBytes |
    Export-Csv (Join-Path $OutputRoot "dirs.csv") -NoTypeInformation -Encoding UTF8

$results = $dirRecords | ForEach-Object -Parallel {
    $record = $_
    $magickPath = $using:MagickPath
    $ffmpegPath = $using:FfmpegPath
    $outputRoot = $using:OutputRoot
    $scratchRoot = $using:ScratchRoot
    $framerate = $using:Framerate
    $crf = $using:Crf
    $preset = $using:Preset
    $encoder = $using:Encoder
    $ffmpegThreads = $using:FfmpegThreads

    $ordered = Get-ChildItem $record.FullName -File -Filter *.webp |
        Sort-Object `
            @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { 0 } else { 1 } } }, `
            @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { [int]$_.BaseName } else { 0 } } }, `
            @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { "" } else { $_.BaseName } } }

    $sequenceDir = Join-Path $scratchRoot $record.OutputStem
    $outputPath = Join-Path $outputRoot ($record.OutputStem + ".mp4")

    if (Test-Path $sequenceDir) {
        Remove-Item -Recurse -Force $sequenceDir
    }
    New-Item -ItemType Directory -Path $sequenceDir | Out-Null

    try {
        $index = 0
        foreach ($file in $ordered) {
            $framePath = Join-Path $sequenceDir ($index.ToString() + ".png")
            & $magickPath $file.FullName -background white -alpha remove -alpha off $framePath
            if ($LASTEXITCODE -ne 0) {
                throw "ImageMagick failed for $($file.FullName)"
            }
            $index++
        }

        $arguments = @(
            "-loglevel", "error",
            "-y",
            "-framerate", $framerate.ToString(),
            "-i", (Join-Path $sequenceDir "%d.png"),
            "-pix_fmt", "yuv420p",
            "-tag:v", "hvc1",
            "-movflags", "+faststart"
        )

        if ($encoder -eq "hevc_nvenc") {
            $nvencPreset = switch ($preset.ToLowerInvariant()) {
                "slow" { "p7" }
                "medium" { "p5" }
                "fast" { "p3" }
                default { $preset }
            }

            $arguments += @(
                "-c:v", "hevc_nvenc",
                "-preset", $nvencPreset,
                "-rc", "vbr",
                "-cq", $crf.ToString(),
                "-b:v", "0",
                "-threads", $ffmpegThreads.ToString()
            )
        }
        else {
            $arguments += @(
                "-c:v", "libx265",
                "-preset", $preset,
                "-crf", $crf.ToString(),
                "-threads", $ffmpegThreads.ToString(),
                "-x265-params", "log-level=error"
            )
        }

        $arguments += @($outputPath)

        & $ffmpegPath @arguments
        $exitCode = $LASTEXITCODE
        $dstBytes = if (Test-Path $outputPath) { (Get-Item $outputPath).Length } else { 0 }

        [PSCustomObject]@{
            Relative = $record.Relative
            Count    = $record.Count
            SrcBytes = $record.SrcBytes
            DstBytes = $dstBytes
            ExitCode = $exitCode
        }
    }
    finally {
        if (Test-Path $sequenceDir) {
            Remove-Item -Recurse -Force $sequenceDir
        }
    }
} -ThrottleLimit $ThrottleLimit

$results = @($results)

$results |
    Sort-Object Relative |
    Export-Csv (Join-Path $OutputRoot "results.csv") -NoTypeInformation -Encoding UTF8

$srcSum = ($results | Measure-Object SrcBytes -Sum).Sum
$dstSum = ($results | Measure-Object DstBytes -Sum).Sum
$successCount = @($results | Where-Object { $_.ExitCode -eq 0 -and $_.DstBytes -gt 0 }).Count
$failed = @($results | Where-Object { $_.ExitCode -ne 0 -or $_.DstBytes -eq 0 })

[PSCustomObject]@{
    DirCount       = @($results).Count
    SuccessCount   = $successCount
    FailedCount    = $failed.Count
    SrcGiB         = [math]::Round($srcSum / 1GB, 3)
    DstGiB         = [math]::Round($dstSum / 1GB, 3)
    SavingPct      = if ($srcSum) { [math]::Round((1 - ($dstSum / $srcSum)) * 100, 2) } else { 0 }
    SourceRoot     = $SourceRoot
    OutputRoot     = $OutputRoot
    Framerate      = $Framerate
    Crf            = $Crf
    Preset         = $Preset
    Encoder        = $Encoder
    FfmpegThreads  = $FfmpegThreads
    ThrottleLimit  = $ThrottleLimit
    MinFrameCount  = $MinFrameCount
    LimitDirs      = $LimitDirs
} | Format-List

if ($failed.Count -gt 0) {
    $failed |
        Select-Object -First 20 Relative, Count, ExitCode, SrcBytes, DstBytes |
        Format-Table -AutoSize
}
