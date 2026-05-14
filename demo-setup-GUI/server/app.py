"""
Localhost API + static UI for acs-demo-setup.sh (Stages 3–4).
Bind 127.0.0.1 only. All cluster/auth checks live in the bootstrap script — this app only spawns it.
"""
from __future__ import annotations

import atexit
import base64
import json
import os
import re
import signal
import subprocess
import threading
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
CONFIG = ROOT / "config" / "modules.json"

_SKILL_SCRIPT = Path.home() / ".cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh"
_SPLUNK_LAB_SCRIPT = Path.home() / ".cursor/skills/rhacs-splunk-ta-demo-skill/scripts/splunk-lab.sh"

_FAVICON_DATA_URI_CACHE: str | None = None


def _favicon_data_uri() -> str:
    """Inline tab icon: Chromium often skips favicons that only arrive via redirect or second-hop fetch."""
    global _FAVICON_DATA_URI_CACHE
    if _FAVICON_DATA_URI_CACHE is not None:
        return _FAVICON_DATA_URI_CACHE
    p = WEB / "favicon.png"
    if not p.is_file():
        _FAVICON_DATA_URI_CACHE = ""
        return _FAVICON_DATA_URI_CACHE
    _FAVICON_DATA_URI_CACHE = "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode("ascii")
    return _FAVICON_DATA_URI_CACHE


def default_script_path() -> Path:
    """Bootstrap script lives in the Cursor skill only; override with ACS_DEMO_SETUP_SCRIPT."""
    return _SKILL_SCRIPT


def splunk_script_path() -> Path:
    """Splunk lab install/status; override with ACS_SPLUNK_LAB_SCRIPT."""
    return Path(os.environ.get("ACS_SPLUNK_LAB_SCRIPT", str(_SPLUNK_LAB_SCRIPT))).expanduser()

# Manifest id → slug expected by acs-demo-setup.sh / --status (single source for the GUI; echoed in GET /api/modules).
MODULE_ID_CANONICAL_ALIASES: dict[str, str] = {"ocp-OAuth": "ocp-oauth"}

# Slugs accepted from modules.json / UI (must match script + manifest).
KNOWN_MODULE_SLUGS = frozenset(
    {
        "ms-demo",
        "init-demo",
        "registries",
        "ocp-users",
        "ocp-oauth",
        "acs-users",
        "slack-notifier",
        "compliance-operator",
        "splunk",
        "central",
        "roxctl-env",
        "secured-cluster",
    }
)
# Wired to acs-demo-setup.sh --module (incl. slack-notifier); Splunk uses rhacs-splunk-ta-demo-skill/scripts/splunk-lab.sh.
RUNNABLE_SLUGS = frozenset(
    {
        "central",
        "roxctl-env",
        "secured-cluster",
        "ms-demo",
        "init-demo",
        "registries",
        "ocp-users",
        "ocp-oauth",
        "acs-users",
        "slack-notifier",
        "compliance-operator",
        "splunk",
    }
)
DEFERRED_SLUGS = KNOWN_MODULE_SLUGS - RUNNABLE_SLUGS


def canonical_module_slug(slug: str) -> str:
    """Map manifest/UI aliases to the slugs expected by acs-demo-setup.sh."""
    return MODULE_ID_CANONICAL_ALIASES.get(slug, slug)


def _sanitize_status_detail(s: str) -> str:
    """Match acs-demo-setup.sh --status: strip opaque API ids from human-facing detail strings."""
    t = s if isinstance(s, str) else str(s)
    t = re.sub(
        r"\bid\s*=\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
        "",
        t,
        flags=re.I,
    )
    t = re.sub(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        "",
        t,
    )
    t = re.sub(r"\(\s*\)", "", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    t = re.sub(r"^[,;\s]+|[,;\s]+$", "", t)
    return t


def script_module_argument(canonical_slug: str) -> str:
    """Map GUI/status module id → argv token for `acs-demo-setup.sh --module` (bootstrap names differ)."""
    s = canonical_module_slug(canonical_slug)
    bootstrap = {
        "central": "install-central",
        "secured-cluster": "install-secured-cluster",
    }
    return bootstrap.get(s, s)


_lock = threading.Lock()
_running = False
# Long-running bash from POST /api/run (kill on shutdown so Ctrl-C does not leave children behind).
_active_run_proc: subprocess.Popen | None = None
_active_run_proc_lock = threading.Lock()


def _terminate_active_run() -> None:
    """SIGTERM/SIGINT cleanup: stop streaming bash and its process group."""
    global _active_run_proc
    with _active_run_proc_lock:
        proc = _active_run_proc
        _active_run_proc = None
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, AttributeError):
        proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        proc.wait(timeout=3)


def _shutdown_signal(signum: int, frame: object | None) -> None:
    _terminate_active_run()
    signal.signal(signum, signal.SIG_DFL)
    signal.raise_signal(signum)


for _sig in (signal.SIGINT, signal.SIGTERM):
    try:
        signal.signal(_sig, _shutdown_signal)
    except ValueError:
        pass  # not main thread / restricted embed
atexit.register(_terminate_active_run)

app = Flask(__name__, static_folder=str(WEB), static_url_path="")


def subprocess_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Env for bash/oc subprocesses — GUI servers often have a minimal PATH."""
    env = dict(os.environ)
    kube = Path.home() / ".kube" / "config"
    if kube.is_file():
        env.setdefault("KUBECONFIG", str(kube))
    path_extra = env.get("ACS_GUI_EXTRA_PATH", "").strip()
    if path_extra:
        env["PATH"] = path_extra + os.pathsep + env.get("PATH", "")
    else:
        brew = "/opt/homebrew/bin:/usr/local/bin"
        if brew not in env.get("PATH", ""):
            env["PATH"] = brew + os.pathsep + env.get("PATH", "")
    if extra:
        env.update(extra)
    return env


def script_path() -> Path:
    p = os.environ.get("ACS_DEMO_SETUP_SCRIPT", str(default_script_path()))
    return Path(p).expanduser()


def central_credentials_path() -> Path:
    """Same default as acs-demo-setup.sh: <skill>/config/central-credentials.json next to scripts/."""
    p = os.environ.get("ACS_CENTRAL_CREDENTIALS_FILE")
    if p:
        return Path(p).expanduser().resolve()
    sp = script_path().resolve()
    return (sp.parent.parent / "config" / "central-credentials.json").resolve()


CREDENTIALS_SCHEMA_RELPATH = "central-credentials.schema.json"

_DEFAULT_CENTRAL_CREDS: dict[str, str] = {
    "centralEndpoint": "",
    "apiKey": "",
    "adminUsername": "admin",
    "adminPassword": "",
    "authPreference": "apiKey",
}


def merge_splunk_status(data: dict) -> dict:
    """Append/replace `splunk` module row from splunk-lab.sh --status (skill tree)."""
    spl = splunk_script_path()
    if not spl.is_file():
        return data
    try:
        out = subprocess.run(
            [str(spl), "--status"],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
            env=subprocess_env(),
        )
    except subprocess.TimeoutExpired:
        row: dict = {"id": "splunk", "state": "unknown", "detail": "Splunk status subprocess timed out"}
    else:
        if out.returncode != 0:
            tail = (out.stderr or out.stdout or "splunk-lab.sh --status failed").strip()
            row = {"id": "splunk", "state": "unknown", "detail": tail[:450]}
        else:
            try:
                extra = json.loads(out.stdout)
            except json.JSONDecodeError:
                row = {"id": "splunk", "state": "unknown", "detail": "invalid JSON from splunk-lab.sh --status"}
            else:
                rows = extra.get("modules") if isinstance(extra, dict) else None
                if isinstance(rows, list) and rows and isinstance(rows[0], dict):
                    row = dict(rows[0])
                else:
                    row = {"id": "splunk", "state": "unknown", "detail": "empty modules from splunk-lab.sh --status"}
    if isinstance(row.get("detail"), str):
        row["detail"] = _sanitize_status_detail(row["detail"])
    mods = list(data.get("modules") or [])
    replaced = False
    for i, m in enumerate(mods):
        if isinstance(m, dict) and m.get("id") == "splunk":
            mods[i] = row
            replaced = True
            break
    if not replaced:
        mods.append(row)
    data["modules"] = mods
    return data


@app.get("/")
def index():
    body = (WEB / "index.html").read_text(encoding="utf-8")
    uri = _favicon_data_uri()
    if uri:
        body = body.replace("__ACS_GUI_FAVICON_DATA_URI__", uri)
    resp = Response(body, mimetype="text/html; charset=utf-8")
    # Avoid stale <head> (favicon links) when the GUI is iterated locally.
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/favicon.ico")
def favicon_ico():
    """Same PNG as /favicon.png with 200 + image/png (redirect breaks tab binding in some Chromium builds)."""
    return send_from_directory(
        app.static_folder,
        "favicon.png",
        mimetype="image/png",
        max_age=86400,
        conditional=False,
    )


@app.get("/favicon.png")
def favicon_png():
    return send_from_directory(
        app.static_folder,
        "favicon.png",
        mimetype="image/png",
        max_age=86400,
        conditional=False,
    )


@app.get("/api/central-credentials")
def api_central_credentials_get():
    path = central_credentials_path()
    data = dict(_DEFAULT_CENTRAL_CREDS)
    exists = path.is_file()
    if exists:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return jsonify({"error": "invalid or unreadable credentials file", "path": str(path)}), 500
        if isinstance(raw, dict):
            for k in _DEFAULT_CENTRAL_CREDS:
                v = raw.get(k)
                if isinstance(v, str):
                    data[k] = v
                elif v is not None:
                    data[k] = str(v)
    apref = (data.get("authPreference") or "apiKey").strip().lower()
    data["authPreference"] = "password" if apref == "password" else "apiKey"
    return jsonify({"path": str(path), "exists": exists, "data": data})


@app.put("/api/central-credentials")
def api_central_credentials_put():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "JSON object required"}), 400
    out = dict(_DEFAULT_CENTRAL_CREDS)
    for k in _DEFAULT_CENTRAL_CREDS:
        if k not in body:
            continue
        v = body[k]
        if v is None:
            out[k] = ""
        elif isinstance(v, str):
            out[k] = v
        else:
            return jsonify({"error": f"{k} must be a string"}), 400
    if not (out.get("adminUsername") or "").strip():
        out["adminUsername"] = "admin"
    apref = (out.get("authPreference") or "apiKey").strip().lower()
    if apref == "password":
        out["authPreference"] = "password"
    else:
        out["authPreference"] = "apiKey"
    path = central_credentials_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        base: dict = {}
        if path.is_file():
            try:
                prev = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(prev, dict):
                    base = prev
            except (OSError, json.JSONDecodeError):
                base = {}
        merged: dict = {"$schema": CREDENTIALS_SCHEMA_RELPATH}
        for k in _DEFAULT_CENTRAL_CREDS:
            merged[k] = out[k]
        for k, v in base.items():
            if k in merged or k == "$schema":
                continue
            merged[k] = v
        path.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        path.chmod(0o600)
    except OSError as e:
        return jsonify({"error": "write failed", "detail": str(e), "path": str(path)}), 500
    return jsonify({"ok": True, "path": str(path), "data": out})


@app.get("/api/modules")
def api_modules():
    if not CONFIG.is_file():
        return jsonify({"error": "modules.json missing"}), 404
    try:
        data = json.loads(CONFIG.read_text())
    except json.JSONDecodeError:
        return jsonify({"error": "invalid modules.json"}), 500
    if not isinstance(data, dict):
        return jsonify({"error": "modules.json must be a JSON object"}), 500
    out = dict(data)
    out["canonicalAliases"] = dict(MODULE_ID_CANONICAL_ALIASES)
    return jsonify(out)


@app.get("/api/status")
def api_status():
    sp = script_path()
    if not sp.is_file():
        return jsonify(
            {
                "error": "script not found",
                "path": str(sp),
                "hint": "Install or restore ~/.cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh or set ACS_DEMO_SETUP_SCRIPT.",
            }
        ), 500
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
    merge_splunk_status(data)
    return jsonify(data)


@app.post("/api/run")
def api_run():
    global _running
    body = request.get_json(silent=True) or {}
    mods_raw = body.get("modules")
    if mods_raw is None:
        mods_raw = []
    if not isinstance(mods_raw, list):
        return jsonify({"error": "modules must be a list"}), 400
    mods = [canonical_module_slug(m) for m in mods_raw]
    update_roxctl_env = body.get("updateRoxctlEnv") is True

    for m in mods:
        if m not in KNOWN_MODULE_SLUGS:
            return jsonify({"error": f"unknown module: {m}"}), 400
        if m in DEFERRED_SLUGS:
            return (
                jsonify(
                    {
                        "error": f"module not implemented yet: {m}",
                        "detail": "This module is not wired for GUI runs yet.",
                    }
                ),
                501,
            )

    acs_mods = [m for m in mods if m != "splunk"]
    splunk_sel = "splunk" in mods

    sp = script_path()
    if acs_mods and not sp.is_file():
        return jsonify(
            {
                "error": "script not found",
                "path": str(sp),
                "hint": "Install or restore ~/.cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh or set ACS_DEMO_SETUP_SCRIPT.",
            }
        ), 500

    sl = splunk_script_path()
    if splunk_sel and not sl.is_file():
        return jsonify(
            {
                "error": "splunk-lab.sh not found",
                "path": str(sl),
                "hint": "Install rhacs-splunk-ta-demo-skill/scripts/splunk-lab.sh or set ACS_SPLUNK_LAB_SCRIPT.",
            }
        ), 500

    if not _lock.acquire(blocking=False):
        return jsonify({"error": "a run is already in progress"}), 409
    _running = True

    def generate():
        global _running, _active_run_proc
        proc: subprocess.Popen | None = None
        try:
            if acs_mods:
                cmd = [str(sp)]
                if update_roxctl_env:
                    cmd.append("--update-roxctl-env")
                for m in acs_mods:
                    cmd.extend(["--module", script_module_argument(m)])
                run_env = subprocess_env()
                if "ocp-users" in acs_mods:
                    run_env = dict(run_env)
                    run_env["REGENERATE_HTPASSWD"] = "true"
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    env=run_env,
                    start_new_session=True,
                )
                with _active_run_proc_lock:
                    _active_run_proc = proc
                assert proc.stdout is not None
                try:
                    for line in proc.stdout:
                        yield line
                finally:
                    if proc.stdout:
                        proc.stdout.close()
                rc_acs = proc.wait()
                yield f"\n___EXIT_CODE_{rc_acs}___\n"
                proc = None
                with _active_run_proc_lock:
                    _active_run_proc = None
                if rc_acs != 0:
                    return

            if splunk_sel:
                yield "\n==> [GUI] Splunk lab (splunk-lab.sh install)\n"
                proc = subprocess.Popen(
                    [str(sl), "install"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    env=subprocess_env(),
                    start_new_session=True,
                )
                with _active_run_proc_lock:
                    _active_run_proc = proc
                assert proc.stdout is not None
                try:
                    for line in proc.stdout:
                        yield line
                finally:
                    if proc.stdout:
                        proc.stdout.close()
                rc_sp = proc.wait()
                yield f"\n___EXIT_CODE_{rc_sp}___\n"
        except GeneratorExit:
            if proc is not None and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        proc.kill()
            raise
        finally:
            with _active_run_proc_lock:
                _active_run_proc = None
            _running = False
            _lock.release()

    return Response(generate(), mimetype="text/plain; charset=utf-8")


def main():
    host = os.environ.get("ACS_GUI_BIND", "127.0.0.1")
    port = int(os.environ.get("ACS_GUI_PORT", "8765"))
    print(f"ACS demo GUI  http://{host}:{port}")
    print(f"Script: {script_path()}")
    print(f"Central credentials: {central_credentials_path()}")
    print(f"Splunk lab: {splunk_script_path()}")
    app.run(host=host, port=port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
