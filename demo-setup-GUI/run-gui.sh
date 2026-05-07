#!/usr/bin/env bash
# Local GUI for acs-demo-setup (Stage 4). Requires server/.venv (see README).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_SCRIPT="${ROOT}/scripts/acs-demo-setup.sh"
SKILL_SCRIPT="${HOME}/.cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh"
if [[ -z "${ACS_DEMO_SETUP_SCRIPT:-}" ]]; then
  if [[ -f "${REPO_SCRIPT}" ]]; then
    export ACS_DEMO_SETUP_SCRIPT="${REPO_SCRIPT}"
  else
    export ACS_DEMO_SETUP_SCRIPT="${SKILL_SCRIPT}"
  fi
fi

# Same defaults as server subprocess_env() — GUI often starts with a thin PATH.
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

echo "==> OpenShift (same env the GUI will use for oc)"
if command -v oc >/dev/null 2>&1; then
  echo "    oc: $(command -v oc)"
  oc whoami && echo "    oc whoami: OK" || echo "    WARNING: oc whoami failed — log in (oc login ...) then restart this script." >&2
else
  echo "    WARNING: oc not on PATH. Install oc or set PATH / ACS_GUI_EXTRA_PATH." >&2
fi
echo ""

GUI_PORT="${ACS_GUI_PORT:-8765}"
if PIDs_listen="$(lsof -nP -tiTCP:"${GUI_PORT}" -sTCP:LISTEN 2>/dev/null)" && [[ -n "${PIDs_listen}" ]]; then
  echo "ERROR: Port ${GUI_PORT} is already in use (leftover listener). Stop it first, do not change ports blindly." >&2
  lsof -nP -iTCP:"${GUI_PORT}" -sTCP:LISTEN >&2 || true
  echo "Example:  kill -TERM ${PIDs_listen//$'\n'/ }" >&2
  exit 1
fi

GUI_URL="http://${ACS_GUI_BIND:-127.0.0.1}:${GUI_PORT}/"
open_gui_url() {
  local u="$1"
  if command -v open >/dev/null 2>&1; then
    open "$u"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$u"
  fi
}
# Brief delay so Flask binds before the browser loads.
(sleep 1; open_gui_url "${GUI_URL}") &

exec "${ROOT}/server/.venv/bin/python" "${ROOT}/server/app.py"
