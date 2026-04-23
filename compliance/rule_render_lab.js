/**
 * Standalone lab renderer for Rule CR descriptions (fixture JSON in #fixture).
 * Open rule_render_lab.html in a browser (file:// is fine).
 */
(function () {
  "use strict";

  function preprocessNumberedGlue(s) {
    const nl = String.fromCharCode(10);
    return String(s).replace(/([.!?])(\s+)(\d+)(\.\s+)(?=[A-Z$"'])/g, (_, a, b, c, d) => a + b + nl + c + d);
  }

  /**
   * Break "… done 2. Execute …" so step 2 starts on a new line but stays in the same
   * logical paragraph as step 1 (single newline). A blank line would start a new HTML
   * paragraph and a new <ol>, which resets numbering to 1.
   */
  function preprocessStepAfterDone(s) {
    const nl = String.fromCharCode(10);
    return String(s).replace(/\bdone\s+(\d+\.\s+Execute\b)/gi, "done" + nl + "$1");
  }

  /**
   * When a footnote marker is immediately followed by a URL, authors often write
   * "…text. [1] https://…" on one line. Insert a blank line only before [n] in that
   * pattern so "[1] This rule…" (prose after the marker) stays inline.
   * Skips list-like "1. [1] https://…" (digit before the period).
   */
  function preprocessCitationLinebreaks(s) {
    const nl = String.fromCharCode(10);
    return String(s).replace(
      /(?<![0-9])([.!?])([ \t]+)(\[\d{1,3}\])(\s*)(https?:\/\/\S+|ftp:\/\/\S+)/gi,
      (_, punct, _spBefore, cite, spAfter, url) => punct + nl + nl + cite + spAfter + url
    );
  }

  /**
   * Strip a leading "-|" some Rule CRs carry (broken YAML block chaff, not meant for users).
   */
  function preprocessStripLeadingYamlChaff(s) {
    return String(s).replace(/^\-\|\s*\n*/, "");
  }

  function preprocessDescription(s) {
    return preprocessStepAfterDone(
      preprocessNumberedGlue(
        preprocessCitationLinebreaks(preprocessStripLeadingYamlChaff(s))
      )
    );
  }

  /**
   * OpenShift-style shell: prose ends with "… owner:" then "for node in $(oc get node …".
   * Renders the loop as a monospace block instead of wrapped paragraph text.
   */
  function splitOcDebugForNodeLoop(s) {
    const t = String(s);
    const re = /:\s+for\s+node\s+in\b/i;
    const m = re.exec(t);
    if (!m) return null;
    const afterColon = t.slice(m.index + 1).replace(/^\s*/, "");
    if (!/^for\s+node\s+in\b/i.test(afterColon)) return null;
    return { prose: t.slice(0, m.index + 1), script: afterColon };
  }

  /**
   * Boilerplate before recipe lines: auditctl (-a / -w …) or simple config assignments (KEY = VAL).
   * Extend the alternation when new catalog phrasing appears; do not glob-scan whole descriptions.
   */
  const AUDIT_ADD_LINE_PHRASE_RE_GI =
    /(?:add\s+the\s+following\s+lines?\b|add\s+or\s+modify\s+the\s+following\s+lines?\b|use\s+the\s+following\s+lines?\b|add\s+the\s+line\s+to\b|add\s+a\s+line\s+of\s+the\s+following\s+form\b|add\s+the\s+rules\s+below\b|see\s+an\s+example\s+of\s+multiple\s+combined\s+system\s+calls\b|(?<!or\s)modify\s+the\s+following\s+lines?\b)/gi;
  const AUDIT_ADD_LINE_PHRASE_RE_I =
    /(?:add\s+the\s+following\s+lines?\b|add\s+or\s+modify\s+the\s+following\s+lines?\b|use\s+the\s+following\s+lines?\b|add\s+the\s+line\s+to\b|add\s+a\s+line\s+of\s+the\s+following\s+form\b|add\s+the\s+rules\s+below\b|see\s+an\s+example\s+of\s+multiple\s+combined\s+system\s+calls\b|(?<!or\s)modify\s+the\s+following\s+lines?\b)/i;

  /** auditd.conf-style assignment after a caption (catalog uses simple keys and placeholders). */
  const AUDIT_RECIPE_CONF_ASSIGN = /^\s*[A-Za-z0-9_.]+\s*=\s*\S/;

  function isAuditDashRecipeLine(ln) {
    return /^\s*-\S/.test(ln);
  }

  function isConfAssignRecipeLine(ln) {
    return AUDIT_RECIPE_CONF_ASSIGN.test(ln);
  }

  /**
   * After a matching caption, capture consecutive auditctl lines (-a / -w …) or consecutive
   * KEY = VALUE assignment lines. Prose stays in the normal flow; the recipe becomes one rule-shell block.
   */
  function consumeAuditFollowingBlock(chunk, m) {
    const proseStart = m.index;
    const pe = proseStart + m[0].length;
    const after = chunk.slice(pe);
    const lines = after.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && lines[i] === "") i++;
    while (i < lines.length) {
      const ln = lines[i];
      if (isAuditDashRecipeLine(ln) || isConfAssignRecipeLine(ln)) break;
      if (ln === "" && i + 1 < lines.length) {
        const nxt = lines[i + 1];
        if (isAuditDashRecipeLine(nxt) || isConfAssignRecipeLine(nxt)) break;
      }
      i++;
    }
    while (i < lines.length && lines[i] === "") i++;
    if (i >= lines.length) return null;
    const block = [];
    if (isAuditDashRecipeLine(lines[i])) {
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln.trim()) break;
        if (!isAuditDashRecipeLine(ln)) break;
        block.push(ln);
        i++;
      }
    } else if (isConfAssignRecipeLine(lines[i])) {
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln.trim()) break;
        if (!isConfAssignRecipeLine(ln)) break;
        block.push(ln);
        i++;
      }
    } else {
      return null;
    }
    if (!block.length) return null;
    const blockStart = chunk.indexOf(block[0], pe);
    if (blockStart < 0) return null;
    const proseSpan = chunk.slice(proseStart, blockStart);
    let pos = blockStart;
    for (let k = 0; k < block.length; k++) {
      if (!chunk.startsWith(block[k], pos)) return null;
      pos += block[k].length;
      if (pos < chunk.length && chunk.charAt(pos) === "\r") pos++;
      if (pos < chunk.length && chunk.charAt(pos) === "\n") pos++;
    }
    const dashText = chunk.slice(blockStart, pos);
    let resumeAt = pos;
    while (resumeAt < chunk.length && (chunk.charAt(resumeAt) === "\n" || chunk.charAt(resumeAt) === "\r")) {
      resumeAt++;
    }
    return { proseSpan: proseSpan, dashText: dashText, resumeAt: resumeAt };
  }

  function renderAuditAddFollowingThenRest(parent, chunk, opts) {
    if (!chunk) return;
    const matches = [...String(chunk).matchAll(AUDIT_ADD_LINE_PHRASE_RE_GI)];
    if (!matches.length) {
      renderTextWithDollarShellBlocks(parent, chunk, opts);
      return;
    }
    let last = 0;
    for (let mi = 0; mi < matches.length; mi++) {
      const m = matches[mi];
      const nextAt = mi + 1 < matches.length ? matches[mi + 1].index : chunk.length;
      if (m.index > last) renderTextWithDollarShellBlocks(parent, chunk.slice(last, m.index), opts);
      const parsed = consumeAuditFollowingBlock(chunk, m);
      if (!parsed) {
        renderTextWithDollarShellBlocks(parent, chunk.slice(m.index, nextAt), opts);
        last = nextAt;
        continue;
      }
      renderTextWithDollarShellBlocks(parent, parsed.proseSpan, opts);
      appendPreBlock(parent, parsed.dashText, "rule-shell");
      last = parsed.resumeAt;
    }
    if (last < chunk.length) renderTextWithDollarShellBlocks(parent, chunk.slice(last), opts);
  }

  function renderRichTextChunk(parent, chunk, opts) {
    opts = opts || {};
    const sp = splitOcDebugForNodeLoop(chunk);
    if (sp && sp.prose.trim() && sp.script.trim()) {
      renderAuditAddFollowingThenRest(parent, sp.prose, opts);
      appendPreBlock(parent, sp.script, "rule-shell");
      return;
    }
    renderAuditAddFollowingThenRest(parent, chunk, opts);
  }

  function extractBalancedJson(s, start) {
    const ch = s.charAt(start);
    if (ch !== "{" && ch !== "[") return null;
    const isObj = ch === "{";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (isObj) {
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) return [i + 1, s.slice(start, i + 1)];
        }
      } else {
        if (c === "[") depth++;
        else if (c === "]") {
          depth--;
          if (depth === 0) return [i + 1, s.slice(start, i + 1)];
        }
      }
    }
    return null;
  }

  function isTrivialCitationJson(jsonStr) {
    try {
      const v = JSON.parse(jsonStr);
      if (Array.isArray(v) && v.length === 1 && typeof v[0] === "number" && v[0] < 10000) return true;
      if (Array.isArray(v) && v.length === 0) return true;
    } catch (_) {}
    return false;
  }

  function jsonBlockStart(trimmed) {
    if (!trimmed) return false;
    if (trimmed.startsWith("{")) return true;
    if (trimmed.startsWith("[")) {
      if (/^\[\d+\]/.test(trimmed)) return false;
      return true;
    }
    return false;
  }

  function yamlBlockStart(trimmed) {
    return /^(apiVersion|kind|metadata|spec|data|template):/.test(trimmed);
  }

  function isYamlLine(line) {
    const t = line.replace(/\r$/, "");
    if (/^\s*$/.test(t)) return true;
    if (/^\s*#/.test(t)) return true;
    if (/^\s*-\s+\S/.test(t)) return true;
    /* Key before colon: allow / and $ (OpenShift label selectors), not spaces. */
    if (/^\s*[^\s:]+:\s*(\S.*)?$/.test(t)) return true;
    if (/^\s{2,}\S/.test(t)) return true;
    return false;
  }

  function splitYamlIsland(para) {
    const lines = para.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      const tr = lines[i].trimStart();
      if (!yamlBlockStart(tr)) continue;
      let j = i;
      while (j < lines.length && isYamlLine(lines[j])) j++;
      if (j <= i) continue;
      return {
        before: lines.slice(0, i).join("\n"),
        yaml: lines.slice(i, j).join("\n"),
        after: lines.slice(j).join("\n"),
      };
    }
    return null;
  }

  /**
   * Incomplete JSON/config excerpts often start with a quoted key and brace, include
   * placeholder lines like "...", and are not valid JSON (human-authored snippets).
   */
  function jsonLikeIslandStart(trimmed) {
    return /^"\w[\w.-]*"\s*:\s*\{/.test(trimmed);
  }

  function isJsonSnippetContinuationLine(line) {
    const tr = line.trim();
    if (!tr) return false;
    if (/^\.{3,},?\s*$/.test(tr)) return true;
    if (/^\{\s*$/.test(tr)) return true;
    if (/^"[\w.-]+"\s*:\s*\{/.test(tr)) return true;
    if (/^"[\w.-]+"\s*:\s*\[/.test(tr)) return true;
    /* JSON string value on its own line (often a path); allow trailing comma or none. */
    if (/^"(?:\\.|[^"\\])*"\s*,?\s*$/.test(tr)) return true;
    if (/^\],?\s*$/.test(tr)) return true;
    if (/^\}\s*,?\s*$/.test(tr)) return true;
    return false;
  }

  function splitJsonLikeSnippetIsland(para) {
    const lines = para.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      const tr = lines[i].trimStart();
      if (!jsonLikeIslandStart(tr)) continue;
      let j = i + 1;
      while (j < lines.length && isJsonSnippetContinuationLine(lines[j])) j++;
      if (j <= i + 1) continue;
      const snippet = lines.slice(i, j).join("\n");
      if (snippet.length < 18) continue;
      return {
        before: lines.slice(0, i).join("\n"),
        snippet,
        after: lines.slice(j).join("\n"),
      };
    }
    return null;
  }

  function splitJsonIsland(para) {
    let offset = 0;
    for (const line of para.split(/\n/)) {
      const tr = line.trimStart();
      const idxInLine = line.indexOf(tr);
      const abs = offset + (idxInLine >= 0 ? idxInLine : 0);
      if (jsonBlockStart(tr)) {
        const ext = extractBalancedJson(para, abs);
        if (ext && !isTrivialCitationJson(ext[1]) && ext[1].length > 15) {
          return {
            before: para.slice(0, abs).trimEnd(),
            json: ext[1],
            after: para.slice(ext[0]),
          };
        }
      }
      offset += line.length + 1;
    }
    return null;
  }

  function appendPreBlock(container, text, cls) {
    const pre = document.createElement("pre");
    pre.className = "rule-block " + (cls || "");
    const code = document.createElement("code");
    code.textContent = text;
    pre.appendChild(code);
    container.appendChild(pre);
  }

  const _Q = String.fromCharCode(34);
  const PATH_RE = new RegExp(
    "(^|[\\s" + _Q + "'(,:;]|\\[)(\\/[A-Za-z0-9][A-Za-z0-9_.\\/-]*)(?![A-Za-z0-9_.\\/-])",
    "g"
  );

  /**
   * Split prose into { text } and { path } spans using PATH_RE so kebab/infra/camel
   * rules never run inside filenames like /tmp/allowed-import-registries-patch.yaml.
   */
  function splitPathSegments(s) {
    const out = [];
    const re = new RegExp(PATH_RE.source, "g");
    let last = 0;
    let pm;
    while ((pm = re.exec(s)) !== null) {
      if (pm.index > last) out.push({ t: "text", s: s.slice(last, pm.index) });
      const pre = pm[1] || "";
      if (pre) out.push({ t: "text", s: pre });
      out.push({ t: "path", s: pm[2] });
      last = pm.index + pm[0].length;
    }
    if (last < s.length) out.push({ t: "text", s: s.slice(last) });
    return out.length ? out : [{ t: "text", s: s }];
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Whole identifiers that are usually infrastructure / API vocabulary and often appear
   * all-lowercase or with hyphens (not covered by PascalCase / camelCase rules).
   * Reject `/` or `-` immediately before the match so `kubelet` is not styled inside
   * `/etc/kubernetes/kubelet.conf` or `--kubelet-https`. Same for trailing `-`.
   */
  const INFRA_ALLOWLIST = [
    "OAuth",
    "oauth",
    "cluster-admin",
    "namespace-admin",
    "kube-apiserver",
    "openshift-apiserver",
    "openshift-kube-apiserver",
    "kubelet",
    "apiserver",
    "cri-o",
    "runc",
  ];

  const INFRA_INLINE_RE = new RegExp(
    "(?<![/-])\\b(" + INFRA_ALLOWLIST.map(escapeRe).join("|") + ")\\b(?!-)",
    "gi"
  );

  /** Long CLI flags with `=` value (`--cert-file=…`, `--peer-auto-tls=true`). Requires a hyphen in the flag name. */
  const LONG_DASH_FLAG_EQ_RE = /--[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+=[^\s,)]+/gi;

  /**
   * CLI flags without `=` (`--kubelet-https`, `--tls-min-version`). Must run after
   * LONG_DASH_FLAG_EQ_RE so values like `--peer-auto-tls=true` stay one span.
   */
  const LONG_DASH_FLAG_PLAIN_RE = /--[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*/gi;

  /**
   * Kebab-case API-ish identifiers (tls-cert-file, service-network-serving-certkey).
   * At least three segments; avoids short prose ("check-in-time"). Skips path-like
   * segments (no match immediately after /, :, #, or .) so URL paths and #fragments
   * are not split (e.g. …md#questions-and-answers must stay one link).
   */
  const KEBAB_INLINE_RE = /(?<![#/:.\w])\b[a-z][a-z0-9]{2,}(?:-[a-z0-9]{2,}){2,}\b/gi;

  /** Hyphenated names where bare `etcd` would otherwise match only a substring. */
  const ETCD_COMPOUND_RE =
    /(?<![/-])\bopenshift-etcd\b|(?<![/-])\betcd-pod\*?(?=\s|,|\.|;|\)|]|'|"|$)/gi;

  /**
   * Standalone `etcd` (not `openshift-etcd`, not `etcd-pod`, not `etcd-all` path segments).
   * Skip when preceded by `/` or `-` so path fragments are not split into code spans.
   */
  const ETCD_STANDALONE_RE = /(?<![/-])(?<!openshift-)\betcd\b(?![-a-z*])/gi;

  /**
   * Kubernetes / OpenShift resource kind names (exact API casing). Only applied inside
   * markdown bullet list items — in prose, "secrets" / "routes" often mean English.
   */
  const K8S_KINDS_IN_BULLETS = [
    "Secret",
    "Secrets",
    "ConfigMap",
    "ConfigMaps",
    "Route",
    "Routes",
    "Service",
    "Services",
    "Pod",
    "Pods",
    "Namespace",
    "Namespaces",
    "Node",
    "Nodes",
    "Deployment",
    "Deployments",
    "StatefulSet",
    "StatefulSets",
    "DaemonSet",
    "DaemonSets",
    "ReplicaSet",
    "ReplicaSets",
    "Job",
    "Jobs",
    "CronJob",
    "CronJobs",
    "Ingress",
    "Ingresses",
    "NetworkPolicy",
    "NetworkPolicies",
    "PersistentVolume",
    "PersistentVolumes",
    "PersistentVolumeClaim",
    "PersistentVolumeClaims",
    "StorageClass",
    "StorageClasses",
    "ServiceAccount",
    "ServiceAccounts",
    "Role",
    "Roles",
    "RoleBinding",
    "RoleBindings",
    "ClusterRole",
    "ClusterRoles",
    "ClusterRoleBinding",
    "ClusterRoleBindings",
    "CustomResourceDefinition",
    "CustomResourceDefinitions",
    "Event",
    "Events",
    "Endpoint",
    "Endpoints",
  ];

  const K8S_KIND_IN_LIST_RE = new RegExp("\\b(" + K8S_KINDS_IN_BULLETS.map(escapeRe).join("|") + ")\\b", "g");

  /**
   * Dotted API / SCC field paths (runAsUser.type, set.runAsUser.type with author typos).
   * Requires at least one capital in the span so hostnames like image.config.openshift.io
   * (all lowercase) are not styled as code.
   */
  const DOTTED_API_FIELD_RE = /\b(?=[a-z0-9.]*[A-Z])(?:[a-z][a-zA-Z0-9]*\.)+[a-z][a-zA-Z0-9]*\b/g;

  /** OpenShift / Kubernetes style PascalCase type names; product names left plain. */
  const PASCAL_TYPE_RE = /\b(?!OpenShift\b)(?!OpehShift\b)(?!HyperShift\b)[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;

  /**
   * camelCase API fields (allowedCapabilities, registrySources, …). Leading segment
   * at least 3 chars to skip tiny words; requires at least one interior capital run.
   */
  const CAMEL_FIELD_RE = /\b[a-z][a-z0-9]{2,}(?:[A-Z][a-z0-9]*)+\b/g;

  function appendPathsOnly(parent, chunk) {
    if (!chunk) return;
    const t = String(chunk);
    const oneLine = t.trim();
    if (
      (oneLine.startsWith("{") && oneLine.endsWith("}")) ||
      (oneLine.startsWith("[") && oneLine.endsWith("]"))
    ) {
      if (/^\[\d+\]/.test(oneLine)) {
        /* citation like [1] url on one line handled elsewhere */
      } else {
        try {
          const parsed = JSON.parse(oneLine);
          if (!isTrivialCitationJson(oneLine)) {
            appendPreBlock(parent, JSON.stringify(parsed, null, 2), "rule-json");
            return;
          }
        } catch (_) {}
      }
    }
    let last = 0;
    let pm;
    PATH_RE.lastIndex = 0;
    while ((pm = PATH_RE.exec(t)) !== null) {
      const pre = pm[1];
      const path = pm[2];
      const idx = pm.index;
      const mid = t.slice(last, idx + pre.length);
      if (mid) parent.appendChild(document.createTextNode(mid));
      const code = document.createElement("code");
      code.className = "rule-path";
      code.textContent = path;
      parent.appendChild(code);
      last = idx + pre.length + path.length;
    }
    if (last < t.length) parent.appendChild(document.createTextNode(t.slice(last)));
  }

  /** http(s) and ftp URLs; same pattern everywhere so links are not split by inline rules. */
  const ABSOLUTE_URI_RE = /(https?:\/\/[^\s<>"']+|ftp:\/\/[^\s<>"']+)/gi;

  /** New instance each scan — global regex lastIndex must not leak across appendUri + applyInline. */
  function absoluteUriMatcher() {
    return new RegExp(ABSOLUTE_URI_RE.source, ABSOLUTE_URI_RE.flags);
  }

  function appendUriAndPaths(parent, rawChunk) {
    if (!rawChunk) return;
    let pos = 0;
    let m;
    const uriScan = absoluteUriMatcher();
    while ((m = uriScan.exec(rawChunk)) !== null) {
      appendPathsOnly(parent, rawChunk.slice(pos, m.index));
      const url = m[1];
      const a = document.createElement("a");
      a.className = "rule-uri";
      a.href = url;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      a.textContent = url;
      parent.appendChild(a);
      pos = m.index + m[0].length;
    }
    appendPathsOnly(parent, rawChunk.slice(pos));
  }

  function applyInlineCodeThenUriPath(parent, rawChunk, opts) {
    if (!rawChunk) return;
    opts = opts || {};
    const INLINE = [
      { re: /`([^`]+)`/g, g: 1 },
      { re: LONG_DASH_FLAG_EQ_RE, g: 0 },
      { re: LONG_DASH_FLAG_PLAIN_RE, g: 0 },
      { re: ETCD_COMPOUND_RE, g: 0 },
      { re: /\bvar-[a-z0-9][-a-z0-9]*\b/gi, g: 0 },
      { re: /\bvar_[a-z0-9_]+\b/gi, g: 0 },
      { re: INFRA_INLINE_RE, g: 0 },
      { re: ETCD_STANDALONE_RE, g: 0 },
    ];
    if (opts.markdownListItem) {
      INLINE.push({ re: K8S_KIND_IN_LIST_RE, g: 0 });
    }
    INLINE.push(
      { re: DOTTED_API_FIELD_RE, g: 0 },
      { re: PASCAL_TYPE_RE, g: 0 },
      { re: CAMEL_FIELD_RE, g: 0 },
      { re: KEBAB_INLINE_RE, g: 0 },
      { re: /\boc patch\b/gi, g: 0 },
      { re: /\b(?:TLSv1\.[0-3]|TLSv[12])\b/g, g: 0 }
    );

    function emitInlinedText(textOnly) {
      if (!textOnly) return;
      const pathPieces = splitPathSegments(textOnly);
      for (const seg of pathPieces) {
        if (seg.t === "path") {
          const pc = document.createElement("code");
          pc.className = "rule-path";
          pc.textContent = seg.s;
          parent.appendChild(pc);
          continue;
        }
        let parts = [{ t: "text", s: seg.s }];
        for (const { re, g } of INLINE) {
          const next = [];
          for (const p of parts) {
            if (p.t !== "text") {
              next.push(p);
              continue;
            }
            const s = p.s;
            let last = 0;
            let m;
            re.lastIndex = 0;
            while ((m = re.exec(s)) !== null) {
              if (m.index > last) next.push({ t: "text", s: s.slice(last, m.index) });
              const cap = g ? m[g] : m[0];
              next.push({ t: "code", s: cap });
              last = m.index + m[0].length;
            }
            if (last < s.length) next.push({ t: "text", s: s.slice(last) });
            if (next.length === 0) next.push(p);
          }
          parts = next;
        }
        for (const p of parts) {
          if (p.t === "code") {
            const c = document.createElement("code");
            c.className = "rule-inline";
            c.textContent = p.s;
            parent.appendChild(c);
          } else {
            appendUriAndPaths(parent, p.s);
          }
        }
      }
    }

    const full = String(rawChunk);
    let pos = 0;
    let um;
    const uriScan = absoluteUriMatcher();
    while ((um = uriScan.exec(full)) !== null) {
      if (um.index > pos) emitInlinedText(full.slice(pos, um.index));
      const url = um[1];
      const a = document.createElement("a");
      a.className = "rule-uri";
      a.href = url;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      a.textContent = url;
      parent.appendChild(a);
      pos = um.index + um[0].length;
    }
    if (pos < full.length) emitInlinedText(full.slice(pos));
  }

  const DOLLAR_SHELL_LINE_TEST = /^\s*\$\s+.+/;

  /**
   * Lines that look like shell examples (`$ oc …`, `$ sudo …`) render as script blocks
   * (same family as `for node in …`), not inline variable-style code.
   */
  function renderTextWithDollarShellBlocks(parent, chunk, opts) {
    const nl = String.fromCharCode(10);
    const lines = String(chunk).split(/\n/);
    let buf = [];
    function flushBuf() {
      if (!buf.length) return;
      const sub = buf.join(nl);
      if (sub.trim()) {
        const wrap = document.createElement("span");
        applyInlineCodeThenUriPath(wrap, sub, opts);
        while (wrap.firstChild) parent.appendChild(wrap.firstChild);
      }
      buf = [];
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (DOLLAR_SHELL_LINE_TEST.test(line)) {
        flushBuf();
        appendPreBlock(parent, line.trim(), "rule-shell");
      } else {
        buf.push(line);
      }
    }
    flushBuf();
  }

  function renderProseBlock(container, text) {
    const nl = String.fromCharCode(10);
    const lines = text.split(/\n/);
    let li = 0;
    while (li < lines.length) {
      while (li < lines.length && !lines[li].trim()) li++;
      if (li >= lines.length) break;
      if (/^\s*[*•]\s+/.test(lines[li])) {
        const ul = document.createElement("ul");
        ul.className = "rule-desc-ul";
        while (li < lines.length) {
          if (!lines[li].trim()) break;
          const mu = lines[li].match(/^\s*\*\s+(.*)$/) || lines[li].match(/^\s*•\s+(.*)$/);
          if (!mu) break;
          const item = document.createElement("li");
          renderRichTextChunk(item, mu[1], { markdownListItem: true });
          ul.appendChild(item);
          li++;
        }
        container.appendChild(ul);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(lines[li])) {
        const ol = document.createElement("ol");
        ol.className = "rule-desc-list";
        while (li < lines.length) {
          const m2 = lines[li].match(/^\s*\d+\.\s+(.*)$/);
          if (!m2) break;
          const item = document.createElement("li");
          renderRichTextChunk(item, m2[1]);
          ol.appendChild(item);
          li++;
        }
        container.appendChild(ol);
        continue;
      }
      const buf = [];
      while (
        li < lines.length &&
        !/^\s*\d+\.\s+/.test(lines[li]) &&
        !/^\s*[*•]\s+/.test(lines[li])
      ) {
        buf.push(lines[li]);
        li++;
      }
      if (buf.length) {
        const div = document.createElement("div");
        div.className = "rule-desc-para";
        renderRichTextChunk(div, buf.join(nl));
        container.appendChild(div);
      }
    }
  }

  /** One paragraph chunk (no double-newline inside). */
  function renderParagraphChunk(container, para) {
    const t = para.trim();
    if (!t) return;

    if (/^\[\d+\]\s+https?:\/\//.test(t)) {
      const m = t.match(/^\[(\d+)\]\s+(https?:\/\/\S+)/);
      if (m) {
        const p = document.createElement("p");
        p.className = "rule-desc-para";
        p.appendChild(document.createTextNode("[" + m[1] + "] "));
        const a = document.createElement("a");
        a.href = m[2];
        a.className = "rule-uri";
        a.rel = "noopener noreferrer";
        a.target = "_blank";
        a.textContent = m[2];
        p.appendChild(a);
        container.appendChild(p);
      }
      return;
    }

    const fb = para.search(/\S/);
    const brace = para.indexOf("{", fb >= 0 ? fb : 0);
    if (brace >= 0 && jsonBlockStart(para.slice(brace).trimStart())) {
      const ext = extractBalancedJson(para, brace);
      if (ext) {
        const rest = para.slice(ext[0]).trim();
        if (rest === "" && !isTrivialCitationJson(ext[1])) {
          try {
            appendPreBlock(container, JSON.stringify(JSON.parse(ext[1]), null, 2), "rule-json");
          } catch (_) {
            appendPreBlock(container, ext[1], "rule-json");
          }
          return;
        }
      }
    }

    const y = splitYamlIsland(para);
    if (y) {
      if (y.before.trim()) renderProseBlock(container, y.before);
      appendPreBlock(container, y.yaml.trimEnd(), "rule-yaml");
      if (y.after.trim()) renderParagraphChunk(container, y.after);
      return;
    }

    const jlike = splitJsonLikeSnippetIsland(para);
    if (jlike) {
      if (jlike.before.trim()) renderProseBlock(container, jlike.before);
      try {
        appendPreBlock(container, JSON.stringify(JSON.parse(jlike.snippet), null, 2), "rule-json");
      } catch (_) {
        appendPreBlock(container, jlike.snippet, "rule-json");
      }
      if (jlike.after.trim()) renderParagraphChunk(container, jlike.after);
      return;
    }

    const trimmedPara = para.trim();
    if (/^oc\s+/i.test(trimmedPara) && trimmedPara.length >= 50 && !/\n/.test(trimmedPara)) {
      appendPreBlock(container, trimmedPara, "rule-shell");
      return;
    }
    if (/^oc patch$/i.test(trimmedPara)) {
      const p = document.createElement("p");
      p.className = "rule-desc-para";
      const c = document.createElement("code");
      c.className = "rule-inline";
      c.textContent = trimmedPara;
      p.appendChild(c);
      container.appendChild(p);
      return;
    }

    const jn = splitJsonIsland(para);
    if (jn) {
      if (jn.before.trim()) renderProseBlock(container, jn.before);
      try {
        appendPreBlock(container, JSON.stringify(JSON.parse(jn.json), null, 2), "rule-json");
      } catch (_) {
        appendPreBlock(container, jn.json, "rule-json");
      }
      if (jn.after.trim()) renderParagraphChunk(container, jn.after);
      return;
    }

    renderProseBlock(container, para);
  }

  /**
   * Rule CRs often put audit boilerplate (see AUDIT_ADD_LINE_PHRASE_RE_I) in one paragraph and
   * recipe lines (-a … or KEY = VAL) in the next (separated by a blank line). Paragraph splitting
   * would otherwise strand those lines without the phrase; merge those pairs into one block.
   */
  function mergeAdjacentAuditParagraphs(paras) {
    const out = [];
    const nl = String.fromCharCode(10);
    function firstNonEmptyLine(s) {
      const lines = String(s).split(/\n/);
      for (let j = 0; j < lines.length; j++) {
        if (lines[j].trim()) return lines[j];
      }
      return "";
    }
    function startsRecipeContinuation(s) {
      const ln = firstNonEmptyLine(s);
      return isAuditDashRecipeLine(ln) || isConfAssignRecipeLine(ln);
    }
    let i = 0;
    while (i < paras.length) {
      let cur = paras[i];
      i++;
      while (i < paras.length && AUDIT_ADD_LINE_PHRASE_RE_I.test(cur) && startsRecipeContinuation(paras[i])) {
        cur = cur.trimEnd() + nl + paras[i].trimStart();
        i++;
      }
      out.push(cur);
    }
    return out;
  }

  function renderDescription(container, raw) {
    container.textContent = "";
    const text = raw == null ? "" : String(raw);
    if (!text.trim()) {
      container.textContent = "(no description on Rule CR)";
      return;
    }
    const normalized = preprocessDescription(text);
    const paras = mergeAdjacentAuditParagraphs(normalized.split(/\n(?:\s*\n)+/));
    for (const p of paras) {
      if (p.trim()) renderParagraphChunk(container, p);
    }
  }

  function renderRuleSection(parent, r) {
    const sec = document.createElement("section");
    sec.className = "rule-lab-section";
    const h = document.createElement("h3");
    h.textContent = r.id;
    sec.appendChild(h);
    const t = document.createElement("p");
    t.className = "rule-title";
    t.textContent = r.title;
    sec.appendChild(t);
    const body = document.createElement("div");
    body.className = "rule-detail-body";
    renderDescription(body, r.description);
    sec.appendChild(body);

    const raw = document.createElement("details");
    raw.className = "rule-raw-drawer";
    const sum = document.createElement("summary");
    sum.textContent = "Original rule data (raw)";
    raw.appendChild(sum);
    const pre = document.createElement("pre");
    pre.className = "rule-raw-pre";
    pre.textContent = JSON.stringify({ id: r.id, title: r.title, description: r.description }, null, 2);
    raw.appendChild(pre);
    sec.appendChild(raw);

    parent.appendChild(sec);
  }

  function run() {
    const el = document.getElementById("fixture");
    const host = document.getElementById("out");
    if (!el || !host) return;
    const data = JSON.parse(el.textContent);
    host.textContent = "";
    const bundles =
      data.profiles && data.profiles.length
        ? data.profiles
        : data.profile && data.rules
          ? [{ profile: data.profile, rules: data.rules }]
          : [];
    if (!bundles.length) {
      host.textContent = "Fixture has no profiles or rules.";
      return;
    }
    for (const bundle of bundles) {
      const art = document.createElement("article");
      art.className = "rule-profile-block";
      const hdr = document.createElement("header");
      hdr.className = "rule-profile-header";
      const ph = document.createElement("h2");
      ph.className = "rule-profile-title";
      ph.textContent = bundle.profile;
      hdr.appendChild(ph);
      const meta = document.createElement("p");
      meta.className = "rule-profile-meta";
      const nr = (bundle.rules && bundle.rules.length) || 0;
      meta.textContent = nr + (nr === 1 ? " rule" : " rules");
      hdr.appendChild(meta);
      art.appendChild(hdr);
      for (const r of bundle.rules || []) {
        renderRuleSection(art, r);
      }
      host.appendChild(art);
    }
  }

  try {
    globalThis.renderRuleDescriptionRich = renderDescription;
  } catch (_) {}

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
