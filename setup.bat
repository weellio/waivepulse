@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "CONF=%SCRIPT_DIR%.waivepulse.bat"

:: ── You can change these, but the defaults should work for most people ────────
if not defined WAIVEPULSE_VENV   set "VENV_DIR=%USERPROFILE%\HeartMuLa\venv"
if not defined WAIVEPULSE_CKPT   set "HEARTMULA_PATH=%USERPROFILE%\HeartMuLa\ckpt"
:: ─────────────────────────────────────────────────────────────────────────────

set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"

echo ================================================
echo   WAIvePulse Setup
echo ================================================
echo.
echo   Venv   : %VENV_DIR%
echo   Models : %HEARTMULA_PATH%
echo.

:: ── 1. Install system tools via winget ───────────────────────────────────────
echo [1/6] Installing system tools...

where python >nul 2>&1
if errorlevel 1 (
    echo   Python not found. Installing via winget...
    winget install --id Python.Python.3.11 -e --silent --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo.
        echo ERROR: Could not install Python automatically.
        echo   Download Python 3.11 from: https://www.python.org/downloads/
        echo   Make sure to check "Add Python to PATH" during installation.
        pause & exit /b 1
    )
    :: Refresh PATH so python is found
    call RefreshEnv.cmd >nul 2>&1 || (
        echo   Please close and re-open this window after Python installs, then re-run setup.bat
        pause & exit /b 1
    )
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo   ffmpeg not found. Installing via winget...
    winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements
)

:: ── 2. Python version check ───────────────────────────────────────────────────
for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PY_VER=%%v
for /f "tokens=1,2 delims=." %%a in ("%PY_VER%") do (
    set PY_MAJOR=%%a
    set PY_MINOR=%%b
)
echo   Python %PY_VER% found.
if %PY_MAJOR% LSS 3 goto :pytoold
if %PY_MAJOR% EQU 3 if %PY_MINOR% LSS 10 goto :pytoold
goto :pyok
:pytoold
echo.
echo ERROR: Python 3.10 or newer is required (found %PY_VER%).
echo   Download from: https://www.python.org/downloads/
pause & exit /b 1
:pyok

:: ── 3. NVIDIA GPU + CUDA check ────────────────────────────────────────────────
echo [2/6] Checking GPU...
where nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: NVIDIA GPU drivers not found.
    echo   Download drivers from: https://www.nvidia.com/Download/index.aspx
    pause & exit /b 1
)

for /f "delims=" %%g in ('nvidia-smi --query-gpu=name --format=csv,noheader 2^>nul') do set GPU_NAME=%%g
for /f "delims=" %%m in ('nvidia-smi --query-gpu=memory.total --format=csv,noheader 2^>nul') do set GPU_MEM=%%m
echo   GPU: %GPU_NAME% (%GPU_MEM%)

set "TORCH_IDX=https://download.pytorch.org/whl/cu124"
nvidia-smi | findstr "CUDA Version: 11" >nul 2>&1 && set "TORCH_IDX=https://download.pytorch.org/whl/cu118"
nvidia-smi | findstr "CUDA Version: 12" >nul 2>&1 && set "TORCH_IDX=https://download.pytorch.org/whl/cu124"

:: ── 4. Create virtual environment ─────────────────────────────────────────────
echo [3/6] Creating virtual environment...
if not exist "%VENV_DIR%\.." mkdir "%VENV_DIR%\.."
python -m venv "%VENV_DIR%"
"%PYTHON_EXE%" -m pip install --upgrade pip --quiet
echo   Venv ready at %VENV_DIR%

:: ── 5. PyTorch ────────────────────────────────────────────────────────────────
echo [4/6] Installing PyTorch...
"%PYTHON_EXE%" -m pip install torch torchvision torchaudio --index-url "%TORCH_IDX%" --quiet
echo   PyTorch installed.

:: ── 6. heartlib + WAIvePulse dependencies ─────────────────────────────────────
echo [5/6] Installing heartlib and WAIvePulse dependencies...
for %%d in ("%VENV_DIR%") do set "HEARTLIB_DIR=%%~dpd\heartlib"
if not exist "%HEARTLIB_DIR%\.git" (
    git clone https://github.com/HeartMuLa/heartlib.git "%HEARTLIB_DIR%"
) else (
    echo   heartlib repo already cloned, pulling latest...
    git -C "%HEARTLIB_DIR%" pull --quiet
)
"%PYTHON_EXE%" -m pip install -e "%HEARTLIB_DIR%" --quiet
"%PYTHON_EXE%" -m pip install -r "%SCRIPT_DIR%requirements.txt" --quiet
echo   All dependencies installed.

:: ── 7. Download model weights ─────────────────────────────────────────────────
echo [6/6] Downloading HeartMuLa model weights (~21 GB)...
echo   This may take a while - do not close this window.
if not exist "%HEARTMULA_PATH%" mkdir "%HEARTMULA_PATH%"
set HEARTMULA_PATH=%HEARTMULA_PATH%
"%PYTHON_EXE%" "%SCRIPT_DIR%scripts\download_models.py"

:: ── Write config for start.bat ────────────────────────────────────────────────
(
    echo set "PYTHON_EXE=%PYTHON_EXE%"
    echo set "HEARTMULA_PATH=%HEARTMULA_PATH%"
) > "%CONF%"

echo.
echo ================================================
echo   Setup complete!
echo.
echo   To launch WAIvePulse: run start.bat
echo   Then open: http://localhost:7861
echo ================================================
pause
