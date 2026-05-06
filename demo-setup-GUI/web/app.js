const logEl = document.getElementById("log");
const modulesTbody = document.getElementById("modulesTbody");
const modSelectAll = document.getElementById("modSelectAll");
const modSelectionCount = document.getElementById("modSelectionCount");
const moduleBulkBar = document.getElementById("moduleBulkBar");
const statusWrap = document.getElementById("statusWrap");

/** Same canonical map as server `canonical_module_slug` — aligns manifest ids with `acs-demo-setup.sh --status`. */
function canonicalSlugForStatus(slug) {
  const aliases = { "ocp-OAuth": "ocp-oauth" };
  return aliases[slug] || slug;
}

// Only Splunk is still deferred; Central + secured cluster now have real --status rows.
const DEFERRED_MODULE_SLUGS = new Set(["splunk"]);

/** Filled in loadModules: canonical id → { dependsOn: canonical[] } */
let moduleMetaByCanonical = new Map();

let lastStatusMap = new Map();
let lastPreflight = null;

function log(line) {
  logEl.textContent += line;
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logEl.textContent = "";
}

function getModuleCheckboxes() {
  return [...modulesTbody.querySelectorAll("input.js-mod-cb[type=checkbox]")];
}

function collectCheckboxByCanonical() {
  const m = new Map();
  for (const tr of modulesTbody.querySelectorAll("tr[data-module-canonical]")) {
    const cid = tr.dataset.moduleCanonical;
    const cb = tr.querySelector("input.js-mod-cb");
    if (cid && cb) m.set(cid, cb);
  }
  return m;
}

/** Dependency satisfied if dependant is `ready` in status OR its checkbox is checked. */
function prereqDepMet(depCanonical, statusMap, cbByCanon) {
  const st = statusMap.get(depCanonical);
  if (st && st.state === "ready") return true;
  const cb = cbByCanon.get(depCanonical);
  return Boolean(cb && cb.checked);
}

function syncDependencyLocks() {
  const statusMap = lastStatusMap;
  const cbByCanon = collectCheckboxByCanonical();

  for (const [canonical, meta] of moduleMetaByCanonical) {
    let tr = null;
    for (const row of modulesTbody.querySelectorAll("tr[data-module-canonical]")) {
      if (row.getAttribute("data-module-canonical") === canonical) {
        tr = row;
        break;
      }
    }
    if (!tr) continue;
    const cb = tr.querySelector("input.js-mod-cb");
    if (!cb) continue;

    let locked = false;
    const reasons = [];
    for (const dep of meta.dependsOn) {
      if (!prereqDepMet(dep, statusMap, cbByCanon)) {
        locked = true;
        reasons.push(dep);
      }
    }

    const hint = tr.querySelector(".js-deps-lock-hint");
    if (locked) {
      cb.checked = false;
      cb.disabled = true;
      const labels = reasons.join(", ");
      cb.title = `Requires ${labels} to be installed (ready) or selected in this run.`;
      tr.classList.add("module-row--locked");
      if (hint) {
        hint.textContent = `Locked: needs ${labels} installed or selected.`;
        hint.hidden = false;
      }
    } else {
      cb.disabled = false;
      cb.title = "";
      tr.classList.remove("module-row--locked");
      if (hint) hint.hidden = true;
    }
  }
}

function syncMasterCheckbox() {
  const boxes = getModuleCheckboxes().filter((b) => !b.disabled);
  const allBoxes = getModuleCheckboxes();
  const n = allBoxes.length;
  const checked = allBoxes.filter((b) => b.checked).length;
  const enabledCount = boxes.length;
  const checkedEnabled = boxes.filter((b) => b.checked).length;
  modSelectAll.checked = enabledCount > 0 && checkedEnabled === enabledCount;
  modSelectAll.indeterminate = checkedEnabled > 0 && checkedEnabled < enabledCount;
  modSelectionCount.textContent = `${checked} of ${n} selected`;
  moduleBulkBar.classList.toggle("bulk-toolbar--has-selection", checked > 0);
}

function applySelectAll(on) {
  for (let pass = 0; pass < 4; pass++) {
    getModuleCheckboxes().forEach((c) => {
      if (!c.disabled) c.checked = on;
    });
    syncDependencyLocks();
  }
  syncMasterCheckbox();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Strip opaque API ids (UUIDs) from status detail; prefer script messages that use names. */
function sanitizeDetailForDisplay(text) {
  if (text == null || text === "") return "";
  let s = String(text);
  s = s.replace(/\bid\s*=\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gi, "");
  s = s.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "");
  s = s.replace(/\(\s*\)/g, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/^[,;\s]+|[,;\s]+$/g, "");
  return s;
}

function dependsOnHintHtml(m) {
  const raw = m.dependsOn;
  if (!Array.isArray(raw) || raw.length === 0) return "";
  const labels = raw.map((d) => escapeHtml(String(d)));
  return `<div class="module-deps-hint">Requires: ${labels.join(", ")}</div>`;
}

/**
 * One line: "1. ms-demo - namespace + workload" (manifest uses "slug — desc"; we render hyphen).
 */
function moduleCellHtml(m) {
  const label = String(m.label ?? "");
  const idx = m.number != null ? `${escapeHtml(String(m.number))}.` : "";
  const parts = label.split(/\s+—\s+/);
  let inner;
  if (parts.length >= 2) {
    const slug = escapeHtml(parts[0].trim());
    const desc = escapeHtml(parts.slice(1).join(" — ").trim());
    inner = `<span class="module-line">
      <span class="module-line__idx">${idx}</span>
      <strong class="module-line__slug">${slug}</strong>
      <span class="module-line__sep"> - </span>
      <span class="module-line__desc">${desc}</span>
    </span>`;
  } else {
    const single = escapeHtml(label.trim());
    inner = `<span class="module-line">
      <span class="module-line__idx">${idx}</span>
      <strong class="module-line__slug">${single}</strong>
    </span>`;
  }
  return `${inner}${dependsOnHintHtml(m)}`;
}

function statusMapFromModules(modules) {
  const map = new Map();
  if (!Array.isArray(modules)) return map;
  for (const row of modules) {
    if (!row || typeof row.id !== "string") continue;
    map.set(row.id, {
      state: row.state != null ? String(row.state) : "",
      detail: row.detail != null ? String(row.detail) : "",
    });
  }
  return map;
}

function centralUrlFromPreflight(pf) {
  if (!pf || typeof pf !== "object") return "";
  const env = pf.environment && typeof pf.environment === "object" ? pf.environment : null;
  const u = env && env.ACS_CENTRAL_URL != null ? String(env.ACS_CENTRAL_URL).trim() : "";
  if (u) return u;
  const checks = Array.isArray(pf.checks) ? pf.checks : [];
  const row = checks.find((c) => c && c.name === "ACS_CENTRAL_URL" && c.ok);
  return row && row.detail ? String(row.detail).trim() : "";
}

function securedClusterNameFromPreflight(pf) {
  if (!pf || typeof pf !== "object") return "";
  const rs = pf.resolved && typeof pf.resolved === "object" ? pf.resolved : null;
  let n = rs && rs.SECURED_CLUSTER_NAME != null ? String(rs.SECURED_CLUSTER_NAME).trim() : "";
  if (n) return n;
  const env = pf.environment && typeof pf.environment === "object" ? pf.environment : null;
  if (env && env._resolved_SECURED_CLUSTER_NAME != null) {
    n = String(env._resolved_SECURED_CLUSTER_NAME).trim();
  }
  return n || "";
}

function detailLineForModule(canonicalId, statusMap, preflight) {
  if (DEFERRED_MODULE_SLUGS.has(canonicalId)) {
    if (canonicalId === "splunk") {
      return "Deferred — Splunk skill integration not wired in this UI yet.";
    }
  }
  const st = statusMap.get(canonicalId);
  return st && st.detail ? st.detail : "";
}

function badgeOnlyHtml(canonicalId, statusMap) {
  if (DEFERRED_MODULE_SLUGS.has(canonicalId)) {
    return `<span class="module-status-badge module-status-badge--deferred">Deferred</span>`;
  }
  const st = statusMap.get(canonicalId);
  if (!st) {
    return `<span class="module-status-badge module-status-badge--pending">…</span>`;
  }
  const { state, detail } = st;
  const title = escapeHtml(sanitizeDetailForDisplay(detail));
  switch (state) {
    case "ready":
      return `<span class="module-status-badge module-status-badge--ready" title="${title}"><span class="module-status-badge__icon" aria-hidden="true">✓</span> Installed</span>`;
    case "partial":
      return `<span class="module-status-badge module-status-badge--partial" title="${title}"><span class="module-status-badge__icon" aria-hidden="true">◐</span> Partial</span>`;
    case "blocked":
      return `<span class="module-status-badge module-status-badge--blocked" title="${title}"><span class="module-status-badge__icon" aria-hidden="true">⚠</span> Blocked</span>`;
    case "absent":
      return `<span class="module-status-badge module-status-badge--absent" title="${title}"><span class="module-status-badge__icon" aria-hidden="true">○</span> Not installed</span>`;
    default:
      return `<span class="module-status-badge module-status-badge--unknown" title="${title}">${escapeHtml(state || "unknown")}</span>`;
  }
}

function moduleStatusCellInnerHtml(canonicalId, statusMap, preflight) {
  const detailRaw = detailLineForModule(canonicalId, statusMap, preflight);
  const cleaned = sanitizeDetailForDisplay(detailRaw);
  const detailDisp = cleaned ? escapeHtml(cleaned) : "—";
  return `<div class="module-status-split">
    <div class="module-status-split__badge">${badgeOnlyHtml(canonicalId, statusMap)}</div>
    <div class="module-status-split__detail">${detailDisp}</div>
  </div>`;
}

function applyModuleStatuses(statusModules, preflight) {
  const map = statusMapFromModules(statusModules);
  lastStatusMap = map;
  lastPreflight = preflight && typeof preflight === "object" ? preflight : null;

  const rows = modulesTbody.querySelectorAll("tr[data-module-canonical]");
  rows.forEach((tr) => {
    const cid = tr.getAttribute("data-module-canonical");
    if (!cid) return;
    const cell = tr.querySelector(".js-module-status-cell");
    if (!cell) return;
    cell.innerHTML = moduleStatusCellInnerHtml(cid, map, lastPreflight);
  });
  syncDependencyLocks();
  syncMasterCheckbox();
}

modSelectAll.addEventListener("change", () => {
  applySelectAll(modSelectAll.checked);
});

function onModuleCheckboxChange() {
  syncDependencyLocks();
  syncMasterCheckbox();
}

async function loadModules() {
  const r = await fetch("/api/modules");
  if (!r.ok) {
    modulesTbody.innerHTML = `<tr class="pf-v5-c-table__tr"><td class="pf-v5-c-table__td module-row-td" colspan="2"><span class="err">Failed to load modules: ${r.status}</span></td></tr>`;
    syncMasterCheckbox();
    return;
  }
  const data = await r.json();
  const list = data.modules || [];

  moduleMetaByCanonical = new Map();
  for (const m of list) {
    const canonical = canonicalSlugForStatus(String(m.id));
    const deps = Array.isArray(m.dependsOn)
      ? m.dependsOn.map((d) => canonicalSlugForStatus(String(d)))
      : [];
    moduleMetaByCanonical.set(canonical, { dependsOn: deps });
  }

  modulesTbody.innerHTML = "";
  for (const m of list) {
    const canonical = canonicalSlugForStatus(String(m.id));
    const safeIdAttr = `mod-${String(m.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const tr = document.createElement("tr");
    tr.className = "pf-v5-c-table__tr";
    tr.dataset.moduleCanonical = canonical;
    tr.innerHTML = `<td class="pf-v5-c-table__td module-row-td module-module-col">
        <div class="module-row">
          <div class="pf-v5-c-check module-row__check">
            <input
              class="pf-v5-c-check__input js-mod-cb"
              type="checkbox"
              id="${safeIdAttr}"
              name="module"
              value="${escapeHtml(m.id)}"
              aria-label="${escapeHtml(m.id)}"
            />
          </div>
          <div class="module-row__label-wrap">
            <label class="module-row__label" for="${safeIdAttr}">${moduleCellHtml(m)}</label>
            <div class="module-deps-lock-hint js-deps-lock-hint" hidden></div>
          </div>
        </div>
      </td>
      <td class="pf-v5-c-table__td module-row-td module-status-col js-module-status-cell"><span class="module-status-badge module-status-badge--pending">…</span></td>`;
    modulesTbody.appendChild(tr);
  }

  getModuleCheckboxes().forEach((cb) => {
    cb.addEventListener("change", onModuleCheckboxChange);
  });
  applyModuleStatuses([], lastPreflight);
}

function selectedSlugs() {
  return getModuleCheckboxes().filter((c) => c.checked && !c.disabled).map((c) => c.value);
}

/** Wrap content in a collapsible <details>. Pass open=true to expand by default. */
function collapsibleSection(title, innerHtml, open = false) {
  const o = open ? " open" : "";
  return `<details class="pf-block"${o}><summary class="pf-block__summary">${escapeHtml(title)}</summary><div class="pf-block__body">${innerHtml}</div></details>`;
}

function renderPreflight(pf) {
  if (!pf || typeof pf !== "object") return "";
  const ok = pf.ok === true;
  const bannerCls = ok ? "ok" : "bad";
  const bannerHtml = `<div class="pfBanner ${bannerCls}"><strong>Preflight</strong> — ${ok ? "all checks passed" : "one or more checks failed"}</div>`;
  let html = "";

  const hasChecks = Array.isArray(pf.checks) && pf.checks.length > 0;
  if (hasChecks) {
    let body = `<table class="status compact"><tr><th>Name</th><th>OK</th><th>Detail</th></tr>`;
    for (const c of pf.checks) {
      const rowOk = c.ok ? "yes" : "no";
      body += `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(rowOk)}</td><td>${escapeHtml(c.detail)}</td></tr>`;
    }
    body += `</table>`;
    html += collapsibleSection(`Checks (${pf.checks.length})`, body, true);
  }

  html += collapsibleSection("Overview", bannerHtml, !hasChecks);

  const os = pf.openshift && typeof pf.openshift === "object" ? pf.openshift : null;
  if (os && Object.keys(os).length) {
    const n = Object.keys(os).length;
    let body = `<table class="status compact"><tr><th>Field</th><th>Value</th></tr>`;
    for (const [k, v] of Object.entries(os)) {
      body += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v === null || v === undefined ? "" : String(v))}</td></tr>`;
    }
    body += `</table>`;
    html += collapsibleSection(`OpenShift (from oc) (${n})`, body, false);
  }

  const rs = pf.resolved && typeof pf.resolved === "object" ? pf.resolved : null;
  if (rs && Object.keys(rs).length) {
    const n = Object.keys(rs).length;
    let body = `<table class="status compact"><tr><th>Name</th><th>Value</th></tr>`;
    for (const [k, v] of Object.entries(rs)) {
      body += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v === null || v === undefined ? "" : String(v))}</td></tr>`;
    }
    body += `</table>`;
    html += collapsibleSection(`Resolved (${n})`, body, false);
  }

  // Omit preflight "Environment — effective / masked (N)": module rows + Checks cover demo URL/secrets at a glance.

  return html;
}

async function refreshStatus() {
  statusWrap.innerHTML = `<p class="pf-v5-c-content pf-m-0" style="color: var(--pf-v5-global--Color--200)">Loading…</p>`;
  const r = await fetch("/api/status");
  const body = await r.json();
  if (!r.ok) {
    const errPre = `<pre class="err">${escapeHtml(JSON.stringify(body, null, 2))}</pre>`;
    statusWrap.innerHTML = collapsibleSection("Error response", errPre, true);
    return;
  }
  const pf = body.preflight;
  let html = renderPreflight(pf);

  const mods = body.modules || [];
  let modBody = `<table class="status"><tr><th>ID</th><th>State</th><th>Detail</th></tr>`;
  for (const m of mods) {
    const cls = `state-${m.state || ""}`;
    const det = sanitizeDetailForDisplay(m.detail != null ? String(m.detail) : "");
    modBody += `<tr><td>${escapeHtml(m.id)}</td><td class="${cls}">${escapeHtml(m.state)}</td><td>${det ? escapeHtml(det) : "—"}</td></tr>`;
  }
  modBody += "</table>";
  html += collapsibleSection(`Modules (${mods.length})`, modBody, true);
  statusWrap.innerHTML = html;
  applyModuleStatuses(mods, pf);
}

async function runModules(mods) {
  clearLog();
  log(`POST /api/run modules=${JSON.stringify(mods)}\n`);
  const r = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modules: mods }),
  });
  if (r.status === 409) {
    log(`Error: ${await r.text()}\n`);
    return;
  }
  if (!r.ok || !r.body) {
    log(`HTTP ${r.status} ${await r.text()}\n`);
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    log(dec.decode(value, { stream: true }));
  }
  await refreshStatus();
}

document.getElementById("btnRun").onclick = async () => {
  const sel = selectedSlugs();
  if (!sel.length) {
    alert("Select at least one module, or use Run full default.");
    return;
  }
  await runModules(sel);
};

document.getElementById("btnRunFull").onclick = async () => {
  await runModules([]);
};

document.getElementById("btnStatus").onclick = refreshStatus;

loadModules().then(() => refreshStatus());
