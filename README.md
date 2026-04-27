# qovery-deploy-gate

Zero-config synchronized traffic cutover for multi-service deployments on Qovery.

## The Problem

When tightly coupled services deploy simultaneously on Qovery, each service passes its readiness probe independently. This creates a **version skew window** where some services run v2 while others still run v1 — causing broken requests, silent data corruption, and user-facing errors.

**qovery-deploy-gate** holds new pods from becoming ready until every service in a sync group is ready, then opens them all at once. Traffic switches to all new versions simultaneously. The version skew window shrinks from minutes to milliseconds.

When combined with a blue/green-style rollout strategy (`maxSurge=100%`, `maxUnavailable=0%`), old pods keep serving throughout. If the gate never opens, old pods serve indefinitely and Qovery eventually rolls back — zero downtime even during failures. See [Deployment strategies](#deployment-strategies) for how the gate behaves with different rollout configurations.

## How It Works

```
1. Deploy the Helm chart as a service in your Qovery environment
2. Label services in the Qovery console: qovery-deploy-gate.life.li/group = <group-name>
3. Deploy normally via Qovery — the gate handles the rest
```

A **mutating webhook** intercepts pod creation, checks for the `qovery-deploy-gate.life.li/group` label, auto-injects a **sidecar** + readiness gate, and pre-registers the service with the **gate API** (`POST /expect`). This happens at Kubernetes admission time — before nodes are even provisioned — so the gate immediately knows which services to expect. When pods start, each **sidecar** registers its pod (`POST /register`) and polls for readiness (`POST /ready`). The gate holds all services until every expected group member has registered, all pods are ready, and a settle time has passed. Then all pods become ready simultaneously.

No changes to application images, Dockerfiles, env vars, or readiness probes. Configuration is done entirely through the Qovery console via labels.

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────┐
│  K8s API Server  │     │  Gate API + UI   │     │ Postgres │
│                  │     │                  │     │          │
│  Pod CREATE ─────┼──┐  │  POST /expect    │◄────┤          │
│  ↓               │  │  │  POST /register  │────►│          │
│  Webhook injects │  └─►│  POST /ready     │     │          │
│  sidecar +       │     │  GET  /status    │     │          │
│  calls /expect   │     │  GET  /ui        │     │          │
└──────────────────┘     └──────────────────┘     └──────────┘
        │
        ▼
  ┌──────────────────────────────────────┐
  │  Pod                                 │
  │  ┌───────────┐ ┌───────────┐         │
  │  │ App       │ │ Sidecar   │         │
  │  │ container │ │ (injected)│         │
  │  │           │ │           │         │
  │  │ Readiness │ │ /register │         │
  │  │ probe     │ │ → /ready  │         │
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

## Where It Fits in Qovery's Pipeline

> **Note:** Synchronized multi-service readiness is an unsolved problem across the Kubernetes ecosystem, not specific to Qovery. Argo Rollouts, Flagger, and service meshes handle progressive delivery for individual services but none coordinate readiness across multiple services. The common workarounds are backward-compatible APIs, feature flags, or accepting the skew window. Everyone builds something custom. This project provides a generic, infrastructure-level solution for Qovery environments.

Qovery's deployment pipeline stages control **what is built and started together** — but not what becomes **ready** together. When you deploy an environment, Qovery orchestrates the rollout: building images, provisioning nodes, and starting pods. Each service independently passes its readiness probe and starts receiving traffic as soon as it's healthy.

The deploy gate fills the gap between deployment *start* and deployment *finish*. Qovery ensures your services deploy together. The gate ensures they go live together.

```
Without the gate:
  API pod ready    ──────► traffic switches to API v2
  Worker pod ready ────────────► traffic switches to Worker v2
                         ↑
                   version skew window (API v2 talks to Worker v1)

With the gate:
  API pod ready    ──┐
  Worker pod ready ──┤
                     └──► gate opens ──► both switch simultaneously
```

### Deployment strategies

We strongly recommend a **blue/green-style rolling update strategy** (`maxSurge=100%`, `maxUnavailable=0%`) for all gated services. This is not Qovery's default — you need to configure it via Qovery's [advanced settings](https://hub.qovery.com/docs/using-qovery/configuration/advanced-settings/).

**Blue/green** (`maxSurge=100%`, `maxUnavailable=0%`) gives you the strongest guarantees. Kubernetes creates all new pods upfront while old pods keep serving. The gate holds every new pod until all group members are ready, then opens them all at once — an atomic traffic cutover with zero downtime and zero version skew. If the gate never opens, old pods serve indefinitely and Qovery eventually rolls back.

**Progressive rolling** (`maxSurge=25%`, `maxUnavailable=25%` — Qovery's default) works but provides weaker guarantees. Kubernetes creates the first batch of new pods (25%). The gate holds them until all expected services have at least one ready pod, then opens the batch. Once the group completes, subsequent waves of pods open immediately (via the completed group shortcut). This means the first batch of v2 pods across all services goes live simultaneously, but the remaining pods roll out progressively — resulting in a period where both v1 and v2 pods serve traffic side by side within each service. The gate prevents the worst case (service A fully on v2 while service B is still on v1) but doesn't give you the clean atomic cutover that blue/green provides.

**Recreate** kills all old pods before starting new ones, so there is inherent downtime during every deployment. The gate can still coordinate readiness across services — ensuring that traffic resumes only when *all* services are up — but the primary value proposition (zero-downtime cutover) does not apply. If you need all services to come back online together after a recreate (e.g., to avoid partial availability), the gate can help with that.

## Quick Start

### 1. Deploy the Helm chart on your Qovery cluster

The gate operates at the Kubernetes cluster level — install it **once per cluster** where you need synchronized deployments. If you run multiple Qovery clusters (e.g., staging and production), install it on each cluster independently.

Add qovery-deploy-gate as a Helm service in your Qovery environment:

1. In the Qovery console, go to your environment and click **Add Service > Helm**.
2. Select **Helm Repository** as the source.
3. Configure the chart:
   - **Repository**: Add `ghcr.io/prosperity-solutions/qovery-deploy-gate` as a Helm repository in **Organization Settings > Helm Repositories** (type: OCI, public).
   - **Chart name**: `chart`
   - **Version**: Use the latest version from the [releases page](https://github.com/prosperity-solutions/qovery-deploy-gate/releases)
4. Enable **"Allow cluster-wide resources"** on the Helm service. The chart deploys ClusterRoles, ClusterRoleBindings, and a MutatingWebhookConfiguration that operate across namespaces — these require cluster-scoped permissions.
5. No values override needed for defaults. Optionally customize via raw YAML or `--set` arguments (see [Configuration](#configuration)).
6. Click **Create** and deploy.

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
                webhook pre-registers [API, Worker] as expected in group "backend"
                sidecars register pods → gate waits for both before opening

Partial deploy: Qovery deploys only [API]
                webhook pre-registers [API] as expected in group "backend"
                → gate opens when API pod is ready
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
| `/expect` | POST | Declare an expected service (called by webhook at admission time) |
| `/register` | POST | Register a pod (called by sidecar on startup) |
| `/ready` | POST | Report readiness + check gate (called by sidecar) |
| `/status` | GET | Deployment status (JSON) |
| `/healthz` | GET | Liveness probe |
| `/readyz` | GET | Readiness probe (verifies DB connectivity) |
| `/ui` | GET | Web dashboard |

## Configuration

### Helm values

```yaml
gate:
  replicas: 2
  minSettleTime: 30        # seconds to wait after last pod registration
  staleTimeout: 300        # seconds since last /ready ping before expiring (default 5m)
  podStaleTimeout: 90      # seconds since a pod's last heartbeat before a never-ready pod is treated as terminated (default 90s)
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
| Deployment cancelled | Sidecars stop polling → deployment expires after stale timeout → old pods keep serving |
| Gate replica restarts | Stateless, reconnects to Postgres → no impact |

## Worth Mentioning

### Stale Deployment Expiration

Deployments track a `lastPingedAt` timestamp, updated on every `/ready` call from a sidecar. If no sidecar has polled for longer than `staleTimeout` (default 5 minutes), the deployment is lazily marked as EXPIRED and the gate opens — letting any remaining sidecars proceed.

This handles cancelled or failed deployments without a background timer. Expiration is checked on `/ready` calls and `/status` queries (the UI polls every 5 seconds), so stale deployments are cleaned up promptly.

### Pod-Level Heartbeat

Each registered pod also tracks a `lastPingedAt` timestamp, refreshed on every `/register` and `/ready` call. While the app containers are still starting, the sidecar heartbeats by re-calling `/register` (idempotent) on every poll iteration; once the app is ready, `/ready` calls keep the heartbeat fresh.

If a pod registers but is then terminated before ever becoming ready — e.g. HPA scale-down mid-rollout, eviction, or node failure — its sidecar stops heartbeating. After `podStaleTimeout` (default 90s), the gate evaluator treats the pod as gone and excludes it from the group's pending-pod set. Without this, a single ghost pod would block the gate forever. Pods that have already reported ready are not affected by stale exclusion.

### Service Account Token Mounting

The gate-sidecar needs access to the Kubernetes API to read its own pod status and patch the readiness gate condition. Rather than enabling `automountServiceAccountToken` pod-wide (which would expose the token to all containers), the webhook injects a [projected volume](https://kubernetes.io/docs/concepts/storage/projected-volumes/) that mounts the service account token and CA certificate **only into the gate-sidecar container**. Your application containers are not affected, even on platforms like Qovery that disable token mounting by default.

## Why Sidecars Instead of a Central Pod Watcher?

A natural question is: if the gate runs inside the cluster, why not have it watch pods directly via the Kubernetes API and skip the sidecar entirely?

The sidecar approach is a deliberate design choice. It inverts responsibility: instead of the gate needing to discover, track, and never miss a pod, **each pod is responsible for proving itself to the gate**. The gate just sits there and evaluates what it's been told.

### Failure defaults to safety

If the sidecar can't reach the gate, the readiness gate stays unpatched and the pod stays not-ready. Traffic never flows to a pod that hasn't been coordinated. A central watcher would need to explicitly handle every failure mode (missed watch events, gate restarts, API server outages) to avoid accidentally letting a pod through.

### The gate stays stateless

The gate is a simple HTTP server backed by Postgres. No Kubernetes watch connections, no `resourceVersion` tracking, no informer caches, no leader election. A gate replica can restart and the next sidecar poll (within 5 seconds) picks up right where it left off. Making the gate watch pods would turn it into a stateful Kubernetes controller — a fundamentally harder system to build, operate, and debug.

### Distributed fault isolation

Each sidecar manages exactly one pod's lifecycle. A bug or network issue affecting one sidecar cannot impact another pod. A central watcher concentrates all responsibility into a single component where one bug can stall an entire deployment.

### Autoscaling and horizontal scaling are trivial

Sidecars don't need to distinguish between "new deployment pod" and "autoscaling pod." They register, the gate checks if the group already completed, and responds accordingly. A central watcher would need to discover new pods, correlate them with deployments, and decide whether they're part of a rollout or autoscaling — all in real time without missing events.

### Belt-and-suspenders registration

The webhook's `/expect` call is fire-and-forget. If it fails, the sidecar's `/register` call serves as a fallback, ensuring the gate always learns about every service. A central watcher would lose this fallback path — if `/expect` fails and no sidecar registers, the gate would never learn about the service and could open the group prematurely, causing the exact version skew the system exists to prevent.

### Minimal RBAC footprint

The gate's service account has zero Kubernetes API permissions. Each sidecar uses the pod's own service account to read and patch only its own pod. A central watcher would need cluster-wide `pods/list`, `pods/watch`, and `pods/status/patch` — making the gate a high-value target if compromised.

### Self-throttling load

Sidecars poll at a fixed 5-second interval, creating predictable, bounded load proportional to the number of actively deploying pods. Outside of deployments, the load is zero. A watch-based approach receives events for every pod status change, with unpredictable bursts during node scaling or large rollouts.

In short: the sidecar is not a workaround for the gate being outside the cluster. It's a design feature that keeps the gate simple, makes failures safe, and distributes responsibility where it belongs.

## Why the Webhook and Gate Are Separate Services

The webhook and gate could be a single service — they both run in-cluster, and the webhook already calls the gate's `/expect` endpoint. Merging them would mean one fewer deployment, service, and TLS certificate to manage.

They are separate for **failure isolation**. Kubernetes admission webhooks are synchronous — the API server blocks pod creation until the webhook responds. If the webhook and gate shared a process, a Postgres outage or gate bug could cause the webhook to hang or crash, blocking **all pod creation** cluster-wide (with `failurePolicy: Fail`).

By keeping them separate:
- **Webhook down** → pod creation is blocked, but only because the admission webhook is unreachable. Qovery's deployment stalls cleanly.
- **Gate down** → pods are created and sidecars are injected normally. Sidecars just can't reach the gate yet and retry every 5 seconds. Old pods keep serving.
- **Postgres down** → only the gate is affected. The webhook continues injecting sidecars without issue because it doesn't need the database — it fire-and-forgets `/expect` and moves on.

This separation ensures that a coordination-layer problem (the gate) never escalates into a platform-level problem (pod creation failing).

## Edge Cases

### Redeployment with unchanged images

When you redeploy an environment via Qovery without code changes, Kubernetes does not create new pods — the Deployment spec is identical, so no rollout occurs. No new pods means no sidecars are injected and the gate is never involved. This is the correct behavior: there is no version skew risk when nothing changed.

### Multi-replica services

If a service has multiple replicas (e.g., 3 pods), each pod registers individually. The gate waits for **all pods** in the group to be ready — not just one per service. This ensures the entire replica set is healthy before traffic switches.

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
