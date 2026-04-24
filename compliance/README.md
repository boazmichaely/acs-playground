# Compliance profiles viewer & rule description lab

This directory contains **offline tooling** around the **OpenShift Compliance Operator**: pull Profile and Rule custom resources from a cluster (or stdin), bake them into a **single interactive HTML file**, and optionally render long **Rule CR descriptions** with structure (audit recipes, shell snippets, links) instead of a plain wall of text.

The README is written **top-down**: overview and behavior first, then data, then rendering concepts, then files and knobs, then how this could relate to **RHACS** (StackRox) compliance UI. Later sections stay useful even if upstream integration work pauses.

---

## Table of contents

1. [What this does](#1-what-this-does)
2. [How it operates (end-to-end)](#2-how-it-operates-end-to-end)
3. [Data: where it lives and how it is organized](#3-data-where-it-lives-and-how-it-is-organized)
4. [Rendering: what the “magic” is](#4-rendering-what-the-magic-is)
5. [Implementation: files, tweaks, and the lab](#5-implementation-files-tweaks-and-the-lab)
6. [Adopting this rendering in RHACS (frontend-focused, phased)](#6-adopting-this-rendering-in-rhacs-frontend-focused-phased)
7. [Git backup / tags](#7-git-backup--tags)
8. [Open questions (for the authors)](#8-open-questions-for-the-authors)

---

## 1. What this does

| Deliverable | Purpose |
|-------------|---------|
| **`generate_compliance_profiles_html.py`** | Fetches **profiles** and **rules** from the cluster (via `oc`), builds JSON rows, emits one **self-contained HTML** page: sortable/filterable profile table, expandable profile text, expandable per-profile **rules** grid with rule detail pane. |
| **`rule_render_lab.js`** (+ **`rule_render_lab.css`**) | **Description renderer**: turns a Rule CR’s free-form `description` string into DOM (paragraphs, lists, monospace blocks for audit lines, inline code for paths/commands, links for URLs). |
| **Lab build scripts** | **`extract_rule_render_lab_fixture.py`** pulls a small JSON fixture from generated HTML; **`build_rule_render_lab.py`** stitches fixture + CSS + JS into **`rule_render_lab.html`** for quick iteration **without** the cluster. |

There is **no server**: open the HTML in a browser (`file://` works). Everything is embedded (data + script + optional renderer).

---

## 2. How it operates (end-to-end)

High-level steps **when you run the generator against a live cluster**:

1. **`oc get profiles.compliance.openshift.io -n <ns> -o json`**  
   Collect every Profile CR. For each profile, keep metadata and the **`rules`** list (rule **names** referencing Rule CRs).

2. **`oc get rules.compliance.openshift.io -n <ns> -o json`**  
   Build a **rule catalog**: map `metadata.name` → `{ title, description, severity }`.  
   This can be **large** (hundreds/thousands of rules); the HTML embeds the full catalog for offline expansion.

3. **Python shaping (`build_rows`)**  
   Normalizes each profile into a row object: counts, applicability from annotations, human **summary** line (heuristic `summarize()` in the script), full title/description text, ordered **`ruleNames`**.

4. **HTML template assembly**  
   - Injects **`#profile-data`**: JSON `{ profiles, ruleCatalog }` (escaped for HTML).  
   - Injects **`rule_render_lab.js`** at build time in place of a sentinel token (see §5).  
   - Client-side JS in the template drives tables, filters, column resize, expand/collapse, and calls **`renderRuleDescriptionRich(container, description)`** when a rule row is expanded.

5. **Browser**  
   Parses JSON once, renders the UI entirely in JS. **No follow-up cluster calls.**

**stdin path (`--stdin`)**: supply Profile list JSON only; rule catalog will be empty unless you extend the pipeline. **`--skip-rules`**: faster/smaller HTML; rule detail shows “missing catalog”.

---

## 3. Data: where it lives and how it is organized

### 3.1 Source of truth (cluster)

| Kubernetes kind | Namespace (default) | Used fields |
|-----------------|----------------------|-------------|
| `profiles.compliance.openshift.io` | `openshift-compliance` (configurable `-n`) | `metadata.name`, `title`, `description`, `version`, `rules[]`, product annotations |
| `rules.compliance.openshift.io` | same | `metadata.name`, `title`, `description`, `severity` |

### 3.2 Inside generated HTML (`#profile-data`)

Single JSON object (see generator: `payload = {"profiles": rows, "ruleCatalog": catalog}`):

- **`profiles`**: array of profile objects, each including **`ruleNames`** (ordered rule ids for that profile).
- **`ruleCatalog`**: object keyed by rule id; values hold **`title`**, **`description`** (long prose + recipes), **`severity`**.

Everything is **flat JSON** embedded in a `<script type="application/json" id="profile-data">` block so the page works offline.

### 3.3 Lab fixtures (JSON on disk)

| File | Role |
|------|------|
| **`lab-multi-profile-rules.json`** | Default multi-profile bundle for **`build_rule_render_lab.py`**: `{ "profiles": [ { "profile", "rules": [ { id, title, description } ] } ] }`. |
| **`lab-ocp4-*.json`** | Older/smaller fixtures (optional). |

Fixtures are **not** fetched at lab runtime; they are snapshots for **renderer development**.

### 3.4 Git policy (repo root `.gitignore`)

Generated HTML such as **`profiles-from-cluster.html`**, **`profiles-short-summaries.html`**, and **`rule_render_lab.html`** is typically **gitignored** so large, machine-specific blobs do not land in git. **What is versioned** is the **generator + renderer source**; anyone can recreate HTML locally.

---

## 4. Rendering: what the “magic” is

Rule descriptions are **one string** in the CR. Authors mix narrative steps, numbered lists, auditctl lines (`-a` / `-w`), shell loops, file paths, URLs, and occasional structured fragments. A naïve UI shows that as wrapped monospace or a single paragraph.

This lab’s renderer (`rule_render_lab.js`) applies a **pipeline**:

1. **Preprocess** (string in → string out)  
   Examples: strip leading YAML chaff (`-|`), normalize “done 2.” step boundaries, split citation markers from URLs, normalize newlines.

2. **Split into coarse blocks**  
   Blank-line-separated chunks become candidate **paragraphs** (or merged where audit boilerplate was split from the recipe lines that follow).

3. **Paragraph-level intelligence**  
   - Detect **Markdown-ish** bullets / numbering.  
   - Detect **URLs** and **file paths** for links or `<code>`.  
   - Detect **“add the following line(s)”**-style captions and pull following **`-a` / `-w` lines** (and some **`KEY = value`** auditd-style lines) into a single **monospace block** (`.rule-shell`).  
   - Detect **shell / oc debug** loops after colons, etc.

4. **DOM assembly**  
   Append `<p>`, `<ol>`, `<ul>`, `<pre class="rule-shell">`, spans with classes for inline tokens, etc. The profile HTML uses the same classes in its embedded CSS so the look matches the lab.

**Contract for reuse**: at the end of the IIFE, the script assigns:

```js
globalThis.renderRuleDescriptionRich = renderDescription;
```

The generator’s inline UI calls that function if present; otherwise it falls back to plain `textContent`.

---

## 5. Implementation: files, tweaks, and the lab

### 5.1 File map

| Path | Responsibility |
|------|------------------|
| **`generate_compliance_profiles_html.py`** | `oc` fetch, row building, `summarize()`, HTML shell, embedded profile UI JS/CSS, sentinel injection of **`rule_render_lab.js`**. |
| **`rule_render_lab.js`** | All description parsing/rendering; exports **`renderRuleDescriptionRich`**. |
| **`rule_render_lab.css`** | Lab page styling; profile HTML duplicates key rules under **`.rule-detail-body`** for consistency. |
| **`extract_rule_render_lab_fixture.py`** | Reads **`#profile-data`** from a generated HTML file, extracts selected profiles + catalog slice → **`lab-multi-profile-rules.json`**. |
| **`build_rule_render_lab.py`** | Produces **`rule_render_lab.html`**: embeds fixture JSON, CSS, JS → one file for rapid refresh. |
| **`lab-*.json`** | Fixture data; safe to regenerate from cluster HTML. |

### 5.2 Where to tweak things

| Goal | Where |
|------|--------|
| Profile **summary** one-liner heuristics | **`summarize()`** in **`generate_compliance_profiles_html.py`** |
| Columns, filters, rules grid **layout**, resize bar, **localStorage** key for rules pane height | HTML shell **`<style>`** + **`mountRulesGrid`** / related JS in same file |
| **Rule description** grammar (new boilerplate phrases, new block types) | **`rule_render_lab.js`** (regexes, `consumeAuditFollowingBlock`, lists, preprocessors) |
| **Visual** polish for rendered descriptions in **both** lab and profiles HTML | Prefer **`rule_render_lab.css`** for lab; mirror critical selectors into the generator’s **`.rule-detail-body …`** rules (or refactor to shared CSS file later) |
| Sentinel / bundled JS file name | Top of **`generate_compliance_profiles_html.py`** (`RULE_RENDERER_*` constants) |

### 5.3 Why the lab exists (and why it confuses newcomers)

There are **two surfaces**:

| Surface | Input | Output | Typical loop |
|---------|--------|--------|----------------|
| **Profiles HTML** (generator) | Live cluster or stdin | Large **`profiles-*.html`** with full catalog | Change renderer → rerun **generator** (embeds fresh `rule_render_lab.js`) → refresh |
| **Rule render lab** | Small **fixture JSON** | **`rule_render_lab.html`** | Edit **`rule_render_lab.js`** / **`.css`** → **`build_rule_render_lab.py`** → refresh |

**Mental model:** **`rule_render_lab.js` is the single source of truth** for description rendering. The lab exists so you can iterate in **seconds** on real-ish text without `oc`, without multi‑MB HTML, and with **raw JSON drawers** per rule for debugging. The generator **copies** that JS into the big HTML at build time.

**Common pitfall:** editing only **`rule_render_lab.html`** or a generated **`profiles-*.html`** in the editor. Those are **outputs**; changes get overwritten. Edit **`rule_render_lab.js`** (and/or the generator template), then rebuild the artifact you open in the browser.

---

## 6. Adopting this rendering in RHACS (frontend-focused, phased)

RHACS (StackRox) **Compliance 2.0** UI is a **React + PatternFly** app under **`ui/apps/platform`**. Compliance **coverage** routes and **scan schedules** live under **`Containers/ComplianceEnhanced/`**. This section is **incremental**: each phase is useful on its own if later phases stall.

> **Note:** A request to the demo Central URL from an automated environment returned **HTTP 500** (no session / server-side). When live UI access is available, validate assumptions against the running app. **Fallback** is always the public **`stackrox/stackrox`** tree on GitHub.

### Phase 0 — Map RHACS UI to data (no new renderer yet)

**Goal:** Know which API field equals the Rule CR `description` you already handle.

- **Coverage / checks:** routes are defined in  
  **`ui/apps/platform/src/Containers/ComplianceEnhanced/Coverage/compliance.coverage.routes.ts`**  
  (`…/profiles/:profileName/checks`, `…/checks/:checkName`, etc.).
- **Check detail content:** today, check **`description`** (and rationale, instructions, …) are rendered largely as **plain text** inside PatternFly **`DescriptionList`** in  
  **`…/Coverage/components/CheckDetailsInfo.tsx`**  
  (e.g. `{description}` without rich formatting).
- **Schedules:** wizard and detail views under  
  **`…/ComplianceEnhanced/Schedules/`** (`compliance.scanConfigs.routes.ts`, wizard components).

**Outcome of phase 0:** a short internal note listing **GraphQL/REST** service + TypeScript types for **`ComplianceCheckResult`** (see imports in `CheckDetailsInfo.tsx`) and which string field should pass through the rich renderer.

### Phase 1 — Isolate a “rich description” component (RHACS repo)

**Goal:** One React component that accepts **`description: string`** (and maybe `className`) and renders PatternFly-safe DOM.

- Port **logic** from **`rule_render_lab.js`** to **TypeScript** (or wrap the existing IIFE bundle in a `useEffect` + ref container if you want a thin first step—tradeoffs: CSP, bundle size, typing).
- Prefer **explicit DOM** or a minimal internal builder (same as today) over `dangerouslySetInnerHTML` unless you add a **sanitization** pass.
- Unit tests: snapshot a handful of **real** description strings from fixtures (`lab-multi-profile-rules.json` or exported from cluster).

**Exit criteria:** Storybook (or unit tests) shows improved layout for representative checks without touching routing yet.

### Phase 2 — Wire into check details only

**Goal:** Replace or augment the **`Description`** `DescriptionListDescription` content in **`CheckDetailsInfo.tsx`** with the rich component **when** the string looks “complex” or unconditionally if product agrees.

- Watch for **accessibility**: headings hierarchy, list semantics, keyboard focus inside expanded regions.
- Watch for **performance**: very long descriptions should not block main thread (chunking, `requestIdleCallback`, or virtualize if needed—usually unnecessary if DOM size is modest).

### Phase 3 — Tables, lists, and consistency

**Goal:** Same rendering for description snippets in **tables** (e.g. profile checks list) if those cells show truncated text with expand behavior—align truncation/expansion UX with the rest of the app.

Relevant files to inspect (names from upstream tree): **`ProfileChecksPage.tsx`**, **`ProfileChecksTable.tsx`**, **`CheckDetailsPage.tsx`**.

### Phase 4 — Product hardening

- **Security:** treat descriptions as **untrusted**; align with platform **CSP** (inline styles, `eval`, third-party scripts).
- **i18n / theming:** classnames vs PatternFly tokens; dark mode.
- **Bundle size:** tree-shake helpers; lazy-load heavy grammar if the port grows.

### Phase 5 — Backend / API (optional, non-frontend)

Only if the UI needs **prestructured** fields (separate rationale vs recipe): consider API/schema changes **after** the frontend proves value with the current string-only contract.

---

## 7. Git backup / tags

Meaningful UI work on the profiles viewer + resize interaction was captured in git with tag **`compliance-profiles-html-ui`** (annotated). The versioned artifact is **`generate_compliance_profiles_html.py`** plus **`rule_render_lab.js`**; regenerate HTML as needed.

---

## 8. Open questions (for the authors)

These are worth answering when someone picks up RHACS integration:

1. **Target product surface:** check details only, or also **scan result** tables, **PDF**/email exports, etc.?
2. **Trust model:** is rich HTML (DOM) acceptable, or must output remain **Markdown → safe HTML** with a sanitizer?
3. **Parity:** should **ACS Console** (OpenShift) compliance views share the same component library as **Central** UI?
4. **Fixture refresh:** who owns periodic refresh of **`lab-multi-profile-rules.json`** from real clusters (and which profiles are canonical)?

---

## Quick commands (reference)

```bash
# Full profiles HTML (cluster; includes rule catalog)
./generate_compliance_profiles_html.py -o profiles-from-cluster.html

# Lab fixture from an existing generated HTML file
python3 extract_rule_render_lab_fixture.py --html profiles-short-summaries.html -o lab-multi-profile-rules.json

# Standalone lab HTML
python3 build_rule_render_lab.py --fixture lab-multi-profile-rules.json
```

---

## Demo URLs (manual verification)

When logged into Central in a browser:

- **Schedules:** `https://central-stackrox.apps.bm-customer-demo.ocp.infra.rox.systems/main/compliance/schedules`
- **Coverage checks (example profile):** `https://central-stackrox.apps.bm-customer-demo.ocp.infra.rox.systems/main/compliance/coverage/profiles/ocp4-cis/checks`

If automated fetch fails, use **browser devtools** + **stackrox/stackrox** sources as described in §6.
