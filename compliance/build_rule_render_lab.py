#!/usr/bin/env python3
"""Build a single self-contained rule_render_lab.html (fixture + CSS + JS).

No server or network is required: open the HTML file in a browser (file:// is fine).

Typical flow:
  python3 extract_rule_render_lab_fixture.py
  python3 build_rule_render_lab.py

Subset: python3 extract_rule_render_lab_fixture.py --profiles ocp4-e8 ocp4-stig-node
Single-file legacy fixture { "profile", "rules" } still works with --fixture.
"""
from __future__ import annotations

import argparse
import html as html_mod
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_FIXTURE = HERE / "lab-multi-profile-rules.json"
CSS = HERE / "rule_render_lab.css"
LAB_JS = HERE / "rule_render_lab.js"
OUT = HERE / "rule_render_lab.html"


def _escape_for_style(css: str) -> str:
    return css.replace("</style>", "<\\/style>")


def _escape_for_script(js: str) -> str:
    # Close-tag sequences inside JS would end the HTML script element early.
    return js.replace("</script>", "<\\/script>")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--fixture",
        type=Path,
        default=DEFAULT_FIXTURE,
        help=f"Lab JSON (default: {DEFAULT_FIXTURE.name})",
    )
    args = ap.parse_args()
    fixture_path = args.fixture.expanduser().resolve()
    if not fixture_path.is_file():
        raise SystemExit(f"Fixture not found: {fixture_path}")

    data = json.loads(fixture_path.read_text(encoding="utf-8"))
    profiles = data.get("profiles")
    if profiles:
        n_rules = sum(len(p.get("rules") or []) for p in profiles)
        profile_summary = ", ".join(p.get("profile") or "?" for p in profiles)
        title_suffix = f"{len(profiles)} profiles"
    else:
        n_rules = len(data.get("rules") or [])
        profile_summary = data.get("profile") or "unknown"
        title_suffix = profile_summary
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    safe_json = raw.replace("<", "\\u003c")  # avoid </script> in JSON strings
    css = _escape_for_style(CSS.read_text(encoding="utf-8"))
    js = _escape_for_script(LAB_JS.read_text(encoding="utf-8"))
    sum_esc = html_mod.escape(title_suffix, quote=True)
    prof_list_esc = html_mod.escape(profile_summary, quote=True)
    fix_name = html_mod.escape(fixture_path.name, quote=True)
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rule render lab — {sum_esc}</title>
  <style>
{css}
  </style>
</head>
<body>
  <h1>Rule render lab</h1>
  <p class="hint">
    Client-only: embedded fixture ({n_rules} rules) — <code>{prof_list_esc}</code>. Regenerate with
    <code>python3 extract_rule_render_lab_fixture.py</code> (optional <code>--profiles …</code>),
    edit <code>rule_render_lab.js</code> / <code>rule_render_lab.css</code>,
    run <code>python3 build_rule_render_lab.py --fixture {fix_name}</code>, then refresh.
  </p>
  <script type="application/json" id="fixture">{safe_json}</script>
  <div id="out"></div>
  <script>
{js}
  </script>
</body>
</html>
"""
    OUT.write_text(html, encoding="utf-8")
    print(f"Wrote {OUT} ({title_suffix!r}, rules={n_rules}, fixture={fixture_path.name})")


if __name__ == "__main__":
    main()
