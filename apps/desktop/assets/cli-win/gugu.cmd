@echo off
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
set "GUGU_DESKTOP_CLI_CONNECTION=%APPDATA%\com.gugu.desktop.preview\cli-connection.json"
"%~dp0..\resources\core-sidecar\gugu-core.exe" --cli %*
exit /b %ERRORLEVEL%
