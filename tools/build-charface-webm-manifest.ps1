param(
    [string]$RepoRoot = "C:\Users\xiyihan\MoeTalk",
    [string]$SourceRoot = "",
    [string]$OutputRoot = "",
    [string]$ManifestPath = "",
    [int]$Framerate = 10
)

$ErrorActionPreference = "Stop"

if (-not $SourceRoot) {
    $SourceRoot = Join-Path $RepoRoot "GameData"
}
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $RepoRoot "webm-charface-assets"
}
if (-not $ManifestPath) {
    $ManifestPath = Join-Path $OutputRoot "manifest.json"
}

if (-not (Test-Path $RepoRoot)) {
    throw "RepoRoot not found: $RepoRoot"
}
if (-not (Test-Path $SourceRoot)) {
    throw "SourceRoot not found: $SourceRoot"
}
if (-not (Test-Path $OutputRoot)) {
    throw "OutputRoot not found: $OutputRoot"
}

function Get-OutputStem {
    param(
        [string]$RelativePath
    )

    return ($RelativePath -replace '[\\/:*?"<>|]', "_")
}

function Get-RelativePath {
    param(
        [string]$BasePath,
        [string]$Path
    )

    $baseUri = [Uri]((Resolve-Path $BasePath).Path + [IO.Path]::DirectorySeparatorChar)
    $pathUri = [Uri](Resolve-Path $Path).Path
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($pathUri).ToString()).Replace('/', '\')
}

$manifestDirs = [ordered]@{}

Get-ChildItem $SourceRoot -Recurse -Directory |
    Where-Object { $_.FullName -match '\\CharFace(\\|$)' } |
    Sort-Object FullName |
    ForEach-Object {
        $files = Get-ChildItem $_.FullName -File -Filter *.webp
        if (-not $files.Count) {
            return
        }

        $relativeDir = $_.FullName.Substring(($RepoRoot + '\').Length).Replace('\', '/')
        $outputStem = Get-OutputStem -RelativePath $relativeDir
        $videoPath = Join-Path $OutputRoot ($outputStem + ".webm")
        if (-not (Test-Path $videoPath)) {
            return
        }

        $orderedFrames = $files |
            Sort-Object `
                @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { 0 } else { 1 } } }, `
                @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { [int]$_.BaseName } else { 0 } } }, `
                @{ Expression = { if ($_.BaseName -match '^[0-9]+$') { "" } else { $_.BaseName } } } |
            Select-Object -ExpandProperty BaseName

        $relativeVideo = Get-RelativePath -BasePath $RepoRoot -Path $videoPath
        $manifestDirs[$relativeDir] = [ordered]@{
            video  = $relativeVideo.Replace('\', '/')
            frames = @($orderedFrames)
        }
    }

$manifest = [ordered]@{
    version   = 1
    framerate = $Framerate
    dirs      = $manifestDirs
}

$manifestJson = $manifest | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($ManifestPath, $manifestJson, [Text.UTF8Encoding]::new($false))

[PSCustomObject]@{
    ManifestPath = $ManifestPath
    DirCount     = $manifestDirs.Count
} | Format-List
