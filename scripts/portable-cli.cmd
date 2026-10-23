@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0DiffEditor.exe" "%~dp0cli.cjs" %*
exit /b %errorlevel%
