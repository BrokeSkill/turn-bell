#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
WIN_DIR="${WIN_DIR:-/mnt/windows/AppData/Local/hermes/desktop-plugins}"
ID=turn-bell

mkdir -p "$HERMES_HOME_DIR/desktop-plugins/$ID" "$HERMES_HOME_DIR/plugins/$ID/dashboard"

install -m 644 "$SRC/plugin.js" "$HERMES_HOME_DIR/desktop-plugins/$ID/plugin.js"
install -m 644 "$SRC/backend/plugin_api.py" "$HERMES_HOME_DIR/plugins/$ID/dashboard/plugin_api.py"
install -m 644 "$SRC/backend/manifest.json" "$HERMES_HOME_DIR/plugins/$ID/dashboard/manifest.json"
install -m 644 "$SRC/backend/plugin.yaml" "$HERMES_HOME_DIR/plugins/$ID/plugin.yaml"
install -m 644 "$SRC/backend/__init__.py" "$HERMES_HOME_DIR/plugins/$ID/__init__.py"

if [ -d "$WIN_DIR" ]; then
  mkdir -p "$WIN_DIR/$ID"
  install -m 644 "$SRC/plugin.js" "$WIN_DIR/$ID/plugin.js"
  echo "desktop half mirrored to $WIN_DIR/$ID"
else
  echo "windows scan dir not mounted; copy plugin.js into %LOCALAPPDATA%\\hermes\\desktop-plugins\\$ID\\ manually"
fi

python3 - "$HERMES_HOME_DIR" <<'PY'
import json
import pathlib
import subprocess
import sys

import yaml

home = pathlib.Path(sys.argv[1])
config = home / "config.yaml"
enabled = yaml.safe_load(config.read_text())["plugins"]["enabled"]
if "turn-bell" in enabled:
    print("turn-bell already enabled")
else:
    enabled.append("turn-bell")
    subprocess.run(["hermes", "config", "set", "plugins.enabled", json.dumps(enabled)], check=True)
    print("enabled turn-bell")
PY

systemctl --user restart hermes-dashboard.service 2>/dev/null || true
echo "turn-bell installed. Restart the Hermes desktop app to load the composer bell."
