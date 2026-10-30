@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "NODE_OPTIONS="
set "NODE_PATH="
set "ELECTRON_RUN_AS_NODE="
if not exist "%~dp0resources\node\node.exe" (
  echo Run the copied launcher from an extracted portable demo folder.
  exit /b 2
)
if not exist "%~dp0resources\app\scripts\broker-recovery-diagnostic.cjs" (
  echo The recovery diagnostic is missing. Extract the complete portable demo.
  exit /b 2
)
echo Read-only broker observation. This does not stop or start any process.
echo It cannot establish that no other overlay application uses the broker.
"%~dp0resources\node\node.exe" "%~dp0resources\app\scripts\broker-recovery-diagnostic.cjs" --output-dir "%~dp0logs\broker-recovery" --samples 180 --interval-ms 2000 %*
set "diagnostic_exit=%ERRORLEVEL%"
echo Observation finished. Reports are under logs\broker-recovery.
pause
exit /b %diagnostic_exit%
