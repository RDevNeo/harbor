# Harbor installer for Windows (x64, Windows 10 1809 or newer): per user, no administrator needed for Harbor
# itself. Harbor installs what it needs beside itself when it's missing: Git for Windows (winget, or Git's own
# installer; Windows may ask once), Claude Code (Anthropic's installer) and Codex (OpenAI's release).
# $env:HARBOR_NO_DEPS = "1" leaves those out.
#
#   irm https://github.com/RDevNeo/harbor/releases/latest/download/install.ps1 | iex
#   $env:HARBOR_UNINSTALL = "1"; irm …/install.ps1 | iex      # remove Harbor (keeps your chats)
#   (also add $env:HARBOR_PURGE = "1" to delete its data)
#   or from a file: powershell -ExecutionPolicy Bypass -File install.ps1 [-Uninstall] [-Purge] [-Version 0.180.0]
#
# Every download is checked against the release's SHA256SUMS and its minisign signature (minisign's own
# Windows build, pinned below, does the check). To install without the signature check anyway:
# $env:HARBOR_INSECURE = "1".
#
# Layout: %LOCALAPPDATA%\Programs\Harbor\{harbor.exe,harbor.png,VERSION,.managed,uninstall.ps1}, a Start menu
# entry "Harbor", Harbor in Settings › Apps, and that folder on your PATH (so `harbor` works in a terminal).
# Claude Code and Codex go to %USERPROFILE%\.local\bin, also put on your PATH. Harbor updates itself afterwards.
param([switch]$Uninstall, [switch]$Purge, [string]$Version = "")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "RDevNeo/harbor"
$PubKey = "RWSaeVHfD2GBvTEgaNXQQs8eQR5rCD50vuckgoo79X6wqhOKXIpUVHNh"
# The same minisign release the workflow signs with, its Windows build.
$MinisignUrl = "https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip"
$MinisignSha256 = "37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479"
$Core = "harbor-x86_64-windows.zip"
$AppId = "dev.harbor.Harbor"

if ($env:HARBOR_UNINSTALL -eq "1") { $Uninstall = $true }
if ($env:HARBOR_PURGE -eq "1") { $Purge = $true }
if ($Version -eq "") { $Version = if ($env:HARBOR_VERSION) { $env:HARBOR_VERSION } else { "latest" } }
$Insecure = $env:HARBOR_INSECURE -eq "1"
# A local folder with the release files (tests): $env:HARBOR_FROM
$From = $env:HARBOR_FROM

$Dir = Join-Path $env:LOCALAPPDATA "Programs\Harbor"
$Bin = Join-Path $env:USERPROFILE ".local\bin"
$Data = Join-Path $env:APPDATA "harbor"
$Menu = Join-Path ([Environment]::GetFolderPath("Programs")) "Harbor.lnk"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harbor"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { Write-Host "harbor install: $m" -ForegroundColor Red; throw "harbor install: $m" }
function Unchecked([string]$m) {
  if ($Insecure) { Write-Host "harbor install: WARNING: $m. Installing it anyway (HARBOR_INSECURE=1)." -ForegroundColor Yellow }
  else { Die "$m. Set `$env:HARBOR_INSECURE = `"1`" to install without the check." }
}

# The user's PATH (not the machine's), with `dir` added or taken out.
function Set-UserPath([string]$dir, [bool]$on) {
  $now = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($now) { $parts = $now.Split(";") | Where-Object { $_ -ne "" -and $_.TrimEnd("\") -ne $dir.TrimEnd("\") } }
  if ($on) { $parts = @($parts) + $dir }
  [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
  if ($on -and -not (($env:Path.Split(";")) -contains $dir)) { $env:Path = "$env:Path;$dir" }
}

# Harbor stops before its folder goes (uninstall): Windows won't delete the files of a running program. Asked
# first (`harbor quit`: turns stop and its data is saved, as its tray's Quit does), stopped only if it doesn't.
function Stop-Harbor {
  $exe = Join-Path $Dir "harbor.exe"
  $running = { Get-Process -Name harbor -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } }
  if (-not (& $running)) { return }
  if (Test-Path $exe) {
    try {
      $q = Start-Process -FilePath $exe -ArgumentList "quit" -WindowStyle Hidden -PassThru
      $q.WaitForExit(40000) | Out-Null
    } catch {}
  }
  & $running | ForEach-Object { try { if (-not $_.HasExited) { $_.Kill(); $_.WaitForExit(5000) | Out-Null } } catch {} }
}

if ($Uninstall) {
  Stop-Harbor
  Remove-ItemProperty -Path $RunKey -Name "Harbor" -ErrorAction SilentlyContinue
  Remove-Item -Path $UninstallKey -Recurse -ErrorAction SilentlyContinue
  Remove-Item -Path "HKCU:\Software\Classes\AppUserModelId\$AppId" -Recurse -ErrorAction SilentlyContinue
  Remove-Item -Path $Menu -ErrorAction SilentlyContinue
  Set-UserPath $Dir $false
  Remove-Item -Path $Dir -Recurse -Force -ErrorAction SilentlyContinue
  if ($Purge) {
    Remove-Item -Path $Data -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path (Join-Path $env:LOCALAPPDATA "harbor") -Recurse -Force -ErrorAction SilentlyContinue
    Say "Harbor and its data were removed."
  } else {
    Say "Harbor was removed. Your chats are still in $Data (set `$env:HARBOR_PURGE = `"1`" to delete them)."
  }
  return
}

if ([Environment]::Is64BitOperatingSystem -ne $true -or ($env:PROCESSOR_ARCHITECTURE -ne "AMD64" -and $env:PROCESSOR_ARCHITEW6432 -ne "AMD64")) {
  Die "Harbor for Windows runs on 64-bit Intel or AMD PCs (x64)."
}
if ([Environment]::OSVersion.Version.Build -lt 17763) { Die "Harbor needs Windows 10 version 1809 or newer." }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("harbor-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Tmp | Out-Null

function Get-File([string]$url, [string]$out) {
  for ($i = 0; $i -lt 3; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out; return $true } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}
$Base = if ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/v$($Version.TrimStart('v'))" }
function Fetch([string]$name) {
  $out = Join-Path $Tmp $name
  if ($From) { try { Copy-Item (Join-Path $From $name) $out; return $true } catch { return $false } }
  return Get-File "$Base/$name" $out
}
function Sha256([string]$path) { (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant() }

function Get-Minisign {
  $have = Get-Command minisign -ErrorAction SilentlyContinue
  if ($have) { return $have.Source }
  $zip = Join-Path $Tmp "minisign.zip"
  if (-not (Get-File $MinisignUrl $zip)) { return $null }
  if ((Sha256 $zip) -ne $MinisignSha256) { Die "the minisign download doesn't match its pinned checksum." }
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Tmp "minisign") -Force
  return Join-Path $Tmp "minisign\minisign-win64\x86_64\minisign.exe"
}

# What Harbor needs beside itself, installed when missing: Git for Windows, Claude Code and Codex.
function Install-Deps {
  if ($env:HARBOR_NO_DEPS -eq "1") { return }
  New-Item -ItemType Directory -Path $Bin -Force | Out-Null
  Set-UserPath $Bin $true
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Say "Harbor needs Git for Windows, which isn't installed. Installing it (Windows may ask you to allow it once)…"
    $ok = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      & winget install --id Git.Git -e --source winget --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
      if ($LASTEXITCODE -ne 0) { & winget install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Null }
      $ok = $LASTEXITCODE -eq 0
    }
    if (-not $ok) {
      # Git's own installer from its latest GitHub release, checked against the digest GitHub lists, for this user only.
      try {
        $rel = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest"
        $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
        $exe = Join-Path $Tmp $asset.name
        if ($asset -and (Get-File $asset.browser_download_url $exe)) {
          if ($asset.digest -and ("sha256:" + (Sha256 $exe)) -ne $asset.digest) { Say "Git's download doesn't match its checksum: left out." }
          else {
            $p = Start-Process -FilePath $exe -ArgumentList "/VERYSILENT", "/NORESTART", "/CURRENTUSER", "/NOCANCEL", "/SP-" -Wait -PassThru
            $ok = $p.ExitCode -eq 0
          }
        }
      } catch {}
    }
    # Its folder on this session's PATH, so Claude Code's installer finds it now.
    foreach ($g in @("$env:LOCALAPPDATA\Programs\Git\cmd", "$env:ProgramFiles\Git\cmd")) { if (Test-Path "$g\git.exe") { $env:Path = "$env:Path;$g" } }
    if (-not $ok) { Say "Git didn't install: get it from https://git-scm.com/download/win, then run Harbor." }
  }
  if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $Bin "claude.exe"))) {
    Say "Installing Claude Code (Anthropic's installer)…"
    try { Invoke-RestMethod -UseBasicParsing -Uri "https://claude.ai/install.ps1" | Invoke-Expression | Out-Null }
    catch { Say "Claude Code didn't install; get it from https://claude.ai/install.ps1" }
  }
  if (-not (Get-Command codex -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $Bin "codex.exe"))) {
    Say "Installing Codex (OpenAI's release)…"
    try {
      $rel = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/openai/codex/releases/latest"
      # codex.exe and the two helpers it runs beside itself on Windows (its sandbox).
      foreach ($name in @("codex", "codex-command-runner", "codex-windows-sandbox-setup")) {
        $asset = $rel.assets | Where-Object { $_.name -eq "$name-x86_64-pc-windows-msvc.exe" } | Select-Object -First 1
        if (-not $asset) { continue }
        $out = Join-Path $Tmp "$name.exe"
        if (-not (Get-File $asset.browser_download_url $out)) { throw "download" }
        if ($asset.digest -and ("sha256:" + (Sha256 $out)) -ne $asset.digest) { throw "checksum" }
        Move-Item -Force $out (Join-Path $Bin "$name.exe")
      }
    } catch { Say "Codex didn't install; get it later from https://github.com/openai/codex/releases" }
  }
}

try {
  if (-not (Fetch "SHA256SUMS")) { Die "could not reach the release ($Base)." }
  Say "Downloading Harbor ($Version)…"
  if (-not (Fetch $Core)) { Die "could not download $Core" }
  $want = (Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { $_ -match "  $([regex]::Escape($Core))$" } | Select-Object -First 1)
  if (-not $want) { Die "$Core is not listed in SHA256SUMS." }
  if ((Sha256 (Join-Path $Tmp $Core)) -ne $want.Split(" ")[0]) { Die "${Core}: checksum mismatch." }
  if (-not (Fetch "$Core.minisig")) { Unchecked "could not download $Core.minisig" }
  else {
    $ms = Get-Minisign
    if ($ms) {
      & $ms -Vqm (Join-Path $Tmp $Core) -P $PubKey
      if ($LASTEXITCODE -ne 0) { Die "${Core}: bad signature." }
    } else { Unchecked "${Core}: its signature can't be checked (minisign couldn't be downloaded)" }
  }
  $core = Join-Path $Tmp "core"
  Expand-Archive -Path (Join-Path $Tmp $Core) -DestinationPath $core -Force
  if (-not (Test-Path (Join-Path $core "harbor.exe"))) { Die "no harbor.exe in $Core." }

  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  # A running harbor.exe can't be overwritten but can be renamed: the old one goes aside, deleted next time.
  Get-ChildItem -Path $Dir -Filter "*.old-*" -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
  $exe = Join-Path $Dir "harbor.exe"
  if (Test-Path $exe) { Rename-Item -Path $exe -NewName ("harbor.exe.old-" + [DateTime]::UtcNow.Ticks) -ErrorAction SilentlyContinue }
  Copy-Item -Path (Join-Path $core "*") -Destination $Dir -Recurse -Force
  # Marks a per-user install the in-app updater may manage.
  Set-Content -Path (Join-Path $Dir ".managed") -Value "install.ps1" -NoNewline
  # This installer's own uninstall, for Settings › Apps.
  $un = Join-Path $Dir "uninstall.ps1"
  @"
`$env:HARBOR_UNINSTALL = "1"
`$s = Join-Path `$env:TEMP "harbor-uninstall.ps1"
Copy-Item -Path "$Dir\install.ps1" -Destination `$s -Force
& powershell -NoProfile -ExecutionPolicy Bypass -File `$s -Uninstall
"@ | Set-Content -Path $un
  if ($PSCommandPath) { Copy-Item -Path $PSCommandPath -Destination (Join-Path $Dir "install.ps1") -Force }
  elseif (Fetch "install.ps1") { Copy-Item -Path (Join-Path $Tmp "install.ps1") -Destination (Join-Path $Dir "install.ps1") -Force }

  # The Start menu entry.
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Menu)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $env:USERPROFILE
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = "Harbor"
  $lnk.Save()

  $ver = (Get-Content (Join-Path $Dir "VERSION") -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $ver) { $ver = $Version.TrimStart("v") }
  New-Item -Path $UninstallKey -Force | Out-Null
  $props = @{
    DisplayName = "Harbor"; DisplayVersion = $ver; Publisher = "Harbor"; DisplayIcon = "$exe,0"
    InstallLocation = $Dir; NoModify = 1; NoRepair = 1
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$un`""
    URLInfoAbout = "https://github.com/$Repo"
  }
  foreach ($k in $props.Keys) {
    $type = if ($props[$k] -is [int]) { "DWord" } else { "String" }
    New-ItemProperty -Path $UninstallKey -Name $k -Value $props[$k] -PropertyType $type -Force | Out-Null
  }
  Set-UserPath $Dir $true

  Install-Deps
  Say "Harbor $ver is installed. Open it from the Start menu, or run: harbor"
} finally {
  Remove-Item -Path $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
