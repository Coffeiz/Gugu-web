!include "WinMessages.nsh"

!macro customInstall
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "$INSTDIR\cli\path.ps1"' $0
  ${If} $0 != 0
    DetailPrint "咕咕 CLI 的 PATH 注册失败"
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000
!macroend

!macro customUnInstall
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "$INSTDIR\cli\path.ps1" -Remove'
  Delete "$INSTDIR\cli\.gugu-path"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000
!macroend
