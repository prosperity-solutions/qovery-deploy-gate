# Webhook

A Kubernetes mutating admission webhook that intercepts pod creation and injects the gate sidecar into pods labeled with a sync group.

## How It Works

1. Kubernetes sends a pod admission review to the webhook on `CREATE`
2. The webhook checks for the `qovery-deploy-gate.life.li/group` label
3. If present (and required Qovery labels exist), it mutates the pod:
   - Injects the sidecar container
   - Adds a `readinessGates` entry for `qovery-deploy-gate.life.li/synced`
   - Fire-and-forget registers the service with the gate API
4. Returns a JSON Patch (RFC 6902) response to the API server

Pods without the group label or missing Qovery identity labels (`qovery.com/deployment-id`, `qovery.com/service-id`) pass through unmodified.

## Tech Stack

- **Runtime**: Node.js 22 (Alpine)
- **Framework**: Fastify (HTTPS)
- **Language**: TypeScript
- **TLS**: cert-manager managed certificates

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TLS_CERT_PATH` | `/certs/tls.crt` | Path to TLS certificate |
| `TLS_KEY_PATH` | `/certs/tls.key` | Path to TLS private key |
| `GATE_URL` | `http://qovery-deploy-gate.qovery-deploy-gate.svc:8080` | Gate API URL |
| `SIDECAR_IMAGE` | `ghcr.io/.../sidecar:latest` | Sidecar container image |
| `POLL_INTERVAL` | `5` | Sidecar poll interval in seconds |
| `PORT` | `8443` | HTTPS listen port |

## Security

- Injected sidecar containers run with a hardened security context (non-root, read-only filesystem, no privilege escalation, all capabilities dropped)
- Dry-run admission requests are handled correctly (no side effects)
- Webhook `failurePolicy` is configurable (`Fail` = fail-closed, `Ignore` = fail-open)

## Development

```bash
npm install
npm run dev    # requires TLS certs at default paths
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot-reload (tsx) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled output |
| `npm run lint` | ESLint check |
| `npm test` | Run tests with Vitest (7 tests) |
