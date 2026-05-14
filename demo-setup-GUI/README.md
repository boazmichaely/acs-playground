# ACS demo setup — localhost GUI

Flask on **`127.0.0.1`** + static UI. It **spawns** `acs-demo-setup.sh`; all cluster/Central logic stays in the **Cursor skill** (not in this repo).

## Paths

| What | Where |
|------|--------|
| Bootstrap (**implementation**) | `~/.cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh` (+ `central-cr-minimal.yaml`, `secured-cluster-cr-minimal.yaml`) |
| **Central API credentials (JSON)** | `~/.cursor/skills/acs-demo-setup/config/central-credentials.json` (default; gitignored). Allowed **`authPreference`** values: **`apiKey`** \| **`password`** (see sibling **`central-credentials.schema.json`** and **`$schema`** in the saved file). Override: **`ACS_CENTRAL_CREDENTIALS_FILE`**. GUI: **Central credentials** → **Save**. |
| Skill notes | `~/.cursor/skills/acs-demo-setup/SKILL.md`, **`REFERENCE.md`** |
| Plan / module map | **`docs/PROJECT_PLAN.md`** (§2 modules, §8 log) |

**Repos:** this tree → **acs-playground** (https://github.com/boazmichaely/acs-playground). Skill → **`my-cursor-skills`** (https://github.com/boazmichaely/my-cursor-skills); commit from **`~/.cursor/skills`**. Workspace rule: **`../.cursor/rules/acs-repositories.mdc`** (from repo root).

Override: **`ACS_DEMO_SETUP_SCRIPT`** → path to `acs-demo-setup.sh`. Default is the skill path above. **`run-gui.sh`** exits if that file is missing and the env var is unset.

**Lab env file:** `run-gui.sh` sources the first file that exists: **`ACS_ENV_FILE`** (if set), else **`../acs-playground.local.env`** (repo root next to `demo-setup-GUI/`), else **`acs-playground.local.env`** next to `run-gui.sh`. It then **`export`s `ACS_ENV_FILE`** so the Flask server and `acs-demo-setup.sh` subprocess see the same variables (`CENTRAL`, `TOKEN`, `ACS_CENTRAL_URL`, …).

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

- **Central credentials** — **collapsed by default** (separate from status “Expand all”). Expand to edit; **API key** is plain text like the file. **Save** writes **`central-credentials.json`** and shows **Saved** next to the button (errors appear there too).
- **Refresh status** → **`acs-demo-setup.sh --status`** → preflight JSON + per-module rows (**`securedCluster`**, **`roxctlEnvConsistency`** breakdowns in the payload where applicable).
- **Run** → passes **`--module`** for checked rows. **`central`** / **`secured-cluster`** map to **`install-central`** / **`install-secured-cluster`**; **`ms-demo`** applies **`MS_DEMO_MANIFEST`** into **`MS_DEMO_NAMESPACE`** (defaults: Mostmark path + **`ms-demo`**); **`init-demo`** applies the three YAMLs from **`INIT_DEMO_SOURCE_DIR`** into **`INIT_DEMO_NAMESPACE`** (defaults: **`~/code/ACS playground/Init Containers`** + **`init-demo`**); **`roxctl-env`** updates **`ROX_ENDPOINT`** from the Route and ensures a Central API token named **`roxctl-admin`** (override **`ROXCTL_ADMIN_TOKEN_NAME`**), creating it with **`POST /v1/apitokens/generate`** when missing ( **`ROX_API_TOKEN`** or **`central-htpasswd`** via **`oc`** ), then merges **`ROX_API_TOKEN`** into **`~/.roxctl/set-env.sh`** — this module is the **only** script path that writes **`~/.roxctl/set-env.sh`**. **`slack-notifier`** runs **`acs-demo-setup.sh --module slack-notifier`** (Slack notifier on Central; webhook defaults live in the script / env). **`splunk`** runs **`~/.cursor/skills/rhacs-splunk-ta-demo-skill/scripts/splunk-lab.sh install`** (override **`ACS_SPLUNK_LAB_SCRIPT`**). Runs that include **`central`** can confirm **Update credentials file from Route** so **`install-central`** receives **`--update-roxctl-env`** and merges the Route **`https://…`** into **`central-credentials.json`** (**`centralEndpoint`** only). Runs that include **`roxctl-env`** prompt again before writing **`~/.roxctl/set-env.sh`** (cancel = skip that module only if you clear the checkbox — selection stays under your control).

**Run full install** selects the full canonical list in **`web/app.js`** (**`FULL_INSTALL_SLUGS_ORDERED`**: through **`slack-notifier`**, then **`splunk`**). Dependency locks still apply (e.g. **`slack-notifier`** needs **`roxctl-env`** ready or checked).

**Module `roxctl-env` (#2):** status uses **`ready`** (“Installed”) when the Central Route matches **`ACS_CENTRAL_URL` / `ROX_ENDPOINT`**, Central has an active API token **`roxctl-admin`**, and **`ROX_API_TOKEN`** is set in the script environment; collapsibles show Route-vs-env and token rows (**`adminApiToken`** in JSON). Run it manually if you dismissed the confirm dialog earlier.

## Docs / roadmap

**`docs/PROJECT_PLAN.md`** — stages, §8 progress. Things like structured progress lines from the script are **not** implemented unless noted there.
