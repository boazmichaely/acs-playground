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

**Ctrl-C:** stops Flask and terminates any in-flight **`/api/run`** bash **process group** (cleaner than leaving `oc`/script children running). Lingering listeners are usually **port still in use**, not zombies—**`run-gui.sh`** checks that before start.

## What the UI does

- **Refresh status** → **`acs-demo-setup.sh --status`** → preflight JSON + per-module rows (**`securedCluster`**, **`roxctlEnvConsistency`** breakdowns in the payload where applicable).
- **Run** → passes **`--module`** for checked rows. **`central`** / **`secured-cluster`** map to **`install-central`** / **`install-secured-cluster`**; **`roxctl-env`** updates **`ROX_ENDPOINT`** from the Route and ensures a Central API token named **`roxctl-admin`** (override **`ROXCTL_ADMIN_TOKEN_NAME`**), creating it with **`POST /v1/apitokens/generate`** when missing ( **`ROX_API_TOKEN`** or **`central-htpasswd`** via **`oc`** ), then merges **`ROX_API_TOKEN`** into **`~/.roxctl/set-env.sh`**. **`splunk`** still returns **501**. Runs that include **`central`** can add **`--update-roxctl-env`** after confirm; runs that include **`roxctl-env`** prompt again before writing **`~/.roxctl/set-env.sh`** (cancel = skip that module only if you clear the checkbox — selection stays under your control).

**Run full install** sends **`central` → `secured-cluster` → demo modules** (does **not** auto-select **`roxctl-env`**).

**Module `roxctl-env` (#2):** status uses **`ready`** (“Installed”) when the Central Route matches **`ACS_CENTRAL_URL` / `ROX_ENDPOINT`**, Central has an active API token **`roxctl-admin`**, and **`ROX_API_TOKEN`** is set in the script environment; collapsibles show Route-vs-env and token rows (**`adminApiToken`** in JSON). Run it manually if you dismissed the confirm dialog earlier.

## Docs / roadmap

**`docs/PROJECT_PLAN.md`** — stages, §8 progress. Things like structured progress lines from the script are **not** implemented unless noted there.
