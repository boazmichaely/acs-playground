#!/usr/bin/env python3
"""Extract lab fixture JSON from profiles-short-summaries.html (#profile-data).

Writes `{"profiles": [{"profile", "rules"}, ...]}` for one or more profiles (default: four lab profiles).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def load_profile_data(html_path: Path) -> dict:
    text = html_path.read_text(encoding="utf-8")
    m = re.search(r'<script[^>]*id="profile-data"[^>]*>(.*?)</script>', text, re.DOTALL)
    if not m:
        raise SystemExit(f"No #profile-data script found in {html_path}")
    return json.loads(m.group(1).strip())


def extract_fixture(data: dict, profile: str) -> dict:
    profiles = data.get("profiles") or []
    prof = next((p for p in profiles if p.get("profile") == profile), None)
    if not prof:
        names = sorted({p.get("profile") for p in profiles if p.get("profile")})
        raise SystemExit(f"Unknown profile {profile!r}. Known profiles ({len(names)}): " + ", ".join(names[:30]) + ("…" if len(names) > 30 else ""))

    cat = data.get("ruleCatalog") or {}
    names = prof.get("ruleNames") or []
    rules = []
    missing = []
    for name in names:
        meta = cat.get(name)
        if not meta:
            missing.append(name)
            rules.append({"id": name, "title": "", "description": ""})
            continue
        rules.append(
            {
                "id": name,
                "title": (meta.get("title") or "").strip(),
                "description": (meta.get("description") or "").strip(),
            }
        )
    out = {"profile": profile, "rules": rules}
    if missing:
        print(f"warning: {len(missing)} rule(s) missing from ruleCatalog: {missing[:5]}{'…' if len(missing) > 5 else ''}", file=sys.stderr)
    return out


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--profiles",
        nargs="+",
        metavar="NAME",
        default=["ocp4-stig-node", "ocp4-e8", "ocp4-cis", "ocp4-cis-node"],
        help="Profile metadata names (default: lab set of four)",
    )
    ap.add_argument(
        "--html",
        type=Path,
        default=here / "profiles-short-summaries.html",
        help="HTML file containing embedded #profile-data JSON",
    )
    ap.add_argument(
        "-o",
        "--output",
        type=Path,
        default=here / "lab-multi-profile-rules.json",
        help="Output JSON path (default: lab-multi-profile-rules.json)",
    )
    args = ap.parse_args()
    out = args.output

    data = load_profile_data(args.html)
    profiles_out = []
    total_rules = 0
    for name in args.profiles:
        one = extract_fixture(data, name)
        profiles_out.append({"profile": one["profile"], "rules": one["rules"]})
        total_rules += len(one["rules"])
    bundle = {"profiles": profiles_out}
    out.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out} ({len(args.profiles)} profiles, {total_rules} rules total)")


if __name__ == "__main__":
    main()
