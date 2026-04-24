#!/usr/bin/env python3
"""
Fetch Compliance Operator Profile CRs from a cluster and write an interactive HTML
table (sort / filter / resize columns, inline expansion for profile text and rules).

Implementation notes / risks:
  - Pulls all `rules.compliance.openshift.io` in the namespace (~1k+ objects) to build
    a client-side rule catalog; expect a larger HTML file and a slower generator run.
  - Very long rule descriptions inflate payload size; everything is embedded for offline
    `file://` use (no runtime cluster access).
  - `--stdin` supplies profiles only; rule catalog will be empty unless you extend the script.

Requires: oc logged in, Python 3.8+

Examples:
  ./generate_compliance_profiles_html.py
  ./generate_compliance_profiles_html.py -o /tmp/profiles.html
  ./generate_compliance_profiles_html.py -n openshift-compliance
  oc get profiles.compliance.openshift.io -n openshift-compliance -o json | \\
    ./generate_compliance_profiles_html.py --stdin -o profiles.html
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Injected into HTML_SHELL after str.format (raw `{{`/`}}` in the JS would break .format).
RULE_RENDERER_SENTINEL = "___RULE_RENDERER_JS___"
RULE_RENDERER_JS_NAME = "rule_render_lab.js"


def summarize(name: str, product: str, description: str = "") -> str:
    """One-line summary from profile name + type; unknown names fall back to trimmed description."""
    rhcos = name.startswith("rhcos4")
    node = "node" in name

    if "cis" in name and "bsi" not in name:
        ver = None
        for tag, label in [("1-7", "v1.7"), ("1-9", "v1.9")]:
            if tag in name:
                ver = label
        if ver is None:
            ver = "v1.9"
        scope = "Host & kubelet (node) checks." if node else "Kubernetes API & OpenShift platform controls."
        return f"CIS OpenShift 4 benchmark ({ver}): {scope}"

    if "bsi" in name:
        yr = " 2022 bundle." if "2022" in name else ""
        layer = "RHCOS/node OS checks." if rhcos else ("Node/kubelet checks." if node else "Cluster & platform API checks.")
        return f"BSI IT-Grundschutz baseline.{yr} {layer}"

    if name.endswith("e8") or re.search(r"-e8$", name):
        return "ACSC Essential Eight checks on RHCOS nodes." if rhcos else "ACSC Essential Eight checks on the OpenShift platform."

    if "moderate" in name:
        rev = " NIST 800-53 rev 4 selection." if "rev-4" in name else ""
        layer = "RHCOS/node Moderate baseline." if rhcos else ("Node Moderate baseline." if node else "Platform Moderate baseline.")
        return f"U.S. federal Moderate-Impact style controls for OpenShift.{rev} {layer}"

    if "high" in name:
        rev = " NIST 800-53 rev 4 selection." if "rev-4" in name else ""
        layer = "RHCOS/node High baseline." if rhcos else ("Node High baseline." if node else "Platform High baseline.")
        return f"U.S. federal High-Impact style controls for OpenShift.{rev} {layer}"

    if "nerc" in name:
        layer = "RHCOS hosts in energy-sector style deployments." if rhcos else ("Nodes in energy-sector style deployments." if node else "Platform in energy-sector style deployments.")
        return f"NERC CIP–oriented recommendations. {layer}"

    if "pci" in name:
        ver = "PCI DSS 4.0" if "4-0" in name else "PCI DSS 3.2.x"
        layer = "Node/kubelet scope for cardholder environments." if node else "OpenShift platform/API scope for cardholder environments."
        return f"{ver} security configuration profile. {layer}"

    if "stig" in name:
        rev = ""
        if "v2r3" in name:
            rev = " (STIG V2R3)"
        elif "v2r2" in name:
            rev = " (STIG V2R2)"
        if rhcos:
            return f"DISA STIG for RHCOS 4.{rev} Node OS controls."
        return f"DISA STIG for OpenShift 4.{rev} {'Node/kubelet' if node else 'Platform/API'} scope."

    d = re.sub(r"\s+", " ", description or "").strip()
    if d:
        if len(d) > 220:
            i = d.rfind(" ", 0, 217)
            d = (d[: i if i > 40 else 217] + "…") if i > 40 else d[:217] + "…"
        return d
    return "Compliance Operator profile (extend summarize() in script for a tailored one-liner)."


def load_profiles_from_cluster(namespace: str, oc_bin: str) -> list[dict[str, Any]]:
    cmd = [
        oc_bin,
        "get",
        "profiles.compliance.openshift.io",
        "-n",
        namespace,
        "-o",
        "json",
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"oc failed ({e.returncode}): {e.output}") from e
    except FileNotFoundError:
        raise SystemExit(f"Executable not found: {oc_bin}") from None
    data = json.loads(out)
    return data.get("items") or []


def load_rule_catalog(namespace: str, oc_bin: str) -> dict[str, dict[str, str]]:
    """Return map rule metadata name -> {title, description, severity}."""
    cmd = [
        oc_bin,
        "get",
        "rules.compliance.openshift.io",
        "-n",
        namespace,
        "-o",
        "json",
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"oc get rules failed ({e.returncode}): {e.output}") from e
    except FileNotFoundError:
        raise SystemExit(f"Executable not found: {oc_bin}") from None
    data = json.loads(out)
    catalog: dict[str, dict[str, str]] = {}
    for item in data.get("items") or []:
        name = item.get("metadata", {}).get("name") or ""
        if not name:
            continue
        catalog[name] = {
            "title": (item.get("title") or "").strip(),
            "description": item.get("description") or "",
            "severity": (item.get("severity") or "").strip(),
        }
    return catalog


def build_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda x: x["metadata"]["name"]):
        name = item["metadata"]["name"]
        ann = item.get("metadata", {}).get("annotations", {}) or {}
        product = ann.get("compliance.openshift.io/product-type") or "—"
        desc = item.get("description") or ""
        rules = item.get("rules")
        rule_names = [str(x) for x in rules] if isinstance(rules, list) else []
        rule_count = len(rule_names)
        version = item.get("version")
        ver_str = str(version) if version not in (None, "") else "—"
        title = (item.get("title") or "").strip()
        summary = re.sub(r"\s+", " ", summarize(name, product, desc)).strip()
        rows.append(
            {
                "profile": name,
                "applicability": product,
                "rules": rule_count,
                "version": ver_str,
                "summary": summary,
                "title": title,
                "description": desc,
                "ruleNames": rule_names,
            }
        )
    return rows


def json_for_html_embed(obj: Any) -> str:
    """JSON safe inside <script type=\"application/json\"> (escape < for HTML parser)."""
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\\u003c")


HTML_SHELL = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Compliance Operator profiles</title>
  <style>
    :root {{
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #1a1a1a;
      background: #f4f4f5;
    }}
    body {{ margin: 0; padding: 1rem 1.25rem 2rem; max-width: 1280px; margin-inline: auto; }}
    h1 {{ font-size: 1.25rem; font-weight: 600; margin: 0 0 0.35rem; }}
    .meta {{ font-size: 0.85rem; color: #52525b; margin-bottom: 1rem; line-height: 1.45; }}
    .wrap {{
      background: #fff;
      border: 1px solid #e4e4e7;
      border-radius: 8px;
      overflow: auto;
      box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
    }}
    table.data-grid {{
      width: max-content;
      max-width: none;
      border-collapse: collapse;
      table-layout: fixed;
    }}
    col.col-expand {{ min-width: 28px; }}
    col.col-idx {{ min-width: 32px; }}
    col.col-profile {{ min-width: 100px; }}
    col.col-app {{ min-width: 70px; }}
    col.col-rules {{ min-width: 48px; }}
    col.col-ver {{ min-width: 48px; }}
    col.col-sum {{ min-width: 200px; }}
    .data-grid thead tr.filters th,
    .data-grid thead tr.headers th,
    .data-grid tbody tr.row-main td {{
      border-right: 1px solid #e8e8ec;
    }}
    .data-grid thead tr.filters th:last-child,
    .data-grid thead tr.headers th:last-child,
    .data-grid tbody tr.row-main td:last-child {{
      border-right: none;
    }}
    thead th {{
      text-align: left;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #52525b;
      background: #fafafa;
      border-bottom: 1px solid #e4e4e7;
      vertical-align: bottom;
      position: relative;
      user-select: none;
    }}
    thead th.no-sort {{ cursor: default; }}
    thead th.no-sort:hover {{ background: #fafafa; }}
    thead tr.filters th {{
      padding: 0.5rem 0.35rem 0.35rem;
      font-weight: normal;
      text-transform: none;
      letter-spacing: normal;
      background: #fff;
    }}
    thead tr.headers th {{
      padding: 0.45rem 1.75rem 0.45rem 0.5rem;
      cursor: pointer;
    }}
    thead tr.headers th:hover {{ background: #f4f4f5; }}
    thead tr.headers th.no-sort {{ cursor: default; }}
    thead tr.headers th.no-sort:hover {{ background: #fafafa; }}
    thead input {{
      width: 100%;
      box-sizing: border-box;
      font: inherit;
      font-size: 0.78rem;
      padding: 0.35rem 0.4rem;
      border: 1px solid #d4d4d8;
      border-radius: 4px;
    }}
    thead input:focus {{ outline: 2px solid #a1a1aa; outline-offset: 1px; border-color: #a1a1aa; }}
    tbody td {{
      padding: 0.45rem 0.5rem;
      font-size: 0.84rem;
      border-bottom: 1px solid #f4f4f4;
      word-wrap: break-word;
      vertical-align: middle;
    }}
    tbody tr.row-main:hover td {{ background: #fafafa; }}
    tbody tr.row-main.expanded > td {{ background: #f4f4f8; }}
    td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
    code {{ font-size: 0.82em; background: #f4f4f5; padding: 0.12em 0.35em; border-radius: 3px; }}
    .sort-ind {{ font-size: 0.65rem; margin-left: 0.25rem; opacity: 0.45; }}
    th.sorted-asc .sort-ind::after {{ content: "▲"; opacity: 1; }}
    th.sorted-desc .sort-ind::after {{ content: "▼"; opacity: 1; }}
    .resizer {{
      position: absolute;
      top: 0;
      right: 0;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      z-index: 2;
    }}
    .resizer:hover, .resizer.active {{ background: rgb(59 130 246 / 0.25); }}
    .count {{ font-size: 0.8rem; color: #71717a; margin-top: 0.5rem; }}
    button.expand-btn {{
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 0.15rem 0.25rem;
      font-size: 0.7rem;
      color: #52525b;
      line-height: 1;
      border-radius: 4px;
    }}
    button.expand-btn:hover {{ background: #e4e4e7; color: #18181b; }}
    tr.row-detail td {{
      padding: 0;
      border-bottom: 1px solid #e4e4e7;
      background: #fafafa;
    }}
    tr.row-detail.collapsed {{ display: none; }}
    .detail-panel {{ padding: 0.65rem 0.75rem 0.85rem 2.25rem; }}
    .detail-title {{ font-weight: 600; font-size: 0.88rem; margin-bottom: 0.4rem; color: #18181b; }}
    .detail-desc {{ font-size: 0.82rem; color: #3f3f46; line-height: 1.5; white-space: pre-wrap; }}
    details.rules-details {{
      margin-top: 0.75rem;
      border: 1px solid #e4e4e7;
      border-radius: 6px;
      background: #fff;
      padding: 0.15rem 0.5rem 0.5rem;
    }}
    details.rules-details > summary {{
      cursor: pointer;
      font-weight: 600;
      font-size: 0.82rem;
      color: #3f3f46;
      padding: 0.35rem 0;
    }}
    /* Rules list: inner scroll + visible drag bar (CSS resize is unreliable here / hidden by scrollbar) */
    .wrap.rules-grid-panel {{
      margin-top: 0.4rem;
      overflow: visible;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      box-sizing: border-box;
    }}
    .rules-grid-scroll {{
      overflow-x: auto;
      overflow-y: auto;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      min-height: 200px;
      height: 520px;
      max-height: 82vh;
    }}
    .rules-grid-scroll table.data-grid {{
      height: auto;
    }}
    .rules-grid-resizer {{
      flex: 0 0 auto;
      height: 14px;
      margin-top: 3px;
      border-radius: 4px;
      background: #e4e4e7;
      cursor: ns-resize;
      touch-action: none;
      user-select: none;
      box-sizing: border-box;
      border: 1px solid #d4d4d8;
      position: relative;
    }}
    .rules-grid-resizer::before {{
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 40px;
      height: 3px;
      border-radius: 2px;
      background: repeating-linear-gradient(
        90deg,
        #71717a 0 2px,
        transparent 2px 6px
      );
    }}
    .rules-grid-resizer:hover {{
      background: #d4d4d8;
      border-color: #a1a1aa;
    }}
    details.rules-details table.data-grid {{
      width: 100%;
      min-width: 100%;
      max-width: none;
    }}
    details.rules-details .data-grid thead tr.filters th,
    details.rules-details .data-grid thead tr.headers th {{
      padding: 0.5rem 0.35rem 0.35rem;
    }}
    details.rules-details .data-grid thead tr.headers th {{
      padding: 0.45rem 1.75rem 0.45rem 0.5rem;
    }}
    details.rules-details .data-grid tbody td {{
      padding: 0.32rem 0.45rem;
      font-size: 0.84rem;
      vertical-align: middle;
    }}
    .rule-detail-box {{
      display: block;
      width: 100%;
      max-width: 100%;
      margin: 0.45rem 0.5rem 0.55rem;
      padding: 0.55rem 0.65rem;
      border: 1px solid #e4e4e7;
      border-radius: 6px;
      background: #fff;
      box-sizing: border-box;
      max-height: min(70vh, 36rem);
      overflow: auto;
    }}
    .rule-detail-meta {{ font-size: 0.75rem; color: #71717a; margin-bottom: 0.45rem; }}
    .rule-detail-body {{
      font-size: 0.84rem;
      line-height: 1.45;
      color: #3f3f46;
      white-space: normal;
    }}
    .rule-detail-body .rule-desc-para {{
      white-space: pre-wrap;
      margin: 0.35rem 0;
    }}
    .rule-detail-body .rule-desc-list {{
      margin: 0.35rem 0 0.35rem 1.1rem;
      padding-left: 0.4rem;
      list-style: decimal;
    }}
    .rule-detail-body .rule-desc-list li {{
      margin: 0.65rem 0;
      white-space: pre-wrap;
    }}
    .rule-detail-body .rule-desc-ul {{
      margin: 0.4rem 0 0.4rem 1.25rem;
      padding-left: 0.45rem;
      list-style-type: disc;
    }}
    .rule-detail-body .rule-desc-ul li {{
      margin: 0.28rem 0;
      white-space: pre-wrap;
    }}
    .rule-detail-body a.rule-uri {{
      color: #2563eb;
      text-decoration: underline;
      text-underline-offset: 2px;
      word-break: break-all;
    }}
    .rule-detail-body a.rule-uri:hover {{ color: #1d4ed8; }}
    .rule-detail-body code.rule-path,
    .rule-detail-body code.rule-inline {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.78em;
      background: #f4f4f5;
      padding: 0.1em 0.35em;
      border-radius: 3px;
      word-break: break-all;
    }}
    .rule-detail-body pre.rule-block {{
      margin: 0.5rem 0;
      padding: 0.55rem 0.65rem;
      background: #e8eef9;
      color: #0f172a;
      border: 1px solid #c7d2fe;
      border-radius: 6px;
      overflow: auto;
      font-size: 0.72rem;
      line-height: 1.45;
      white-space: pre;
      tab-size: 2;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }}
    .rule-detail-body pre.rule-block.rule-yaml {{ border-left: 3px solid #22c55e; }}
    .rule-detail-body pre.rule-block.rule-json {{ border-left: 3px solid #0ea5e9; }}
    .rule-detail-body pre.rule-block.rule-shell {{ border-left: 3px solid #f97316; }}
    .rule-detail-body pre.rule-block code {{
      font-family: inherit;
      background: transparent;
      color: inherit;
      font-size: inherit;
      padding: 0;
      border-radius: 0;
      word-break: normal;
      white-space: pre;
    }}
  </style>
</head>
<body>
  <h1>Compliance Operator profiles</h1>
  <p class="meta">
    Generated: <strong>{generated}</strong>.
    Source: cluster <code>profiles.compliance.openshift.io</code> in <code>{namespace}</code>.
    <strong>Rule set</strong> is <code>len(.rules)</code> on each Profile CR; <strong>Version</strong> is the Profile <code>.version</code> field (same labels as Red Hat ACS schedule UI).
    <strong>Summary</strong> is curated in this generator script (with a trimmed <code>description</code> fallback for unknown profile families).
    Expand a row for the Profile <code>.title</code>, full <code>.description</code>, and nested <strong>Rules</strong> (inline table; click a row to expand full text from <code>rules.compliance.openshift.io</code>).
    <strong>Tip:</strong> click column headers to sort; type in filters; drag the grip on the <strong>right edge</strong> of a header to resize <strong>that column only</strong> (table may scroll horizontally). <strong>Refresh the page</strong> to restore default column widths.
  </p>
  <div class="wrap">
    <table id="grid" class="data-grid" aria-label="Compliance profiles">
      <colgroup>
        <col class="col-expand" id="col0" />
        <col class="col-idx" id="col1" />
        <col class="col-profile" id="col2" />
        <col class="col-app" id="col3" />
        <col class="col-rules" id="col4" />
        <col class="col-ver" id="col5" />
        <col class="col-sum" id="col6" />
      </colgroup>
      <thead>
        <tr class="filters">
          <th class="no-sort"></th>
          <th class="no-sort"></th>
          <th><input type="search" id="f0" placeholder="Profile…" autocomplete="off" /></th>
          <th><input type="search" id="f1" placeholder="Applicability…" autocomplete="off" /></th>
          <th><input type="search" id="f2" placeholder="Rule set…" autocomplete="off" /></th>
          <th><input type="search" id="f3" placeholder="Version…" autocomplete="off" /></th>
          <th><input type="search" id="f4" placeholder="Summary / title / description / rule ids…" autocomplete="off" /></th>
        </tr>
        <tr class="headers">
          <th class="no-sort" scope="col"><div class="resizer" data-resize-col="0" title="Resize expand column"></div></th>
          <th class="no-sort" scope="col"># <div class="resizer" data-resize-col="1" title="Resize # column"></div></th>
          <th data-col="0" scope="col">Profile <span class="sort-ind" aria-hidden="true"></span><div class="resizer" data-resize-col="2" title="Resize Profile column"></div></th>
          <th data-col="1" scope="col">Applicability <span class="sort-ind" aria-hidden="true"></span><div class="resizer" data-resize-col="3" title="Resize Applicability column"></div></th>
          <th data-col="2" scope="col">Rule set <span class="sort-ind" aria-hidden="true"></span><div class="resizer" data-resize-col="4" title="Resize Rule set column"></div></th>
          <th data-col="3" scope="col">Version <span class="sort-ind" aria-hidden="true"></span><div class="resizer" data-resize-col="5" title="Resize Version column"></div></th>
          <th data-col="4" scope="col">Summary <span class="sort-ind" aria-hidden="true"></span><div class="resizer" data-resize-col="6" title="Resize Summary column"></div></th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <p class="count" id="count"></p>

  <script type="application/json" id="profile-data">
{raw_json}
  </script>
  <script>
___RULE_RENDERER_JS___
  </script>
  <script>
(function () {{
  const _pd = document.getElementById("profile-data");
  if (!_pd) {{
    const el = document.getElementById("count");
    if (el) el.textContent = "Error: missing embedded profile data (#profile-data). Regenerate this file.";
    return;
  }}
  let DATA;
  try {{
    DATA = JSON.parse(_pd.textContent);
  }} catch (e) {{
    const el = document.getElementById("count");
    if (el) el.textContent = "Error: could not parse profile JSON (" + (e && e.message ? e.message : e) + "). Regenerate this file.";
    return;
  }}
  const PROFILES = DATA.profiles || [];
  const RULE_CATALOG = DATA.ruleCatalog || {{}};
  const KEYS = ["profile", "applicability", "rules", "version", "summary"];

  const tbody = document.getElementById("tbody");
  const countEl = document.getElementById("count");
  const cols = document.querySelectorAll("#grid colgroup col");
  const headerCells = document.querySelectorAll("#grid thead tr.headers th[data-col]");

  let sortCol = 0;
  let sortDir = 1;

  function norm(s) {{ return String(s).toLowerCase(); }}

  function matches(r, filters) {{
    const names = (r.ruleNames || []).join(" ");
    const hay = [r.profile, r.applicability, String(r.rules), r.version, r.summary, r.title, r.description, names]
      .map(norm)
      .join(" ");
    for (let c = 0; c < 5; c++) {{
      const q = norm(filters[c]).trim();
      if (!q) continue;
      if (c === 4) {{
        if (!hay.includes(q)) return false;
      }} else {{
        if (!norm(String(r[KEYS[c]])).includes(q)) return false;
      }}
    }}
    return true;
  }}

  function getFilters() {{
    return [0, 1, 2, 3, 4].map((i) => document.getElementById("f" + i).value);
  }}

  function cmp(a, b) {{
    const key = KEYS[sortCol];
    let va = a[key];
    let vb = b[key];
    if (key === "rules") {{
      va = Number(va);
      vb = Number(vb);
    }} else {{
      va = String(va);
      vb = String(vb);
    }}
    if (va < vb) return -sortDir;
    if (va > vb) return sortDir;
    return 0;
  }}

  function setExpanded(trMain, trDetail, open) {{
    if (open) {{
      trMain.classList.add("expanded");
      trDetail.classList.remove("collapsed");
      trMain.querySelector(".expand-btn").textContent = "▼";
      trMain.querySelector(".expand-btn").setAttribute("aria-expanded", "true");
    }} else {{
      trMain.classList.remove("expanded");
      trDetail.classList.add("collapsed");
      trMain.querySelector(".expand-btn").textContent = "▶";
      trMain.querySelector(".expand-btn").setAttribute("aria-expanded", "false");
    }}
  }}

  function mountRulesGrid(rulesDet, r, pid) {{
    const ids = r.ruleNames || [];
    const baseRows = ids.map((rid, j) => {{
      const inf = RULE_CATALOG[rid] || {{}};
      return {{
        ord: j,
        rid: rid,
        title: inf.title || "—",
        desc: inf.description || "",
        sev: inf.severity || "",
      }};
    }});

    const panel = document.createElement("div");
    panel.className = "wrap rules-grid-panel";
    const scrollBox = document.createElement("div");
    scrollBox.className = "rules-grid-scroll";
    const grip = document.createElement("div");
    grip.className = "rules-grid-resizer";
    grip.title = "Drag up or down to resize the rules list height";

    const tbl = document.createElement("table");
    tbl.className = "data-grid";
    tbl.setAttribute("aria-label", "Rules for " + r.profile);

    const cg = document.createElement("colgroup");
    const defW = [36, 48, 260, 360];
    const minW = [28, 32, 120, 160];
    for (let i = 0; i < 4; i++) {{
      const c = document.createElement("col");
      cg.appendChild(c);
    }}
    tbl.appendChild(cg);

    const thead = document.createElement("thead");
    const trF = document.createElement("tr");
    trF.className = "filters";
    const fCells = [
      null,
      null,
      {{ ph: "Filter rule name…" }},
      {{ ph: "Filter description…" }},
    ];
    const rgFilterInputs = [];
    for (let c = 0; c < 4; c++) {{
      const th = document.createElement("th");
      if (c < 2) {{
        th.className = "no-sort";
      }} else {{
        const inp = document.createElement("input");
        inp.type = "search";
        inp.id = "rgf-" + pid + "-" + (c - 2);
        inp.setAttribute("autocomplete", "off");
        inp.placeholder = fCells[c].ph;
        th.appendChild(inp);
        rgFilterInputs.push(inp);
      }}
      trF.appendChild(th);
    }}
    thead.appendChild(trF);

    const trH = document.createElement("tr");
    trH.className = "headers";
    const h0 = document.createElement("th");
    h0.className = "no-sort";
    h0.scope = "col";
    const rz0 = document.createElement("div");
    rz0.className = "resizer";
    rz0.setAttribute("data-resize-col", "0");
    rz0.title = "Resize expand column";
    h0.appendChild(rz0);
    trH.appendChild(h0);

    const h1 = document.createElement("th");
    h1.className = "no-sort";
    h1.scope = "col";
    h1.textContent = "#";
    const rz1 = document.createElement("div");
    rz1.className = "resizer";
    rz1.setAttribute("data-resize-col", "1");
    rz1.title = "Resize # column";
    h1.appendChild(rz1);
    trH.appendChild(h1);

    const h2 = document.createElement("th");
    h2.setAttribute("data-col", "0");
    h2.scope = "col";
    h2.innerHTML = 'Rule name <span class="sort-ind" aria-hidden="true"></span>';
    const rz2 = document.createElement("div");
    rz2.className = "resizer";
    rz2.setAttribute("data-resize-col", "2");
    rz2.title = "Resize Rule name column";
    h2.appendChild(rz2);
    trH.appendChild(h2);

    const h3 = document.createElement("th");
    h3.setAttribute("data-col", "1");
    h3.scope = "col";
    h3.innerHTML = 'Description <span class="sort-ind" aria-hidden="true"></span>';
    const rz3 = document.createElement("div");
    rz3.className = "resizer";
    rz3.setAttribute("data-resize-col", "3");
    rz3.title = "Resize Description column";
    h3.appendChild(rz3);
    trH.appendChild(h3);

    thead.appendChild(trH);
    tbl.appendChild(thead);

    const tbod = document.createElement("tbody");
    tbl.appendChild(tbod);
    scrollBox.appendChild(tbl);
    panel.appendChild(scrollBox);
    panel.appendChild(grip);
    rulesDet.appendChild(panel);

    (function wireRulesGridResize() {{
      const minH = 220;
      const maxH = () => Math.max(minH + 80, Math.floor(window.innerHeight * 0.92));
      const defH = () =>
        Math.min(560, Math.max(380, Math.floor(window.innerHeight * 0.5)));
      function applyH(px) {{
        const cap = maxH();
        const v = Math.min(cap, Math.max(minH, Math.round(px)));
        scrollBox.style.height = v + "px";
        try {{
          localStorage.setItem("complianceProfilesRulesGridH", String(v));
        }} catch (e1) {{}}
      }}
      let saved = NaN;
      try {{
        saved = parseInt(localStorage.getItem("complianceProfilesRulesGridH") || "", 10);
      }} catch (e2) {{}}
      if (!Number.isFinite(saved)) applyH(defH());
      else applyH(saved);

      grip.addEventListener("mousedown", (e) => {{
        if (e.button !== 0) return;
        e.preventDefault();
        const startY = e.clientY;
        const startH = scrollBox.getBoundingClientRect().height;
        function onMove(e2) {{
          applyH(startH + (e2.clientY - startY));
        }}
        function onUp() {{
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        }}
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }});
    }})();

    const rgCols = tbl.querySelectorAll("colgroup col");
    const rgHeaderCells = tbl.querySelectorAll("thead tr.headers th[data-col]");
    const RG_KEYS = ["rid", "title"];
    let rgSortCol = 0;
    let rgSortDir = 1;
    let rgWidths = defW.slice();

    function rgApplyWidths() {{
      rgWidths.forEach((px, i) => {{
        rgCols[i].style.width = px + "px";
      }});
    }}

    function rgGetFilters() {{
      return rgFilterInputs.map((inp) => inp.value);
    }}

    function rgMatch(row, filters) {{
      for (let c = 0; c < 2; c++) {{
        const q = norm(filters[c]).trim();
        if (!q) continue;
        if (c === 0) {{
          if (!norm(row.rid).includes(q)) return false;
        }} else {{
          if (!norm(row.title + " " + row.desc).includes(q)) return false;
        }}
      }}
      return true;
    }}

    function rgCmp(a, b) {{
      const k = RG_KEYS[rgSortCol];
      let va = a[k];
      let vb = b[k];
      va = String(va);
      vb = String(vb);
      if (va < vb) return -rgSortDir;
      if (va > vb) return rgSortDir;
      return 0;
    }}

    function fillRuleDetailCell(tdCell, rid) {{
      const info = RULE_CATALOG[rid];
      tdCell.textContent = "";
      const wrap = document.createElement("div");
      wrap.className = "rule-detail-box";
      if (!info) {{
        const hb = document.createElement("div");
        hb.className = "rule-detail-body";
        hb.textContent =
          "No catalog entry for this rule id (missing Rule CR or different namespace snapshot). Id: " + rid;
        wrap.appendChild(hb);
        tdCell.appendChild(wrap);
        return;
      }}
      const hm = document.createElement("div");
      hm.className = "rule-detail-meta";
      hm.textContent = "Severity: " + (info.severity || "—") + " · Rule id: " + rid;
      const hb = document.createElement("div");
      hb.className = "rule-detail-body";
      if (typeof globalThis.renderRuleDescriptionRich === "function") {{
        globalThis.renderRuleDescriptionRich(hb, info.description);
      }} else {{
        hb.textContent = info.description || "(no description on Rule CR)";
      }}
      wrap.appendChild(hm);
      wrap.appendChild(hb);
      tdCell.appendChild(wrap);
    }}

    function renderRulesBody() {{
      const filters = rgGetFilters();
      let rows = baseRows.filter((row) => rgMatch(row, filters));
      rows = rows.slice().sort(rgCmp);
      tbod.textContent = "";
      rows.forEach((row, di) => {{
        const trM = document.createElement("tr");
        trM.className = "row-main";

        const tdB = document.createElement("td");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "expand-btn";
        btn.textContent = "▶";
        btn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-label", "Show rule details for " + row.rid);
        tdB.appendChild(btn);
        trM.appendChild(tdB);

        const tdN = document.createElement("td");
        tdN.className = "num";
        tdN.textContent = String(di + 1);
        trM.appendChild(tdN);

        const tdR = document.createElement("td");
        const cd = document.createElement("code");
        cd.textContent = row.rid;
        tdR.appendChild(cd);
        trM.appendChild(tdR);

        const tdT = document.createElement("td");
        tdT.textContent = row.title;
        trM.appendChild(tdT);

        const trD = document.createElement("tr");
        trD.className = "row-detail collapsed";
        const tdD = document.createElement("td");
        tdD.colSpan = 4;
        trD.appendChild(tdD);

        btn.addEventListener("click", (ev) => {{
          ev.stopPropagation();
          const open = trD.classList.contains("collapsed");
          if (open) {{
            trM.classList.add("expanded");
            trD.classList.remove("collapsed");
            btn.textContent = "▼";
            btn.setAttribute("aria-expanded", "true");
            if (!trD.dataset.filled) {{
              trD.dataset.filled = "1";
              fillRuleDetailCell(tdD, row.rid);
            }}
          }} else {{
            trM.classList.remove("expanded");
            trD.classList.add("collapsed");
            btn.textContent = "▶";
            btn.setAttribute("aria-expanded", "false");
          }}
        }});

        tbod.appendChild(trM);
        tbod.appendChild(trD);
      }});
    }}

    rgFilterInputs.forEach((inp) => {{
      inp.addEventListener("input", renderRulesBody);
    }});

    rgHeaderCells.forEach((th) => {{
      th.addEventListener("click", (ev) => {{
        if (ev.target.closest(".resizer")) return;
        const c = parseInt(th.getAttribute("data-col"), 10);
        if (c === rgSortCol) rgSortDir = -rgSortDir;
        else {{
          rgSortCol = c;
          rgSortDir = 1;
        }}
        rgHeaderCells.forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
        th.classList.add(rgSortDir === 1 ? "sorted-asc" : "sorted-desc");
        renderRulesBody();
      }});
    }});
    rgHeaderCells[0].classList.add("sorted-asc");

    tbl.querySelectorAll(".resizer").forEach((el) => {{
      el.addEventListener("mousedown", (e) => {{
        e.preventDefault();
        e.stopPropagation();
        const i = parseInt(el.getAttribute("data-resize-col"), 10);
        const startX = e.pageX;
        const startW = rgWidths[i];
        el.classList.add("active");
        function onMove(e2) {{
          const dx = e2.pageX - startX;
          rgWidths[i] = Math.max(minW[i], startW + dx);
          rgApplyWidths();
        }}
        function onUp() {{
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          el.classList.remove("active");
        }}
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }});
    }});

    rgApplyWidths();
    renderRulesBody();
  }}

  function render() {{
    const filters = getFilters();
    let rows = PROFILES.filter((r) => matches(r, filters));
    rows = rows.slice().sort(cmp);

    tbody.textContent = "";
    const frag = document.createDocumentFragment();
    for (let idx = 0; idx < rows.length; idx++) {{
      const r = rows[idx];
      const trMain = document.createElement("tr");
      trMain.className = "row-main";

      const td0 = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "expand-btn";
      btn.textContent = "▶";
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-label", "Show profile details for " + r.profile);
      td0.appendChild(btn);
      trMain.appendChild(td0);

      const tdIdx = document.createElement("td");
      tdIdx.className = "num";
      tdIdx.textContent = String(idx + 1);
      trMain.appendChild(tdIdx);

      const td1 = document.createElement("td");
      const code = document.createElement("code");
      code.textContent = r.profile;
      td1.appendChild(code);
      trMain.appendChild(td1);

      const td2 = document.createElement("td");
      td2.textContent = r.applicability;
      trMain.appendChild(td2);

      const td3 = document.createElement("td");
      td3.className = "num";
      td3.textContent = String(r.rules);
      trMain.appendChild(td3);

      const td4 = document.createElement("td");
      td4.textContent = r.version;
      trMain.appendChild(td4);

      const td5 = document.createElement("td");
      td5.textContent = r.summary;
      trMain.appendChild(td5);

      const trDetail = document.createElement("tr");
      trDetail.className = "row-detail collapsed";
      const tdD = document.createElement("td");
      tdD.colSpan = 7;
      const panel = document.createElement("div");
      panel.className = "detail-panel";
      const tEl = document.createElement("div");
      tEl.className = "detail-title";
      tEl.textContent = r.title || "(no title on Profile CR)";
      const dEl = document.createElement("div");
      dEl.className = "detail-desc";
      dEl.textContent = r.description || "(no description)";
      panel.appendChild(tEl);
      panel.appendChild(dEl);

      const rulesDet = document.createElement("details");
      rulesDet.className = "rules-details";
      const rsum = document.createElement("summary");
      const rn = (r.ruleNames && r.ruleNames.length) || 0;
      rsum.textContent = "Rules (" + rn + ")";
      rulesDet.appendChild(rsum);

      const pid = "rg-" + idx;
      mountRulesGrid(rulesDet, r, pid);

      panel.appendChild(rulesDet);
      tdD.appendChild(panel);
      trDetail.appendChild(tdD);

      btn.addEventListener("click", (ev) => {{
        ev.stopPropagation();
        const open = trDetail.classList.contains("collapsed");
        setExpanded(trMain, trDetail, open);
      }});

      frag.appendChild(trMain);
      frag.appendChild(trDetail);
    }}
    tbody.appendChild(frag);
    countEl.textContent = "Showing " + rows.length + " of " + PROFILES.length + " profiles.";
  }}

  [0, 1, 2, 3, 4].forEach((i) => {{
    document.getElementById("f" + i).addEventListener("input", render);
  }});

  headerCells.forEach((th) => {{
    th.addEventListener("click", (ev) => {{
      if (ev.target.closest(".resizer")) return;
      const c = parseInt(th.getAttribute("data-col"), 10);
      if (c === sortCol) sortDir = -sortDir;
      else {{
        sortCol = c;
        sortDir = 1;
      }}
      headerCells.forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(sortDir === 1 ? "sorted-asc" : "sorted-desc");
      render();
    }});
  }});

  headerCells[0].classList.add("sorted-asc");

  const DEFAULT_WIDTHS = [36, 44, 200, 112, 64, 72, 480];
  const MIN_WIDTHS = [28, 32, 100, 70, 48, 48, 200];
  let colWidths = DEFAULT_WIDTHS.slice();

  function applyColWidths() {{
    colWidths.forEach((px, i) => {{
      cols[i].style.width = px + "px";
    }});
  }}

  document.querySelectorAll("#grid .resizer").forEach((el) => {{
    el.addEventListener("mousedown", (e) => {{
      e.preventDefault();
      e.stopPropagation();
      const i = parseInt(el.getAttribute("data-resize-col"), 10);
      const startX = e.pageX;
      const startW = colWidths[i];
      el.classList.add("active");

      function onMove(e2) {{
        const dx = e2.pageX - startX;
        colWidths[i] = Math.max(MIN_WIDTHS[i], startW + dx);
        applyColWidths();
      }}
      function onUp() {{
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        el.classList.remove("active");
      }}
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }});
  }});

  applyColWidths();
  render();
}})();
  </script>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "profiles-short-summaries.html",
        help="Output HTML path (default: alongside this script)",
    )
    parser.add_argument(
        "-n",
        "--namespace",
        default="openshift-compliance",
        help="Namespace listing Profile CRs (default: openshift-compliance)",
    )
    parser.add_argument("--oc", dest="oc_bin", default="oc", help="oc binary name or path (default: oc)")
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="Read ProfileList JSON from stdin instead of calling oc",
    )
    parser.add_argument(
        "--skip-rules",
        action="store_true",
        help="Do not fetch Rule CRs (smaller HTML; rule detail pane will show missing catalog).",
    )
    args = parser.parse_args()

    if args.stdin:
        data = json.load(sys.stdin)
        items = data.get("items") or []
    else:
        items = load_profiles_from_cluster(args.namespace, args.oc_bin)

    if not items:
        raise SystemExit("No profiles found (empty items list).")

    rows = build_rows(items)
    if args.skip_rules or args.stdin:
        catalog: dict[str, dict[str, str]] = {}
    else:
        catalog = load_rule_catalog(args.namespace, args.oc_bin)
    payload = {"profiles": rows, "ruleCatalog": catalog}
    raw_json = json_for_html_embed(payload)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    ns_esc = html.escape(args.namespace, quote=True)
    out = HTML_SHELL.format(
        generated=html.escape(generated, quote=True),
        namespace=ns_esc,
        raw_json=raw_json,
    )
    js_path = Path(__file__).resolve().parent / RULE_RENDERER_JS_NAME
    renderer_js = js_path.read_text(encoding="utf-8")
    if RULE_RENDERER_SENTINEL not in out:
        raise SystemExit(f"Internal error: sentinel {RULE_RENDERER_SENTINEL!r} missing from HTML template.")
    out = out.replace(RULE_RENDERER_SENTINEL, renderer_js, 1)
    if RULE_RENDERER_SENTINEL in out:
        raise SystemExit(f"rule renderer JS still contains sentinel token {RULE_RENDERER_SENTINEL!r}; refuse to write.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(out, encoding="utf-8")
    print(f"Wrote {len(rows)} profiles to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
