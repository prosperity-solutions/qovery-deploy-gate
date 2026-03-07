#!/bin/sh
set -e

# --- Logging ---
log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [gate-check] $1"
}

log_error() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [gate-check] ERROR: $1" >&2
}

# --- Graceful shutdown ---
shutdown() {
  log "Received shutdown signal, exiting."
  exit 0
}
trap shutdown TERM INT

# --- Validate required environment variables ---
REQUIRED_VARS="GATE_URL GATE_DEPLOYMENT_ID GATE_SERVICE_ID GATE_GROUP GATE_POD_NAME GATE_POD_NAMESPACE KUBERNETES_SERVICE_HOST KUBERNETES_SERVICE_PORT"
for var in $REQUIRED_VARS; do
  val=$(printenv "$var" 2>/dev/null || true)
  if [ -z "$val" ]; then
    log_error "Required environment variable $var is not set."
    exit 1
  fi
done

GATE_POLL_INTERVAL="${GATE_POLL_INTERVAL:-5}"
case "$GATE_POLL_INTERVAL" in
  ''|*[!0-9]*) log_error "GATE_POLL_INTERVAL must be a positive integer"; exit 1 ;;
esac

# --- Kubernetes API configuration ---
SA_TOKEN_PATH="/var/run/secrets/kubernetes.io/serviceaccount/token"
SA_CA_PATH="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

if [ ! -f "$SA_TOKEN_PATH" ]; then
  log_error "Service account token not found at $SA_TOKEN_PATH"
  exit 1
fi

if [ ! -f "$SA_CA_PATH" ]; then
  log_error "CA certificate not found at $SA_CA_PATH"
  exit 1
fi

get_k8s_token() {
  cat "$SA_TOKEN_PATH"
}
K8S_API="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"

log "Starting gate-check sidecar"
log "  Gate URL:       ${GATE_URL}"
log "  Deployment ID:  ${GATE_DEPLOYMENT_ID}"
log "  Service ID:     ${GATE_SERVICE_ID}"
log "  Group:          ${GATE_GROUP:-<none>}"
log "  Pod:            ${GATE_POD_NAMESPACE}/${GATE_POD_NAME}"
log "  Poll interval:  ${GATE_POLL_INTERVAL}s"

# --- Helper: check if pod containers are ready ---
check_containers_ready() {
  POD_JSON=$(curl -s --fail \
    --cacert "$SA_CA_PATH" \
    -H "Authorization: Bearer $(get_k8s_token)" \
    "${K8S_API}/api/v1/namespaces/${GATE_POD_NAMESPACE}/pods/${GATE_POD_NAME}" 2>/dev/null) || return 1

  # Check that all non-sidecar containers are ready (excludes gate-sidecar to avoid deadlock)
  READY=$(echo "$POD_JSON" | jq '[.status.containerStatuses[]? | select(.name != "gate-sidecar") | .ready] | all' 2>/dev/null)
  [ "$READY" = "true" ]
}

# --- Helper: register with gate ---
register_with_gate() {
  BODY=$(jq -n --arg d "$GATE_DEPLOYMENT_ID" --arg s "$GATE_SERVICE_ID" --arg g "$GATE_GROUP" \
    --arg p "$GATE_POD_NAME" --arg ns "$GATE_POD_NAMESPACE" \
    '{deployment_id: $d, service_id: $s, pod_name: $p, namespace: $ns, group: $g}')

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${GATE_URL}/register" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>/dev/null) || return 1

  if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    log "Successfully registered with gate"
    return 0
  else
    log_error "Failed to register with gate, HTTP status: ${HTTP_CODE}"
    return 1
  fi
}

# --- Register with gate on startup ---
# The sidecar is the sole registrar (webhook only injects the sidecar).
# Retry registration until it succeeds — the gate may not be reachable immediately.
REGISTERED=false
for i in 1 2 3 4 5; do
  if register_with_gate; then
    REGISTERED=true
    break
  fi
  log "Registration attempt $i failed, retrying in ${GATE_POLL_INTERVAL}s..."
  sleep "$GATE_POLL_INTERVAL"
done

if [ "$REGISTERED" = "false" ]; then
  log "Initial registration failed after 5 attempts, will retry via fallback in main loop"
fi

# --- Helper: post ready status to gate ---
post_ready() {
  BODY=$(jq -n --arg d "$GATE_DEPLOYMENT_ID" --arg s "$GATE_SERVICE_ID" \
    --arg p "$GATE_POD_NAME" --arg ns "$GATE_POD_NAMESPACE" \
    '{deployment_id: $d, service_id: $s, pod_name: $p, namespace: $ns}')

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${GATE_URL}/ready" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>/dev/null) || return 1

  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

  if [ -z "$RESPONSE_BODY" ]; then
    return 1
  fi

  if [ "$HTTP_CODE" -ge 500 ]; then
    log_error "Gate returned server error, HTTP status: ${HTTP_CODE}"
    return 1
  fi

  echo "$RESPONSE_BODY"
}

# --- Helper: patch readiness gate on the pod ---
patch_readiness_gate() {
  TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  PATCH_BODY="{\"status\":{\"conditions\":[{\"type\":\"qovery-deploy-gate.life.li/synced\",\"status\":\"True\",\"lastTransitionTime\":\"${TIMESTAMP}\"}]}}"

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --cacert "$SA_CA_PATH" \
    -H "Authorization: Bearer $(get_k8s_token)" \
    -H "Content-Type: application/strategic-merge-patch+json" \
    -X PATCH \
    "${K8S_API}/api/v1/namespaces/${GATE_POD_NAMESPACE}/pods/${GATE_POD_NAME}/status" \
    -d "$PATCH_BODY" 2>/dev/null) || return 1

  if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    return 0
  else
    log_error "Failed to patch readiness gate, HTTP status: ${HTTP_CODE}"
    return 1
  fi
}

# --- Main loop ---
while true; do
  # Step 1: Check if app containers are ready
  if ! check_containers_ready; then
    log "App not ready yet, waiting..."
    sleep "$GATE_POLL_INTERVAL" &
    wait $!
    continue
  fi

  # Step 2: Report readiness to gate API
  if ! GATE_RESPONSE=$(post_ready) || [ -z "$GATE_RESPONSE" ]; then
    log_error "Gate unreachable at ${GATE_URL}, retrying..."
    sleep "$GATE_POLL_INTERVAL" &
    wait $!
    continue
  fi

  GATE_STATUS=$(echo "$GATE_RESPONSE" | jq -r '.gate_status // empty' 2>/dev/null)
  if [ -z "$GATE_STATUS" ]; then
    ERROR_MSG=$(echo "$GATE_RESPONSE" | jq -r '.error // "Unknown error"' 2>/dev/null)
    log_error "Gate returned error: ${ERROR_MSG}"
    sleep "$GATE_POLL_INTERVAL" &
    wait $!
    continue
  fi

  # If gate reports error (e.g. unknown deployment), try fallback registration
  if [ "$GATE_STATUS" = "error" ]; then
    REASON=$(echo "$GATE_RESPONSE" | jq -r '.reason // ""' 2>/dev/null)
    case "$REASON" in
      *"Unknown deployment"*|*"not registered"*)
        log "Service not registered, attempting fallback registration..."
        register_with_gate
        sleep "$GATE_POLL_INTERVAL" &
        wait $!
        continue
        ;;
    esac
  fi

  case "$GATE_STATUS" in
    open)
      log "Gate is OPEN, patching readiness gate on pod..."
      if patch_readiness_gate; then
        log "Gate opened, readiness gate patched successfully."
        break
      else
        log_error "Failed to patch readiness gate, retrying..."
      fi
      ;;
    waiting)
      PENDING=$(echo "$GATE_RESPONSE" | jq -r '.pending_pods // [] | join(", ")' 2>/dev/null)
      MISSING=$(echo "$GATE_RESPONSE" | jq -r '.missing_services // [] | join(", ")' 2>/dev/null)
      READY_COUNT=$(echo "$GATE_RESPONSE" | jq -r '.group_services_ready // "?"' 2>/dev/null)
      TOTAL_COUNT=$(echo "$GATE_RESPONSE" | jq -r '.group_services_total // "?"' 2>/dev/null)
      MSG="Gate is WAITING (${READY_COUNT}/${TOTAL_COUNT} ready)."
      [ -n "$PENDING" ] && MSG="$MSG Pending pods: ${PENDING}"
      [ -n "$MISSING" ] && MSG="$MSG Missing services: ${MISSING}"
      log "$MSG"
      ;;
    error)
      REASON=$(echo "$GATE_RESPONSE" | jq -r '.reason // "Unknown error"' 2>/dev/null)
      log_error "Gate returned error: ${REASON}"
      ;;
    *)
      log_error "Unexpected gate_status: ${GATE_STATUS}"
      ;;
  esac

  sleep "$GATE_POLL_INTERVAL" &
  wait $!
done

# --- Idle loop: keep container alive ---
log "Entering idle state. Container will stay alive until terminated."
while true; do
  sleep 3600 &
  wait $!
done
