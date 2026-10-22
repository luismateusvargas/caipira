@echo off
REM Caipira launcher — always uses the bundled Node 22 runtime.
REM better-sqlite3 is compiled against Node 22's ABI; the system Node 24 will not load it.
setlocal
set "CAIPIRA_DIR=%~dp0"
set "CAIPIRA_ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "CAIPIRA_ARCH=arm64"
set "CAIPIRA_NODE=%CAIPIRA_DIR%node22\node-v22.20.0-win-%CAIPIRA_ARCH%\node.exe"
if not exist "%CAIPIRA_NODE%" (
  echo [caipira] bundled Node 22 runtime not found at "%CAIPIRA_NODE%".
  exit /b 1
)
"%CAIPIRA_NODE%" "%CAIPIRA_DIR%install.js" %*
endlocal
