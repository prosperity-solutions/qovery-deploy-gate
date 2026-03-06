# qovery-deploy-gate

Zero-config synchronized traffic cutover for multi-service deployments on Qovery.

## The Problem

When tightly coupled services deploy simultaneously on Qovery, each service passes its readiness probe independently. This creates a **version skew window** where some services run v2 while others still run v1 — causing broken requests, silent data corruption, and user-facing errors.

**qovery-deploy-gate** holds new pods from becoming ready until every service in a sync group is ready, then opens them all at once. Traffic switches to all new versions simultaneously. The version skew window shrinks from minutes to milliseconds.

Since Qovery uses a blue-green rolling update strategy (`maxSurge=100%`, `maxUnavailable=0%`), old pods keep serving throughout. If the gate never opens, old pods serve indefinitely and Qovery eventually rolls back — zero downtime even during failures.

## How It Works

```
1. Deploy the Helm chart as a service in your Qovery environment
2. Label services in the Qovery console: qovery-deploy-gate.life.li/group = <group-name>
3. Deploy normally via Qovery — the gate handles the rest
```

A **mutating webhook** intercepts pod creation, checks for the `qovery-deploy-gate.life.li/group` label, and auto-injects a **sidecar** + readiness gate. The sidecar polls the **gate API**, which holds all services until every group member is ready and a settle time has passed. Then all pods become ready simultaneously.

No changes to application images, Dockerfiles, env vars, or readiness probes. Configuration is done entirely through the Qovery console via labels.

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────┐
│  K8s API Server  │     │  Gate API + UI   │     │ Postgres │
│                  │     │                  │     │          │
│  Pod CREATE ─────┼────►│  POST /register  │◄────┤          │
│  ↓               │     │  POST /ready     │────►│          │
│  Webhook injects │     │  GET  /status    │     │          │
│  sidecar         │     │  GET  /ui        │     │          │
└──────────────────┘     └──────────────────┘     └──────────┘
        │
        ▼
  ┌──────────────────────────────────────┐
  │  Pod                                 │
  │  ┌───────────┐ ┌───────────┐         │
  │  │ App       │ │ Sidecar   │         │
  │  │ container │ │ (injected)│         │
  │  │           │ │           │         │
  │  │ Readiness │ │ Watches   │         │
  │  │ probe     │ │ → polls   │         │
  │  │           │ │ → patches │         │
  │  └───────────┘ └───────────┘         │
  │  readinessGates:                     │
  │    qovery-deploy-gate.life.li/synced │
  └──────────────────────────────────────┘
```

## Components

| Component | Image | Description |
|-----------|-------|-------------|
| Gate | `ghcr.io/prosperity-solutions/qovery-deploy-gate/gate` | API server + web dashboard |
| Webhook | `ghcr.io/prosperity-solutions/qovery-deploy-gate/webhook` | Mutating admission webhook |
| Sidecar | `ghcr.io/prosperity-solutions/qovery-deploy-gate/sidecar` | Readiness gate coordinator (~8MB) |

## Quick Start

### 1. Deploy the Helm chart on your Qovery cluster

Add qovery-deploy-gate as a Helm service in your Qovery environment:

1. In the Qovery console, go to your environment and click **Add Service > Helm**.
2. Select **Helm Repository** as the source.
3. Configure the chart:
   - **Repository**: Add `ghcr.io/prosperity-solutions/qovery-deploy-gate` as a Helm repository in **Organization Settings > Helm Repositories** (type: OCI, public).
   - **Chart name**: `chart`
   - **Version**: `1.0.0` (or `latest`)
4. No values override needed for defaults. Optionally customize via raw YAML or `--set` arguments (see [Configuration](#configuration)).
5. Click **Create** and deploy.

> **Alternative**: You can also install via the [Qovery Terraform provider](https://registry.terraform.io/providers/Qovery/qovery/latest/docs) or the [Qovery API](https://api-doc.qovery.com/).

### 2. Create label groups in the Qovery console

Go to **Organization Settings > Labels & Annotations > Add Label Group**:

| Label Group Name | Label Key | Label Value |
|-----------------|-----------|-------------|
| deploy-gate-backend | `qovery-deploy-gate.life.li/group` | `backend` |
| deploy-gate-frontend | `qovery-deploy-gate.life.li/group` | `frontend` |

### 3. Assign label groups to Qovery services

In the Qovery console, open each service that should be gated and assign the corresponding label group.

### 4. Deploy via Qovery

That's it. Deploy your environment as usual through the Qovery console, API, or Terraform. The webhook detects labels, injects sidecars, and the gate coordinates readiness automatically.

## Sync Groups

Services with the same `qovery-deploy-gate.life.li/group` label value form a sync group. The gate holds all services in a group until every member is ready.

```
Full deploy:    Qovery deploys [API, Worker, Frontend]
                webhook sees [API, Worker] in group "backend"
                → waits for both before opening

Partial deploy: Qovery deploys only [API]
                webhook sees [API] in group "backend"
                → opens when API is ready
                Worker not deploying → old pods keep serving
```

Groups are independent — the backend group can open before the frontend group.

## Identity Model

All identity is derived from Qovery's own pod labels — no user-managed identifiers needed:

| Label | Source | Purpose |
|-------|--------|---------|
| `qovery.com/deployment-id` | Qovery (automatic) | Deployment run identity — shared across all pods in the same Qovery deployment |
| `qovery.com/service-id` | Qovery (automatic) | Service identity — unique per Qovery service |
| `qovery-deploy-gate.life.li/group` | User (Qovery console) | Sync group membership |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/register` | POST | Register a service (called by webhook) |
| `/ready` | POST | Report readiness + check gate (called by sidecar) |
| `/status` | GET | Deployment status (JSON) |
| `/healthz` | GET | Liveness probe |
| `/ui` | GET | Web dashboard |

## Configuration

### Helm values

```yaml
gate:
  replicas: 2
  minSettleTime: 30        # seconds to wait after first registration
  database:
    external: false        # use built-in Postgres
    url: ""                # connection string if external

webhook:
  replicas: 2
  failurePolicy: Fail      # Fail = reject pod if webhook unreachable (fail-closed, recommended)
                           # Ignore = allow pod without sidecar injection (fail-open)

sidecar:
  pollInterval: 5          # seconds between gate checks
```

See [`chart/values.yaml`](chart/values.yaml) for all options.

## Failure Modes

Every failure is **fail-closed** — Qovery's existing rollback mechanisms handle recovery:

| Failure | Result |
|---------|--------|
| Gate down | Sidecar can't reach gate → old pods keep serving |
| Webhook down | Pod creation rejected → Qovery deployment stalls |
| Service never boots | Group never completes → old pods keep serving, Qovery rolls back |
| Gate replica restarts | Stateless, reconnects to Postgres → no impact |

## Worth Mentioning

### Service Account Token Mounting

The gate-sidecar needs access to the Kubernetes API to patch pod readiness conditions. Some platforms (including Qovery) disable `automountServiceAccountToken` on pods by default. When the webhook detects this, it patches the field to `true` so the service account token gets mounted.

This is a **pod-level** setting — all containers in the pod (including your application) will have access to the token. The token is scoped to the pod's service account, and the RBAC rules only grant `pods/get` and `pods/status/patch`, so the blast radius is minimal.

If this is a concern for your security posture, a future improvement could inject a [projected volume](https://kubernetes.io/docs/concepts/storage/projected-volumes/) that mounts the token only into the `gate-sidecar` container instead of enabling it pod-wide.

## Development

```bash
# Gate
cd gate && npm install && npx prisma generate
npm run dev    # requires DATABASE_URL

# Webhook
cd webhook && npm install
npm run dev    # requires TLS certs

# Tests
cd gate && npm test
cd webhook && npm test
```

## Tech Stack

| Component | Choice |
|-----------|--------|
| Gate / Webhook | Node.js, TypeScript, Fastify |
| Sidecar | Alpine, curl, jq, shell |
| Database | PostgreSQL via Prisma |
| TLS | cert-manager |
| Packaging | Helm |
| CI/CD | GitHub Actions |
| Registry | ghcr.io |

## License

See [LICENSE](LICENSE).
