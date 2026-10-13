@echo off
rem Sanmou Viewer launcher.
rem NOTE: keep this file ASCII-only -- cmd.exe misparses batch files that
rem contain non-ASCII characters (commands get split at wrong offsets).
setlocal
cd /d "%~dp0"
chcp 65001 >nul

set PY=python
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python 3.9+ and add it to PATH.
  pause
  exit /b 1
)

echo Checking dependencies...
%PY% -c "import flask" >nul 2>nul
if errorlevel 1 (
  echo Installing flask ...
  %PY% -m pip install flask
)

echo Starting server at http://127.0.0.1:8770 (Ctrl+C to stop) ...
%PY% run.py %*
if errorlevel 1 pause
