@echo off
REM Caipira launcher — uses bundled Node 22 when its SQLite addon loads, else Node on PATH.
setlocal
set "CAIPIRA_DIR=%~dp0"
set "CAIPIRA_ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "CAIPIRA_ARCH=arm64"
set "CAIPIRA_NODE=%CAIPIRA_DIR%node22\node-v22.20.0-win-%CAIPIRA_ARCH%\node.exe"
if exist "%CAIPIRA_NODE%" (
  pushd "%CAIPIRA_DIR%"
  "%CAIPIRA_NODE%" -e "require('better-sqlite3')" >nul 2>nul
  if errorlevel 1 set "CAIPIRA_NODE="
  popd
)
if not exist "%CAIPIRA_NODE%" set "CAIPIRA_NODE="
if not defined CAIPIRA_NODE (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [caipira] Node.js 20, 22, or 24 is required; install Node.js or restore the bundled Node 22 runtime.
    exit /b 1
  )
  set "CAIPIRA_NODE=node"
)
"%CAIPIRA_NODE%" "%CAIPIRA_DIR%install.js" %*
endlocal
