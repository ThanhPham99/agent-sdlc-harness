@echo off
rem The cmd.exe entry point. `bin/agent-sdlc` is a POSIX sh script, which both
rem cmd.exe and PowerShell refuse to run, so the entry point the skills and docs
rem name did not exist on Windows at all.
setlocal
node "%~dp0..\runtime\cli.mjs" %*
exit /b %ERRORLEVEL%
