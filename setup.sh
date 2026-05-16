#!/usr/bin/env bash
set -e

echo "WAIvePulse Setup"
echo "================"

# ── Edit these two paths for your machine ─────────────────────────────────────
PYTHON_EXE="$HOME/HeartMuLa/venv/bin/python"
HEARTMULA_PATH="$HOME/HeartMuLa/ckpt"
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Verify the Python exe exists
if [ ! -f "$PYTHON_EXE" ]; then
    echo ""
    echo "ERROR: Python not found at: $PYTHON_EXE"
    echo "Edit the PYTHON_EXE line at the top of this script to point to your"
    echo "HeartMuLa virtualenv's Python interpreter."
    exit 1
fi

echo ""
echo "Python : $PYTHON_EXE"
echo "Models : $HEARTMULA_PATH"
echo ""

# Install Python dependencies
echo "Installing dependencies..."
"$PYTHON_EXE" -m pip install --upgrade pip
"$PYTHON_EXE" -m pip install -r "$SCRIPT_DIR/requirements.txt"

# Download model weights
echo ""
echo "Downloading HeartMuLa model weights (~21 GB, this will take a while)..."
HEARTMULA_PATH="$HEARTMULA_PATH" "$PYTHON_EXE" "$SCRIPT_DIR/scripts/download_models.py"

echo ""
echo "Setup complete!"
echo "Run ./start.sh to launch WAIvePulse, then open http://localhost:7860"
