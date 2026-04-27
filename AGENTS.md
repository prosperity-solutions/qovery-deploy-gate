# Agents Guide

## Project Overview

qovery-deploy-gate synchronizes multi-service deployments on Qovery by holding new pods from becoming ready until every service in a sync group is ready. It prevents version skew between tightly coupled services during rollouts.

## Architecture

Three components, each with its own Docker image:

- **Gate** (`gate/`) — Fastify HTTP API + web dashboard. Stateless, backed by PostgreSQL via Prisma. Tracks deployments, services, pods, groups, expected services, and completed groups. Evaluates gate open/close decisions.
- **Webhook** (`webhook/`) — Kubernetes mutating admission webhook. Intercepts pod creation, injects the sidecar container + readiness gate into pods labeled with `qovery-deploy-gate.life.li/group`. Fire-and-forgets `/expect` calls to the gate.
- **Sidecar** (`sidecar/`) — Alpine shell script (~8MB image). Injected into pods by the webhook. Registers with the gate, polls for container readiness, reports to the gate, and patches the pod's readiness gate condition when the gate opens.

Packaging: Helm chart in `chart/` with PostgreSQL subchart dependency.

## Key Design Decisions

- **Sidecar over central pod watcher**: Each pod proves itself to the gate, rather than the gate watching pods via the K8s API. This keeps the gate stateless, makes failures fail-safe, and avoids informer/controller complexity. See the README's "Why Sidecars" section.
- **Webhook and gate are separate services**: Failure isolation. A Postgres outage shouldn't block pod creation cluster-wide via the synchronous admission webhook path.
- **Fire-and-forget `/expect`**: The webhook doesn't wait for the gate's response. The sidecar's `/register` serves as a belt-and-suspenders fallback if `/expect` fails.
- **Per-group settle time**: Computed from `max(registeredAt)` of each group's pods, not deployment-global. Prevents group-B registration from resetting group-A's timer.
- **CompletedGroup table**: Records when a group first opens. Autoscaling pods that appear after completion get instant "open" and are filtered from the status/UI.
- **Per-pod heartbeat**: Each `DeploymentService` row carries `lastPingedAt`, refreshed by `/register` and `/ready`. Never-ready pods whose heartbeat lapses past `POD_STALE_TIMEOUT` (default 90s) are excluded from gate evaluation, so HPA scale-down or eviction of a pre-ready pod cannot stall the gate forever. The sidecar re-calls `/register` on each loop iteration while waiting for app-ready to keep its heartbeat fresh.
- **CASCADE deletes**: All FK constraints use ON DELETE CASCADE for easy deployment cleanup.
- **Requires blue/green rollout strategy**: `maxSurge=100%`, `maxUnavailable=0%`. Progressive rolling (Qovery's default 25/25) works but provides weaker guarantees.

## Tech Stack

- **Gate / Webhook**: Node.js, TypeScript, Fastify
- **Sidecar**: Alpine, curl, jq, shell (`gate-check.sh`)
- **Database**: PostgreSQL via Prisma ORM
- **TLS**: cert-manager (self-signed issuer for webhook)
- **Packaging**: Helm
- **CI/CD**: GitHub Actions, semantic-release
- **Registry**: ghcr.io

## Repository Structure

```
gate/
  src/
    index.ts          # Fastify server setup, config loading
    routes.ts         # All API endpoints (/expect, /register, /ready, /status, /healthz, /readyz)
    routes.test.ts    # Integration tests (40 tests, requires PostgreSQL)
    ui.ts             # HTML dashboard (GET /ui)
    config.ts         # Environment variable parsing
  prisma/
    schema.prisma     # Data models: Deployment, DeploymentService, ExpectedService, CompletedGroup
    migrations/       # SQL migrations (0001–0012)

webhook/
  src/
    index.ts          # Fastify server setup with TLS
    webhook.ts        # Admission review handler, sidecar injection logic
    webhook.test.ts   # Unit tests (8 tests)

sidecar/
  gate-check.sh       # Main sidecar script: register → poll ready → patch readiness gate

chart/
  Chart.yaml          # Helm chart metadata (version managed by semantic-release)
  values.yaml         # Default configuration values
  templates/          # K8s manifests (deployments, services, RBAC, webhook config, etc.)
```

## Data Model

- **Deployment**: Top-level entity keyed by `deploymentId` (from Qovery's `qovery.com/deployment-id` label)
- **DeploymentService**: Individual pod registration. Unique on `(deploymentId, serviceId, podName, namespace)`
- **ExpectedService**: Pre-registered by webhook at admission time. Unique on `(deploymentId, serviceId)`
- **CompletedGroup**: Records when a deployment+group first opens. Unique on `(deploymentId, groupName)`

## API Flow

1. Webhook intercepts pod CREATE → injects sidecar → calls `POST /expect` (fire-and-forget)
2. Sidecar starts → calls `POST /register` to register the pod
3. Sidecar polls K8s API to check if app containers are ready
4. When ready, sidecar calls `POST /ready` to report and check gate status
5. Gate evaluates: all expected services present? All pods ready? Settle time met?
6. If yes → gate returns `open`, sidecar patches pod's readiness gate condition
7. CompletedGroup recorded → future autoscaling pods get instant `open`

## Development

```bash
# Gate (requires PostgreSQL)
cd gate && npm install && npx prisma generate
DATABASE_URL="postgresql://..." npx prisma migrate deploy
DATABASE_URL="postgresql://..." npm run dev
DATABASE_URL="postgresql://..." npm test

# Webhook
cd webhook && npm install
npm run dev    # requires TLS certs
npm test

# Lint (both gate and webhook)
npm run lint
```

## Testing

- Gate tests are integration tests requiring a real PostgreSQL database. Set `DATABASE_URL` env var.
- Webhook tests are unit tests with no external dependencies.
- Tests use Vitest.
- Gate tests clean up via `prisma.deployment.deleteMany()` (CASCADE handles related records).
- Some gate tests use real timers (e.g., 2-second settle time test). Don't mock timers.

## Commits

- Uses conventional commits enforced by commitlint + husky.
- `feat:` → triggers a minor release. `fix:` → patch release. `chore:` / `docs:` → no release.
- semantic-release manages versioning, tagging, and GitHub releases.
- Releases are created as drafts, published only after Docker images and Helm chart are pushed.

## Common Patterns

- **Upserts everywhere**: Most write operations use upsert for idempotency under concurrent requests.
- **Transaction blocks**: Gate logic in `/ready` runs in a Prisma `$transaction` to ensure consistent reads and writes.
- **Belt-and-suspenders**: `/register` also upserts ExpectedService as fallback for failed `/expect`.
- **Structured error codes**: Error responses include `error_code` (e.g., `"not_found"`) for machine-readable error handling in the sidecar.
