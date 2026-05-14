const logEl = document.getElementById("log");
const modulesTbody = document.getElementById("modulesTbody");
const modSelectAll = document.getElementById("modSelectAll");
const modSelectionCount = document.getElementById("modSelectionCount");
const moduleBulkBar = document.getElementById("moduleBulkBar");
const statusWrap = document.getElementById("statusWrap");
const credFilePath = document.getElementById("credFilePath");

/**
 * Canonical module ids for status/API come from `acs-demo-setup.sh --status`. Manifest `modules.json` may use
 * display ids (e.g. ocp-OAuth); GET /api/modules includes `canonicalAliases` (authoritative copy of server
 * MODULE_ID_CANONICAL_ALIASES). Fallback below is only for stale servers.
 */
let canonicalAliasesFromServer = { "ocp-OAuth": "ocp-oauth" };

function canonicalSlugForStatus(slug) {
  return canonicalAliasesFromServer[slug] || slug;
}

const DEFERRED_MODULE_SLUGS = new Set([]);

/** Canonical `/api/run` slugs: ACS demo script order, then Splunk last (`splunk-lab.sh`). Includes `slack-notifier` (Central Slack integration). */
const FULL_INSTALL_SLUGS_ORDERED = [
  "central",
  "secured-cluster",
  "ms-demo",
  "init-demo",
  "registries",
  "ocp-users",
  "ocp-oauth",
  "acs-users",
  "slack-notifier",
  "compliance-operator",
  "splunk",
];

/** Filled in loadModules: canonical id → { dependsOn: canonical[] } */
let moduleMetaByCanonical = new Map();

let lastStatusMap = new Map();
/** Full `modules` array from last `/api/status` (includes securedCluster breakdown). */
let lastStatusModules = [];

/** Parsed from last streamed install log (`print_install_footer`); cleared when a new run starts. */
let lastOcpUsersPasswordsFromLog = [];

let statusRefreshIntervalId = null;
let credSaveFeedbackTimer = null;

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
  lastOcpUsersPasswordsFromLog = [];
}

/**
 * Option B: extract adam/boaz/chris lines from `acs-demo-setup.sh` `print_install_footer` in the log.
 * Anchor: "OpenShift users (passwords generated or merged this run" … lines like "  adam / <password>".
 */
function parseOcpUsersPasswordsFromLog(text) {
  const raw = String(text ?? "");
  const key = "OpenShift users (passwords generated or merged this run";
  const idx = raw.lastIndexOf(key);
  if (idx === -1) return [];
  const tail = raw.slice(idx);
  const lines = tail.split(/\r?\n/);
  const out = [];
  const re = /^\s*(adam|boaz|chris)\s*\/\s*(.*)$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(re);
    if (m) {
      out.push({ login: m[1].toLowerCase(), password: (m[2] ?? "").trim() });
      continue;
    }
    if (out.length > 0) {
      const t = line.trim();
      if (t === "" || t.startsWith("OpenShift users")) continue;
      if (t.includes("(unknown)")) continue;
      break;
    }
  }
  return out;
}

function ocpUsersPasswordsCollapseHtml() {
  const rows = lastOcpUsersPasswordsFromLog;
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const body = rows
    .map(
      (r) =>
        `<div class="ocp-users-pw-row"><span class="ocp-users-pw-login">${escapeHtml(r.login)}</span> <code class="ocp-users-pw-code">${escapeHtml(r.password)}</code></div>`,
    )
    .join("");
  return `<details class="sc-levels re-env-levels"><summary class="sc-levels__sum">HTPasswd</summary><div class="sc-levels__body">${body}</div></details>`;
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

/**
 * UI-only module state (exception: "logic lives in the script" rule):
 * Checkbox lock/disable for rows whose `dependsOn` are not yet `ready` in the last `/api/status`.
 * The bootstrap script cannot know which modules the user will run in this GUI session, so we treat
 * "checked for this run" as satisfying a dependency alongside `ready`. All detail text, URLs, and
 * API-id stripping come from `acs-demo-setup.sh --status` (plus server merge for Splunk), not here.
 */

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

/** Select / clear the runnable full-install set (includes Splunk when selected). */
function applySelectAll(on) {
  if (!on) {
    getModuleCheckboxes().forEach((c) => {
      c.checked = false;
    });
    syncDependencyLocks();
    syncMasterCheckbox();
    return;
  }
  // After each pass, re-run locks: selecting a parent can unlock dependents (e.g. central → secured-cluster).
  // Each pass is cheap (~9 rows); cost adds up only when we repeat. Exit early if no checkbox flipped on
  // this pass (already fully selected). Cap 5 passes for deep chains; more suggests inconsistent metadata.
  for (let pass = 0; pass < 5; pass++) {
    const cbByCanon = collectCheckboxByCanonical();
    let anyNewlyChecked = false;
    for (const slug of FULL_INSTALL_SLUGS_ORDERED) {
      const canonical = canonicalSlugForStatus(slug);
      const cb = cbByCanon.get(canonical);
      if (cb && !cb.disabled) {
        if (!cb.checked) anyNewlyChecked = true;
        cb.checked = true;
      }
    }
    syncDependencyLocks();
    if (!anyNewlyChecked) break;
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

/** Escape plain text; split on embedded schemes so `…comhttps://…` yields two links. */
function linkifyHttpsUrls(text) {
  const raw = String(text ?? "");
  const pieces = raw.split(/(?=https?:\/\/)/);
  let out = "";
  for (const piece of pieces) {
    if (!piece) continue;
    if (/^https?:\/\//.test(piece)) {
      const reOne = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s<>"'()[\]{}]*)?/;
      const m = piece.match(reOne);
      if (m) {
        const url = m[0].replace(/[),.;]+$/g, "");
        const rest = piece.slice(m[0].length);
        out += `<a class="module-detail-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
        out += /^https?:\/\//.test(rest) ? linkifyHttpsUrls(rest) : escapeHtml(rest);
        continue;
      }
    }
    out += escapeHtml(piece);
  }
  return out;
}

/** One-line module detail: linkify https URLs only (`--status` / server produce plain text). */
function linkifiedModuleDetailHtml(detailRaw) {
  const t = String(detailRaw ?? "").trim();
  return t ? linkifyHttpsUrls(t) : "";
}

/** Structured link on a status row: `configuredHyperlink` (REQUIREMENTS); `detailLink` accepted for older `--status` JSON. */
function moduleRowLinkObject(rowOrSt) {
  const o = rowOrSt && typeof rowOrSt === "object" ? rowOrSt : null;
  if (!o) return null;
  const ch = o.configuredHyperlink && typeof o.configuredHyperlink === "object" ? o.configuredHyperlink : null;
  if (ch) return ch;
  const legacy = o.detailLink && typeof o.detailLink === "object" ? o.detailLink : null;
  return legacy;
}

/** Prefer structured row link from `--status` JSON over bare-URL linkification of `detail`. */
function moduleDetailLinkOrLinkify(st, detailRaw) {
  const dl = moduleRowLinkObject(st);
  const href = dl && dl.href != null ? String(dl.href).trim() : "";
  const lab = dl && dl.label != null ? String(dl.label).trim() : "";
  if (href && lab) {
    return `<a class="module-detail-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(lab)}</a>`;
  }
  if (href) {
    return `<a class="module-detail-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>`;
  }
  return linkifiedModuleDetailHtml(detailRaw);
}

/** One-line Splunk Web URL: prefer https:// from status detail; else first Route host (legacy rows with splunkRoutes). */
function splunkWebUrlLineHtml(row, detailRaw) {
  const d = String(detailRaw ?? "").trim();
  if (/\bhttps:\/\//i.test(d)) return linkifiedModuleDetailHtml(d);
  const routes = row && Array.isArray(row.splunkRoutes) ? row.splunkRoutes : [];
  const pick =
    routes.find((r) => String(r && r.name != null ? r.name : "").trim() === "splunk-web") || routes[0];
  const host = pick && pick.host != null ? String(pick.host).trim() : "";
  if (!host) return "";
  const href = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return `<a class="module-detail-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>`;
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
    if (!row || row.id == null) continue;
    const mid = String(row.id).trim();
    if (!mid) continue;
    const dlRaw = moduleRowLinkObject(row);
    const href = dlRaw && dlRaw.href != null ? String(dlRaw.href).trim() : "";
    const label = dlRaw && dlRaw.label != null ? String(dlRaw.label).trim() : "";
    const configuredHyperlink =
      href && label ? { href, label } : href ? { href, label: href } : null;
    map.set(mid, {
      state: row.state != null ? String(row.state) : "",
      detail: row.detail != null ? String(row.detail) : "",
      configuredHyperlink,
    });
  }
  return map;
}

function detailLineForModule(canonicalId, statusMap) {
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
  const det = admin.detail ? String(admin.detail).trim() : "";
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
    const det = L && L.detail ? String(L.detail).trim() : "";
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
  const title = escapeHtml(String(detail ?? "").trim());
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

function moduleStatusCellInnerHtml(canonicalId, statusMap) {
  const badge = badgeOnlyHtml(canonicalId, statusMap);
  let detailInner = "";
  if (canonicalId === "roxctl-env") {
    const row = lastStatusModules.find((x) => x && x.id === "roxctl-env");
    const cc =
      row && row.roxctlEnvConsistency && typeof row.roxctlEnvConsistency === "object"
        ? row.roxctlEnvConsistency
        : null;
    const layers = cc && roxctlEnvConsistencyBlockHtml(cc);
    const summaryLine = detailLineForModule(canonicalId, statusMap);
    const sumHtml = summaryLine ? linkifiedModuleDetailHtml(summaryLine) : "";
    detailInner = `${sumHtml ? `<div class="sc-overall">${sumHtml}</div>` : ""}${layers || ""}`;
    if (!String(detailInner).trim()) detailInner = "—";
  } else if (canonicalId === "secured-cluster") {
    const row = lastStatusModules.find((x) => x && x.id === "secured-cluster");
    const sc = row && row.securedCluster && typeof row.securedCluster === "object" ? row.securedCluster : null;
    const layers = sc && securedClusterLevelsBlockHtml(sc);
    const summaryLine = detailLineForModule(canonicalId, statusMap);
    const sumHtml = summaryLine ? linkifiedModuleDetailHtml(summaryLine) : "";
    if (layers) {
      detailInner = `${sumHtml ? `<div class="sc-overall">${sumHtml}</div>` : ""}${layers}`;
    } else {
      detailInner = sumHtml || "—";
    }
  } else if (canonicalId === "splunk") {
    const row = lastStatusModules.find((x) => x && x.id === "splunk");
    const summaryLine = detailLineForModule(canonicalId, statusMap);
    const urlLine = splunkWebUrlLineHtml(row, summaryLine);
    detailInner = urlLine ? `<div class="sc-overall">${urlLine}</div>` : (summaryLine ? linkifiedModuleDetailHtml(summaryLine) : "—");
  } else if (canonicalId === "ocp-users") {
    const stOcp = statusMap.get(canonicalId);
    const detailRaw = detailLineForModule(canonicalId, statusMap);
    let sumHtml = linkifiedModuleDetailHtml(detailRaw);
    const pwHtml = ocpUsersPasswordsCollapseHtml();
    if (
      !sumHtml &&
      !pwHtml &&
      stOcp &&
      (stOcp.state === "ready" || stOcp.state === "partial")
    ) {
      sumHtml = escapeHtml("passwords are unknown");
    }
    const parts = [];
    if (sumHtml) parts.push(`<div class="sc-overall">${sumHtml}</div>`);
    if (pwHtml) parts.push(pwHtml);
    detailInner = parts.length ? parts.join("") : "—";
  } else {
    const st = statusMap.get(canonicalId);
    const detailRaw = detailLineForModule(canonicalId, statusMap);
    const sumHtml = moduleDetailLinkOrLinkify(st, detailRaw);
    detailInner = sumHtml ? `<div class="sc-overall">${sumHtml}</div>` : "—";
  }
  return `<div class="module-status-split">
    <div class="module-status-split__badge">${badge}</div>
    <div class="module-status-split__detail">${detailInner}</div>
  </div>`;
}

function applyModuleStatuses(statusModules) {
  lastStatusModules = Array.isArray(statusModules) ? statusModules : [];
  const map = statusMapFromModules(statusModules);
  lastStatusMap = map;

  const rows = modulesTbody.querySelectorAll("tr[data-module-canonical]");
  rows.forEach((tr) => {
    const cid = tr.getAttribute("data-module-canonical");
    if (!cid) return;
    const cell = tr.querySelector(".js-module-status-cell");
    if (!cell) return;
    cell.innerHTML = moduleStatusCellInnerHtml(cid, map);
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

async function loadCentralCredentials() {
  const r = await fetch("/api/central-credentials");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j.error || r.statusText || "failed to load credentials");
  }
  credFilePath.textContent = j.path || "—";
  const d = j.data || {};
  document.getElementById("credCentralEndpoint").value = d.centralEndpoint || "";
  document.getElementById("credApiKey").value = d.apiKey || "";
  document.getElementById("credAdminUsername").value = d.adminUsername || "admin";
  document.getElementById("credAdminPassword").value = d.adminPassword || "";
  const pref = (d.authPreference || "apiKey").toLowerCase() === "password" ? "password" : "apiKey";
  const pr = document.querySelector(`input[name="authPreference"][value="${pref}"]`);
  if (pr) pr.checked = true;
}

async function saveCentralCredentials() {
  const btn = document.getElementById("btnCredSave");
  const fb = document.getElementById("credSaveFeedback");
  if (credSaveFeedbackTimer) {
    clearTimeout(credSaveFeedbackTimer);
    credSaveFeedbackTimer = null;
  }
  fb.textContent = "";
  fb.classList.remove("cred-save-feedback--err");
  btn.disabled = true;
  const prefEl = document.querySelector('input[name="authPreference"]:checked');
  const authPreference = prefEl && prefEl.value === "password" ? "password" : "apiKey";
  const body = {
    centralEndpoint: document.getElementById("credCentralEndpoint").value.trim(),
    apiKey: document.getElementById("credApiKey").value,
    adminUsername: document.getElementById("credAdminUsername").value.trim() || "admin",
    adminPassword: document.getElementById("credAdminPassword").value,
    authPreference,
  };
  try {
    const r = await fetch("/api/central-credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      fb.textContent = j.error || j.detail || "Save failed";
      fb.classList.add("cred-save-feedback--err");
      return;
    }
    credFilePath.textContent = j.path || credFilePath.textContent;
    fb.textContent = "Saved";
    credSaveFeedbackTimer = setTimeout(() => {
      fb.textContent = "";
      credSaveFeedbackTimer = null;
    }, 2800);
  } catch (e) {
    fb.textContent = String(e.message || e);
    fb.classList.add("cred-save-feedback--err");
  } finally {
    btn.disabled = false;
  }
}

async function loadModules() {
  const r = await fetch("/api/modules");
  if (!r.ok) {
    modulesTbody.innerHTML = `<tr class="pf-v5-c-table__tr"><td class="pf-v5-c-table__td module-row-td" colspan="2"><span class="err">Failed to load modules: ${r.status}</span></td></tr>`;
    syncMasterCheckbox();
    return;
  }
  const data = await r.json();
  if (data && typeof data.canonicalAliases === "object" && data.canonicalAliases !== null) {
    canonicalAliasesFromServer = { ...canonicalAliasesFromServer, ...data.canonicalAliases };
  }
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
  applyModuleStatuses([]);
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
      const dRaw = c.detail != null ? String(c.detail).trim() : "";
      const detailCell = dRaw ? linkifyHttpsUrls(dRaw) : "—";
      body += `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(rowOk)}</td><td>${detailCell}</td></tr>`;
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
    html += collapsibleSection(`Environment — effective (${n})`, body, false);
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
    applyModuleStatuses(mods);
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

/** @returns {boolean} whether user chose to merge Central Route into central-credentials.json (not ~/.roxctl/set-env.sh) */
function confirmRoxctlEnvUpdate(slugs) {
  if (!selectionIncludesCentral(slugs)) return false;
  return window.confirm(
    [
      "This run includes the Central module (install-central).",
      "",
      "If you click OK, acs-demo-setup.sh will merge the OpenShift Central Route into your",
      "central-credentials.json file (field centralEndpoint — https://… from route \"central\" in namespace stackrox,",
      "unless you override CENTRAL_ROUTE_NAME / STACKROX_NAMESPACE in the shell).",
      "",
      "Other fields in that JSON (apiKey, adminPassword, authPreference, …) are preserved.",
      "~/.roxctl/set-env.sh is not updated by install-central — only the roxctl-env module changes that file.",
      "",
      "Cancel = run without updating the credentials JSON.",
      "OK = update centralEndpoint after Central install / noop.",
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
  lastOcpUsersPasswordsFromLog = parseOcpUsersPasswordsFromLog(logEl.textContent);
  if (ok) await refreshStatus();
  else if (lastStatusModules.length) applyModuleStatuses(lastStatusModules);
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

document.getElementById("btnCredSave").onclick = () => {
  saveCentralCredentials().catch((e) => alert(String(e.message || e)));
};

Promise.all([
  loadCentralCredentials().catch((e) => {
    credFilePath.textContent = `(${String(e.message || e)})`;
  }),
  loadModules(),
]).then(() => refreshStatus());
