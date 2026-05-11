# ACS playground

Personal ACS / RHACS experiments.

**Secrets:** Do not commit tokens. Use a gitignored env file or exports as each script expects.

## Layout

| Piece | Where |
|--------|--------|
| Bootstrap script (**edit here**) | `~/.cursor/skills/acs-demo-setup/scripts/acs-demo-setup.sh` and YAMLs beside it; **`REFERENCE.md`** / **`SKILL.md`** in the same skill folder |
| Localhost GUI (**runs that script**) | **`demo-setup-GUI/`** — Flask API + static UI (see **`demo-setup-GUI/README.md`**) |
| Staged plan + §8 log | **`demo-setup-GUI/docs/PROJECT_PLAN.md`** |

Other scripts in this repo root (each self-documented): **`setup.sh`**, **`play-with-roxctl.sh`**, **`acs-list-images-by-base.sh`**.
