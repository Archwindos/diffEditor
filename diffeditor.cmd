@echo off
setlocal
node "%~dp0dist-electron\cli.cjs" %*
exit /b %errorlevel%
