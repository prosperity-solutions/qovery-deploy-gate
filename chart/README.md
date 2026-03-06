# Helm Chart

Packages all qovery-deploy-gate components for Kubernetes deployment.

## Components Deployed

| Resource | Description |
|----------|-------------|
| Gate Deployment + Service | API server and web dashboard |
| Webhook Deployment + Service | Mutating admission webhook |
| MutatingWebhookConfiguration | Intercepts pod creation |
| Certificate + Issuer | TLS for webhook (via cert-manager) |
| Sidecar RBAC | ServiceAccount, ClusterRole, ClusterRoleBinding for pod status patching |
| Migration Job | Helm hook that runs Prisma migrations on install/upgrade |
| PodDisruptionBudgets | For both gate and webhook |
| PostgreSQL (subchart) | Bitnami PostgreSQL, enabled by default |

## Prerequisites

- Kubernetes 1.25+
- cert-manager installed in the cluster
- Helm 3.x

## Install

```bash
helm dependency build ./chart
helm install qovery-deploy-gate ./chart -n qovery-deploy-gate --create-namespace
```

## Key Configuration

```yaml
gate:
  replicas: 2
  minSettleTime: 30           # seconds before gate can open
  database:
    external: false           # set true + url for external Postgres
    url: ""

webhook:
  replicas: 2
  failurePolicy: Fail         # Fail (fail-closed) or Ignore (fail-open)

sidecar:
  pollInterval: 5
  rbac:
    serviceAccountNamespaces: []  # restrict to specific namespaces

postgresql:
  enabled: true               # disable if using external DB
  auth:
    password: deploy_gate     # override in production!

certManager:
  createSelfSignedIssuer: true
  issuerRef:
    name: ""                  # auto-set when using self-signed
    kind: Issuer
```

See [values.yaml](values.yaml) for all options.

## Database Migrations

Migrations run automatically as a Helm `post-install,pre-upgrade` hook. The migration job:

1. Creates a temporary Secret with the database URL (hook-weight: -5)
2. Runs `prisma migrate deploy` (hook-weight: 0)
3. Both resources are cleaned up after completion (`hook-delete-policy: hook-succeeded,hook-failed`)

## TLS

By default, the chart creates a self-signed cert-manager Issuer. To use your own:

```yaml
certManager:
  createSelfSignedIssuer: false
  issuerRef:
    name: my-issuer
    kind: ClusterIssuer  # or Issuer
```

## Security

All containers run with hardened security contexts:
- `runAsNonRoot: true`
- `readOnlyRootFilesystem: true`
- `allowPrivilegeEscalation: false`
- `capabilities: { drop: ["ALL"] }`
