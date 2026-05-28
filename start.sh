#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/.waivepulse"

if [ ! -f "$CONF" ]; then
    echo "ERROR: Setup not complete. Run 'bash setup.sh' first."
    exit 1
fi

# shellcheck source=.waivepulse
source "$CONF"

echo "Starting WAIvePulse..."

# Free port 7861 if already in use
if command -v fuser &>/dev/null && fuser 7861/tcp &>/dev/null 2>&1; then
    echo "Stopping existing server on port 7861..."
    fuser -k 7861/tcp 2>/dev/null || true
fi

export HEARTMULA_PATH

echo "Open http://localhost:7861 in your browser"
cd "$SCRIPT_DIR/backend"
"$PYTHON_EXE" -m uvicorn app:app --host 127.0.0.1 --port 7861
