; 支持可选的整机安装时，使用当前令牌可获得的最高权限级别。
!ifndef MULTIUSER_EXECUTIONLEVEL
  !define MULTIUSER_EXECUTIONLEVEL Highest
!endif

!include "WinMessages.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro GuguUpgradeExistingInstall
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    GetFullPathName $0 "$0\."
    GetFullPathName $1 "$INSTDIR\."
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 != $1
    !insertmacro uninstallOldVersion SHELL_CONTEXT
    !insertmacro handleUninstallResult SHELL_CONTEXT
  ${EndIf}
!macroend

!macro customHeader
  ; 允许目录页接受盘符根目录，进入安装页前会改写为应用子目录。
  AllowRootDirInstall true
  ShowInstDetails nevershow
  !ifndef BUILD_UNINSTALLER
    !ifdef GUGU_INSTALL_SECTION_DIR
      !cd "${GUGU_INSTALL_SECTION_DIR}"
    !endif
  !endif
!macroend

!macro customPageAfterChangeDir
  Page custom GuguNormalizeInstallRoot
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW GuguShowInstallProgress

  Function GuguNormalizeInstallRoot
    Push $0
    Push $1
    GetFullPathName $0 "$INSTDIR"
    ${GetRoot} "$0" $1
    ${If} $1 != ""
      ${If} $0 == "$1\"
      ${OrIf} $0 == "$1"
        StrCpy $INSTDIR "$1\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
    ; 跳过占位页，直接进入正常的安装进度页。
    Abort
  FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER
Function GuguShowInstallProgress
  DetailPrint "正在写入应用文件…"
  ; NSIS 默认在 InstFiles 页禁用取消按钮；安装步骤支持取消确认后显式启用。
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 1
FunctionEnd
; electron-builder 的 MUI_ABORTWARNING 已提供取消确认，避免重复定义 .onUserAbort。
!endif

!macro customInstall
  SetDetailsPrint textonly
  DetailPrint "应用文件已写入，安装信息和快捷方式已处理。"
  DetailPrint "正在注册咕咕命令行工具…"
  ${If} $installMode == "all"
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "$INSTDIR\cli\path.ps1" -AllUsers' $0
  ${Else}
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "$INSTDIR\cli\path.ps1"' $0
  ${EndIf}
  ${If} $0 != 0
    DetailPrint "咕咕 CLI 的 PATH 注册失败"
  ${EndIf}
  DetailPrint "正在通知 Windows 更新环境变量…"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000
!macroend

!macro customUnInstall
  ${If} $installMode == "all"
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "$INSTDIR\cli\path.ps1" -Remove -AllUsers'
  ${Else}
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "$INSTDIR\cli\path.ps1" -Remove'
  ${EndIf}
  Delete "$INSTDIR\cli\.gugu-path"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000
!macroend
