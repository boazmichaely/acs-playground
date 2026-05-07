# ACS demo setup — GUI project (working folder)

This directory holds **documentation and (later) code** for a localhost web UI and API that orchestrates the existing ACS demo bootstrap script. The **bash script remains the implementation** in the Cursor skill; this repo tracks the GUI/backend work and written plans only.

## Canonical paths

| What | Where |
|------|--------|
| Bootstrap script (**GitHub canonical**) | **`demo-setup-GUI/scripts/acs-demo-setup.sh`** (CR YAML defaults in the same **`scripts/`** folder) |
| Bootstrap script (Cursor skill mirror, optional) | `~/.cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh` |
| Skill metadata / workflow notes | `~/.cursor/skills/acs-demo-setup/SKILL.md` |
| This project (plans, server + UI + scripts) | `~/code/ACS playground/demo-setup-GUI/` |

## Default behavior (non-negotiable)

Until explicitly changed in the skill script and documented here: **running the script with no module flags must behave as today — install everything** (full demo path). Any modular flags are **additive opt-in**; the default invocation is all modules in the correct dependency order.

**Module numbers `1`–`8`** (names + script map + **6–8** deferred) are in **`docs/PROJECT_PLAN.md` §2**.

## Where to read first (pause / resume)

**`docs/PROJECT_PLAN.md`** — staged plan, exit criteria, and **§8 Progress log** (append-only; each row **When** = **`YYYY-MM-DD HH:MM:SS`** local).

After a break: read **§8 from the bottom** for latest state and **next** action.

## Run the GUI (Stage 4)

The backend only **starts** `acs-demo-setup.sh` — same as running it in a terminal. Preflight (OpenShift, Central, env) is implemented **inside the script** (`--status` JSON); the GUI displays that payload.

Start from a shell where your demo env is loaded (`ACS_CENTRAL_URL`, credentials, etc.):

```bash
cd ~/code/ACS\ playground/demo-setup-GUI
# one-time:
python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt
./run-gui.sh
```

`run-gui.sh` sets a default **`KUBECONFIG`** and prepends common Homebrew **`PATH`** entries so the **script subprocess** can find `oc`/`curl` when the GUI server has a minimal PATH. Override if needed:

```bash
export ACS_GUI_EXTRA_PATH="/directory/containing/oc"
```

Open **http://127.0.0.1:8765** — **Refresh status** runs **`acs-demo-setup.sh --status`** and shows preflight + modules.

The UI uses **PatternFly 5** (jsDelivr) plus project-local **`web/demo-setup.css`** (layout/tokens aligned with ACS-style prototypes; no dependency on other repos).

**Run full default** calls the script with **no** `--module` flags (same as CLI default).

Override script path: `export ACS_DEMO_SETUP_SCRIPT=/path/to/acs-demo-setup.sh`  
Default if unset: **`./scripts/acs-demo-setup.sh`** in this repo when that file exists (else falls back to the skill path via server default).

Optional: `ACS_GUI_PORT=9000 ./run-gui.sh`

## Review

Plan: **`docs/PROJECT_PLAN.md`**. Implementation through **Stage 4** is ready for your UI review; Stage 5 (structured progress lines) not built yet.
