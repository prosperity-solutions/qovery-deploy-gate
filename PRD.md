# deploy-gate — PRD

> **Zero-config synchronized traffic cutover for multi-service deployments on Qovery/Kubernetes**

---

## Problem

### Version Skew During Deployment

When multiple tightly coupled services are deployed simultaneously on Kubernetes, each service independently passes its readiness probe and starts receiving traffic the moment Kubernetes considers it ready. Services cut over to new versions at different times, creating a **version skew window** where some services run v2 while others still run v1.

For services that share API contracts, database schemas, or message formats, this window causes:

- **Broken requests**: API v2 sends a field that Worker v1 doesn't understand.
- **Silent data corruption**: Worker v1 writes data in the old format while API v2 reads it expecting the new format.
- **User-facing errors**: Frontend v1 calls an API endpoint that was renamed in v2.

The window is typically 10–60 seconds, depending on boot times. In a microservices architecture with 5–10 coupled services, the probability of at least one cross-version call during this window approaches certainty.

### Why There Is No Existing Solution

**Kubernetes treats each Deployment as independent.** There is no native mechanism to say "these 3 Deployments should become ready at the same time." Every tool in the ecosystem — Argo Rollouts, Flagger, Grafana rollout-operator, Istio, Linkerd — operates on individual Deployments. None of them coordinate readiness *across* Deployments.

### Why Blue-Green Rolling Updates Make This Worse

Qovery uses a blue-green style rolling update strategy: `maxSurge=100%`, `maxUnavailable=0%`. This means:

- Old pods (v1) keep running and serving traffic throughout the deployment.
- New pods (v2) are created alongside them.
- As each new pod passes its readiness probe, Kubernetes adds it to the Service and starts routing traffic to it.
- Old pods are terminated only after new pods are ready.

This is excellent for zero-downtime deploys of individual services. But for grouped services, it creates the version skew problem:

```
Timeline without deploy-gate:
─────────────────────────────────────────────────────────
  t0: Deployment starts. Old pods (v1) serving all traffic.
      New pods for API, Worker, Frontend booting in parallel.

  t1: API v2 passes readiness probe → starts receiving traffic.
      Worker still booting (v1 Worker still serving).
      ⚠️ API v2 talking to Worker v1 — version skew!

  t2: Worker v2 passes readiness probe → starts receiving traffic.
      ⚠️ Frontend v1 calling API v2 — possible contract mismatch!

  t3: Frontend v2 passes readiness. All on v2 now.

  The window between t1 and t3 is the danger zone.
  With deploy-gate, ALL grouped services become ready at t3.
```

### The Key Insight

With `maxUnavailable=0%`, old pods stay alive and healthy throughout the entire deployment. If a new pod **never** passes readiness — because something holds it — old pods keep serving indefinitely. There is no downtime.

deploy-gate exploits this: it holds new pods from becoming ready until every service in the group is ready to go. Then all pass readiness simultaneously. Traffic switches to all new versions at once. The version skew window shrinks from minutes to milliseconds.

If a service fails to boot entirely, the gate never opens, old pods keep serving, and Qovery eventually rolls back. **Zero downtime throughout — even during failures.**

---

## Solution

A Helm-installable deployment gate that coordinates readiness across services using **sync groups** defined by Qovery labels. A **mutating webhook** auto-injects a **sidecar** into pods that need gating — zero changes to application images, Dockerfiles, or readiness probes.

**Project name**: `deploy-gate`

### How It Works (30-Second Version)

1. Install the Helm chart once per cluster.
2. In the Qovery UI, assign a label `qovery-deploy-gate.life.li/group = <group-name>` to services that must deploy together.
3. When Kubernetes creates a pod, the **webhook** checks: does this pod have a `qovery-deploy-gate.life.li/group` label? If yes → inject a sidecar. If no → pass through untouched.
4. The webhook also tells the gate: "service X with deployment-id Y just joined group Z."
5. The **sidecar** watches the pod's `ContainersReady` condition (set by Kubernetes when the app's own readiness probe passes), then asks the gate: "can I go?"
6. The gate holds all services in a group until every member with the same deployment-id has registered AND a minimum settle time has passed, then opens.
7. Kubernetes sees all grouped pods become ready at ~the same time → traffic switches together.

### Design Principles

- **Zero-config**: `helm install` + assign labels in Qovery UI. No env vars, no secrets, no TOML, no config files.
- **Fail-closed**: Every failure mode blocks deployment. Old pods keep serving.
- **Zero-touch on app images**: No Dockerfile changes, no scripts, no curl to install.
- **Label-driven**: Group membership is a property of the service, managed in the Qovery UI.
- **No external API calls**: The gate discovers everything from pod labels and webhook observations.
- **Helm-native**: One `helm install` is the only infrastructure step.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                        Qovery                             │
│                                                          │
│  Cluster: deploy-gate installed via Helm                 │
│                                                          │
│  Services carry Qovery labels:                           │
│     qovery.com/service-id     (auto, on every pod)       │
│     qovery.com/deployment-id  (auto, on every pod)       │
│     qovery-deploy-gate.life.li/group      (user-assigned via UI)     │
│                                                          │
│  Qovery triggers deployment → pods created               │
│     → Webhook intercepts → injects sidecar               │
│     → Webhook registers service with gate                │
└──────────────────────────────────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
  ┌──────────────┐     ┌──────────────┐      ┌──────────────┐
  │ K8s API Server│     │  deploy-gate │      │  Postgres    │
  │              │     │  API + UI    │      │              │
  │  "create pod"│     │              │      │              │
  │       │      │     │  POST /ready │◄──── Sidecars
  │       ▼      │     │  GET  /status│◄──── Debug / UI
  │   Webhook ───┼────►│  GET /healthz│      │              │
  │  (intercept) │     │              │      │              │
  └──────────────┘     └──────────────┘      └──────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────┐
  │  Pod (auto-modified by webhook)              │
  │                                              │
  │  ┌───────────────┐  ┌───────────────────┐   │
  │  │ app container  │  │ gate-sidecar      │   │
  │  │ (untouched)    │  │ (injected)        │   │
  │  │                │  │                   │   │
  │  │ /health ◄──────┼──┤ watches             │   │
  │  │                │  │ ContainersReady     │   │
  │  │                │  │ talks to gate API   │   │
  │  │ original       │  │ readiness gate    │   │
  │  │ readiness probe│  │ controls pod      │   │
  │  └───────────────┘  └───────────────────┘   │
  │                                              │
  │  readinessGates:                             │
  │    - qovery-deploy-gate.life.li/synced ◄── set by sidecar│
  └─────────────────────────────────────────────┘
```

---

## Container Registry — ghcr.io

Three pre-built images, all published to GitHub Container Registry under `ghcr.io/prosperity-solutions/qovery-deploy-gate/`:

| Image | Purpose | Base | Size |
|-------|---------|------|------|
| `ghcr.io/prosperity-solutions/qovery-deploy-gate/gate` | API server + web UI | `node:20-alpine` | ~80MB |
| `ghcr.io/prosperity-solutions/qovery-deploy-gate/webhook` | Mutating admission webhook | `node:20-alpine` | ~60MB |
| `ghcr.io/prosperity-solutions/qovery-deploy-gate/sidecar` | Readiness gate check | `alpine:3.19` + `curl` | ~8MB |

All images are versioned with semver tags (`v1.0.0`) and a `latest` tag. Multi-arch builds for `linux/amd64` and `linux/arm64`.

The Helm chart is also published as an OCI artifact to `ghcr.io/prosperity-solutions/qovery-deploy-gate/chart`.

Everything is free — GitHub Packages storage, bandwidth, and Actions minutes are all free for public repositories.

---

## CI/CD — GitHub Actions

### Repository Structure

```
deploy-gate/
├── gate/                    # API server + UI (Node.js/TypeScript)
│   ├── src/
│   ├── prisma/
│   ├── Dockerfile
│   └── package.json
├── webhook/                 # Mutating admission webhook (Node.js/TypeScript)
│   ├── src/
│   ├── Dockerfile
│   └── package.json
├── sidecar/                 # Readiness gate sidecar
│   ├── gate-check.sh
│   └── Dockerfile
├── chart/                   # Helm chart
│   ├── Chart.yaml
│   ├── values.yaml
│   └── templates/
├── .github/
│   └── workflows/
│       ├── build-images.yml # Build + push on tag
│       └── test.yml         # Lint + unit + integration
└── README.md
```

### Build & Push Workflow

Triggered on semver tags (`v*`). Builds all three images in parallel, packages and pushes Helm chart.

```yaml
# .github/workflows/build-images.yml
name: Build and Push Images

on:
  push:
    tags: ['v*']

env:
  REGISTRY: ghcr.io
  ORG: prosperity-solutions/qovery-deploy-gate

jobs:
  build:
    strategy:
      matrix:
        image: [gate, webhook, sidecar]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-qemu-action@v3

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ${{ env.REGISTRY }}/${{ env.ORG }}/${{ matrix.image }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest

      - uses: docker/build-push-action@v5
        with:
          context: ./${{ matrix.image }}
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  helm:
    runs-on: ubuntu-latest
    needs: build
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Install Helm
        uses: azure/setup-helm@v3

      - name: Login to ghcr.io
        run: echo "${{ secrets.GITHUB_TOKEN }}" | helm registry login ghcr.io -u ${{ github.actor }} --password-stdin

      - name: Package and push chart
        run: |
          helm package ./chart
          helm push deploy-gate-*.tgz oci://ghcr.io/prosperity-solutions/qovery-deploy-gate
```

### Test Workflow

Triggered on PRs and pushes to `main`.

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: deploy_gate_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: cd gate && npm ci && npm run lint && npm test
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/deploy_gate_test
      - run: cd webhook && npm ci && npm run lint && npm test
```

---

## Helm Chart

### Install

```bash
helm install deploy-gate oci://ghcr.io/prosperity-solutions/qovery-deploy-gate/chart \
  --namespace deploy-gate \
  --create-namespace
```

That's it. No secrets. No values to configure for the default case. The gate runs at `deploy-gate.deploy-gate.svc:8080` (ClusterIP, internal only).

### What the Chart Installs

| Resource | Kind | Purpose |
|----------|------|---------|
| `deploy-gate` | Deployment + Service | Gate API server + web UI |
| `deploy-gate-webhook` | Deployment + Service | Mutating admission webhook |
| `deploy-gate-db` | StatefulSet (or external) | Postgres via Bitnami subchart |
| `deploy-gate-injector` | MutatingWebhookConfiguration | Webhook registration with K8s |
| `deploy-gate-webhook-tls` | Certificate (cert-manager) | Auto-managed TLS for webhook |
| `deploy-gate-sidecar-rbac` | ClusterRole + ClusterRoleBinding | Sidecar permission to patch pod status |
| `deploy-gate-migrate` | Job (Helm pre-install hook) | Prisma schema migration |
| `deploy-gate-pdb` | PodDisruptionBudget | Webhook high availability |

### values.yaml (Key Options)

```yaml
gate:
  image:
    repository: ghcr.io/prosperity-solutions/qovery-deploy-gate/gate
    tag: latest
  replicas: 2
  minSettleTime: 30              # Seconds to wait after first registration before opening
  database:
    external: false              # Use built-in Postgres (default)
    url: ""                      # If external: full connection string

webhook:
  image:
    repository: ghcr.io/prosperity-solutions/qovery-deploy-gate/webhook
    tag: latest
  replicas: 2
  failurePolicy: Fail            # fail-closed: if webhook down, reject pod creation
  namespaceSelector:             # Only intercept pods in labeled namespaces
    matchExpressions:
      - key: qovery-deploy-gate.life.li/enabled
        operator: In
        values: ["true"]

sidecar:
  image:
    repository: ghcr.io/prosperity-solutions/qovery-deploy-gate/sidecar
    tag: latest
  pollInterval: 5                # Seconds between gate checks

postgresql:
  enabled: true                  # Bitnami subchart
  auth:
    database: deploy_gate
    username: deploy_gate

certManager:
  issuerRef:
    name: selfsigned             # cert-manager ClusterIssuer
    kind: ClusterIssuer
```

### Namespace Selector

The webhook only intercepts pods in namespaces with the label `qovery-deploy-gate.life.li/enabled=true`. This prevents the webhook from affecting `kube-system`, monitoring, cert-manager, or any namespace that isn't explicitly opted in.

```bash
kubectl label namespace my-qovery-namespace qovery-deploy-gate.life.li/enabled=true
```

---

## Core Concept: Label-Driven Sync Groups

### How Groups Are Defined

In the Qovery UI, create a **label group** with one label:

```
Key:   qovery-deploy-gate.life.li/group
Value: backend
```

Assign this label group to services that must deploy together (e.g., API + Worker). Qovery propagates the label to the pods. That's the entire configuration.

Different groups for different sets of services:

| Label Group | Label Value | Assigned To |
|-------------|------------|-------------|
| deploy-gate-backend | `qovery-deploy-gate.life.li/group = backend` | API, Worker |
| deploy-gate-frontend | `qovery-deploy-gate.life.li/group = frontend` | Web App, BFF, CDN Invalidator |

Groups are independent. The backend group can open before the frontend group.

### Constraint

A service must belong to exactly one group. If a service needs to synchronize with two different sets, those sets are not independent — merge them into one group.

### What Qovery Already Puts on Every Pod

From the pod labels (observed via k9s):

```yaml
qovery.com/service-id: "2df728a3-f54c-4e97-90b1-6f7dc1807f23"
qovery.com/deployment-id: "f299fe6c-509f-41e7-94d1-cfae9c7c1de0-1"
qovery.com/environment-id: "f299fe6c-509f-41e7-94d1-cfae9c7c1de0"
```

Combined with the user-assigned label:

```yaml
qovery-deploy-gate.life.li/group: "backend"
```

The webhook has everything: service identity, deployment identity, and group membership. No configuration needed beyond the label assignment.

### How the Gate Resolves Groups

1. **Qovery starts a deployment.** Creates Deployments for all services within seconds. Pods are created.
2. **Webhook intercepts each pod creation.** Reads labels. If `qovery-deploy-gate.life.li/group` is present → injects sidecar, registers `(deployment-id, service-id, group)` with the gate.
3. **Apps boot.** Takes 10–60+ seconds (image pull, node provisioning, application startup).
4. **Sidecars start polling.** Once `ContainersReady` is True (app's readiness probe passes), the sidecar asks the gate: "can I go?"
5. **Gate checks:** have all registered members of this group (for this deployment-id) reported ready? AND has at least `minSettleTime` passed since the first registration for this deployment-id?
6. **When both conditions are met → gate opens.** Sidecar patches the pod's readiness gate to `True`. Kubernetes sees the pod as ready. Traffic flows.

```
Qovery deploys API + Worker + Frontend:

  Webhook sees:
    deployment-id=X, service-id=abc, group=backend   ← API
    deployment-id=X, service-id=def, group=backend   ← Worker
    deployment-id=X, service-id=ghi, group=frontend  ← Frontend

  Gate builds:
    deployment X, group "backend":  [abc, def]
    deployment X, group "frontend": [ghi]

  Sidecar for API calls gate:    abc ready, but def not yet → waiting
  Sidecar for Worker calls gate:  abc+def both ready, settle time passed → OPEN
  Sidecar for API calls gate:     group already open → OPEN
  Sidecar for Frontend calls gate: ghi ready, only member, settle time passed → OPEN
```

### Partial Deployments

When only some services are deployed (e.g., just the API), only those services create new pods. The webhook only sees the API pod. The gate only knows about the API for this deployment-id. The group "backend" for this run has one member. It opens when that one member is ready.

Services not being deployed keep their old pods with old deployment-ids. They never contact the gate for the new deployment. No deadlock.

```
Full deploy:    webhook sees [API, Worker] for deployment-id=X
                backend = [API, Worker] → waits for both

Partial deploy: webhook sees [API] for deployment-id=Y
                backend = [API] → opens when API is ready
                Worker not deploying → old pods keep serving
```

### Multi-Replica Services

The gate tracks **services**, not pods. A service with 3 replicas creates 3 pods, each with the same `service-id` and `deployment-id`. The webhook's `POST /register` is idempotent per `(deployment_id, service_id)` — the first pod registers the service, subsequent pods are no-ops.

Each pod gets its own sidecar, and each sidecar independently watches its own pod's `ContainersReady`, polls the gate, and patches its own pod's readiness gate. Pods may become ready at different times — that's fine. There is no version skew between replicas of the same service (they're all the same version). The version skew problem is between *services* (API v2 talking to Worker v1), not between replicas.

```
API (3 replicas) + Worker (1 replica), group=backend:

  Gate knows: backend = [API, Worker]  (services, not pods)

  t=60s  API pod-1: ready → POST /ready → "waiting" (Worker not ready)
  t=62s  API pod-2: ready → POST /ready → "waiting"
  t=70s  Worker pod: ready → POST /ready → group complete → "open"
  t=75s  API pod-1: POST /ready → "open" → patches own pod ✓
  t=75s  API pod-2: POST /ready → "open" → patches own pod ✓
  t=80s  API pod-3: ready → POST /ready → "open" → patches own pod ✓
```

Pod-3 becomes ready 5 seconds after pods 1 and 2. All three are v2 — no skew within a service. The gate opened when both *services* were ready, which is the correct behavior.

---

## Minimum Settle Time

The gate will not open a group until `minSettleTime` seconds (default: 30) have elapsed since the first registration for that deployment-id.

### Why This Exists

Qovery creates all Deployments within seconds, and Kubernetes creates all pods nearly simultaneously. But the sidecar only contacts the gate *after* the app passes its health check. A very fast-booting service (e.g., nginx, static Go binary) could call the gate before Kubernetes has even created pods for slower services in the same group.

Without the settle time, the gate would see one service, conclude the group is complete (only one member registered), and open prematurely.

### Why 30 Seconds Costs Nothing

In practice, the settle time adds zero latency. Consider the real deployment timeline:

```
t=0s      Qovery creates all Deployments
t=1-5s    All pods created (webhook registers them with gate)
t=5-30s   Karpenter provisions new nodes (if needed)
t=30-60s  Container images pulled
t=60-90s  Apps boot, health checks pass
t=90s+    Sidecars start calling gate
```

By the time the fastest app boots and its sidecar contacts the gate, 60+ seconds have passed since the first registration. The 30s settle time was satisfied long ago. It's a safety net that never triggers under normal conditions.

### When It Does Trigger

Only when a service boots in under 30 seconds on a warm node with cached images. In that case, the gate waits an extra few seconds — still far faster than a typical deployment cycle.

---

## Identity Model

All identity is derived from Qovery's own pod labels. No user-managed identifiers.

| Label | Source | Purpose |
|-------|--------|---------|
| `qovery.com/deployment-id` | Qovery (automatic) | Run identity — shared across all pods in the same deployment |
| `qovery.com/service-id` | Qovery (automatic) | Service identity — unique per Qovery service |
| `qovery-deploy-gate.life.li/group` | User (via Qovery label group) | Group membership |

### Why deployment-id Works as a Run ID

The `deployment-id` label has the format `{environment-id}-{version}`. All pods created in the same Qovery deployment share the same `deployment-id` value. A new deployment produces a new `deployment-id`. Old pods (from previous deployments, or from autoscaling) carry their original `deployment-id` — it's immutable in the pod spec.

| Scenario | What the gate sees | Result |
|----------|-------------------|--------|
| New pod, group waiting | Known deployment-id, group incomplete | Gated ✓ |
| New pod, group complete | Known deployment-id, group open | Serves traffic ✓ |
| Old pod (previous deployment) | Different deployment-id | Not gated, normal lifecycle |
| HPA-autoscaled old pod | Same old deployment-id | Not gated, normal lifecycle |
| No `qovery-deploy-gate.life.li/group` label | Webhook skips injection | Normal pod lifecycle |

---

## Mutating Webhook

### Injection Decision

```
Pod creation request arrives at webhook:

1. Is this namespace labeled qovery-deploy-gate.life.li/enabled=true?
   → No? SKIP. Pod passes through untouched.

2. Does the pod have label qovery-deploy-gate.life.li/group?
   → No? SKIP. Pod passes through untouched.

3. Read group name, deployment-id, service-id from labels.
   → INJECT sidecar + readiness gate.
   → Register (deployment-id, service-id, group) with the gate.
```

### What the Webhook Injects

**1. Sidecar container:**

```yaml
containers:
  - name: gate-sidecar
    image: ghcr.io/prosperity-solutions/qovery-deploy-gate/sidecar:v1
    env:
      - name: GATE_URL
        value: "http://deploy-gate.deploy-gate.svc:8080"
      - name: GATE_DEPLOYMENT_ID
        value: <from pod label qovery.com/deployment-id>
      - name: GATE_SERVICE_ID
        value: <from pod label qovery.com/service-id>
      - name: GATE_GROUP
        value: <from pod label qovery-deploy-gate.life.li/group>
      - name: GATE_POD_NAME
        valueFrom:
          fieldRef:
            fieldPath: metadata.name
      - name: GATE_POD_NAMESPACE
        valueFrom:
          fieldRef:
            fieldPath: metadata.namespace
    resources:
      requests:
        cpu: 10m
        memory: 16Mi
      limits:
        cpu: 50m
        memory: 32Mi
```

**2. Readiness gate:**

```yaml
readinessGates:
  - conditionType: "qovery-deploy-gate.life.li/synced"
```

### What the Webhook Does NOT Touch

- The app container (image, command, probes, env, ports — all untouched)
- Existing readiness probes (they continue to work independently)
- Pods without `qovery-deploy-gate.life.li/group` label
- Pods in namespaces without `qovery-deploy-gate.life.li/enabled=true`

### Webhook-to-Gate Registration

When injecting a sidecar, the webhook also makes an internal call to the gate:

```
POST /register {
  deployment_id: "f299fe6c-...-1",
  service_id: "2df728a3-...",
  group: "backend"
}
```

This is how the gate learns about deploying services. The webhook sees pod creation (which happens seconds after Qovery starts the deployment) — long before any app boots and any sidecar polls. By the time the first sidecar calls the gate, the gate already has the complete picture of which services are part of this deployment.

### Failure Policy

```yaml
failurePolicy: Fail
```

If the webhook is unreachable, Kubernetes rejects pod creation. Fail-closed. The webhook runs with 2 replicas and a `PodDisruptionBudget`.

---

## Sidecar

The sidecar is a minimal container (`alpine` + `curl`, ~8MB). It runs alongside the app container.

### Behavior

```
Sidecar starts:
  │
  ├── Loop (every GATE_POLL_INTERVAL seconds):
  │     │
  │     ├── GET own pod status from K8s API
  │     │   → Is condition "ContainersReady" == True?
  │     │   → No? Sleep. (App still booting / readiness probe failing.)
  │     │
  │     ├── POST /ready to gate: { deployment_id, service_id }
  │     │   ├── "open"    → Patch pod readiness gate to True. Exit loop.
  │     │   ├── "waiting" → Continue loop. (Group not complete yet.)
  │     │   ├── 4xx error → Log error with full response. Continue loop.
  │     │   └── Unreachable → Log "gate unreachable". Continue loop.
  │     │
  │     └── Sleep GATE_POLL_INTERVAL
  │
  └── After gate opens: sidecar stays alive (required by K8s)
      but does nothing — idle, minimal resources.
```

### Why ContainersReady Instead of Custom Health Checks

Kubernetes already evaluates the app container's readiness probe (HTTP, TCP, gRPC, exec — whatever the developer configured). The result is reflected in the pod condition `ContainersReady`. The sidecar simply reads this condition instead of re-implementing health checks.

This means:

- **Zero health check configuration.** No port, no path, no probe type to specify.
- **Works with any probe type.** TCP, HTTP, gRPC, exec — the sidecar doesn't care.
- **No per-service overrides needed.** Each pod's existing readiness probe is the source of truth.
- **ContainersReady is independent of readiness gates.** `ContainersReady` reflects container readiness probes only. The readiness gate (`qovery-deploy-gate.life.li/synced`) only affects the `Ready` condition. They don't interfere — this is by design in the Kubernetes pod lifecycle spec.

### Patching the Readiness Gate

When the gate returns `open`, the sidecar patches the pod's status condition via the Kubernetes API:

```
PATCH /api/v1/namespaces/{ns}/pods/{name}/status
{
  "status": {
    "conditions": [{
      "type": "qovery-deploy-gate.life.li/synced",
      "status": "True"
    }]
  }
}
```

This requires `get` permission on `pods` (to read `ContainersReady`) and `patch` permission on `pods/status` (to set the readiness gate). The Helm chart creates a `ClusterRole` with these permissions and binds it to all ServiceAccounts (same pattern as Istio/Linkerd sidecar RBAC):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: deploy-gate-sidecar
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods/status"]
    verbs: ["patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: deploy-gate-sidecar
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: deploy-gate-sidecar
subjects:
  - kind: Group
    name: system:serviceaccounts
    apiGroup: rbac.authorization.k8s.io
```

### Sidecar Resource Usage

The sidecar is idle after the gate opens. Resource limits ensure it can't impact the app container:

```
Requests: 10m CPU, 16Mi memory
Limits:   50m CPU, 32Mi memory
```

---

## Authentication

None. The gate is a ClusterIP service — internal network only, no public ingress. The threat model for authentication would be a malicious pod calling the gate API to prematurely open a group. But if an attacker can deploy arbitrary pods in your cluster, deploy-gate is the least of your concerns.

---

## API

All JSON responses are compact (single-line).

### POST /register

Called by the webhook when injecting a sidecar. Registers a service as part of a deployment run.

**Request:**

```json
{
  "deployment_id": "f299fe6c-...-1",
  "service_id": "2df728a3-...",
  "group": "backend"
}
```

**Response (201):**

```json
{
  "deployment_id": "f299fe6c-...-1",
  "service_id": "2df728a3-...",
  "group": "backend",
  "registered_at": "2025-03-05T14:33:21Z"
}
```

**Behavior:**
- Idempotent per `(deployment_id, service_id)`. Duplicate registrations return 200 with existing data.
- Creates the deployment run record if it doesn't exist (first registration for this deployment-id).
- Records the registration time (used for settle time calculation).

### POST /ready

Called by the sidecar on every poll cycle until the gate opens.

**Request:**

```json
{
  "deployment_id": "f299fe6c-...-1",
  "service_id": "2df728a3-..."
}
```

**Response (200 — gate open):**

```json
{
  "gate_status": "open",
  "deployment_id": "f299fe6c-...-1",
  "group": "backend",
  "registered": ["2df728a3-...", "5ef891b2-..."],
  "ready": ["2df728a3-...", "5ef891b2-..."]
}
```

**Response (200 — gate waiting):**

```json
{
  "gate_status": "waiting",
  "deployment_id": "f299fe6c-...-1",
  "group": "backend",
  "registered": ["2df728a3-...", "5ef891b2-..."],
  "ready": ["2df728a3-..."],
  "pending": ["5ef891b2-..."],
  "settle_time_remaining_seconds": 12
}
```

**Response (4xx — error):**

```json
{
  "gate_status": "error",
  "reason": "service_not_registered | deployment_unknown"
}
```

**Behavior:**
- Idempotent per `(deployment_id, service_id)`. Calling `/ready` multiple times is expected (polling).
- Marks the service as "ready" (ContainersReady condition is True, meaning the app's readiness probe passed).
- Evaluates group completion: all registered members of this group for this deployment-id are ready AND `minSettleTime` has passed since first registration.
- When group opens → run transitions to `COMPLETED` if all groups are open.
- Unknown deployment-id or unregistered service → error.
- Completed deployment → open (autoscaled pods are fine).

### GET /status

Read-only debug endpoint.

**Response:**

```json
{
  "active_deployments": [
    {
      "deployment_id": "f299fe6c-...-1",
      "first_registered_at": "2025-03-05T14:33:21Z",
      "settle_time_remaining_seconds": 0,
      "groups": {
        "backend": {
          "status": "waiting",
          "registered": ["2df728a3-...", "5ef891b2-..."],
          "ready": ["2df728a3-..."],
          "pending": ["5ef891b2-..."]
        },
        "frontend": {
          "status": "open",
          "registered": ["8ab123c4-..."],
          "ready": ["8ab123c4-..."]
        }
      }
    }
  ],
  "recent_deployments": [
    {
      "deployment_id": "f299fe6c-...-0",
      "status": "COMPLETED",
      "completed_at": "2025-03-05T12:02:30Z"
    }
  ]
}
```

### GET /healthz

Liveness probe. Returns `200 OK` with empty body. Does not touch the database.

---

## Run States

```
POST /register (first for deployment-id)
    │
    ▼
  ACTIVE
    │
    └── All groups open AND settle time passed ──► COMPLETED
```

| State | Meaning | Gate response |
|-------|---------|---------------|
| `ACTIVE` | Deployment in progress | `waiting` or `open` per group |
| `COMPLETED` | All groups opened | `open` for any pod with this deployment-id |

Two states.

**Failed deployments**: Pods get killed by Kubernetes, the run stays `ACTIVE` forever. No harm — stale `ACTIVE` runs are inert rows. Next deployment gets a new deployment-id.

**Rapid re-deploys**: Each deployment gets its own deployment-id. Multiple `ACTIVE` runs coexist.

> **Implementation note**: The ACTIVE → COMPLETED transition must be idempotent. Use `UPDATE runs SET status = 'COMPLETED' WHERE deployment_id = $1 AND status = 'ACTIVE'`.

---

## Storage

Postgres is the sole data store. No in-memory cache.

At the scale this operates (tens of pods polling every 5 seconds = low double-digit queries/second), Postgres handles this trivially.

### Horizontal Scaling

Multiple gate replicas share the same Postgres database. Every write and read goes directly to Postgres. No replica-local state. Strong consistency by default.

---

## Data Model (Prisma)

```prisma
model Deployment {
  id               Int      @id @default(autoincrement())
  deploymentId     String   @unique @map("deployment_id")
  status           String   @default("ACTIVE")
  firstRegisteredAt DateTime @map("first_registered_at")
  completedAt      DateTime? @map("completed_at")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  services DeploymentService[]

  @@index([status])
  @@index([createdAt])
  @@map("deployments")
}

model DeploymentService {
  id             Int      @id @default(autoincrement())
  deploymentId   String   @map("deployment_id")
  serviceId      String   @map("service_id")
  groupName      String   @map("group_name")
  registeredAt   DateTime @default(now()) @map("registered_at")
  readyAt        DateTime? @map("ready_at")

  deployment Deployment @relation(fields: [deploymentId], references: [deploymentId])

  @@unique([deploymentId, serviceId])
  @@index([deploymentId])
  @@map("deployment_services")
}
```

---

## Web UI

Minimal server-rendered HTML at `GET /ui`. JavaScript polls `GET /status`.

- Active deployment(s): groups, registered/ready/pending services, settle time remaining, elapsed time.
- Recent completed deployments.
- Auto-refresh, polls every 5s.
- Read-only. No auth.

> **Implementation note**: The UI derives the API base URL dynamically from `window.location`.

---

## Failure Modes

Every failure is **fail-closed**.

| Failure | What happens | Impact |
|---------|-------------|--------|
| Gate down | Sidecar can't reach gate → readiness gate stays False | Old pods serve. |
| Webhook down | Pod creation rejected (`failurePolicy: Fail`) | Nothing deploys. |
| Pod creation without labels | Webhook skips injection | Normal lifecycle. |
| Service not registered (code bug) | Gate returns error → sidecar blocks | Nothing deploys. |
| Service never boots | Group incomplete forever | Old pods serve. Qovery rolls back. |
| Pod crash after gate opens | Restart → sidecar re-checks → COMPLETED → open | Recovers. |
| Stale ACTIVE deployments | Inert rows | None. |
| Gate replica restarts | Stateless — reconnects to Postgres | No impact. |
| Sidecar crash | K8s restarts → re-enters poll loop | Recovers. |
| cert-manager down | Webhook cert expires → pod creation fails | Nothing deploys. |
| Namespace not labeled | Webhook never intercepts | Services deploy normally (ungated). |

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Gate runtime | Node.js + TypeScript | Fast startup, same stack as webhook |
| Webhook runtime | Node.js + TypeScript | Same stack as gate |
| Sidecar | Alpine + curl + shell | Minimal, ~8MB |
| Database | Postgres via Prisma | Shared across replicas |
| HTTP framework | Fastify | Lightweight |
| UI | Server-rendered HTML | Zero build step |
| TLS | cert-manager | Already on Qovery clusters |
| Package manager | Helm | Standard K8s distribution |

---

## Qovery Setup Guide

### 1. Install the Helm chart (once per cluster)

```bash
helm install deploy-gate oci://ghcr.io/prosperity-solutions/qovery-deploy-gate/chart \
  --namespace deploy-gate \
  --create-namespace
```

### 2. Label your namespace

```bash
kubectl label namespace <your-qovery-namespace> qovery-deploy-gate.life.li/enabled=true
```

### 3. Create label groups in Qovery UI

Go to **Organization Settings → Labels & Annotations → Add Label Group**.

Create one label group per sync group:

| Label Group Name | Label Key | Label Value |
|-----------------|-----------|-------------|
| deploy-gate-backend | `qovery-deploy-gate.life.li/group` | `backend` |
| deploy-gate-frontend | `qovery-deploy-gate.life.li/group` | `frontend` |

### 4. Assign label groups to services

For each service that should be gated, go to the service settings in the Qovery console and assign the corresponding label group.

### 5. Set deployment strategy

For all gated services: `maxSurge: 100%`, `maxUnavailable: 0%`.

### 6. Deploy

That's it. The webhook detects the labels, injects sidecars, and the gate coordinates readiness automatically. No env vars. No secrets. No scripts. No Dockerfile changes.

---

## v1 Scope

### In

- Gate API: `POST /register`, `POST /ready`, `GET /status`, `GET /healthz`
- Webhook: label-driven auto-injection with namespace selector
- Sidecar: ContainersReady polling + gate check + readiness gate patching
- Label-driven sync groups (Qovery UI configuration)
- Minimum settle time (`minSettleTime`, default 30s)
- Partial deployment support (automatic, from webhook observations)
- Deployment-id as run identity (from Qovery pod labels)
- Zero-config networking (no auth, auto-discovered gate URL)
- Horizontal scaling (Postgres, no replica-local state)
- Basic auto-refresh web UI
- Prisma migrations via Helm hook
- ghcr.io images (3)
- GitHub Actions CI/CD
- Helm chart with cert-manager TLS
- ClusterRole RBAC for sidecar

### Out (v2+)

- DB cleanup of old runs
- Prometheus metrics / Grafana dashboard
- CLI tool
- Operator-based approach (readiness gates without sidecar)
- Multi-cluster support
- Alerting integrations (Slack, PagerDuty)

---

## Summary

One Helm install. One namespace label. One Qovery label per service. Zero env vars. Zero secrets. Zero Dockerfile changes. Zero lifecycle jobs. The webhook reads pod labels, injects sidecars where needed, and registers services with the gate. The gate holds traffic until every grouped service is ready and the settle time has passed. Fail-closed everywhere. If the gate breaks, old pods keep serving.
