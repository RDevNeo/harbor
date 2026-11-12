; Harbor's setup for Windows (harbor-x86_64-windows-setup.exe), made by makensis on Linux
; (.github/windows-setup.sh). It holds what harbor-x86_64-windows.zip holds and hands it to that folder's
; install.ps1 (-Source), so the setup and `irm .../install.ps1 | iex` install the same way: per user, no
; administrator, %LOCALAPPDATA%\Programs\Harbor, the Start menu entry, Harbor in Settings > Apps (its
; uninstall there is install.ps1's), and Git for Windows, Claude Code, Codex and ripgrep when missing.
; Silent: harbor-x86_64-windows-setup.exe /S (add /DESKTOP for the desktop shortcut).
;
;   makensis -DSRC=DIR -DVERSION=0.180.22 -DVERSION4=0.180.22.0 -DICON=harbor.ico -DBITMAP=harbor-setup.bmp -DOUT=setup.exe setup.nsi
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
; zlib: LZMA saves about a quarter of the download but takes minutes to pack (one core) and to unpack.
!ifndef COMPRESSOR
!define COMPRESSOR zlib
!endif
SetCompressor /SOLID ${COMPRESSOR}

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

Name "Harbor"
Caption "Harbor ${VERSION} Setup"
BrandingText "Harbor ${VERSION}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Harbor"
ShowInstDetails show

VIProductVersion "${VERSION4}"
VIAddVersionKey "ProductName" "Harbor"
VIAddVersionKey "FileDescription" "Harbor Setup"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Harbor"
VIAddVersionKey "LegalCopyright" "MIT licence"

!define MUI_ICON "${ICON}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${BITMAP}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Harbor ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Harbor runs Claude Code and Codex agents for your projects.$\r$\n$\r$\nIt installs for you only (no administrator needed), together with what it needs: Git for Windows, Claude Code, Codex and ripgrep, when they're missing. Windows may ask you once to allow Git.$\r$\n$\r$\nClick Install to continue."
!define MUI_FINISHPAGE_RUN "$INSTDIR\harbor.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Harbor"
; The finish page's second checkbox, used for the desktop shortcut.
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION DesktopShortcut

!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeInstall
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

; The welcome page's Next button says Install: there's nothing to choose before it.
Function WelcomeInstall
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:&Install"
FunctionEnd

Function DesktopShortcut
  CreateShortcut "$DESKTOP\Harbor.lnk" "$INSTDIR\harbor.exe" "" "$INSTDIR\harbor.exe" 0
FunctionEnd

Section "Harbor"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\harbor"
  File /r "${SRC}\*"
  SetOutPath "$TEMP"
  DetailPrint "Installing Harbor ${VERSION}..."
  ; The 64-bit PowerShell (Sysnative: this setup is a 32-bit program, whose System32 is SysWOW64's), or Claude
  ; Code's installer refuses to run.
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\harbor\install.ps1" -Source "$PLUGINSDIR\harbor"'
  Pop $0
  ${If} $0 != 0
    SetDetailsView show
    DetailPrint "install.ps1 exited with $0"
    MessageBox MB_ICONSTOP|MB_OK "Harbor wasn't installed (see the details above)." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ; Silent installs: /DESKTOP asks for the desktop shortcut.
  ${If} ${Silent}
    ${GetParameters} $1
    ClearErrors
    ${GetOptions} $1 "/DESKTOP" $2
    ${IfNot} ${Errors}
      Call DesktopShortcut
    ${EndIf}
  ${EndIf}
SectionEnd
