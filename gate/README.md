# Gate Service

The central API server and web dashboard for qovery-deploy-gate. It tracks deployment registrations, evaluates group readiness, and serves the status UI.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/register` | POST | Register a service for a deployment (called by webhook) |
| `/ready` | POST | Report service readiness and check gate status (called by sidecar) |
| `/status` | GET | Get all deployment statuses (JSON) |
| `/healthz` | GET | Liveness probe (no DB access) |
| `/readyz` | GET | Readiness probe (verifies DB connectivity) |
| `/ui` | GET | Web dashboard |

## Tech Stack

- **Runtime**: Node.js 22 (Alpine)
- **Framework**: Fastify
- **Database**: PostgreSQL via Prisma ORM
- **Language**: TypeScript

## Environment Variables

Validated at startup using [envalid](https://github.com/af/envalid):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection URL |
| `PORT` | No | `8080` | HTTP listen port |
| `HOST` | No | `0.0.0.0` | Listen address |
| `MIN_SETTLE_TIME` | No | `30` | Seconds to wait after first registration before gate can open |

## Database Schema

Uses Prisma with two models:

- **Deployment** — Tracks a Qovery deployment run (`ACTIVE` / `COMPLETED`)
- **DeploymentService** — Individual service registration within a deployment, grouped by `group_name`

Migrations are in `prisma/migrations/` and run automatically via a Helm hook during install/upgrade.

## Development

```bash
npm install
npx prisma generate
DATABASE_URL="postgresql://..." npm run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot-reload (tsx) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled output |
| `npm run lint` | ESLint check |
| `npm test` | Run tests with Vitest |
| `npm run db:migrate` | Apply Prisma migrations |
| `npm run db:generate` | Regenerate Prisma client |
