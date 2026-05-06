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

const DEFERRED_MODULE_SLUGS = new Set(["splunk", "central", "secured-cluster"]);

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

function syncMasterCheckbox() {
  const boxes = getModuleCheckboxes();
  const n = boxes.length;
  const checked = boxes.filter((b) => b.checked).length;
  modSelectAll.checked = n > 0 && checked === n;
  modSelectAll.indeterminate = checked > 0 && checked < n;
  modSelectionCount.textContent = `${checked} of ${n} selected`;
  moduleBulkBar.classList.toggle("bulk-toolbar--has-selection", checked > 0);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One line: "1. ms-demo - namespace + workload" (manifest uses "slug — desc"; we render hyphen).
 */
function moduleCellHtml(m) {
  const label = String(m.label ?? "");
  const idx = m.number != null ? `${escapeHtml(String(m.number))}.` : "";
  const parts = label.split(/\s+—\s+/);
  if (parts.length >= 2) {
    const slug = escapeHtml(parts[0].trim());
    const desc = escapeHtml(parts.slice(1).join(" — ").trim());
    return `<span class="module-line">
      <span class="module-line__idx">${idx}</span>
      <strong class="module-line__slug">${slug}</strong>
      <span class="module-line__sep"> - </span>
      <span class="module-line__desc">${desc}</span>
    </span>`;
  }
  const single = escapeHtml(label.trim());
  return `<span class="module-line">
    <span class="module-line__idx">${idx}</span>
    <strong class="module-line__slug">${single}</strong>
  </span>`;
}

/**
 * Build Map(canonicalId -> { state, detail }) from /api/status `modules` array.
 */
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

function moduleStatusBadgeHtml(canonicalId, statusMap) {
  if (DEFERRED_MODULE_SLUGS.has(canonicalId)) {
    return `<span class="module-status-badge module-status-badge--deferred" title="Not implemented in GUI runner yet">Deferred</span>`;
  }
  const st = statusMap.get(canonicalId);
  if (!st) {
    return `<span class="module-status-badge module-status-badge--pending" title="Refresh status after preflight passes">—</span>`;
  }
  const { state, detail } = st;
  const title = escapeHtml(detail);
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

/** Fill the Status column from latest --status modules list. */
function applyModuleStatuses(statusModules) {
  const map = statusMapFromModules(statusModules);
  const rows = modulesTbody.querySelectorAll("tr[data-module-canonical]");
  rows.forEach((tr) => {
    const cid = tr.getAttribute("data-module-canonical");
    if (!cid) return;
    const cell = tr.querySelector(".js-module-status-cell");
    if (!cell) return;
    cell.innerHTML = moduleStatusBadgeHtml(cid, map);
  });
}

modSelectAll.addEventListener("change", () => {
  const on = modSelectAll.checked;
  getModuleCheckboxes().forEach((c) => {
    c.checked = on;
  });
  syncMasterCheckbox();
});

async function loadModules() {
  const r = await fetch("/api/modules");
  if (!r.ok) {
    modulesTbody.innerHTML = `<tr class="pf-v5-c-table__tr"><td class="pf-v5-c-table__td module-row-td" colspan="2"><span class="err">Failed to load modules: ${r.status}</span></td></tr>`;
    syncMasterCheckbox();
    return;
  }
  const data = await r.json();
  const list = data.modules || [];
  modulesTbody.innerHTML = "";
  for (const m of list) {
    const canonical = canonicalSlugForStatus(String(m.id));
    const safeIdAttr = `mod-${String(m.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const tr = document.createElement("tr");
    tr.className = "pf-v5-c-table__tr";
    tr.dataset.moduleCanonical = canonical;
    tr.innerHTML = `<td class="pf-v5-c-table__td module-row-td">
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
          <label class="module-row__label" for="${safeIdAttr}">${moduleCellHtml(m)}</label>
        </div>
      </td>
      <td class="pf-v5-c-table__td module-row-td module-status-col js-module-status-cell"><span class="module-status-badge module-status-badge--pending">…</span></td>`;
    modulesTbody.appendChild(tr);
  }

  getModuleCheckboxes().forEach((cb) => {
    cb.addEventListener("change", syncMasterCheckbox);
  });
  syncMasterCheckbox();
}

function selectedSlugs() {
  return getModuleCheckboxes().filter((c) => c.checked).map((c) => c.value);
}

/** Wrap content in a collapsible <details>; default open. */
function collapsibleSection(title, innerHtml, open = true) {
  const o = open ? " open" : "";
  return `<details class="pf-block"${o}><summary class="pf-block__summary">${escapeHtml(title)}</summary><div class="pf-block__body">${innerHtml}</div></details>`;
}

function renderPreflight(pf) {
  if (!pf || typeof pf !== "object") return "";
  const ok = pf.ok === true;
  const bannerCls = ok ? "ok" : "bad";
  const bannerHtml = `<div class="pfBanner ${bannerCls}"><strong>Preflight</strong> — ${ok ? "all checks passed" : "one or more checks failed"}</div>`;
  let html = collapsibleSection("Overview", bannerHtml);

  if (Array.isArray(pf.checks) && pf.checks.length) {
    let body = `<table class="status compact"><tr><th>Name</th><th>OK</th><th>Detail</th></tr>`;
    for (const c of pf.checks) {
      const rowOk = c.ok ? "yes" : "no";
      body += `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(rowOk)}</td><td>${escapeHtml(c.detail)}</td></tr>`;
    }
    body += `</table>`;
    html += collapsibleSection(`Checks (${pf.checks.length})`, body);
  }

  const os = pf.openshift && typeof pf.openshift === "object" ? pf.openshift : null;
  if (os && Object.keys(os).length) {
    const n = Object.keys(os).length;
    let body = `<table class="status compact"><tr><th>Field</th><th>Value</th></tr>`;
    for (const [k, v] of Object.entries(os)) {
      body += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v === null || v === undefined ? "" : String(v))}</td></tr>`;
    }
    body += `</table>`;
    html += collapsibleSection(`OpenShift (from oc) (${n})`, body);
  }

  const rs = pf.resolved && typeof pf.resolved === "object" ? pf.resolved : null;
  if (rs && Object.keys(rs).length) {
    const n = Object.keys(rs).length;
    let body = `<table class="status compact"><tr><th>Name</th><th>Value</th></tr>`;
    for (const [k, v] of Object.entries(rs)) {
      body += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v === null || v === undefined ? "" : String(v))}</td></tr>`;
    }
    body += `</table>`;
    html += collapsibleSection(`Resolved (${n})`, body);
  }

  const env = pf.environment && typeof pf.environment === "object" ? pf.environment : null;
  if (env && Object.keys(env).length) {
    const n = Object.keys(env).length;
    let body = `<table class="status compact"><tr><th>Variable</th><th>Value</th></tr>`;
    for (const [k, v] of Object.entries(env)) {
      let disp = v === null || v === undefined ? "" : String(v);
      if (disp.length > 800) disp = disp.slice(0, 800) + "…";
      body += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(disp)}</td></tr>`;
    }
    body += `</table>`;
    html += collapsibleSection(`Environment — effective / masked (${n})`, body);
  }

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
    modBody += `<tr><td>${escapeHtml(m.id)}</td><td class="${cls}">${escapeHtml(m.state)}</td><td>${escapeHtml(m.detail)}</td></tr>`;
  }
  modBody += "</table>";
  html += collapsibleSection(`Modules (${mods.length})`, modBody);
  statusWrap.innerHTML = html;
  applyModuleStatuses(mods);
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
