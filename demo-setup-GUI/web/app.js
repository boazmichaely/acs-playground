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

/** Canonical `/api/run` slugs in `acs-demo-setup.sh` order (Central → SC → demo). Splunk excluded (not wired). */
const FULL_INSTALL_SLUGS_ORDERED = [
  "central",
  "secured-cluster",
  "ms-demo",
  "registries",
  "ocp-users",
  "ocp-oauth",
  "acs-users",
];

/** Filled in loadModules: canonical id → { dependsOn: canonical[] } */
let moduleMetaByCanonical = new Map();

let lastStatusMap = new Map();
/** Full `modules` array from last `/api/status` (includes securedCluster breakdown). */
let lastStatusModules = [];
let lastPreflight = null;

let statusRefreshIntervalId = null;

function clearStatusRefreshInterval() {
  if (statusRefreshIntervalId !== null) {
    clearInterval(statusRefreshIntervalId);
    statusRefreshIntervalId = null;
  }
}

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
  const cbByCanon = collectCheckboxByCanonical();
  const installCbs = FULL_INSTALL_SLUGS_ORDERED.map((slug) =>
    cbByCanon.get(canonicalSlugForStatus(slug)),
  ).filter(Boolean);
  const allBoxes = getModuleCheckboxes();
  const n = allBoxes.length;
  const checked = allBoxes.filter((b) => b.checked).length;

  const allInstallChecked =
    installCbs.length === FULL_INSTALL_SLUGS_ORDERED.length &&
    installCbs.every((cb) => cb.checked);

  modSelectAll.checked = allInstallChecked;
  modSelectAll.indeterminate = !allInstallChecked && installCbs.some((cb) => cb.checked);
  modSelectionCount.textContent = `${checked} of ${n} selected`;
  moduleBulkBar.classList.toggle("bulk-toolbar--has-selection", checked > 0);
}

/** Select / clear the runnable full-install set (Central through acs-users). Splunk is never toggled here. */
function applySelectAll(on) {
  if (!on) {
    getModuleCheckboxes().forEach((c) => {
      c.checked = false;
    });
    syncDependencyLocks();
    syncMasterCheckbox();
    return;
  }
  for (let pass = 0; pass < 8; pass++) {
    const cbByCanon = collectCheckboxByCanonical();
    for (const slug of FULL_INSTALL_SLUGS_ORDERED) {
      const canonical = canonicalSlugForStatus(slug);
      const cb = cbByCanon.get(canonical);
      if (cb && !cb.disabled) cb.checked = true;
    }
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
  const checks = Array.isArray(pf.checks) ? pf.checks : [];
  const row = checks.find((c) => c && c.name === "ACS_CENTRAL_URL" && c.ok);
  if (row && row.detail) return String(row.detail).trim();
  const env = pf.environment && typeof pf.environment === "object" ? pf.environment : null;
  const u = env && env.ACS_CENTRAL_URL != null ? String(env.ACS_CENTRAL_URL).trim() : "";
  return u || "";
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

const SC_LEVEL_ORDER = ["crs_secret", "securedcluster_cr", "workloads", "central_registration"];
const SC_LEVEL_LABEL = {
  crs_secret: "Registration secret",
  securedcluster_cr: "SecuredCluster CR",
  workloads: "Secured cluster workloads",
  central_registration: "Visibility in Central",
};

/** Collapsible Central API token row for `roxctlEnvConsistency.adminApiToken`. */
function roxctlAdminApiTokenBlockHtml(admin) {
  if (!admin || typeof admin !== "object") return "";
  const st = admin.state != null ? String(admin.state) : "unknown";
  const nm = admin.tokenName != null ? String(admin.tokenName).trim() : "roxctl-admin";
  const envHas = admin.envHasToken === true;
  const det = admin.detail ? sanitizeDetailForDisplay(String(admin.detail)) : "";
  const envCell = envHas ? "yes" : "no";
  let sum = `API token · ${nm}`;
  if (st === "present") sum += " · on Central";
  else if (st === "absent") sum += " · missing on Central";
  else if (st === "skipped") sum += " · n/a";
  else sum += ` · ${st}`;
  return `<details class="sc-levels re-env-levels"><summary class="sc-levels__sum">${escapeHtml(sum)}</summary><div class="sc-levels__body"><table class="pf-v5-c-table pf-m-compact"><tbody><tr><th scope="row">Named token on Central</th><td><code>${escapeHtml(nm)}</code> (${escapeHtml(st)})</td></tr><tr><th scope="row">ROX_API_TOKEN in env</th><td>${escapeHtml(envCell)}</td></tr>${det ? `<tr><th scope="row">Detail</th><td>${escapeHtml(det)}</td></tr>` : ""}</tbody></table></div></details>`;
}

/** Collapsible Route vs env table for `modules[].roxctlEnvConsistency` (`roxctl-env` status row). */
function roxctlEnvConsistencyBlockHtml(cc) {
  if (!cc || typeof cc !== "object") return "";
  const admin = cc.adminApiToken && typeof cc.adminApiToken === "object" ? cc.adminApiToken : null;
  const adminLayers = admin ? roxctlAdminApiTokenBlockHtml(admin) : "";
  const cs = cc.state != null ? String(cc.state) : "";
  const rhRaw = cc.routeHost != null ? String(cc.routeHost).trim() : "";
  const envHosts = Array.isArray(cc.envHosts) ? cc.envHosts : [];
  const clusterCell = rhRaw !== "" ? `<code>${escapeHtml(rhRaw)}</code>` : "—";
  const envRows = envHosts
    .map(
      (e) =>
        `<tr><th scope="row">${escapeHtml(String(e.source || ""))}</th><td><code>${escapeHtml(String(e.host || ""))}</code></td></tr>`,
    )
    .join("");
  const unsetRow =
    envHosts.length === 0 && rhRaw !== ""
      ? `<tr><th scope="row">ACS_CENTRAL_URL / ROX_ENDPOINT</th><td>— <span style="color:var(--pf-v5-global--Color--200)">(unset in process env)</span></td></tr>`
      : "";
  let sum = "compare · Route vs env";
  if (cs === "ok") sum = "consistent · Route vs env";
  else if (cs === "skipped") sum = "n/a · Route vs env";

  return `<details class="sc-levels re-env-levels"><summary class="sc-levels__sum">${escapeHtml(sum)}</summary><div class="sc-levels__body"><table class="pf-v5-c-table pf-m-compact"><tbody><tr><th scope="row">Cluster (OpenShift Route)</th><td>${clusterCell}</td></tr>${envRows}${unsetRow}</tbody></table>${adminLayers}</div></details>`;
}

/** Compact collapsible for `modules[].securedCluster` (script `--status`). */
function securedClusterLevelsBlockHtml(sc) {
  const ov0 = sc && sc.overall && typeof sc.overall === "object" ? sc.overall : null;
  if (ov0 && ov0.state === "absent") return "";

  const levels = sc && sc.levels && typeof sc.levels === "object" ? sc.levels : null;
  if (!levels) return "";

  const summaryBits = SC_LEVEL_ORDER.map((k) => {
    const L = levels[k];
    const st = L && L.state != null ? String(L.state) : "—";
    return `${SC_LEVEL_LABEL[k] || k}:${st}`;
  });

  const rows = SC_LEVEL_ORDER.map((k) => {
    const L = levels[k];
    const state = L && L.state != null ? String(L.state) : "—";
    const det = sanitizeDetailForDisplay(L && L.detail ? L.detail : "");
    const name = SC_LEVEL_LABEL[k] || k;
    const stCls = ["ready", "partial", "absent", "unknown"].includes(state) ? state : "unknown";
    return `<div class="sc-level"><span class="sc-level__name">${escapeHtml(name)}</span><span class="sc-level__state sc-level__state--${stCls}">${escapeHtml(state)}</span><span class="sc-level__det">${escapeHtml(det)}</span></div>`;
  }).join("");

  const ov = sc.overall && typeof sc.overall === "object" ? sc.overall : null;
  const blocked =
    ov && ov.blocked_reason != null && String(ov.blocked_reason).trim() !== ""
      ? `<div class="sc-blocked">blocked: ${escapeHtml(String(ov.blocked_reason).trim())}</div>`
      : "";

  return `<details class="sc-levels"><summary class="sc-levels__sum">${escapeHtml(summaryBits.join(" · "))}</summary><div class="sc-levels__body">${rows}</div>${blocked}</details>`;
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
  const badge = badgeOnlyHtml(canonicalId, statusMap);
  let detailInner = "";
  if (canonicalId === "roxctl-env") {
    const row = lastStatusModules.find((x) => x && x.id === "roxctl-env");
    const cc =
      row && row.roxctlEnvConsistency && typeof row.roxctlEnvConsistency === "object"
        ? row.roxctlEnvConsistency
        : null;
    const layers = cc && roxctlEnvConsistencyBlockHtml(cc);
    const summaryLine = detailLineForModule(canonicalId, statusMap, preflight);
    const sumEsc = summaryLine ? escapeHtml(sanitizeDetailForDisplay(summaryLine)) : "";
    detailInner = `${sumEsc ? `<div class="sc-overall">${sumEsc}</div>` : ""}${layers || ""}`;
    if (!String(detailInner).trim()) detailInner = "—";
  } else if (canonicalId === "secured-cluster") {
    const row = lastStatusModules.find((x) => x && x.id === "secured-cluster");
    const sc = row && row.securedCluster && typeof row.securedCluster === "object" ? row.securedCluster : null;
    const layers = sc && securedClusterLevelsBlockHtml(sc);
    const summaryLine = detailLineForModule(canonicalId, statusMap, preflight);
    const sumEsc = summaryLine ? escapeHtml(sanitizeDetailForDisplay(summaryLine)) : "";
    if (layers) {
      detailInner = `${sumEsc ? `<div class="sc-overall">${sumEsc}</div>` : ""}${layers}`;
    } else {
      detailInner = sumEsc || "—";
    }
  } else {
    const detailRaw = detailLineForModule(canonicalId, statusMap, preflight);
    const cleaned = sanitizeDetailForDisplay(detailRaw);
    detailInner = cleaned ? escapeHtml(cleaned) : "—";
  }
  return `<div class="module-status-split">
    <div class="module-status-split__badge">${badge}</div>
    <div class="module-status-split__detail">${detailInner}</div>
  </div>`;
}

function applyModuleStatuses(statusModules, preflight) {
  lastStatusModules = Array.isArray(statusModules) ? statusModules : [];
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

  html += collapsibleSection("Overview", bannerHtml, true);

  const hasChecks = Array.isArray(pf.checks) && pf.checks.length > 0;
  if (hasChecks) {
    let body = `<table class="status compact preflight-checks"><tr><th>Name</th><th>OK</th><th>Detail</th></tr>`;
    for (const c of pf.checks) {
      const rowOk = c.ok ? "yes" : "no";
      body += `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(rowOk)}</td><td>${escapeHtml(c.detail)}</td></tr>`;
    }
    body += `</table>`;
    html += collapsibleSection(`Checks (${pf.checks.length})`, body, true);
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
    html += collapsibleSection(`Environment — effective / masked (${n})`, body, false);
  }

  return html;
}

function preflightInnerBlocks() {
  return statusWrap ? [...statusWrap.querySelectorAll("details.pf-block")] : [];
}

function syncPreflightExpandAllButton() {
  const btn = document.getElementById("btnPreflightExpandAll");
  if (!btn) return;
  const blocks = preflightInnerBlocks();
  btn.disabled = blocks.length === 0;
  btn.setAttribute("aria-label", "Expand all sections");
}

async function drainStreamingRunResponse(r) {
  if (r.status === 409) {
    log(`Error: ${await r.text()}\n`);
    return false;
  }
  if (!r.ok || !r.body) {
    log(`HTTP ${r.status} ${await r.text()}\n`);
    return false;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    log(dec.decode(value, { stream: true }));
  }
  return true;
}

async function refreshStatus() {
  const btn = document.getElementById("btnStatus");
  const ind = document.getElementById("statusRefreshIndicator");
  clearStatusRefreshInterval();

  const t0 = Date.now();
  const tick = () => {
    if (!ind) return;
    const s = Math.floor((Date.now() - t0) / 1000);
    ind.textContent = `Refreshing… ${s}s`;
  };

  if (btn) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
  }
  tick();
  statusRefreshIntervalId = setInterval(tick, 500);

  statusWrap.innerHTML = `<p class="pf-v5-c-content pf-m-0 status-refresh-loading">Loading…</p>`;
  syncPreflightExpandAllButton();

  try {
    const r = await fetch("/api/status");
    let body;
    try {
      body = await r.json();
    } catch {
      statusWrap.innerHTML = collapsibleSection(
        "Error response",
        `<pre class="err">${escapeHtml("Response was not JSON")}</pre>`,
        true,
      );
      syncPreflightExpandAllButton();
      return;
    }
    if (!r.ok) {
      const errPre = `<pre class="err">${escapeHtml(JSON.stringify(body, null, 2))}</pre>`;
      statusWrap.innerHTML = collapsibleSection("Error response", errPre, true);
      syncPreflightExpandAllButton();
      return;
    }
    const pf = body.preflight;
    statusWrap.innerHTML = renderPreflight(pf);
    syncPreflightExpandAllButton();

    const mods = body.modules || [];
    applyModuleStatuses(mods, pf);
  } catch (e) {
    statusWrap.innerHTML = collapsibleSection(
      "Refresh failed",
      `<pre class="err">${escapeHtml(String(e))}</pre>`,
      true,
    );
    syncPreflightExpandAllButton();
  } finally {
    clearStatusRefreshInterval();
    if (ind) ind.textContent = "";
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  }
}

function selectionIncludesCentral(slugs) {
  return slugs.some((s) => canonicalSlugForStatus(String(s)) === "central");
}

function selectionIncludesRoxctlEnv(slugs) {
  return slugs.some((s) => canonicalSlugForStatus(String(s)) === "roxctl-env");
}

/** Confirm writing ~/.roxctl/set-env.sh when running module roxctl-env only. */
function confirmRoxctlEnvSyncRun() {
  return window.confirm(
    [
      "Run module roxctl-env?",
      "",
      "This will update ~/.roxctl/set-env.sh on this machine:",
      "ROX_ENDPOINT ← OpenShift Central Route (central / stackrox).",
      "If Central has no active API token named roxctl-admin (env ROXCTL_ADMIN_TOKEN_NAME),",
      "the script creates one (Admin) using ROX_API_TOKEN or admin password from Secret central-htpasswd (oc),",
      "and sets ROX_API_TOKEN in that file.",
      "",
      "Other unrelated exports are preserved.",
      "",
      "Cancel = stop (you can run later by selecting roxctl-env and Run selected).",
      "OK = proceed.",
    ].join("\n"),
  );
}

/** @returns {boolean} whether user chose to allow ~/.roxctl/set-env.sh ROX_ENDPOINT update */
function confirmRoxctlEnvUpdate(slugs) {
  if (!selectionIncludesCentral(slugs)) return false;
  return window.confirm(
    [
      "This run includes the Central module (install-central).",
      "",
      "If you click OK, acs-demo-setup.sh will update on this machine:",
      "  ~/.roxctl/set-env.sh",
      "",
      "It will set ROX_ENDPOINT from the OpenShift Route in your current oc context",
      "(route name \"central\", namespace stackrox — override with CENTRAL_ROUTE_NAME / STACKROX_NAMESPACE in the shell if needed).",
      "",
      "Existing lines (e.g. ROX_API_TOKEN) are kept; only ROX_ENDPOINT is added or replaced.",
      "",
      "Cancel = run without changing that file.",
      "OK = update the file after Central install / noop.",
    ].join("\n"),
  );
}

/**
 * @param {string[]} mods
 * @param {{ promptRoxctlEnvIfCentral?: boolean }} [opts]
 */
async function runModules(mods, opts = {}) {
  let updateRoxctlEnv = false;
  if (opts.promptRoxctlEnvIfCentral) {
    if (selectionIncludesRoxctlEnv(mods) && !confirmRoxctlEnvSyncRun()) return;
    updateRoxctlEnv = confirmRoxctlEnvUpdate(mods);
  }

  clearLog();
  const payload = { modules: mods };
  if (updateRoxctlEnv) payload.updateRoxctlEnv = true;
  log(`POST /api/run ${JSON.stringify(payload)}\n`);
  const r = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const ok = await drainStreamingRunResponse(r);
  if (ok) await refreshStatus();
}

document.getElementById("btnRun").onclick = async () => {
  const sel = selectedSlugs();
  if (!sel.length) {
    alert("Select at least one module, or use Run full install.");
    return;
  }
  await runModules(sel, { promptRoxctlEnvIfCentral: true });
};

document.getElementById("btnRunFull").onclick = async () => {
  await runModules([...FULL_INSTALL_SLUGS_ORDERED], { promptRoxctlEnvIfCentral: true });
};

document.getElementById("btnStatus").onclick = refreshStatus;

document.getElementById("btnPreflightExpandAll").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const blocks = preflightInnerBlocks();
  if (!blocks.length) return;
  const anyClosed = blocks.some((d) => !d.open);
  const openNext = anyClosed;
  blocks.forEach((d) => {
    d.open = openNext;
  });
  e.currentTarget.setAttribute(
    "aria-label",
    openNext ? "Collapse all sections" : "Expand all sections",
  );
});

loadModules().then(() => refreshStatus());
