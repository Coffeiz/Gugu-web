!include "WinMessages.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro customHeader
  ; 允许目录页接受盘符根目录，进入安装页前会改写为应用子目录。
  AllowRootDirInstall true
  ShowInstDetails show
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

; NSIS 的解包进度仅覆盖当前阶段，不能作为整个安装的百分比。
!ifndef BUILD_UNINSTALLER
Function GuguShowInstallProgress
  Push $0
  Push $1
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $0 $0 1004
  ${If} $0 != 0
    System::Call 'user32::GetWindowLong(p r0, i -16) i .r1'
    IntOp $1 $1 | 0x08
    System::Call 'user32::SetWindowLong(p r0, i -16, i r1)'
    SendMessage $0 0x040A 1 35
  ${EndIf}
  DetailPrint "正在准备安装并解包应用文件…"
  Pop $1
  Pop $0
FunctionEnd
!endif

!macro customInstall
  SetDetailsPrint listonly
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
