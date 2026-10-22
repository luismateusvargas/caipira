@echo off
REM Caipira launcher — always uses the deployment's pinned Node 22 runtime.
setlocal
set "CAIPIRA_DIR=%~dp0"
set "CAIPIRA_ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "CAIPIRA_ARCH=arm64"
set "CAIPIRA_NODE=%CAIPIRA_DIR%node22\node-v22.23.4-win-%CAIPIRA_ARCH%\node.exe"
if not exist "%CAIPIRA_NODE%" (
  echo [caipira] bundled Node 22.23.4 is missing; run caipira install 1>&2
  exit /b 1
)
for /f "delims=" %%V in ('"%CAIPIRA_NODE%" --version 2^>nul') do set "CAIPIRA_VERSION=%%V"
if not "%CAIPIRA_VERSION%"=="v22.23.4" (
  echo [caipira] bundled Node 22.23.4 is invalid; run caipira install 1>&2
  exit /b 1
)
"%CAIPIRA_NODE%" "%CAIPIRA_DIR%install.js" %*
endlocal
