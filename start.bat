@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "CONF=%SCRIPT_DIR%.waivepulse.bat"

if not exist "%CONF%" (
    echo ERROR: Setup not complete. Run setup.bat first.
    pause & exit /b 1
)

call "%CONF%"

echo Starting WAIvePulse...

:: Free port 7860 if already in use
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7860 " ^| findstr "LISTENING"') do (
    echo Stopping existing server on port 7860...
    taskkill /F /PID %%a >nul 2>&1
)

echo Open http://localhost:7860 in your browser
cd /d "%SCRIPT_DIR%backend"
"%PYTHON_EXE%" -m uvicorn app:app --host 127.0.0.1 --port 7860
pause
