# Sidecar

A lightweight shell-based init container injected into application pods by the webhook. It coordinates with the gate API to synchronize readiness across services.

## How It Works

1. Waits for the pod's application containers to become ready (via Kubernetes API)
2. Reports readiness to the gate API (`POST /ready`)
3. Polls until the gate responds with `open` status
4. Patches the pod's readiness gate condition (`qovery-deploy-gate.life.li/synced = True`)
5. Enters idle state until the pod is terminated

## Image

- **Base**: Alpine 3.21 (~8MB total)
- **Dependencies**: `curl`, `jq`
- **Runs as**: non-root (UID 65534 / nobody)

## Environment Variables

All injected automatically by the webhook:

| Variable | Description |
|----------|-------------|
| `GATE_URL` | Gate API base URL |
| `GATE_DEPLOYMENT_ID` | Qovery deployment ID (from pod label) |
| `GATE_SERVICE_ID` | Qovery service ID (from pod label) |
| `GATE_GROUP` | Sync group name (from pod label) |
| `GATE_POD_NAME` | Pod name (from downward API) |
| `GATE_POD_NAMESPACE` | Pod namespace (from downward API) |
| `GATE_POLL_INTERVAL` | Seconds between gate checks (default: 5) |

## Resilience

- **Fallback registration**: If the webhook's fire-and-forget registration failed, the sidecar detects "Unknown deployment" errors and re-registers with the gate
- **Graceful shutdown**: Handles SIGTERM/SIGINT
- **Safe JSON construction**: Uses `jq -n` to prevent shell injection
- **Numeric validation**: Validates `GATE_POLL_INTERVAL` is a positive integer

## Development

The sidecar is a single shell script (`gate-check.sh`). To test locally:

```bash
docker build -t sidecar .
docker run -e GATE_URL=http://localhost:8080 \
  -e GATE_DEPLOYMENT_ID=test -e GATE_SERVICE_ID=test \
  -e GATE_POD_NAME=test -e GATE_POD_NAMESPACE=default \
  sidecar
```
