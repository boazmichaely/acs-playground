# ACS playground

Personal ACS / RHACS experiments.

**Secrets:** Do not commit tokens. Use a gitignored env file or exports as each script expects.

## Git repositories (two remotes — agents & humans)

| Repo | Remote | What lives here |
|------|--------|------------------|
| **acs-playground** | https://github.com/boazmichaely/acs-playground | This workspace: **`demo-setup-GUI/`** orchestrator only (no bash bootstrap copy). |
| **my-cursor-skills** | https://github.com/boazmichaely/my-cursor-skills | **`~/.cursor/skills`** — includes **`acs-demo-setup/`** (`acs-demo-setup.sh`, YAMLs, skill docs). Commit skill changes from the **parent** `skills` directory. |

Workspace rule (always loaded in Cursor): **`.cursor/rules/acs-repositories.mdc`**.

## Layout

| Piece | Where |
|--------|--------|
| Bootstrap script (**edit here**) | `~/.cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh` and YAMLs beside it; **`REFERENCE.md`** / **`SKILL.md`** in the same skill folder |
| Localhost GUI (**runs that script**) | **`demo-setup-GUI/`** — Flask API + static UI (see **`demo-setup-GUI/README.md`**) |
| Staged plan + §8 log | **`demo-setup-GUI/docs/PROJECT_PLAN.md`** |

Other scripts in this repo root (each self-documented): **`setup.sh`**, **`play-with-roxctl.sh`**, **`acs-list-images-by-base.sh`**.
