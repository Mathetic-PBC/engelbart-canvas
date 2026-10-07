# Installs Engelbart on Windows, or updates it (2026-10-07, docs/windows-port-log.md "One-command install"):
#
#   irm __DOWNLOADS__install.ps1 | iex
#
# The Windows twin of scripts/install-mac.sh. It reads the newest version from __DOWNLOADS__ (latest.yml there names
# the installer and gives its checksum), downloads it, checks it, installs it silently for this Windows account (in
# %LOCALAPPDATA%\Programs\Engelbart; where Engelbart already is, when it was installed for everyone) and opens
# Engelbart. When that version is already installed it stops without downloading (ENGELBART_FORCE=1 installs it again
# anyway). Projects, notes and settings live outside the app (~\.engelbart, %APPDATA%\Engelbart) and are not touched.
#
# Engelbart runs its scripts with Git for Windows' bash: when no Git for Windows is found it is installed with winget
# (`winget install --id Git.Git -e`), or, without winget, this says where to get it.
#
# The release script (scripts/release-site.mjs) writes the download folder into this file. ENGELBART_DOWNLOADS reads
# from another folder instead; ENGELBART_INSTALL_DIR installs into that folder; ENGELBART_NO_OPEN=1 leaves Engelbart
# closed afterwards. It runs in Windows PowerShell 5.1 and PowerShell 7, and is kept to ASCII: `irm` hands `iex`
# whatever text the server's answer decodes to. A failure is one line and never closes the window it runs in (no
# `exit`: under `iex` that would end the person's PowerShell); $LASTEXITCODE is 1 after one.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell's progress bar slows a download down many times over
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  $downloads = if ($env:ENGELBART_DOWNLOADS) { $env:ENGELBART_DOWNLOADS } else { '__DOWNLOADS__' }
  if (-not $downloads.EndsWith('/')) { $downloads += '/' }
  $gitUrl = 'https://git-scm.com/download/win'
  $work = $null

  # The text of an answer: Windows PowerShell gives bytes for a type it does not know as text (a .yml, often).
  function Get-Text($uri) {
    $content = (Invoke-WebRequest -UseBasicParsing -Uri $uri).Content
    if ($content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($content) }
    return [string]$content
  }

  # Where Engelbart is installed and which version, from its uninstall entry (this account's, then everyone's), else the
  # usual folder. The installer leaves InstallLocation out of the entry; its uninstaller is in the folder, so the folder
  # is that (UninstallString: "<folder>\Uninstall Engelbart.exe" /currentuser). $null when it is not installed.
  function Get-Installed {
    $roots = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    foreach ($root in $roots) {
      foreach ($key in @(Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
        $entry = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
        if (-not $entry -or "$($entry.DisplayName)" -notlike 'Engelbart*') { continue }
        $dir = "$($entry.InstallLocation)".Trim('"')
        if (-not $dir -and "$($entry.UninstallString)" -match '^\s*"([^"]+)"|^\s*(\S+)') { $dir = Split-Path -Parent $(if ($Matches[1]) { $Matches[1] } else { $Matches[2] }) }
        if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'Engelbart.exe'))) { return [pscustomobject]@{ Version = "$($entry.DisplayVersion)"; Dir = $dir; Everyone = $root -like 'HKLM:*' } }
      }
    }
    $usual = Join-Path $env:LOCALAPPDATA 'Programs\Engelbart'
    $exe = Join-Path $usual 'Engelbart.exe'
    if (Test-Path -LiteralPath $exe) { # its file version has a fourth part, 0.1.10.0
      $parts = "$((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion)" -split '\.'
      return [pscustomobject]@{ Version = ($parts[0..([Math]::Min(2, $parts.Count - 1))] -join '.'); Dir = $usual; Everyone = $false }
    }
    return $null
  }

  # Git for Windows' bash, where Engelbart looks for it (src/main/terminal/launch.cjs findGitBash). $null when missing.
  function Find-GitBash {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $places = @()
    if ($git) { $places += Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe' }
    if ($env:ProgramFiles) { $places += Join-Path $env:ProgramFiles 'Git\bin\bash.exe' }
    if ($env:LOCALAPPDATA) { $places += Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe' }
    foreach ($place in $places) { if (Test-Path -LiteralPath $place) { return $place } }
    return $null
  }

  # Git for Windows, installed with winget when it is missing; else where to get it. Engelbart installs either way.
  function Confirm-Git {
    if (Find-GitBash) { return }
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
      Write-Host 'Engelbart needs Git for Windows, which is not installed: installing it with winget...'
      & winget.exe install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -eq 0) { Write-Host 'Git for Windows is installed.' }
      else { Write-Host "winget could not install Git for Windows (exit code $LASTEXITCODE). Get it from $gitUrl; Engelbart needs it." -ForegroundColor Yellow }
    } else {
      Write-Host "Engelbart needs Git for Windows, which is not installed. Get it from $gitUrl, then open Engelbart again." -ForegroundColor Yellow
    }
  }

  try {
    $os = $null
    try { $os = "$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)" } catch { }
    if (-not $os) { $os = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
    if ($os -match 'arm') { throw 'Engelbart for Windows runs on 64-bit Intel and AMD PCs (x64); this PC has an ARM processor.' }
    if ($os -notmatch '^(X64|AMD64)$') { throw "Engelbart for Windows runs on 64-bit Intel and AMD PCs (x64); this PC is $os (32-bit)." }

    # The query keeps a cache in front of the folder from answering with an older feed.
    try { $feed = Get-Text "${downloads}latest.yml?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" } catch { throw "could not reach $downloads (is this PC online?)." }
    $version = $null; $sha512 = $null; $url = $null
    foreach ($line in ($feed -split "`r?`n")) {
      if (-not $version -and $line -match '^version:\s*(\S+)') { $version = $Matches[1].Trim("'", '"') }
    }
    $installer = "Engelbart-$version-x64.exe"
    foreach ($line in ($feed -split "`r?`n")) {
      if ($line -match '^\s*-\s*url:\s*(\S+)') { $url = $Matches[1].Trim("'", '"') }
      elseif ($line -match '^\s*sha512:\s*(\S+)' -and $url -eq $installer) { $sha512 = $Matches[1].Trim("'", '"'); break }
    }
    if (-not $version -or -not $sha512) { throw "${downloads}latest.yml does not list $installer." }

    # Already the newest: nothing to download (and Engelbart need not quit). ENGELBART_FORCE=1 installs again anyway.
    $installed = Get-Installed
    if ($env:ENGELBART_FORCE -ne '1' -and $installed -and $installed.Version -eq $version) {
      Write-Host "Engelbart $version is already installed in $($installed.Dir) and up to date."
      Confirm-Git
      $global:LASTEXITCODE = 0
      return
    }

    $work = Join-Path ([IO.Path]::GetTempPath()) ('engelbart-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    $file = Join-Path $work $installer
    Write-Host "Downloading Engelbart $version for Windows..."
    try { Invoke-WebRequest -UseBasicParsing -Uri "$downloads$installer" -OutFile $file } catch { throw 'the download did not finish; run the command again.' }
    $stream = [IO.File]::OpenRead($file)
    try { $got = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) } finally { $stream.Dispose() }
    if ($got -ne $sha512) { throw 'the download does not match its checksum; run the command again.' }

    if (Get-Process -Name Engelbart -ErrorAction SilentlyContinue) {
      Write-Host 'Engelbart is open. Quit it (File > Quit, or close its windows) and the install will go on.'
      $until = (Get-Date).AddMinutes(10)
      while (Get-Process -Name Engelbart -ErrorAction SilentlyContinue) {
        if ((Get-Date) -gt $until) { throw 'Engelbart was still open after 10 minutes. Quit it and run the command again.' }
        Start-Sleep -Seconds 1
      }
    }

    # Silently (/S), for this account, or for everyone when that is how it was installed before (Windows then asks).
    $switches = @('/S', $(if ($installed -and $installed.Everyone) { '/allusers' } else { '/currentuser' }))
    if ($env:ENGELBART_INSTALL_DIR) { $switches += "/D=$($env:ENGELBART_INSTALL_DIR)" } # NSIS: last, unquoted
    $run = Start-Process -FilePath $file -ArgumentList $switches -Wait -PassThru
    if ($run.ExitCode -ne 0) { throw "the installer stopped with exit code $($run.ExitCode)." }
    $now = Get-Installed
    $dir = if ($env:ENGELBART_INSTALL_DIR) { $env:ENGELBART_INSTALL_DIR } elseif ($now) { $now.Dir } else { $null }
    if (-not $dir -or -not (Test-Path -LiteralPath (Join-Path $dir 'Engelbart.exe'))) { throw 'the installer finished, but Engelbart.exe is not where it should be.' }

    Write-Host "Engelbart $version is installed in $dir."
    Confirm-Git
    if ($env:ENGELBART_NO_OPEN -ne '1') { Start-Process -FilePath (Join-Path $dir 'Engelbart.exe') }
    $global:LASTEXITCODE = 0
  } catch {
    Write-Host ''
    Write-Host "Engelbart was not installed: $($_.Exception.Message)" -ForegroundColor Red
    $global:LASTEXITCODE = 1
  } finally {
    if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
