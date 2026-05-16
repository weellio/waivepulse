@echo off
echo WAIvePulse Setup
echo ================

:: ── Edit these two paths for your machine ────────────────────────────────────
set PYTHON_EXE=F:\HeartMuLa\venv\Scripts\python.exe
set HEARTMULA_PATH=F:\HeartMuLa\ckpt
:: ─────────────────────────────────────────────────────────────────────────────

if not exist "%PYTHON_EXE%" (
    echo.
    echo ERROR: Python not found at: %PYTHON_EXE%
    echo Edit the PYTHON_EXE line at the top of this script to point to your
    echo HeartMuLa virtualenv's Python interpreter.
    pause
    exit /b 1
)

echo.
echo Python : %PYTHON_EXE%
echo Models : %HEARTMULA_PATH%
echo.

echo Installing dependencies...
%PYTHON_EXE% -m pip install --upgrade pip
%PYTHON_EXE% -m pip install -r "%~dp0requirements.txt"

echo.
echo Downloading HeartMuLa model weights (~21 GB, this will take a while)...
%PYTHON_EXE% "%~dp0scripts\download_models.py"

echo.
echo Setup complete!
echo Run start.bat to launch WAIvePulse, then open http://localhost:7860
pause
