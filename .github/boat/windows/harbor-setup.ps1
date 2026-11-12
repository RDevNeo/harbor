# The Windows test VM's setup, run once by SetupComplete.cmd as SYSTEM after Windows' own setup and before
# the first logon (autounattend.xml copies this disc to C:\Windows\Setup\Scripts): what scripts/boat/windows
# needs to drive the VM. The first logon of "harbor" then runs the task harbor-finish (sets the screen to
# 1920x1080 in the desktop session, marks C:\rig\setup-done, powers off) and windows.sh saves the disk.
# Logs to C:\Windows\Setup\Scripts\harbor-setup.log.
#  - OpenSSH server (Win32-OpenSSH's MSI from the disc) with the sandbox's key, for every command;
#  - a scheduled task "harbor-gui" that runs C:\rig\gui.cmd in the logged-on desktop session: what
#    SSH starts can't show a window (it runs in no desktop), what this task starts can;
#  - Git for Windows, the Visual C++ runtime and Bun (the version ts/package.json pins), from the disc:
#    runs and tests from source;
#  - no Windows Update, no sleep, no lock screen, no screen saver (a test VM that must stay the same
#    between runs). Defender stays on: a script that turns it off is blocked as malware (AMSI), this one too.
# Nothing else: Harbor itself, Claude Code and Codex are what the tests install or bring.
param([string]$Disc)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Step($what) { Write-Output ("==> {0} {1}" -f (Get-Date -Format HH:mm:ss), $what) }

Step 'OpenSSH server'
$msi = Get-ChildItem $Disc -Filter 'OpenSSH-Win64*.msi' | Select-Object -First 1
Start-Process msiexec.exe -Wait -ArgumentList @('/i', $msi.FullName, '/qn', '/norestart')
New-Item -ItemType Directory -Force C:\ProgramData\ssh | Out-Null
Copy-Item (Join-Path $Disc 'authorized_keys') C:\ProgramData\ssh\administrators_authorized_keys -Force
icacls.exe C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
# PowerShell as the shell: windows.sh sends every command as -EncodedCommand.
New-ItemProperty -Path HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
Set-Service sshd -StartupType Automatic
Start-Service sshd
if (-not (Get-NetFirewallRule -Name 'sshd-harbor' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'sshd-harbor' -DisplayName 'OpenSSH (Harbor test VM)' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
}

Step 'Git for Windows'
$git = Get-ChildItem $Disc -Filter 'Git-*-64-bit.exe' | Select-Object -First 1
Start-Process $git.FullName -Wait -ArgumentList @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES')

Step 'Visual C++ runtime'
Start-Process (Join-Path $Disc 'VC_redist.x64.exe') -Wait -ArgumentList @('/install', '/quiet', '/norestart')

Step 'Bun'
New-Item -ItemType Directory -Force C:\Tools | Out-Null
Expand-Archive (Join-Path $Disc 'bun-windows-x64.zip') C:\Tools -Force
Move-Item C:\Tools\bun-windows-x64 C:\Tools\bun -Force
$path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($path -notlike '*C:\Tools\bun*') { [Environment]::SetEnvironmentVariable('Path', "$path;C:\Tools\bun", 'Machine') }

Step 'the desktop task'
New-Item -ItemType Directory -Force C:\rig | Out-Null
Set-Content C:\rig\gui.cmd '@echo nothing to run' -Encoding ASCII
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c C:\rig\gui.cmd > C:\rig\gui.log 2>&1' -WorkingDirectory C:\rig
$principal = New-ScheduledTaskPrincipal -UserId 'harbor' -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel
Register-ScheduledTask -TaskName 'harbor-gui' -Action $action -Principal $principal -Settings $settings -Force | Out-Null

Step 'quiet machine'
foreach ($s in 'wuauserv', 'UsoSvc', 'DoSvc', 'WSearch', 'SysMain', 'DiagTrack', 'MapsBroker') {
  Stop-Service $s -Force -ErrorAction SilentlyContinue
  Set-Service $s -StartupType Disabled -ErrorAction SilentlyContinue
}
$au = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
New-Item -Force $au | Out-Null
Set-ItemProperty $au -Name NoAutoUpdate -Value 1 -Type DWord
$p = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization'
New-Item -Force $p | Out-Null
Set-ItemProperty $p -Name NoLockScreen -Value 1 -Type DWord
New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' -Name DisableWindowsConsumerFeatures -Value 1 -Type DWord
powercfg.exe /change monitor-timeout-ac 0
powercfg.exe /change standby-timeout-ac 0
powercfg.exe /hibernate off
# The page file is zeroed at every shutdown: the saved disk then holds no stale pages (zeros compress away).
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' -Name ClearPageFileAtShutdown -Value 1 -Type DWord
# The time comes from the host's clock at every boot (the VM is cold-booted from the saved disk).
Set-Service W32Time -StartupType Disabled -ErrorAction SilentlyContinue

Step 'screen 1920x1080, power off: at the first logon'
# Its own file: Add-Type with user32 calls is what scanners look for, and a flag there must not block this one.
Copy-Item (Join-Path $Disc 'screen.ps1') C:\rig\screen.ps1 -Force
# As SYSTEM at harbor's first logon: the screen in its session (through harbor-gui), the leftovers, the
# trim (the saved disk keeps only used blocks), then power off.
Set-Content C:\rig\finish.ps1 -Encoding ASCII -Value @'
Start-Sleep 30
Set-Content C:\rig\gui.cmd "powershell -NoProfile -ExecutionPolicy Bypass -File C:\rig\screen.ps1"
Start-ScheduledTask -TaskName harbor-gui
Start-Sleep 10
Set-Content C:\rig\gui.cmd "@echo nothing to run"
Unregister-ScheduledTask -TaskName harbor-finish -Confirm:$false
Get-ChildItem C:\Windows\Setup\Scripts -Exclude *.log | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force C:\Windows\Temp\*, C:\Users\harbor\AppData\Local\Temp\*, C:\Windows\SoftwareDistribution\Download\* -ErrorAction SilentlyContinue
Dism.exe /Online /Cleanup-Image /StartComponentCleanup /ResetBase /Quiet
Optimize-Volume -DriveLetter C -ReTrim -ErrorAction SilentlyContinue
Set-Content C:\rig\setup-done (Get-Date -Format o)
Stop-Computer -Force
'@
$t = New-ScheduledTaskTrigger -AtLogOn -User 'harbor'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\rig\finish.ps1'
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'harbor-finish' -Trigger $t -Action $a -Principal $p -Force | Out-Null
Step 'done'
