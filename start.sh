#!/usr/bin/env bash
set -e

echo "Starting WAIvePulse..."

# ── Edit these two paths for your machine ─────────────────────────────────────
PYTHON_EXE="$HOME/HeartMuLa/venv/bin/python"
HEARTMULA_PATH="$HOME/HeartMuLa/ckpt"
# ─────────────────────────────────────────────────────────────────────────────

# Free port 7860 if already in use
if command -v fuser &>/dev/null && fuser 7860/tcp &>/dev/null 2>&1; then
    echo "Stopping existing server on port 7860..."
    fuser -k 7860/tcp 2>/dev/null || true
fi

export PYTHON_EXE
export HEARTMULA_PATH

echo "Open http://localhost:7860 in your browser"
cd "$(dirname "$0")/backend"
"$PYTHON_EXE" -m uvicorn app:app --host 127.0.0.1 --port 7860
