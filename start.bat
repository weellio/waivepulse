@echo off
echo Starting WAIvePulse...

:: ── Edit these two paths for your machine ────────────────────────────────────
set PYTHON_EXE=F:\HeartMuLa\venv\Scripts\python.exe
set HEARTMULA_PATH=F:\HeartMuLa\ckpt
:: ─────────────────────────────────────────────────────────────────────────────

:: Free port 7860 if already in use
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7860 " ^| findstr "LISTENING"') do (
    echo Stopping existing server on port 7860...
    taskkill /F /PID %%a >nul 2>&1
)

echo Open http://localhost:7860 in your browser
cd /d "%~dp0backend"
%PYTHON_EXE% -m uvicorn app:app --host 127.0.0.1 --port 7860
pause
