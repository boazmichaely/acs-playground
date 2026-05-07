#!/usr/bin/env bash
#
# acs-demo-setup.sh — RHACS + OpenShift demo bootstrap (readable, repeat-safe).
#
# Chris scenario (narrow ACS, wide OCP):
#   - chris gets OpenShift admin on CHRIS_OCP_NAMESPACES, but ACS Analyst only for DEMO_NAMESPACE via ACS scope.
#   - Use this lab setup to confirm ACS respects access scope (no substitute for formal pen-test).
#
# Safe to run multiple times:
#   - Merges chris into existing htpasswd without rotating users unless you set an explicit *PASSWORD or REGENERATE_HTPASSWD=true.
#   - If ADAM_PASSWORD, BOAZ_PASSWORD, or CHRIS_PASSWORD is set (non-empty), that user’s line is rewritten in htpasswd-secret even when the user already exists.
#   - Reconciles ACS access scope + role via PUT when definitions drift.
#   - Registry integration, OAuth IdP append, RBAC, auth provider, group rules are idempotent.
#
# Prerequisites:
#   - OpenShift: oc logged into the right cluster
#   - RHACS: Central + secured cluster already installed
#
# Required before run (or provided via ~/.roxctl/set-env.sh — see ROX_ENDPOINT below):
#   ACS_CENTRAL_URL  — https://… (Central route, no trailing junk). If unset but ROX_ENDPOINT
#     is set (typical after sourcing ~/.roxctl/set-env.sh), the script sets ACS_CENTRAL_URL to https://<ROX_ENDPOINT>.
#   Central auth (one of):
#     ROX_API_TOKEN  — preferred; often: source ~/.roxctl/set-env.sh
#     ACS_ADMIN_PASSWORD — Central admin basic-auth password
#
# Strongly recommended:
#   SECURED_CLUSTER_NAME — must match the cluster name in ACS (UI: Platform Configuration →
#     Clusters). If unset, the script uses Central GET /v1/clusters when exactly one cluster
#     exists; otherwise it falls back to the OpenShift MachineSet label (which may *not* match
#     ACS and will make scoped users see empty CVEs/violations).
#
# How to run (execute the script; do NOT `source` it — that runs it in your interactive shell):
#   source ~/.roxctl/set-env.sh    # optional, if you use API token auth
#   export ACS_CENTRAL_URL="https://central-stackrox.apps.<cluster>.<domain>"
#   ./acs-demo-setup.sh            # default: all modules (ms-demo → registries → ocp-users → ocp-oauth → acs-users)
#   ./acs-demo-setup.sh --module ms-demo --module registries
#   ACS_DEMO_MODULES="ocp-users ocp-oauth" ./acs-demo-setup.sh
#   ./acs-demo-setup.sh --status    # JSON: preflight snapshot + module status for 1–5
#
# Create Central as a module (RHACS operator must already be installed from the catalog):
#   ./acs-demo-setup.sh --module install-central
#   CENTRAL_CR_MANIFEST=/path/to/custom.yaml ./acs-demo-setup.sh --module install-central
#   (If a Central CR already exists in stackrox, prints names and applies nothing.)
# Combined with other modules (canonical order — see --help):
#   ./acs-demo-setup.sh --module install-central --module ms-demo --module registries
#   ./acs-demo-setup.sh --module install-central --module install-secured-cluster
#
# Optional:
#   ACS_ENV_FILE=/path/to/file   — if set and the file exists, it is sourced before the script body
#     (use for secrets you keep outside git).
#
# Optional overrides (defaults shown; see Defaults section in the script body):
#   DEMO_NAMESPACE=ms-demo
#   DEMO_MANIFEST=\$HOME/code/GitHub/Kubernetes-demos/mostmark-microservices-demo/microservices-demo/application.yaml
#   HTPASSWD_IDP_NAME=lab_htpasswd
#   ACS_OPENSHIFT_AUTH_NAME=OCP-OAuth
#   ACS_ROLE_BOAZ=boaz-in-acs
#   ACS_ROLE_CHRIS=chris-in-acs
#   CHRIS_OCP_NAMESPACES=\"ms-demo splunk-demo init-demo\"
#   ACS_SCOPE_NAME=ms-demo
#   REGISTRY_ENDPOINT=us-central1-docker.pkg.dev
#   ROX_ENDPOINT — for roxctl whoami check when ROX_API_TOKEN is set
#   ADAM_PASSWORD / BOAZ_PASSWORD / CHRIS_PASSWORD — non-empty forces that user’s htpasswd line to be
#     written or updated (even if the user already exists)
#   REGENERATE_HTPASSWD=true — replace entire htpasswd-secret with fresh hashes for adam, boaz, chris
#

set -euo pipefail

if [[ -n "${ACS_ENV_FILE:-}" && -f "${ACS_ENV_FILE}" ]]; then
  # shellcheck source=/dev/null
  source "${ACS_ENV_FILE}"
fi

# -----------------------------------------------------------------------------
# Defaults
# -----------------------------------------------------------------------------
DEMO_NAMESPACE="${DEMO_NAMESPACE:-ms-demo}"
DEMO_MANIFEST="${DEMO_MANIFEST:-${HOME}/code/GitHub/Kubernetes-demos/mostmark-microservices-demo/microservices-demo/application.yaml}"
HTPASSWD_IDP_NAME="${HTPASSWD_IDP_NAME:-lab_htpasswd}"
ACS_OPENSHIFT_AUTH_NAME="${ACS_OPENSHIFT_AUTH_NAME:-OCP-OAuth}"
ACS_ROLE_BOAZ="${ACS_ROLE_BOAZ:-boaz-in-acs}"
ACS_ROLE_CHRIS="${ACS_ROLE_CHRIS:-chris-in-acs}"
CHRIS_OCP_NAMESPACES="${CHRIS_OCP_NAMESPACES:-ms-demo splunk-demo init-demo}"
ACS_SCOPE_NAME="${ACS_SCOPE_NAME:-ms-demo}"
ACS_SCOPE_DESCRIPTION="${ACS_SCOPE_DESCRIPTION:-Access to ms-demo namespace}"
REGISTRY_INTEGRATION_NAME="${REGISTRY_INTEGRATION_NAME:-Public Google Artifact Registry us-central1}"
REGISTRY_ENDPOINT="${REGISTRY_ENDPOINT:-us-central1-docker.pkg.dev}"
ACS_ANALYST_PERMISSION_SET_ID="${ACS_ANALYST_PERMISSION_SET_ID:-ffffffff-ffff-fff4-f5ff-fffffffffffe}"

# Directory of this script (for bundled manifests).
ACS_DEMO_SETUP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CENTRAL_CR_MANIFEST="${CENTRAL_CR_MANIFEST:-${ACS_DEMO_SETUP_SCRIPT_DIR}/central-cr-minimal.yaml}"
SECURED_CLUSTER_CR_MANIFEST="${SECURED_CLUSTER_CR_MANIFEST:-${ACS_DEMO_SETUP_SCRIPT_DIR}/secured-cluster-cr-minimal.yaml}"
STACKROX_NAMESPACE="${STACKROX_NAMESPACE:-stackrox}"
CENTRAL_CR_NAME="${CENTRAL_CR_NAME:-stackrox-central-services}"
SECURED_CLUSTER_CR_NAME="${SECURED_CLUSTER_CR_NAME:-stackrox-secured-cluster-services}"
CENTRAL_READY_TIMEOUT="${CENTRAL_READY_TIMEOUT:-900}"
CENTRAL_READY_POLL="${CENTRAL_READY_POLL:-10}"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
die() { echo "ERROR: $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

load_rox_env_if_present() {
  # Prefer user’s existing roxctl environment (API token, endpoint, TLS flags).
  if [[ -f "${HOME}/.roxctl/set-env.sh" ]]; then
    # shellcheck source=/dev/null
    source "${HOME}/.roxctl/set-env.sh"
  fi
}

# ROX_ENDPOINT from ~/.roxctl/set-env.sh is host:port (Central); REST base URL is https://host[:port].
ensure_acs_central_url() {
  [[ -n "${ACS_CENTRAL_URL:-}" ]] && return 0
  [[ -z "${ROX_ENDPOINT:-}" ]] && return 0
  local raw="${ROX_ENDPOINT%%/*}"
  raw="${raw#https://}"
  raw="${raw#http://}"
  export ACS_CENTRAL_URL="https://${raw}"
}

acs_auth_args() {
  # Prefer token auth when available; fall back to basic auth when provided.
  if [[ -n "${ROX_API_TOKEN:-}" ]]; then
    echo "token"
    return 0
  fi
  if [[ -n "${ACS_ADMIN_PASSWORD:-}" ]]; then
    echo "basic"
    return 0
  fi
  return 1
}

acs_curl() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local auth_mode
  auth_mode="$(acs_auth_args)" || die "Set ROX_API_TOKEN (preferred) or ACS_ADMIN_PASSWORD for Central API auth"
  local args=(-skS -X "${method}" "${ACS_CENTRAL_URL%/}${path}")
  if [[ "${auth_mode}" == "token" ]]; then
    args+=(-H "Authorization: Bearer ${ROX_API_TOKEN}")
  else
    args+=(-u "admin:${ACS_ADMIN_PASSWORD}")
  fi
  if [[ -n "${body}" ]]; then
    args+=(-H "Content-Type: application/json" -d "${body}")
  fi
  curl "${args[@]}"
}

parse_public_host() {
  local u="$1"
  u="${u#https://}"
  u="${u#http://}"
  echo "${u%%/*}"
}

detect_secured_cluster_name_from_central() {
  # Prefer the name ACS uses (Platform Configuration → Clusters). OpenShift MachineSet labels
  # often differ (e.g. …-t7kqh), which makes scoped users see *nothing*.
  local name ec
  name="$(acs_curl GET "/v1/clusters" | python3 -c '
import json,sys
j=json.load(sys.stdin)
names=[c.get("name") for c in j.get("clusters",[]) if c.get("name")]
if len(names)==0:
    sys.exit(1)
if len(names)==1:
    print(names[0])
    sys.exit(0)
sys.stderr.write("Multiple clusters in Central; set SECURED_CLUSTER_NAME explicitly.\\n")
sys.exit(2)
')" ; ec=$?
  if [[ "${ec}" -eq 0 ]]; then
    [[ -n "${name}" ]] || return 1
    echo "${name}"
    return 0
  fi
  if [[ "${ec}" -eq 2 ]]; then
    die "Multiple clusters in Central; set SECURED_CLUSTER_NAME to the target cluster (ACS → Platform Configuration → Clusters)."
  fi
  return 1
}

detect_secured_cluster_name() {
  local n
  n="$(oc get machineset.machine.openshift.io -n openshift-machine-api \
    -o jsonpath='{.items[0].metadata.labels.machine\.openshift\.io/cluster-api-cluster}' 2>/dev/null || true)"
  [[ -n "${n}" ]] || return 1
  echo "${n}"
}

append_htpasswd_idp() {
  local edited rc
  edited="$(oc get oauth.config.openshift.io cluster -o json | HTNAME="${HTPASSWD_IDP_NAME}" python3 -c '
import json,sys,os
j=json.load(sys.stdin)
spec=j.setdefault("spec", {})
idps=spec.setdefault("identityProviders", [])
name=os.environ["HTNAME"]
if any(p.get("name")==name for p in idps):
    sys.exit(3)
idps.append({
    "name": name,
    "mappingMethod": "claim",
    "type": "HTPasswd",
    "htpasswd": {"fileData": {"name": "htpasswd-secret"}},
})
print(json.dumps(j))
')"
  rc=$?
  if [[ "${rc}" -eq 3 ]]; then
    return 0
  fi
  [[ "${rc}" -eq 0 ]] || die "failed to edit OAuth JSON"
  echo "${edited}" | oc replace -f -
}

reconcile_simple_access_scope() {
  # Ensures scope ACS_SCOPE_NAME includes exactly SECURED_CLUSTER_NAME / DEMO_NAMESPACE.
  local desired_json found_id
  found_id="$(acs_curl GET "/v1/simpleaccessscopes" | python3 -c '
import json,sys
want=sys.argv[1]
j=json.load(sys.stdin)
for s in j.get("accessScopes",[]):
    if s.get("name")==want:
        print(s["id"])
        break
' "${ACS_SCOPE_NAME}")"

  desired_json="$(python3 -c 'import json
print(json.dumps({
  "name": "'"${ACS_SCOPE_NAME}"'",
  "description": "'"${ACS_SCOPE_DESCRIPTION}"'",
  "rules": {
    "includedClusters": [],
    "includedNamespaces": [{
      "clusterName": "'"${SECURED_CLUSTER_NAME}"'",
      "namespaceName": "'"${DEMO_NAMESPACE}"'",
    }],
    "clusterLabelSelectors": [],
    "namespaceLabelSelectors": [],
  },
}))')"

  if [[ -z "${found_id}" ]]; then
    echo "    creating scope ${ACS_SCOPE_NAME}"
    SCOPE_ID="$(echo "$(acs_curl POST "/v1/simpleaccessscopes" "${desired_json}")" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
    return 0
  fi

  SCOPE_ID="${found_id}"
  local current rc_line put_body
  current="$(acs_curl GET "/v1/simpleaccessscopes/${SCOPE_ID}")"
  rc_line="$(echo "${current}" | DESIRED="${desired_json}" python3 -c '
import json,sys,os
cur=json.load(sys.stdin)
want=json.loads(os.environ["DESIRED"])
ns_want=want["rules"]["includedNamespaces"]
ns_cur=cur.get("rules",{}).get("includedNamespaces",[])
ok = cur.get("name")==want["name"] and ns_cur==ns_want
if ok:
    print("NOOP")
    sys.exit(0)
cur["name"]=want["name"]
cur["description"]=want["description"]
cur["rules"]=want["rules"]
print("PUT")
print(json.dumps(cur))
sys.exit(0)
')"
  put_body="$(echo "${rc_line}" | tail -n +2)"
  if [[ "$(echo "${rc_line}" | head -1)" == "NOOP" ]]; then
    echo "    scope ${ACS_SCOPE_NAME} already matches desired rules"
    return 0
  fi
  echo "    updating scope ${ACS_SCOPE_NAME} (PUT reconcile)"
  acs_curl PUT "/v1/simpleaccessscopes/${SCOPE_ID}" "${put_body}" >/dev/null
}

reconcile_boaz_role() {
  local want_body get_json rc_line put_body
  want_body="$(python3 -c 'import json
print(json.dumps({
  "name": "'"${ACS_ROLE_BOAZ}"'",
  "description": "Analyst for '"${DEMO_NAMESPACE}"' (demo)",
  "permissionSetId": "'"${ACS_ANALYST_PERMISSION_SET_ID}"'",
  "accessScopeId": "'"${SCOPE_ID}"'",
  "globalAccess": "NO_ACCESS",
  "resourceToAccess": {},
}))')"

  get_json="$(acs_curl GET "/v1/roles/${ACS_ROLE_BOAZ}")"
  if ! echo "${get_json}" | python3 -c 'import json,sys; j=json.load(sys.stdin); sys.exit(0 if j.get("name") else 1)'; then
    echo "    creating role ${ACS_ROLE_BOAZ}"
    acs_curl POST "/v1/roles/${ACS_ROLE_BOAZ}" "${want_body}" >/dev/null
    return 0
  fi

  rc_line="$(echo "${get_json}" | WANT="${want_body}" python3 -c '
import json,sys,os
cur=json.load(sys.stdin)
want=json.loads(os.environ["WANT"])
need = (
    cur.get("permissionSetId")!=want["permissionSetId"]
    or cur.get("accessScopeId")!=want["accessScopeId"]
    or cur.get("globalAccess")!=want["globalAccess"]
)
if not need:
    print("NOOP")
    sys.exit(0)
cur["permissionSetId"]=want["permissionSetId"]
cur["accessScopeId"]=want["accessScopeId"]
cur["globalAccess"]=want["globalAccess"]
cur["description"]=want["description"]
cur["resourceToAccess"]=want["resourceToAccess"]
print("PUT")
print(json.dumps(cur))
sys.exit(0)
')"
  put_body="$(echo "${rc_line}" | tail -n +2)"
  if [[ "$(echo "${rc_line}" | head -1)" == "NOOP" ]]; then
    echo "    role ${ACS_ROLE_BOAZ} already matches desired permission set + scope"
    return 0
  fi
  echo "    updating role ${ACS_ROLE_BOAZ} (PUT reconcile)"
  acs_curl PUT "/v1/roles/${ACS_ROLE_BOAZ}" "${put_body}" >/dev/null
}

reconcile_chris_role() {
  local want_body get_json rc_line put_body
  want_body="$(python3 -c 'import json
print(json.dumps({
  "name": "'"${ACS_ROLE_CHRIS}"'",
  "description": "Analyst for '"${DEMO_NAMESPACE}"' only (Chris lab: OCP admin on '"${CHRIS_OCP_NAMESPACES}"')",
  "permissionSetId": "'"${ACS_ANALYST_PERMISSION_SET_ID}"'",
  "accessScopeId": "'"${SCOPE_ID}"'",
  "globalAccess": "NO_ACCESS",
  "resourceToAccess": {},
}))')"

  get_json="$(acs_curl GET "/v1/roles/${ACS_ROLE_CHRIS}")"
  if ! echo "${get_json}" | python3 -c 'import json,sys; j=json.load(sys.stdin); sys.exit(0 if j.get("name") else 1)'; then
    echo "    creating role ${ACS_ROLE_CHRIS}"
    acs_curl POST "/v1/roles/${ACS_ROLE_CHRIS}" "${want_body}" >/dev/null
    return 0
  fi

  rc_line="$(echo "${get_json}" | WANT="${want_body}" python3 -c '
import json,sys,os
cur=json.load(sys.stdin)
want=json.loads(os.environ["WANT"])
need = (
    cur.get("permissionSetId")!=want["permissionSetId"]
    or cur.get("accessScopeId")!=want["accessScopeId"]
    or cur.get("globalAccess")!=want["globalAccess"]
)
if not need:
    print("NOOP")
    sys.exit(0)
cur["permissionSetId"]=want["permissionSetId"]
cur["accessScopeId"]=want["accessScopeId"]
cur["globalAccess"]=want["globalAccess"]
cur["description"]=want["description"]
cur["resourceToAccess"]=want["resourceToAccess"]
print("PUT")
print(json.dumps(cur))
sys.exit(0)
')"
  put_body="$(echo "${rc_line}" | tail -n +2)"
  if [[ "$(echo "${rc_line}" | head -1)" == "NOOP" ]]; then
    echo "    role ${ACS_ROLE_CHRIS} already matches desired permission set + scope"
    return 0
  fi
  echo "    updating role ${ACS_ROLE_CHRIS} (PUT reconcile)"
  acs_curl PUT "/v1/roles/${ACS_ROLE_CHRIS}" "${put_body}" >/dev/null
}

warn_conflicting_name_rule() {
  local login="$1" want_role="$2"
  acs_curl GET "/v1/groups" | OPENSHIFT_PROVIDER_ID="${OPENSHIFT_PROVIDER_ID}" LOGIN="${login}" WANT_ROLE="${want_role}" python3 -c '
import json,sys,os
pid=os.environ["OPENSHIFT_PROVIDER_ID"]
login=os.environ["LOGIN"]
want_role=os.environ["WANT_ROLE"]
j=json.load(sys.stdin)
for g in j.get("groups",[]):
    pr=g.get("props",{})
    if pr.get("authProviderId")!=pid: continue
    if pr.get("key")=="name" and pr.get("value")==login:
        if g.get("roleName")!=want_role:
            print("WARNING: %s is mapped to role %r; this script expects %r. Remove the extra rule in ACS UI if login picks the wrong role." % (login, g.get("roleName"), want_role), file=sys.stderr)
' || true
}

# Populated when htpasswd-secret is created or merged (printed in footer).
HTPASSWD_ADDED_USERS=()

ensure_demouser_htpasswd() {
  REGENERATE_HTPASSWD="${REGENERATE_HTPASSWD:-false}"
  need_cmd openssl
  need_cmd htpasswd

  local tmp old_d new_d
  tmp="$(mktemp)"
  if oc -n openshift-config get secret htpasswd-secret >/dev/null 2>&1; then
    oc -n openshift-config get secret htpasswd-secret -o jsonpath='{.data.htpasswd}' | base64 -d >"${tmp}"
  else
    : >"${tmp}"
  fi

  old_d="$(openssl dgst -sha256 "${tmp}" | awk '{print $2}')"
  HTPASSWD_ADDED_USERS=()

  maybe_add_missing_user() {
    local user="$1" pass_var="$2"
    if grep -q "^${user}:" "${tmp}"; then
      return 0
    fi
    if [[ -z "${!pass_var:-}" ]]; then
      printf -v "${pass_var}" '%s' "$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
    fi
    htpasswd -Bb "${tmp}" "${user}" "${!pass_var}"
    HTPASSWD_ADDED_USERS+=("${user}")
  }

  apply_explicit_password_if_set() {
    # Non-empty ADAM_PASSWORD / BOAZ_PASSWORD / CHRIS_PASSWORD always rewrites that user’s htpasswd line (add or update).
    local user="$1" pass_var="$2"
    [[ -n "${!pass_var:-}" ]] || return 0
    htpasswd -Bb "${tmp}" "${user}" "${!pass_var}"
    HTPASSWD_ADDED_USERS+=("${user}")
  }

  if [[ "${REGENERATE_HTPASSWD}" == "true" ]]; then
    : >"${tmp}"
    ADAM_PASSWORD="${ADAM_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)}"
    BOAZ_PASSWORD="${BOAZ_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)}"
    CHRIS_PASSWORD="${CHRIS_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)}"
    htpasswd -Bb "${tmp}" adam "${ADAM_PASSWORD}"
    htpasswd -Bb "${tmp}" boaz "${BOAZ_PASSWORD}"
    htpasswd -Bb "${tmp}" chris "${CHRIS_PASSWORD}"
    HTPASSWD_ADDED_USERS=(adam boaz chris)
  elif ! grep -q '^adam:' "${tmp}"; then
    : >"${tmp}"
    ADAM_PASSWORD="${ADAM_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)}"
    BOAZ_PASSWORD="${BOAZ_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)}"
    CHRIS_PASSWORD="${CHRIS_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)}"
    htpasswd -Bb "${tmp}" adam "${ADAM_PASSWORD}"
    htpasswd -Bb "${tmp}" boaz "${BOAZ_PASSWORD}"
    htpasswd -Bb "${tmp}" chris "${CHRIS_PASSWORD}"
    HTPASSWD_ADDED_USERS=(adam boaz chris)
  else
    apply_explicit_password_if_set adam ADAM_PASSWORD
    apply_explicit_password_if_set boaz BOAZ_PASSWORD
    apply_explicit_password_if_set chris CHRIS_PASSWORD
    maybe_add_missing_user boaz BOAZ_PASSWORD
    maybe_add_missing_user chris CHRIS_PASSWORD
    maybe_add_missing_user adam ADAM_PASSWORD
  fi

  new_d="$(openssl dgst -sha256 "${tmp}" | awk '{print $2}')"
  if [[ "${old_d}" == "${new_d}" ]]; then
    echo "    htpasswd-secret unchanged (set ADAM_PASSWORD / BOAZ_PASSWORD / CHRIS_PASSWORD to update a user, or REGENERATE_HTPASSWD=true for all)"
    rm -f "${tmp}"
    return 0
  fi

  oc -n openshift-config create secret generic htpasswd-secret \
    --from-file=htpasswd="${tmp}" \
    --dry-run=client -o yaml | oc apply -f -
  oc -n openshift-config label secret htpasswd-secret \
    oauth-config.openshift.io/managed-by=config.openshift.io --overwrite 2>/dev/null || true
  rm -f "${tmp}"
}

# -----------------------------------------------------------------------------
# Preflight minimal (OpenShift only — Central API not contacted)
# -----------------------------------------------------------------------------
run_preflight_minimal() {
  echo "==> Preflight (minimal — OpenShift only; Central API not required)"
  need_cmd oc
  oc whoami >/dev/null || die "oc whoami failed — log in to the correct cluster/context"
}

modules_need_full_preflight() {
  local m
  for m in "$@"; do
    case "${m}" in
      registries|ocp-oauth|acs-users) return 0 ;;
    esac
  done
  return 1
}

# -----------------------------------------------------------------------------
# 0) Preconditions (Central API + roxctl — required for registry/OAuth/ACS-user modules)
# -----------------------------------------------------------------------------
run_preflight() {
load_rox_env_if_present
ensure_acs_central_url
[[ -n "${ACS_CENTRAL_URL:-}" ]] || die "Set ACS_CENTRAL_URL or ROX_ENDPOINT (e.g. source ~/.roxctl/set-env.sh)"

need_cmd oc
need_cmd curl
need_cmd python3

ACS_PUBLIC_HOST="$(parse_public_host "${ACS_CENTRAL_URL}")"

echo "==> Checking OpenShift CLI (oc)"
oc whoami >/dev/null || die "oc whoami failed — log in to the correct cluster/context"

echo "==> Checking Central API (${ACS_CENTRAL_URL})"
acs_curl GET "/v1/metadata" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null \
  || die "Central /v1/metadata failed — check ACS_CENTRAL_URL and credentials (ROX_API_TOKEN or ACS_ADMIN_PASSWORD)"

echo "==> Checking roxctl"
need_cmd roxctl
roxctl version >/dev/null 2>&1 || die "roxctl version failed — install roxctl and ensure it is on PATH"
echo "    roxctl present ($(roxctl version 2>/dev/null | head -1 || echo ok))"
if [[ -n "${ROX_API_TOKEN:-}" && -n "${ROX_ENDPOINT:-}" ]]; then
  roxctl central whoami -e "${ROX_ENDPOINT}" --insecure-skip-tls-verify >/dev/null \
    || die "roxctl central whoami failed using ROX_API_TOKEN; check ~/.roxctl/set-env.sh"
  echo "    roxctl token auth OK (whoami succeeded)"
else
  echo "    NOTE: ROX_API_TOKEN/ROX_ENDPOINT not set; Central was verified via REST above."
fi

if [[ -z "${SECURED_CLUSTER_NAME:-}" ]]; then
  if SECURED_CLUSTER_NAME="$(detect_secured_cluster_name_from_central)"; then
    echo "==> SECURED_CLUSTER_NAME not set; using sole cluster name from Central /v1/clusters: ${SECURED_CLUSTER_NAME}"
  elif SECURED_CLUSTER_NAME="$(detect_secured_cluster_name)"; then
    echo "==> SECURED_CLUSTER_NAME not set; inferred from OpenShift MachineSet label: ${SECURED_CLUSTER_NAME}"
    echo "    NOTE: If scoped ACS users see empty CVEs/violations, set SECURED_CLUSTER_NAME to the exact name in ACS → Platform Configuration → Clusters (it may differ from the MachineSet label)."
  else
    die "Set SECURED_CLUSTER_NAME to the cluster name shown in ACS (Platform Configuration → Clusters)."
  fi
fi
}

# -----------------------------------------------------------------------------
# Install Central CR (OpenShift console “Create Central” equivalent).
# Invoked as module install-central (runs before full preflight when combined with ACS modules).
# Prerequisite: RHACS operator installed via OLM (centrals.platform.stackrox.io CRD present).
# If stackrox already has any Central CR, skips oc apply and reports noop.
# -----------------------------------------------------------------------------
run_install_central() {
  need_cmd oc

  echo "==> [install-central] OpenShift login check"
  oc whoami >/dev/null || die "oc whoami failed — log in to the correct cluster/context"

  if ! oc get crd centrals.platform.stackrox.io >/dev/null 2>&1; then
    die "CRD centrals.platform.stackrox.io not found — install the RHACS operator from OperatorHub first"
  fi

  [[ -f "${CENTRAL_CR_MANIFEST}" ]] || die "Central CR manifest not found: ${CENTRAL_CR_MANIFEST}"

  echo "==> [install-central] Ensuring namespace ${STACKROX_NAMESPACE}"
  if oc get "namespace/${STACKROX_NAMESPACE}" >/dev/null 2>&1; then
    echo "    namespace ${STACKROX_NAMESPACE} already exists (skip oc new-project)"
  else
    oc new-project "${STACKROX_NAMESPACE}" || oc get "namespace/${STACKROX_NAMESPACE}" >/dev/null 2>&1 \
      || die "could not create ${STACKROX_NAMESPACE} (oc new-project failed and namespace still missing)"
  fi
  oc project "${STACKROX_NAMESPACE}" >/dev/null 2>&1 || true

  echo "==> [install-central] Checking for existing Central custom resources (${STACKROX_NAMESPACE})"
  local central_names
  central_names="$(oc get central.platform.stackrox.io -n "${STACKROX_NAMESPACE}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  if printf '%s' "${central_names}" | grep -q '[^[:space:]]'; then
    echo "    Central already installed — CR(s) in namespace ${STACKROX_NAMESPACE}:"
    while IFS= read -r crname; do
      [[ -z "${crname}" ]] && continue
      echo "      - ${crname}"
    done <<< "${central_names}"
    echo ""
    echo "=== install-central: noop (Central already present) ==="
    echo "No manifest applied. Check status:  oc get central -n ${STACKROX_NAMESPACE}"
    echo "                          workloads:  oc get pods -n ${STACKROX_NAMESPACE}"
    return 0
  fi

  echo "==> [install-central] Applying Central CR (${CENTRAL_CR_MANIFEST})"
  oc apply -f "${CENTRAL_CR_MANIFEST}"

  echo ""
  echo "=== install-central: applied ==="
  echo "Watch reconcile:  oc get central -n ${STACKROX_NAMESPACE}"
  echo "Watch workloads:  oc get pods -n ${STACKROX_NAMESPACE}"
}

resolve_cluster_name_for_secured_cluster() {
  # Required SecuredCluster.spec.clusterName — must match ACS “Clusters” name for demos.
  if [[ -n "${ACS_SECURED_CLUSTER_NAME:-}" ]]; then
    echo "${ACS_SECURED_CLUSTER_NAME}"
    return 0
  fi
  if [[ -n "${SECURED_CLUSTER_NAME:-}" ]]; then
    echo "${SECURED_CLUSTER_NAME}"
    return 0
  fi
  local infra
  infra="$(oc get infrastructure cluster -o jsonpath='{.status.infrastructureName}' 2>/dev/null || true)"
  if [[ -n "${infra}" ]]; then
    echo "${infra}"
    return 0
  fi
  local ms
  if ms="$(detect_secured_cluster_name 2>/dev/null)" && [[ -n "${ms}" ]]; then
    echo "${ms}"
    return 0
  fi
  die "Could not infer cluster name for SecuredCluster.spec.clusterName. Set ACS_SECURED_CLUSTER_NAME or SECURED_CLUSTER_NAME."
}

wait_for_central_ready() {
  need_cmd oc
  local ns="${STACKROX_NAMESPACE}"
  local name="${CENTRAL_CR_NAME}"
  local deadline=$(( $(date +%s) + ${CENTRAL_READY_TIMEOUT} ))

  echo "==> [install-secured-cluster] Waiting for Central (${name}) in ${ns} (timeout ${CENTRAL_READY_TIMEOUT}s)"

  if ! oc get "namespace/${ns}" >/dev/null 2>&1; then
    die "Namespace ${ns} does not exist — run --module install-central first (or create the project)."
  fi

  if ! oc get "central.platform.stackrox.io/${name}" -n "${ns}" >/dev/null 2>&1; then
    die "Central CR '${name}' not found in ${ns}. Apply Central first (--module install-central or console \"Create Central\")."
  fi

  local avail msg reason
  while (( $(date +%s) < deadline )); do
    avail="$(oc get "central.platform.stackrox.io/${name}" -n "${ns}" -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null || true)"
    reason="$(oc get "central.platform.stackrox.io/${name}" -n "${ns}" -o jsonpath='{.status.conditions[?(@.type=="Available")].reason}' 2>/dev/null || true)"
    msg="$(oc get "central.platform.stackrox.io/${name}" -n "${ns}" -o jsonpath='{.status.conditions[?(@.type=="Available")].message}' 2>/dev/null || true)"
    if [[ "${avail}" == "True" ]]; then
      echo "    Central Available=True (${reason:-ok}) ${msg:+- ${msg}}"
      return 0
    fi
    echo "    Central not ready yet (Available=${avail:-unknown}; reason=${reason:-n/a}); sleeping ${CENTRAL_READY_POLL}s..."
    sleep "${CENTRAL_READY_POLL}"
  done

  echo "ERROR: Central did not become Available within ${CENTRAL_READY_TIMEOUT}s." >&2
  echo "  oc get central -n ${ns} -o yaml" >&2
  echo "  oc get pods -n ${ns}" >&2
  echo "  oc describe central.platform.stackrox.io/${name} -n ${ns}" >&2
  die "Central stuck or failing — fix Central before installing SecuredCluster."
}

# -----------------------------------------------------------------------------
# Install SecuredCluster CR (same OpenShift cluster as Central — simplified lab).
# Waits for Central Available=True, then applies SECURED_CLUSTER_CR_MANIFEST.
# Remote-cluster installs need spec.centralEndpoint (see manifest comments).
# -----------------------------------------------------------------------------
run_install_secured_cluster() {
  need_cmd oc
  need_cmd python3

  echo "==> [install-secured-cluster] OpenShift login check"
  oc whoami >/dev/null || die "oc whoami failed — log in to the correct cluster/context"

  if ! oc get crd securedclusters.platform.stackrox.io >/dev/null 2>&1; then
    die "CRD securedclusters.platform.stackrox.io not found — install the RHACS operator from OperatorHub first"
  fi

  [[ -f "${SECURED_CLUSTER_CR_MANIFEST}" ]] || die "SecuredCluster manifest not found: ${SECURED_CLUSTER_CR_MANIFEST}"

  wait_for_central_ready

  echo "==> [install-secured-cluster] Checking for existing SecuredCluster custom resources (${STACKROX_NAMESPACE})"
  local sc_names
  sc_names="$(oc get securedcluster.platform.stackrox.io -n "${STACKROX_NAMESPACE}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  if printf '%s' "${sc_names}" | grep -q '[^[:space:]]'; then
    echo "    SecuredCluster already present in ${STACKROX_NAMESPACE}:"
    while IFS= read -r crname; do
      [[ -z "${crname}" ]] && continue
      echo "      - ${crname}"
    done <<< "${sc_names}"
    echo ""
    echo "=== install-secured-cluster: noop (SecuredCluster already present) ==="
    echo "Check status:  oc get securedcluster -n ${STACKROX_NAMESPACE}"
    echo "               oc get pods -n ${STACKROX_NAMESPACE}"
    return 0
  fi

  local cluster_name rendered
  cluster_name="$(resolve_cluster_name_for_secured_cluster)"
  echo "==> [install-secured-cluster] Using spec.clusterName=${cluster_name}"

  rendered="$(python3 -c '
import pathlib, sys
path, cname = sys.argv[1], sys.argv[2]
raw = pathlib.Path(path).read_text(encoding="utf-8")
if "CLUSTER_NAME_PLACEHOLDER" not in raw:
    sys.stderr.write("manifest missing CLUSTER_NAME_PLACEHOLDER\\n")
    sys.exit(1)
sys.stdout.write(raw.replace("CLUSTER_NAME_PLACEHOLDER", cname))
' "${SECURED_CLUSTER_CR_MANIFEST}" "${cluster_name}")"

  echo "==> [install-secured-cluster] Applying SecuredCluster CR (${SECURED_CLUSTER_CR_MANIFEST})"
  printf '%s\n' "${rendered}" | oc apply -f -

  echo ""
  echo "=== install-secured-cluster: applied ==="
  echo "Watch:  oc get securedcluster -n ${STACKROX_NAMESPACE}"
  echo "        oc get pods -n ${STACKROX_NAMESPACE}"
}

# -----------------------------------------------------------------------------
# Module 1 — ms-demo (DEMO_NAMESPACE + manifest only)
# -----------------------------------------------------------------------------
run_module_ms_demo() {
echo "==> [ms-demo] Ensuring project ${DEMO_NAMESPACE}"
oc get "project/${DEMO_NAMESPACE}" >/dev/null 2>&1 || oc new-project "${DEMO_NAMESPACE}"

[[ -f "${DEMO_MANIFEST}" ]] || die "Demo manifest not found: ${DEMO_MANIFEST}"

echo "==> [ms-demo] Applying microservices demo (${DEMO_MANIFEST})"
oc apply -f "${DEMO_MANIFEST}"
}

# -----------------------------------------------------------------------------
# Module 2 — registries
# -----------------------------------------------------------------------------
run_module_registries() {
echo "==> [registries] Ensuring ACS registry integration for ${REGISTRY_ENDPOINT}"
EXIST_REG="$(acs_curl GET "/v1/imageintegrations" | python3 -c '
import json,sys
ep=sys.argv[1]
j=json.load(sys.stdin)
for i in j.get("integrations",[]):
    if i.get("docker",{}).get("endpoint")==ep:
        print(i.get("id",""))
        break
' "${REGISTRY_ENDPOINT}")"
if [[ -n "${EXIST_REG}" ]]; then
  echo "    (already present id=${EXIST_REG})"
else
  BODY="$(python3 -c 'import json
print(json.dumps({
  "name": "'"${REGISTRY_INTEGRATION_NAME}"'",
  "type": "docker",
  "categories": ["REGISTRY"],
  "docker": {
    "endpoint": "'"${REGISTRY_ENDPOINT}"'",
    "username": "",
    "password": "",
    "insecure": False,
  },
  "autogenerated": False,
  "clusterId": "",
  "skipTestIntegration": True,
}))')"
  acs_curl POST "/v1/imageintegrations" "${BODY}" >/dev/null
  echo "    created registry integration ${REGISTRY_INTEGRATION_NAME}"
fi
}

# -----------------------------------------------------------------------------
# Module 3 — OCP users (CHRIS namespaces + HTPasswd + IdP + RBAC)
# -----------------------------------------------------------------------------
run_module_ocp_users() {
echo "==> [ocp-users] Ensuring projects (${CHRIS_OCP_NAMESPACES})"
for ns in ${CHRIS_OCP_NAMESPACES}; do
  oc get "project/${ns}" >/dev/null 2>&1 || oc new-project "${ns}"
done

echo "==> [ocp-users] OpenShift HTPasswd IdP (${HTPASSWD_IDP_NAME})"

ensure_demouser_htpasswd

if echo "$(oc get oauth.config.openshift.io cluster -o jsonpath='{range .spec.identityProviders[*]}{.name}{" "}{end}' 2>/dev/null || true)" | grep -qw "${HTPASSWD_IDP_NAME}"; then
  echo "    identity provider ${HTPASSWD_IDP_NAME} already configured"
else
  echo "    appending ${HTPASSWD_IDP_NAME} to OAuth (existing IdPs preserved)"
  append_htpasswd_idp
fi

echo "==> [ocp-users] RBAC: adam → cluster-admin, boaz → admin on ${DEMO_NAMESPACE}"
oc adm policy add-cluster-role-to-user cluster-admin adam --rolebinding-name="adam-cluster-admin" 2>/dev/null \
  || oc adm policy add-cluster-role-to-user cluster-admin adam
oc adm policy add-role-to-user admin boaz -n "${DEMO_NAMESPACE}" --rolebinding-name="boaz-namespace-admin" 2>/dev/null \
  || oc adm policy add-role-to-user admin boaz -n "${DEMO_NAMESPACE}"

echo "==> [ocp-users] RBAC: chris → admin on ${CHRIS_OCP_NAMESPACES}"
for ns in ${CHRIS_OCP_NAMESPACES}; do
  oc adm policy add-role-to-user admin chris -n "${ns}" --rolebinding-name="chris-admin-${ns}" 2>/dev/null \
    || oc adm policy add-role-to-user admin chris -n "${ns}"
done
}

# -----------------------------------------------------------------------------
# Module 4 — OCP-OAuth on Central
# -----------------------------------------------------------------------------
run_module_ocp_oauth() {
echo "==> [ocp-oauth] ACS OpenShift auth provider (${ACS_OPENSHIFT_AUTH_NAME})"

OPENSHIFT_PROVIDER_ID="$(acs_curl GET "/v1/authProviders" | python3 -c '
import json,sys
j=json.load(sys.stdin)
for p in j.get("authProviders",[]):
    if p.get("type")=="openshift":
        print(p["id"])
        break
')"

if [[ -n "${OPENSHIFT_PROVIDER_ID}" ]]; then
  echo "    openshift auth provider already exists id=${OPENSHIFT_PROVIDER_ID}"
  EXIST_NAME="$(acs_curl GET "/v1/authProviders" | python3 -c '
import json,sys
j=json.load(sys.stdin)
for p in j.get("authProviders",[]):
    if p.get("type")=="openshift":
        print(p.get("name",""))
        break
')"
  if [[ "${EXIST_NAME}" != "${ACS_OPENSHIFT_AUTH_NAME}" ]]; then
    echo "    NOTE: provider display name is '${EXIST_NAME}'. Rename to ${ACS_OPENSHIFT_AUTH_NAME} in UI if you want that label."
  fi
else
  BODY="$(python3 -c 'import json
print(json.dumps({
  "name": "'"${ACS_OPENSHIFT_AUTH_NAME}"'",
  "type": "openshift",
  "uiEndpoint": "'"${ACS_PUBLIC_HOST}"'",
  "enabled": True,
  "config": {},
  "validated": False,
  "extraUiEndpoints": [],
  "active": False,
  "requiredAttributes": [],
  "claimMappings": {},
}))')"
  RESP="$(acs_curl POST "/v1/authProviders" "${BODY}")"
  OPENSHIFT_PROVIDER_ID="$(echo "${RESP}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  echo "    created provider id=${OPENSHIFT_PROVIDER_ID}"
fi

[[ -n "${OPENSHIFT_PROVIDER_ID}" ]] || die "No OpenShift auth provider id (unexpected)"
export OPENSHIFT_PROVIDER_ID
}

# -----------------------------------------------------------------------------
# Module 5 — ACS users (scope + roles + group rules; needs openshift provider)
# -----------------------------------------------------------------------------
run_module_acs_users() {
SCOPE_ID=""

echo "==> [acs-users] ACS access scope ${ACS_SCOPE_NAME} (${SECURED_CLUSTER_NAME} / ${DEMO_NAMESPACE})"
reconcile_simple_access_scope
[[ -n "${SCOPE_ID}" ]] || die "SCOPE_ID unset after reconcile_simple_access_scope"

echo "==> [acs-users] ACS role ${ACS_ROLE_BOAZ}"
reconcile_boaz_role

echo "==> [acs-users] ACS role ${ACS_ROLE_CHRIS} (Chris: Analyst + same scope as ${ACS_SCOPE_NAME})"
reconcile_chris_role

if [[ -z "${OPENSHIFT_PROVIDER_ID:-}" ]]; then
  OPENSHIFT_PROVIDER_ID="$(acs_curl GET "/v1/authProviders" | python3 -c '
import json,sys
j=json.load(sys.stdin)
for p in j.get("authProviders",[]):
    if p.get("type")=="openshift":
        print(p["id"])
        break
' || true)"
fi
[[ -n "${OPENSHIFT_PROVIDER_ID:-}" ]] || die "No OpenShift-type auth provider on Central — run ocp-oauth (module 4) first"

echo "==> [acs-users] ACS auth provider rules for provider ${OPENSHIFT_PROVIDER_ID}"
warn_conflicting_name_rule boaz "${ACS_ROLE_BOAZ}"
warn_conflicting_name_rule chris "${ACS_ROLE_CHRIS}"

has_default_none() {
  acs_curl GET "/v1/groups" | python3 -c '
import json,sys
pid=sys.argv[1]
j=json.load(sys.stdin)
for g in j.get("groups",[]):
    pr=g.get("props",{})
    if pr.get("authProviderId")!=pid: continue
    if pr.get("key","")=="" and pr.get("value","")=="" and g.get("roleName")=="None":
        sys.exit(0)
sys.exit(1)
' "${OPENSHIFT_PROVIDER_ID}"
}

if has_default_none; then
  echo "    default minimum rule (None) already present"
else
  BODY="$(python3 -c 'import json
print(json.dumps({
  "props": {"authProviderId": "'"${OPENSHIFT_PROVIDER_ID}"'", "key": "", "value": ""},
  "roleName": "None",
}))')"
  acs_curl POST "/v1/groups" "${BODY}" >/dev/null || echo "    (could not add default None — check UI / duplicates)"
fi

has_boaz_rule() {
  acs_curl GET "/v1/groups" | python3 -c '
import json,sys
pid=sys.argv[1]
role=sys.argv[2]
j=json.load(sys.stdin)
for g in j.get("groups",[]):
    pr=g.get("props",{})
    if pr.get("authProviderId")!=pid: continue
    if pr.get("key")=="name" and pr.get("value")=="boaz" and g.get("roleName")==role:
        sys.exit(0)
sys.exit(1)
' "${OPENSHIFT_PROVIDER_ID}" "${ACS_ROLE_BOAZ}"
}

if has_boaz_rule; then
  echo "    rule boaz → ${ACS_ROLE_BOAZ} already present"
else
  BODY="$(python3 -c 'import json
print(json.dumps({
  "props": {"authProviderId": "'"${OPENSHIFT_PROVIDER_ID}"'", "key": "name", "value": "boaz"},
  "roleName": "'"${ACS_ROLE_BOAZ}"'",
}))')"
  acs_curl POST "/v1/groups" "${BODY}" >/dev/null
  echo "    added rule boaz → ${ACS_ROLE_BOAZ}"
fi

has_chris_rule() {
  acs_curl GET "/v1/groups" | python3 -c '
import json,sys
pid=sys.argv[1]
role=sys.argv[2]
j=json.load(sys.stdin)
for g in j.get("groups",[]):
    pr=g.get("props",{})
    if pr.get("authProviderId")!=pid: continue
    if pr.get("key")=="name" and pr.get("value")=="chris" and g.get("roleName")==role:
        sys.exit(0)
sys.exit(1)
' "${OPENSHIFT_PROVIDER_ID}" "${ACS_ROLE_CHRIS}"
}

if has_chris_rule; then
  echo "    rule chris → ${ACS_ROLE_CHRIS} already present"
else
  BODY="$(python3 -c 'import json
print(json.dumps({
  "props": {"authProviderId": "'"${OPENSHIFT_PROVIDER_ID}"'", "key": "name", "value": "chris"},
  "roleName": "'"${ACS_ROLE_CHRIS}"'",
}))')"
  acs_curl POST "/v1/groups" "${BODY}" >/dev/null
  echo "    added rule chris → ${ACS_ROLE_CHRIS}"
fi
}

print_install_footer() {
echo ""
echo "=== Finished ==="
if [[ ${#HTPASSWD_ADDED_USERS[@]} -gt 0 ]]; then
  echo "OpenShift users (passwords generated or merged this run; HTPasswd / ${HTPASSWD_IDP_NAME}):"
  for u in "${HTPASSWD_ADDED_USERS[@]}"; do
    case "${u}" in
      adam) echo "  adam / ${ADAM_PASSWORD:-}" ;;
      boaz) echo "  boaz / ${BOAZ_PASSWORD:-}" ;;
      chris) echo "  chris / ${CHRIS_PASSWORD:-}" ;;
      *) echo "  ${u} (unknown)" ;;
    esac
  done
fi
}

# --- status helpers (stdout: id<TAB>state<TAB>detail) ---
status_row_ms_demo() {
  if oc get "project/${DEMO_NAMESPACE}" >/dev/null 2>&1; then
    local cnt
    cnt="$(oc get all -n "${DEMO_NAMESPACE}" -o name 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "${cnt:-0}" -gt 2 ]]; then
      printf '%s\t%s\t%s\n' "ms-demo" "ready" "project ${DEMO_NAMESPACE} has workloads"
    else
      printf '%s\t%s\t%s\n' "ms-demo" "partial" "project exists; few resources in ${DEMO_NAMESPACE}"
    fi
  else
    printf '%s\t%s\t%s\n' "ms-demo" "absent" "project ${DEMO_NAMESPACE} missing"
  fi
}

status_row_registries() {
  local detail
  detail="$(acs_curl GET "/v1/imageintegrations" 2>/dev/null | python3 -c '
import json,sys
ep=sys.argv[1]
try:
 j=json.load(sys.stdin)
except Exception:
 sys.exit(1)
for i in j.get("integrations",[]):
    if i.get("docker",{}).get("endpoint")==ep:
        name = (i.get("name") or "").strip()
        if name:
            print("integration \"%s\" — %s" % (name, ep))
        else:
            print("registry integration configured — %s" % ep)
        sys.exit(0)
sys.exit(1)
' "${REGISTRY_ENDPOINT}" 2>/dev/null)" || detail=""
  if [[ -n "${detail}" ]]; then
    printf '%s\t%s\t%s\n' "registries" "ready" "${detail}"
  else
    printf '%s\t%s\t%s\n' "registries" "absent" "no integration for ${REGISTRY_ENDPOINT}"
  fi
}

status_row_ocp_users() {
  local ok=true detail=""
  for ns in ${CHRIS_OCP_NAMESPACES}; do
    if ! oc get "project/${ns}" >/dev/null 2>&1; then ok=false; detail="${detail} missing:${ns}"; fi
  done
  if ! oc -n openshift-config get secret htpasswd-secret >/dev/null 2>&1; then ok=false; detail="${detail} no htpasswd-secret"; fi
  local idplist
  idplist="$(oc get oauth.config.openshift.io cluster -o jsonpath='{range .spec.identityProviders[*]}{.name}{" "}{end}' 2>/dev/null || true)"
  if ! echo "${idplist}" | grep -qw "${HTPASSWD_IDP_NAME}"; then ok=false; detail="${detail} no IdP ${HTPASSWD_IDP_NAME}"; fi
  if $ok; then
    printf '%s\t%s\t%s\n' "ocp-users" "ready" "namespaces+htpasswd+IdP present"
  elif oc -n openshift-config get secret htpasswd-secret >/dev/null 2>&1; then
    printf '%s\t%s\t%s\n' "ocp-users" "partial" "$(echo "${detail}" | tr -s ' ')"
  else
    printf '%s\t%s\t%s\n' "ocp-users" "absent" "$(echo "${detail}" | tr -s ' ')"
  fi
}

status_row_ocp_oauth() {
  local detail
  detail="$(acs_curl GET "/v1/authProviders" 2>/dev/null | python3 -c '
import json,sys
try:
 j=json.load(sys.stdin)
except Exception:
 sys.exit(1)
for p in j.get("authProviders",[]):
    if p.get("type")=="openshift":
        name = (p.get("name") or "").strip()
        if name:
            print("OpenShift login: %s" % name)
        else:
            print("OpenShift login configured")
        sys.exit(0)
sys.exit(1)
' 2>/dev/null)" || detail=""
  if [[ -n "${detail}" ]]; then
    printf '%s\t%s\t%s\n' "ocp-oauth" "ready" "${detail}"
  else
    printf '%s\t%s\t%s\n' "ocp-oauth" "absent" "no openshift-type auth provider"
  fi
}

status_row_central() {
  # Status-only check: can we reach Central's API with current auth inputs?
  if [[ -z "${ACS_CENTRAL_URL:-}" ]]; then
    printf '%s\t%s\t%s\n' "central" "absent" "ACS_CENTRAL_URL not set"
    return 0
  fi

  local detail
  detail="$(acs_curl GET "/v1/metadata" 2>/dev/null | python3 -c '
import json,sys
try:
  j=json.load(sys.stdin)
except Exception:
  sys.exit(1)
ver = j.get("version") or ""
if isinstance(ver, dict):
  ver = ver.get("version") or ver.get("tag") or ""
ver = (ver or "").strip()
if ver:
  print("Central API reachable — %s" % ver)
else:
  print("Central API reachable")
' 2>/dev/null)" || detail=""

  if [[ -n "${detail}" ]]; then
    printf '%s\t%s\t%s\n' "central" "ready" "${detail} — ${ACS_CENTRAL_URL}"
  else
    printf '%s\t%s\t%s\n' "central" "absent" "Central API not reachable — ${ACS_CENTRAL_URL} (check credentials)"
  fi
}

status_row_secured_cluster() {
  # Status-only check: is the secured cluster registered in Central?
  local scn
  scn="$(resolve_secured_cluster_name_for_status 2>/dev/null || true)"
  if [[ -z "${scn}" ]]; then
    printf '%s\t%s\t%s\n' "secured-cluster" "absent" "SECURED_CLUSTER_NAME not set (and could not be resolved)"
    return 0
  fi

  local found
  found="$(acs_curl GET "/v1/clusters" 2>/dev/null | python3 -c '
import json,sys
want=sys.argv[1]
try:
  j=json.load(sys.stdin)
except Exception:
  sys.exit(2)
names=[(c.get("name") or "").strip() for c in j.get("clusters",[]) if (c.get("name") or "").strip()]
print("yes" if want in names else "no")
' "${scn}" 2>/dev/null)" || found="__ERR__"

  if [[ "${found}" == "__ERR__" ]]; then
    printf '%s\t%s\t%s\n' "secured-cluster" "partial" "cannot verify cluster registration (token may lack permission to list clusters)"
    return 0
  fi

  if [[ "${found}" == "yes" ]]; then
    printf '%s\t%s\t%s\n' "secured-cluster" "ready" "registered as ${scn}"
  else
    printf '%s\t%s\t%s\n' "secured-cluster" "absent" "not registered in Central as ${scn}"
  fi
}

status_row_acs_users() {
  local pid
  pid="$(acs_curl GET "/v1/authProviders" 2>/dev/null | python3 -c '
import json,sys
try: j=json.load(sys.stdin)
except: sys.exit(1)
for p in j.get("authProviders",[]):
    if p.get("type")=="openshift":
        print(p["id"])
        break
' 2>/dev/null)" || pid=""
  if [[ -z "${pid}" ]]; then
    printf '%s\t%s\t%s\n' "acs-users" "blocked" "needs ocp-oauth (no openshift auth provider)"
    return 0
  fi
  local sc rb rc gb gc
  sc="$(acs_curl GET "/v1/simpleaccessscopes" 2>/dev/null | python3 -c '
import json,sys
want=sys.argv[1]
try: j=json.load(sys.stdin)
except: sys.exit(1)
for s in j.get("accessScopes",[]):
    if s.get("name")==want:
        print("yes"); break
' "${ACS_SCOPE_NAME}" 2>/dev/null)" || sc=""
  rb="$(acs_curl GET "/v1/roles/${ACS_ROLE_BOAZ}" 2>/dev/null | python3 -c 'import json,sys; j=json.load(sys.stdin); print("yes" if j.get("name") else "no")' 2>/dev/null || echo no)"
  rc="$(acs_curl GET "/v1/roles/${ACS_ROLE_CHRIS}" 2>/dev/null | python3 -c 'import json,sys; j=json.load(sys.stdin); print("yes" if j.get("name") else "no")' 2>/dev/null || echo no)"
  gb="$(acs_curl GET "/v1/groups" 2>/dev/null | OPENSHIFT_PROVIDER_ID="${pid}" ACS_ROLE_BOAZ="${ACS_ROLE_BOAZ}" python3 -c '
import json,sys,os
pid=os.environ["OPENSHIFT_PROVIDER_ID"]; role=os.environ["ACS_ROLE_BOAZ"]
j=json.load(sys.stdin)
for g in j.get("groups",[]):
    pr=g.get("props",{})
    if pr.get("authProviderId")==pid and pr.get("key")=="name" and pr.get("value")=="boaz" and g.get("roleName")==role:
        print("yes"); sys.exit(0)
print("no")
' 2>/dev/null || echo no)"
  gc="$(acs_curl GET "/v1/groups" 2>/dev/null | OPENSHIFT_PROVIDER_ID="${pid}" ACS_ROLE_CHRIS="${ACS_ROLE_CHRIS}" python3 -c '
import json,sys,os
pid=os.environ["OPENSHIFT_PROVIDER_ID"]; role=os.environ["ACS_ROLE_CHRIS"]
j=json.load(sys.stdin)
for g in j.get("groups",[]):
    pr=g.get("props",{})
    if pr.get("authProviderId")==pid and pr.get("key")=="name" and pr.get("value")=="chris" and g.get("roleName")==role:
        print("yes"); sys.exit(0)
print("no")
' 2>/dev/null || echo no)"

  if [[ "${sc}" == yes && "${rb}" == yes && "${rc}" == yes && "${gb}" == yes && "${gc}" == yes ]]; then
    printf '%s\t%s\t%s\n' "acs-users" "ready" "scope+roles+group rules present"
  elif [[ "${sc}" == yes || "${rb}" == yes ]]; then
    printf '%s\t%s\t%s\n' "acs-users" "partial" "scope/roles/rules incomplete"
  else
    printf '%s\t%s\t%s\n' "acs-users" "absent" "ACS scope/roles not configured"
  fi
}

# For --status only: same checks as preflight, but non-fatal; full JSON for GUI (preflight + modules).
soft_secured_cluster_name_from_central() {
  [[ -n "${ACS_CENTRAL_URL:-}" ]] || return 1
  acs_auth_args >/dev/null 2>&1 || return 1
  local out ec
  out="$(acs_curl GET "/v1/clusters" 2>/dev/null | python3 -c '
import json,sys
j=json.load(sys.stdin)
names=[c.get("name") for c in j.get("clusters",[]) if c.get("name")]
if len(names)==1:
    print(names[0])
elif len(names)==0:
    sys.exit(3)
else:
    sys.exit(2)
')" ; ec=$?
  [[ "${ec}" -eq 0 ]] && [[ -n "${out}" ]] && echo "${out}"
}

resolve_secured_cluster_name_for_status() {
  if [[ -n "${SECURED_CLUSTER_NAME:-}" ]]; then
    echo "${SECURED_CLUSTER_NAME}"
    return 0
  fi
  local n
  n="$(soft_secured_cluster_name_from_central 2>/dev/null || true)"
  [[ -n "${n}" ]] && { echo "${n}"; return 0; }
  n="$(detect_secured_cluster_name 2>/dev/null || true)"
  [[ -n "${n}" ]] && echo "${n}"
}

emit_status_json_with_preflight() {
  load_rox_env_if_present
  ensure_acs_central_url
  # So embedded Python sees the same effective values as the rest of the script (defaults above).
  export DEMO_NAMESPACE DEMO_MANIFEST HTPASSWD_IDP_NAME ACS_OPENSHIFT_AUTH_NAME ACS_ROLE_BOAZ ACS_ROLE_CHRIS \
    CHRIS_OCP_NAMESPACES ACS_SCOPE_NAME ACS_SCOPE_DESCRIPTION REGISTRY_ENDPOINT REGISTRY_INTEGRATION_NAME \
    ACS_ANALYST_PERMISSION_SET_ID

  local ACS_PUBLIC_HOST_VAL kube_eff mods_tsv resolved_scn
  ACS_PUBLIC_HOST_VAL="$(parse_public_host "${ACS_CENTRAL_URL:-}" 2>/dev/null || echo "")"
  kube_eff="${KUBECONFIG:-${HOME}/.kube/config}"
  resolved_scn="$(resolve_secured_cluster_name_for_status 2>/dev/null || true)"

  mods_tsv="$({
    status_row_central
    status_row_secured_cluster
    status_row_ms_demo
    status_row_registries
    status_row_ocp_users
    status_row_ocp_oauth
    status_row_acs_users
  })"

  export PRELOAD_MODS_TSV="${mods_tsv}"
  export PRELOAD_ACS_PUBLIC_HOST="${ACS_PUBLIC_HOST_VAL}"
  export PRELOAD_KUBECONFIG_EFFECTIVE="${kube_eff}"
  export PRELOAD_RESOLVED_SECURED_CLUSTER_NAME="${resolved_scn}"

  python3 - <<'PY'
import json, os, shutil, subprocess

mods_tsv = os.environ.get("PRELOAD_MODS_TSV", "")
mods = []
for line in mods_tsv.splitlines():
    line = line.strip()
    if not line:
        continue
    parts = line.split("\t", 2)
    if len(parts) >= 3:
        mods.append({"id": parts[0], "state": parts[1], "detail": parts[2]})

SIGNIFICANT_KEYS = [
    "ACS_CENTRAL_URL",
    "ROX_API_TOKEN",
    "ACS_ADMIN_PASSWORD",
    "ROX_ENDPOINT",
    "SECURED_CLUSTER_NAME",
    "KUBECONFIG",
    "DEMO_NAMESPACE",
    "DEMO_MANIFEST",
    "CHRIS_OCP_NAMESPACES",
    "HTPASSWD_IDP_NAME",
    "ACS_SCOPE_NAME",
    "ACS_SCOPE_DESCRIPTION",
    "REGISTRY_ENDPOINT",
    "REGISTRY_INTEGRATION_NAME",
    "ACS_OPENSHIFT_AUTH_NAME",
    "ACS_ROLE_BOAZ",
    "ACS_ROLE_CHRIS",
    "ACS_ENV_FILE",
    "ACS_ANALYST_PERMISSION_SET_ID",
]

SECRET_KEYS = {
    "ROX_API_TOKEN",
    "ACS_ADMIN_PASSWORD",
    "ADAM_PASSWORD",
    "BOAZ_PASSWORD",
    "CHRIS_PASSWORD",
}


def env_snapshot():
    out = {}
    for k in SIGNIFICANT_KEYS:
        v = os.environ.get(k)
        if v is None:
            out[k] = None
        elif k in SECRET_KEYS:
            out[k] = "(set)" if v else ""
        else:
            out[k] = v
    kc = os.environ.get("PRELOAD_KUBECONFIG_EFFECTIVE")
    if kc:
        out["_kubeconfig_effective"] = kc
    rsc = os.environ.get("PRELOAD_RESOLVED_SECURED_CLUSTER_NAME", "").strip()
    if rsc:
        out["_resolved_SECURED_CLUSTER_NAME"] = rsc
    return out


def run_cmd(argv, timeout=40):
    try:
        r = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=os.environ.copy(),
        )
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except Exception as e:
        return None, "", str(e)


checks = []
pf_ok = True


def add_check(name, ok, detail):
    global pf_ok
    detail_s = detail if isinstance(detail, str) else str(detail)
    checks.append({"name": name, "ok": bool(ok), "detail": detail_s[:4000]})
    if not ok:
        pf_ok = False


acu = (os.environ.get("ACS_CENTRAL_URL") or "").strip()
if not acu:
    add_check("ACS_CENTRAL_URL", False, "not set (required)")
else:
    add_check("ACS_CENTRAL_URL", True, acu)

curl_bin = shutil.which("curl")
api_tok = os.environ.get("ROX_API_TOKEN", "")
api_pwd = os.environ.get("ACS_ADMIN_PASSWORD", "")
if acu:
    if not curl_bin:
        add_check("central_api_metadata", False, "curl not found on PATH")
    else:
        meta_url = acu.rstrip("/") + "/v1/metadata"
        rc = None
        body = ""
        cerr = ""
        if api_tok:
            rc, body, cerr = run_cmd(
                [curl_bin, "-skS", "-H", "Authorization: Bearer " + api_tok, meta_url]
            )
        elif api_pwd:
            rc, body, cerr = run_cmd(
                [curl_bin, "-skS", "-u", "admin:" + api_pwd, meta_url]
            )
        else:
            add_check(
                "central_api_metadata",
                False,
                "no ROX_API_TOKEN or ACS_ADMIN_PASSWORD",
            )
        if api_tok or api_pwd:
            if rc is None:
                add_check("central_api_metadata", False, (cerr or "command failed")[:500])
            elif rc != 0:
                add_check(
                    "central_api_metadata",
                    False,
                    (cerr or body or "curl failed")[:500],
                )
            else:
                try:
                    json.loads(body)
                    add_check("central_api_metadata", True, "/v1/metadata OK")
                except Exception:
                    add_check(
                        "central_api_metadata",
                        False,
                        (body or "invalid JSON")[:500],
                    )

oc_path = shutil.which("oc")
openshift = {}
if not oc_path:
    add_check("oc_cli", False, "oc not found on PATH")
else:
    add_check("oc_cli", True, oc_path)

if oc_path:
    rc, out, err = run_cmd([oc_path, "whoami"])
    if rc == 0:
        openshift["username"] = out
        add_check("oc_whoami", True, out)
    else:
        openshift["username"] = None
        add_check("oc_whoami", False, (err or out or "failed")[:800])

    for label, args in [
        ("api_server", ["whoami", "--show-server"]),
        ("current_context", ["whoami", "--show-context"]),
        (
            "kubeconfig_cluster",
            ["config", "view", "--minify", "-o", "jsonpath={.contexts[0].context.cluster}"],
        ),
    ]:
        rc, out, err = run_cmd([oc_path] + args)
        openshift[label] = out if rc == 0 else None

    rc, out, err = run_cmd([oc_path, "version", "-o", "json"])
    openshift["oc_client_version"] = None
    if rc == 0 and out:
        try:
            j = json.loads(out)
            v = j.get("clientVersion") or {}
            openshift["oc_client_version"] = v.get("gitVersion") or v.get("version") or ""
        except Exception:
            openshift["oc_client_version"] = out[:120]

    rc, out, err = run_cmd(
        [oc_path, "get", "infrastructure", "cluster", "-o", "jsonpath={.status.infrastructureName}"]
    )
    openshift["infrastructure_name"] = out if rc == 0 and out else None

    rc, out, err = run_cmd(
        [oc_path, "get", "dns", "cluster", "-o", "jsonpath={.spec.baseDomain}"]
    )
    openshift["cluster_base_domain"] = out if rc == 0 and out else None

rox = shutil.which("roxctl")
if not rox:
    add_check("roxctl_cli", False, "roxctl not found on PATH")
else:
    add_check("roxctl_cli", True, rox)
    rc, out, err = run_cmd([rox, "version"], timeout=15)
    if rc == 0:
        line = (out or "").splitlines()[0] if out else "ok"
        add_check("roxctl_version", True, line[:200])
    else:
        add_check("roxctl_version", False, (err or out)[:300])

tok = os.environ.get("ROX_API_TOKEN", "")
rend = os.environ.get("ROX_ENDPOINT", "")
if tok and rend:
    rx = shutil.which("roxctl")
    if rx:
        rc, out, err = run_cmd(
            [
                rx,
                "central",
                "whoami",
                "-e",
                rend,
                "--insecure-skip-tls-verify",
            ],
            timeout=30,
        )
        add_check(
            "roxctl_central_whoami",
            rc == 0,
            "OK" if rc == 0 else (err or out or "failed")[:400],
        )
else:
    add_check(
        "roxctl_central_whoami",
        True,
        "skipped (ROX_API_TOKEN and ROX_ENDPOINT both required for this check)",
    )

resolved = {
    "ACS_PUBLIC_HOST": (os.environ.get("PRELOAD_ACS_PUBLIC_HOST") or "").strip(),
    "SECURED_CLUSTER_NAME": (os.environ.get("PRELOAD_RESOLVED_SECURED_CLUSTER_NAME") or "").strip(),
}

out_obj = {
    "preflight": {
        "ok": pf_ok,
        "checks": checks,
        "openshift": openshift,
        "resolved": resolved,
        "environment": env_snapshot(),
    },
    "modules": mods,
}
print(json.dumps(out_obj, indent=2))
PY
}

ACS_DEMO_SETUP_STATUS=false
declare -a ACS_SELECTED_MODULES=()

usage() {
  cat <<'USAGE'
Usage:
  acs-demo-setup.sh [--status]
  acs-demo-setup.sh [--module <name>] ...
  acs-demo-setup.sh   (no flags = all modules in default order)

--module <name>
  Run only the selected modules instead of the full default pipeline.
  Pass --module once per module, or use ACS_DEMO_MODULES (space-separated list).
  Execution order is always the canonical order below—not the order you type flags.

  Examples (multiple modules):
    ./acs-demo-setup.sh --module install-central --module install-secured-cluster
    ./acs-demo-setup.sh --module install-central --module ms-demo
    ./acs-demo-setup.sh --module ms-demo --module registries --module ocp-users
    ACS_DEMO_MODULES="install-central install-secured-cluster" ./acs-demo-setup.sh

  Example (canonical reorder): flags ocp-users before ms-demo still run ms-demo first:
    ./acs-demo-setup.sh --module ocp-users --module ms-demo

Modules (names for --module):
  install-central  Create namespace stackrox if needed; apply Central CR (CENTRAL_CR_MANIFEST).
                   RHACS operator must already be installed. No-op if a Central CR already exists in stackrox.
                   Runs before full preflight when combined with registries / ocp-oauth / acs-users.
  install-secured-cluster  Wait until Central is Available, then apply SecuredCluster CR (SECURED_CLUSTER_CR_MANIFEST).
                   Simplified lab: Central + Secured Cluster on the SAME OpenShift cluster (no spec.centralEndpoint).
                   For Secured Cluster on another cluster, set centralEndpoint in a custom manifest (see file comments).
                   No manual init-bundle / CRS step — Operator reconciles from the SecuredCluster CR.
                   clusterName from ACS_SECURED_CLUSTER_NAME / SECURED_CLUSTER_NAME / infrastructure name / MachineSet hint.
  ms-demo          Ensure DEMO_NAMESPACE; apply microservices-demo manifest (DEMO_MANIFEST).
  registries       Ensure ACS image registry integration for REGISTRY_ENDPOINT (artifact/registry).
  ocp-users        Projects in CHRIS_OCP_NAMESPACES; htpasswd secret + OAuth IdP; RBAC for adam/boaz/chris.
  ocp-oauth        Register Central auth provider for OpenShift login (ACS_OPENSHIFT_AUTH_NAME).
  acs-users        ACS simple access scope + Analyst roles + OpenShift provider group rules (boaz/chris).

Default order when you pass no flags (install-central is not included—Central is assumed to exist):
  ms-demo → registries → ocp-users → ocp-oauth → acs-users

Canonical order when you pass --module (includes RHACS bootstrap modules if selected):
  install-central → install-secured-cluster → ms-demo → registries → ocp-users → ocp-oauth → acs-users

Notes:
  --status prints JSON: preflight (checks, openshift, resolved, masked env) plus module rows.
  Env: CENTRAL_CR_MANIFEST=… SECURED_CLUSTER_CR_MANIFEST=… (defaults: central-cr-minimal.yaml, secured-cluster-cr-minimal.yaml next to this script)
  Env: CENTRAL_READY_TIMEOUT=900 CENTRAL_READY_POLL=10 — wait limits for install-secured-cluster.
  If you select acs-users but omit ocp-oauth, ocp-oauth is appended automatically (acs-users needs the OpenShift auth provider).
USAGE
}

validate_selected_modules() {
  local s
  for s in "${ACS_SELECTED_MODULES[@]}"; do
    case "${s}" in
      install-central|install-secured-cluster|ms-demo|registries|ocp-users|ocp-oauth|acs-users) ;;
      *) die "unknown module '${s}' (try --help)" ;;
    esac
  done
}

normalize_selection() {
  declare -a raw=("$@")
  declare -a out=()
  local m
  if [[ ${#raw[@]} -eq 0 ]]; then
    out=(ms-demo registries ocp-users ocp-oauth acs-users)
  else
    out=("${raw[@]}")
  fi
  local need_oauth=false
  for m in "${out[@]}"; do
    [[ "${m}" == acs-users ]] && need_oauth=true
  done
  if $need_oauth; then
    local has=false
    for m in "${out[@]}"; do [[ "${m}" == ocp-oauth ]] && has=true; done
    if ! $has; then out+=(ocp-oauth); fi
  fi
  ORDERED_MODULES=()
  local canon=(install-central install-secured-cluster ms-demo registries ocp-users ocp-oauth acs-users)
  for m in "${canon[@]}"; do
    for s in "${out[@]}"; do
      if [[ "${s}" == "${m}" ]]; then ORDERED_MODULES+=("${m}"); break; fi
    done
  done
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) usage; exit 0 ;;
      --status) ACS_DEMO_SETUP_STATUS=true; shift ;;
      --module)
        [[ -n "${2:-}" ]] || die "--module requires an argument"
        ACS_SELECTED_MODULES+=("$2")
        shift 2 ;;
      *)
        die "unknown argument: $1 (try --help)"
        ;;
    esac
  done
  if [[ -n "${ACS_DEMO_MODULES:-}" ]]; then
    read -r -a extra <<< "${ACS_DEMO_MODULES}"
    ACS_SELECTED_MODULES+=("${extra[@]}")
  fi
}

run_one_install_module() {
  case "$1" in
    ms-demo) run_module_ms_demo ;;
    registries) run_module_registries ;;
    ocp-users) run_module_ocp_users ;;
    ocp-oauth) run_module_ocp_oauth ;;
    acs-users) run_module_acs_users ;;
    *) die "internal: unknown module $1" ;;
  esac
}

parse_args "$@"
validate_selected_modules

if [[ "${ACS_DEMO_SETUP_STATUS}" == true ]]; then
  emit_status_json_with_preflight
  exit 0
fi

normalize_selection "${ACS_SELECTED_MODULES[@]}"

declare -a ACS_MODULES_AFTER_BOOTSTRAP=()
for m in "${ORDERED_MODULES[@]}"; do
  case "${m}" in
    install-central) run_install_central ;;
    install-secured-cluster) run_install_secured_cluster ;;
    *) ACS_MODULES_AFTER_BOOTSTRAP+=("${m}") ;;
  esac
done

if modules_need_full_preflight "${ACS_MODULES_AFTER_BOOTSTRAP[@]}"; then
  run_preflight
else
  run_preflight_minimal
fi

for m in "${ACS_MODULES_AFTER_BOOTSTRAP[@]}"; do
  run_one_install_module "${m}"
done

print_install_footer
