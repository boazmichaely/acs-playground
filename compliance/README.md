# Compliance profiles: a readable snapshot of OpenShift rules

If you work with **OpenShift compliance profiles**—CIS, STIG, PCI, and the rest—you have probably opened a profile or a rule in the cluster and been handed a **very long block of text**. Steps, audit commands, file paths, and links run together. It is hard to scan, hard to brief someone else on, and awkward to review in a meeting.

This folder holds a small **offline report** that fixes that experience. You get a normal web page you can open from your laptop: **profiles in a table**, **plain-language summaries**, and—when you drill in—**rule guidance that is formatted for humans**, not for a database field.

---

## What you can do with it

- **Browse every compliance profile** the cluster exposes, with filters and sorting, the way you would in a spreadsheet.
- **Open a profile** to read its official title and description without clicking through the console.
- **See how many rules** sit under each profile and **open the list** for that profile.
- **Expand a single rule** to read its full guidance with **headings, steps, lists**, and **commands shown in a separate, easy-to-copy block** where that makes sense.
- **Adjust how much of the rule list fits on screen** using the resize control under the table (your preference can be remembered on that machine).
- **Work offline**: once the page exists, it does not phone home to the cluster. You can archive it, attach it to a ticket, or walk through it in a readout.

None of this replaces the Compliance Operator or your cluster settings. It is a **read-only mirror** of what the API already says—presented so that product, GRC, or platform folks can actually use it.

---

## How you get your copy

Someone who can reach the cluster (usually an engineer with the `oc` command-line tool and permission to read the compliance namespace) runs **one small script** that lives in this folder. The script asks OpenShift for the same profile and rule records the console would show, then **writes a single HTML file**.

That file is your **snapshot**. Open it in Chrome, Firefox, or Safari like any downloaded report. You do not install a server or sign into the cluster again to read it.

If you are the person running the export, the exact command names live in **Appendix A** at the bottom of this document. Everyone else only needs the finished HTML.

---

## Why the rule text finally reads well

Compliance rules ship as **one long string** per rule. Authors mix story, numbered steps, “add these lines to your audit config,” shell snippets, paths, and URLs. A typical tool either shows that as a single paragraph or dumps it all in monospace. Neither is pleasant.

Here, the page applies a set of **careful reading rules** (developed against real rule text from common profiles):

1. **Cleanup** — harmless junk at the start of a field is removed; odd line breaks around steps or footnotes are normalized so steps stay in order.
2. **Structure** — blank lines and numbering are interpreted so you get real paragraphs and real lists instead of one slab of text.
3. **Commands and recipes** — when the text says, in effect, “add the following lines,” the following **audit-style lines** (the ones starting with `-` that many admins recognize) are grouped into a **fixed-width block** so they read like a recipe card, not like prose.
4. **Paths and links** — file paths and URLs are picked out so links are clickable and paths are easy to spot.
5. **Shell snippets** — short scripts (for example loops that use `oc`) can be broken out so the English explanation stays readable and the script stays copy-pasteable.

The same ideas could later power **in-product** experiences (for example in RHACS) where check descriptions today are still mostly plain text. **Appendix B** sketches that path for engineering partners.

---

## Where the information lives (before and after the snapshot)

**On the cluster**, OpenShift stores compliance definitions as **Kubernetes objects**. Think of two layers:

- **Profiles** — the named bundles you hear about in sales and audits (“CIS on the nodes,” “STIG for the platform,” and so on). Each profile carries metadata, a human description, and a **ordered list of rule names** that belong to it.
- **Rules** — the individual checks. Each has a name, a title, a severity, and that **long description** string described above.

**In the snapshot file**, everything you need is **bundled together** so the page works on an airplane:

- A **roster of profiles** with the fields you would want in a review (name, applicability, counts, short summary line, full text when expanded).
- A **library of rules** keyed by name, so when you expand “rule 37 of 200” the text is already there—no second round trip to the cluster.

That design is what makes the file large sometimes: popular clusters ship **hundreds or thousands** of rules, and the snapshot includes the text for all of them so any profile can be explored fully offline.

---

## The “lab” (what it is, in one minute)

While the formatting rules were being invented and tested, engineers used a **tiny side page** with a handful of sample rules—the **rule render lab**. It starts fast, shows before/after, and makes it obvious when a new phrase in the wild breaks the heuristics.

The important point for everyone else: **the lab and the big profile report share the same formatter.** Tuning happened in the lab; the **finished behavior** is what you see when you open the full HTML export. You do not need to open the lab to use the product of this folder.

---

## Who this is for

- **Product and program managers** reviewing what OpenShift actually promises in a profile.
- **Customer-facing teams** preparing readouts or comparisons without live cluster access.
- **Engineers** who already live in `oc` but want a **shareable artifact** for peers who do not.

---

## Appendix A — For engineers: what is in the folder and how it is built

| File | Role |
|------|------|
| `generate_compliance_profiles_html.py` | Fetches profiles and rules via `oc`, shapes rows (including heuristic one-line summaries), emits one self-contained HTML page. Embeds the rule formatter script at build time. |
| `rule_render_lab.js` | Implements the description pipeline (preprocess → blocks → structured output). |
| `rule_render_lab.css` | Styles for the lab page; key rules are mirrored in the generated HTML for matching appearance. |
| `extract_rule_render_lab_fixture.py` | Pulls a small multi-profile fixture out of an existing generated HTML file (reads embedded profile JSON). |
| `build_rule_render_lab.py` | Builds `rule_render_lab.html` from a fixture + CSS + JS for fast iteration. |
| `lab-*.json` | Saved samples used by the lab builder. |

**Build flow (cluster):** `oc get profiles …` → `oc get rules …` → Python normalizes data → HTML template written with embedded JSON (`profile-data`) plus client-side UI logic → formatter script pasted in from `rule_render_lab.js` → single output file.

**Lab flow:** adjust `rule_render_lab.js` / `.css` → run `build_rule_render_lab.py` → refresh `rule_render_lab.html` → when happy, rerun the main script so the big export picks up the same JS.

**Tweaks:** profile summary lines → `summarize()` in the Python script. Description grammar → `rule_render_lab.js`. Table chrome (columns, filters, rules pane height behavior) → inline style/script in the Python template.

Generated HTML outputs are usually **gitignored**; source files in this directory are what you version and reuse.

**Commands:**

```bash
./generate_compliance_profiles_html.py -o profiles-from-cluster.html
python3 extract_rule_render_lab_fixture.py --html profiles-short-summaries.html -o lab-multi-profile-rules.json
python3 build_rule_render_lab.py --fixture lab-multi-profile-rules.json
```

**Git note:** UI work on the profiles viewer and rules-pane resize was tagged `compliance-profiles-html-ui`.

---

## Appendix B — Toward RHACS (StackRox) in-product descriptions

RHACS Central today shows compliance check detail largely as **plain text** in PatternFly description lists (see upstream `CheckDetailsInfo.tsx` under `ui/apps/platform/src/Containers/ComplianceEnhanced/Coverage/`). A practical rollout sequence:

1. **Confirm the field** — Ensure the API string you want to beautify maps to the same “long description” concept as OpenShift Rule CR text.
2. **Component first** — Port or wrap the formatter behind a single UI component with tests on real strings.
3. **Wire check details** — Swap or augment the description row in check detail views.
4. **Spread where useful** — Tables, exports, and accessibility review as product scope allows.
5. **Harden** — Security review (treat text as untrusted), CSP, i18n, bundle size.

Demo URLs (require a live Central session):  
`https://central-stackrox.apps.bm-customer-demo.ocp.infra.rox.systems/main/compliance/schedules`  
`https://central-stackrox.apps.bm-customer-demo.ocp.infra.rox.systems/main/compliance/coverage/profiles/ocp4-cis/checks`

---

*Earlier draft of this README preserved as `README.disaster` for comparison.*
