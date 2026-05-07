"""
Localhost API + static UI for acs-demo-setup.sh (Stages 3–4).
Bind 127.0.0.1 only. All cluster/auth checks live in the bootstrap script — this app only spawns it.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
CONFIG = ROOT / "config" / "modules.json"

_REPO_SCRIPT = ROOT / "scripts" / "acs-demo-setup.sh"
_SKILL_SCRIPT = Path.home() / ".cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh"


def default_script_path() -> Path:
    """Implementation lives in the Cursor skill; repo copy is GitHub backup only."""
    if _SKILL_SCRIPT.is_file():
        return _SKILL_SCRIPT
    return _REPO_SCRIPT

# Slugs accepted from modules.json / UI (must match script + manifest).
KNOWN_MODULE_SLUGS = frozenset(
    {
        "ms-demo",
        "registries",
        "ocp-users",
        "ocp-oauth",
        "acs-users",
        "splunk",
        "central",
        "secured-cluster",
    }
)
# Implemented in acs-demo-setup.sh today (modules 1–5).
RUNNABLE_SLUGS = frozenset(
    {"ms-demo", "registries", "ocp-users", "ocp-oauth", "acs-users"}
)
DEFERRED_SLUGS = KNOWN_MODULE_SLUGS - RUNNABLE_SLUGS


def canonical_module_slug(slug: str) -> str:
    """Map manifest/UI aliases to the slugs expected by acs-demo-setup.sh."""
    # Bash script only accepts lowercase ocp-oauth; allow ocp-OAuth in modules.json id/label style.
    aliases = {"ocp-OAuth": "ocp-oauth"}
    return aliases.get(slug, slug)


_lock = threading.Lock()
_running = False

app = Flask(__name__, static_folder=str(WEB), static_url_path="")


def subprocess_env() -> dict[str, str]:
    """Env for bash/oc subprocesses — GUI servers often have a minimal PATH."""
    env = dict(os.environ)
    kube = Path.home() / ".kube" / "config"
    if kube.is_file():
        env.setdefault("KUBECONFIG", str(kube))
    extra = env.get("ACS_GUI_EXTRA_PATH", "").strip()
    if extra:
        env["PATH"] = extra + os.pathsep + env.get("PATH", "")
    else:
        brew = "/opt/homebrew/bin:/usr/local/bin"
        if brew not in env.get("PATH", ""):
            env["PATH"] = brew + os.pathsep + env.get("PATH", "")
    return env


def script_path() -> Path:
    p = os.environ.get("ACS_DEMO_SETUP_SCRIPT", str(default_script_path()))
    return Path(p).expanduser()


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/modules")
def api_modules():
    if not CONFIG.is_file():
        return jsonify({"error": "modules.json missing"}), 404
    return Response(CONFIG.read_text(), mimetype="application/json")


@app.get("/api/status")
def api_status():
    sp = script_path()
    if not sp.is_file():
        return jsonify({"error": f"script not found: {sp}"}), 500
    env = subprocess_env()
    try:
        out = subprocess.run(
            [str(sp), "--status"],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": "status timed out"}), 504
    if out.returncode != 0:
        return (
            jsonify(
                {
                    "error": "status failed",
                    "stderr": out.stderr[-8000:],
                    "stdout": out.stdout[-8000:],
                    "code": out.returncode,
                }
            ),
            500,
        )
    try:
        data = json.loads(out.stdout)
    except json.JSONDecodeError:
        return jsonify({"error": "invalid JSON from script", "raw": out.stdout[-8000:]}), 500
    return jsonify(data)


@app.post("/api/run")
def api_run():
    global _running
    sp = script_path()
    if not sp.is_file():
        return jsonify({"error": f"script not found: {sp}"}), 500

    body = request.get_json(silent=True) or {}
    mods_raw = body.get("modules")
    if mods_raw is None:
        mods_raw = []
    if not isinstance(mods_raw, list):
        return jsonify({"error": "modules must be a list"}), 400
    mods = [canonical_module_slug(m) for m in mods_raw]
    for m in mods:
        if m not in KNOWN_MODULE_SLUGS:
            return jsonify({"error": f"unknown module: {m}"}), 400
        if m in DEFERRED_SLUGS:
            return (
                jsonify(
                    {
                        "error": f"module not implemented yet: {m}",
                        "detail": "This module is not wired for GUI runs yet; use acs-demo-setup.sh from a terminal. Refresh status still reports Central and secured-cluster.",
                    }
                ),
                501,
            )

    if not _lock.acquire(blocking=False):
        return jsonify({"error": "a run is already in progress"}), 409
    _running = True

    def generate():
        global _running
        try:
            cmd = [str(sp)]
            for m in mods:
                cmd.extend(["--module", m])
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=subprocess_env(),
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                yield line
            proc.wait()
            yield f"\n___EXIT_CODE_{proc.returncode}___\n"
        finally:
            _running = False
            _lock.release()

    return Response(generate(), mimetype="text/plain; charset=utf-8")


def main():
    host = os.environ.get("ACS_GUI_BIND", "127.0.0.1")
    port = int(os.environ.get("ACS_GUI_PORT", "8765"))
    print(f"ACS demo GUI  http://{host}:{port}")
    print(f"Script: {script_path()}")
    app.run(host=host, port=port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
