# ACS demo setup — localhost GUI

Flask on **`127.0.0.1`** + static UI. It **spawns** `acs-demo-setup.sh`; all cluster/Central logic stays in the **Cursor skill** (not in this repo).

## Paths

| What | Where |
|------|--------|
| Bootstrap (**implementation**) | `~/.cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh` (+ `central-cr-minimal.yaml`, `secured-cluster-cr-minimal.yaml`) |
| Skill notes | `~/.cursor/skills/acs-demo-setup/SKILL.md`, **`REFERENCE.md`** |
| Plan / module map | **`docs/PROJECT_PLAN.md`** (§2 modules, §8 log) |

**Repos:** this tree → **acs-playground** (https://github.com/boazmichaely/acs-playground). Skill → **`my-cursor-skills`** (https://github.com/boazmichaely/my-cursor-skills); commit from **`~/.cursor/skills`**. Workspace rule: **`../.cursor/rules/acs-repositories.mdc`** (from repo root).

Override: **`ACS_DEMO_SETUP_SCRIPT`** → path to `acs-demo-setup.sh`. Default is the skill path above. **`run-gui.sh`** exits if that file is missing and the env var is unset.

## Env (same idea as the script)

Load what you use on the CLI (e.g. **`ACS_CENTRAL_URL`**, **`ROX_API_TOKEN`** or **`ACS_ADMIN_PASSWORD`**, **`KUBECONFIG`**). See the script file header for the full list.

## Run

```bash
cd ~/code/ACS\ playground/demo-setup-GUI
python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt
./run-gui.sh
```

Optional: **`ACS_GUI_PORT`**, **`ACS_GUI_BIND`**, **`ACS_GUI_EXTRA_PATH`** (prepend to PATH for `oc`/`curl` in subprocesses).

Open **http://127.0.0.1:8765** (unless you changed port/bind).

## What the UI does

- **Refresh status** → **`acs-demo-setup.sh --status`** → preflight JSON + per-module rows (secured-cluster includes **`securedCluster.levels`** in the payload; the table shows a compact layer summary).
- **Run** → passes **`--module`** for checked rows; only **`ms-demo`**, **`registries`**, **`ocp-users`**, **`ocp-oauth`**, **`acs-users`** are implemented from the GUI (**501** for others until wired).

Full default run (no modules) = script default (demo modules **1→5** only — Central install modules are CLI-only unless you add flags yourself).

## Docs / roadmap

**`docs/PROJECT_PLAN.md`** — stages, §8 progress. Things like structured progress lines from the script are **not** implemented unless noted there.
