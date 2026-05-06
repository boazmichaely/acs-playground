const logEl = document.getElementById("log");
const modulesTbody = document.getElementById("modulesTbody");
const modSelectAll = document.getElementById("modSelectAll");
const modSelectionCount = document.getElementById("modSelectionCount");
const moduleBulkBar = document.getElementById("moduleBulkBar");
const statusWrap = document.getElementById("statusWrap");

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
    modulesTbody.innerHTML = `<tr class="pf-v5-c-table__tr"><td class="pf-v5-c-table__td module-row-td"><span class="err">Failed to load modules: ${r.status}</span></td></tr>`;
    syncMasterCheckbox();
    return;
  }
  const data = await r.json();
  const list = data.modules || [];
  modulesTbody.innerHTML = "";
  for (const m of list) {
    const safeIdAttr = `mod-${String(m.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const tr = document.createElement("tr");
    tr.className = "pf-v5-c-table__tr";
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
      </td>`;
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
