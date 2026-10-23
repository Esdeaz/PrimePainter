@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0release\PrimePainter-0.1.1.exe" (
  start "PrimePainter" "%~dp0release\PrimePainter-0.1.1.exe"
  exit /b
)
if exist "%~dp0PrimePainter.exe" (
  start "PrimePainter" "%~dp0PrimePainter.exe"
  exit /b
)
if not exist "node_modules\electron\dist\electron.exe" (
  where npm >nul 2>nul
  if errorlevel 1 goto missing_node
  call npm install
  if errorlevel 1 goto failed
)
if not exist "dist\index.html" (
  where npm >nul 2>nul
  if errorlevel 1 goto missing_node
  call npm run build
  if errorlevel 1 goto failed
)
set ELECTRON_RUN_AS_NODE=
start "PrimePainter" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
exit /b
:missing_node
echo Node.js and npm are needed to build PrimePainter from source.
echo Alternatively, run the portable PrimePainter executable from release.
pause
exit /b 1
:failed
echo PrimePainter could not be built. See the error above.
pause
exit /b 1
