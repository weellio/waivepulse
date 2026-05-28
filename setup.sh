#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/.waivepulse"

# ── You can change these, but the defaults should work for most people ─────────
VENV_DIR="${WAIVEPULSE_VENV:-$HOME/HeartMuLa/venv}"
HEARTMULA_PATH="${WAIVEPULSE_CKPT:-$HOME/HeartMuLa/ckpt}"
# ─────────────────────────────────────────────────────────────────────────────

PYTHON_EXE="$VENV_DIR/bin/python"

echo "================================================"
echo "  WAIvePulse Setup"
echo "================================================"
echo ""
echo "  Venv   : $VENV_DIR"
echo "  Models : $HEARTMULA_PATH"
echo ""

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/6] Installing system packages..."
if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y python3 python3-venv python3-pip ffmpeg git curl
elif command -v dnf &>/dev/null; then
    sudo dnf install -y python3 python3-pip ffmpeg git curl
elif command -v pacman &>/dev/null; then
    sudo pacman -Sy --noconfirm python python-pip ffmpeg git curl
else
    echo "  WARNING: Unknown package manager. Ensure python3 (3.10+), ffmpeg, and git are installed."
fi

# ── 2. Python version check ───────────────────────────────────────────────────
# Prefer python3.11, then 3.10, then plain python3
for candidate in python3.11 python3.10 python3; do
    if command -v "$candidate" &>/dev/null; then
        PYTHON_BIN=$(command -v "$candidate")
        break
    fi
done

PY_MAJOR=$("$PYTHON_BIN" -c "import sys; print(sys.version_info.major)")
PY_MINOR=$("$PYTHON_BIN" -c "import sys; print(sys.version_info.minor)")
PY_VER="$PY_MAJOR.$PY_MINOR"

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    echo ""
    echo "ERROR: Python 3.10 or newer is required (found $PY_VER)."
    echo "  Ubuntu 22.04+: sudo apt install python3.11"
    echo "  Or download from: https://www.python.org/downloads/"
    exit 1
fi
echo "  Python $PY_VER OK."

# ── 3. NVIDIA GPU + CUDA check ────────────────────────────────────────────────
echo "[2/6] Checking GPU..."
if ! command -v nvidia-smi &>/dev/null; then
    echo ""
    echo "ERROR: nvidia-smi not found — NVIDIA GPU drivers are not installed."
    echo "  Ubuntu: https://ubuntu.com/server/docs/nvidia-drivers-installation"
    echo "  Run:    sudo ubuntu-drivers install"
    exit 1
fi

GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -1)
echo "  GPU: $GPU_NAME ($GPU_MEM)"

CUDA_MAJOR=$(nvidia-smi | grep -oP 'CUDA Version: \K[0-9]+' | head -1)
echo "  CUDA $CUDA_MAJOR detected."

case "$CUDA_MAJOR" in
    12) TORCH_IDX="https://download.pytorch.org/whl/cu124" ;;
    11) TORCH_IDX="https://download.pytorch.org/whl/cu118" ;;
    *)  TORCH_IDX="https://download.pytorch.org/whl/cu124" ;;
esac

# ── 4. Create virtual environment ─────────────────────────────────────────────
echo "[3/6] Creating virtual environment..."
mkdir -p "$(dirname "$VENV_DIR")"
"$PYTHON_BIN" -m venv "$VENV_DIR"
"$PYTHON_EXE" -m pip install --upgrade pip --quiet
echo "  Venv ready at $VENV_DIR"

# ── 5. PyTorch ────────────────────────────────────────────────────────────────
echo "[4/6] Installing PyTorch (CUDA $CUDA_MAJOR)..."
"$PYTHON_EXE" -m pip install torch torchvision torchaudio \
    --index-url "$TORCH_IDX" --quiet
echo "  PyTorch installed."

# ── 6. heartlib + WAIvePulse dependencies ─────────────────────────────────────
echo "[5/6] Installing heartlib and WAIvePulse dependencies..."
HEARTLIB_DIR="$(dirname "$VENV_DIR")/heartlib"
if [ ! -d "$HEARTLIB_DIR/.git" ]; then
    git clone https://github.com/HeartMuLa/heartlib.git "$HEARTLIB_DIR"
else
    echo "  heartlib repo already cloned, pulling latest..."
    git -C "$HEARTLIB_DIR" pull --quiet
fi
"$PYTHON_EXE" -m pip install -e "$HEARTLIB_DIR" --quiet
"$PYTHON_EXE" -m pip install -r "$SCRIPT_DIR/requirements.txt" --quiet
echo "  All dependencies installed."

# ── 7. Download model weights ─────────────────────────────────────────────────
echo "[6/6] Downloading HeartMuLa model weights (~21 GB)..."
echo "  This may take a while — do not close this window."
mkdir -p "$HEARTMULA_PATH"
HEARTMULA_PATH="$HEARTMULA_PATH" "$PYTHON_EXE" "$SCRIPT_DIR/scripts/download_models.py"

# ── Write config for start.sh ─────────────────────────────────────────────────
cat > "$CONF" <<EOF
PYTHON_EXE="$PYTHON_EXE"
HEARTMULA_PATH="$HEARTMULA_PATH"
EOF

echo ""
echo "================================================"
echo "  Setup complete!"
echo ""
echo "  To launch WAIvePulse:"
echo "    bash start.sh"
echo "  Then open: http://localhost:7861"
echo "================================================"
