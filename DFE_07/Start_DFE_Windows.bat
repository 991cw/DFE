@echo off
cd /d "%~dp0"
where py >nul 2>&1
if %errorlevel%==0 (
    py -3 DFE_local_server.py
) else (
    python DFE_local_server.py
)
pause
