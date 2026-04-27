# Dynamics-Marketo-Sync

Bidirectional real-time sync between Microsoft Dynamics CRM and Marketo, with a live dashboard, admin console, and trigger page.

---

## What's new in this fork

- **Contact-vs-Lead differentiator** on every Marketo Person — `crmEntityType` plus `crmContactId` / `crmLeadId` so Smart Lists can filter cleanly.
- **"Sync with Company" bundle button** in the run page — multi-row sequential push of selected Contacts/Leads with their associated Account, in one click. Preview-first modal flow.
- **Expanded Account → Company mapping** — 18 fields total (billing address, industry, revenue, employees, website, main phone) using Marketo's standard Companies API. No ABM, no custom object.
- See [`CHANGELOG.md`](./CHANGELOG.md) for the full per-file change log and [`docs/MERGE_GUIDE.md`](./docs/MERGE_GUIDE.md) if you're merging this fork into a sibling branch.

---

## Summary

This service synchronizes Accounts, Contacts, and Leads between Dynamics CRM and Marketo, providing:
- Real-time, bidirectional sync with audit logging
- Admin UI for runtime credential management
- Live dashboard and trigger tools for testing
- Azure-native deployment (App Service, Static Web Apps)

---

## Quick start (no Docker, no Dapr)

The simplest local dev path. **You do NOT need Docker, Dapr, or Redis.** Webhooks are plain HTTPS endpoints, the queue runs on PostgreSQL via pg-boss.

Prerequisites: **Node 18+** and a reachable **PostgreSQL** (Azure Postgres / Supabase Postgres / managed instance — anything reachable with `psql`).

```bash
# 1. Install dependencies (backend + web)
npm install
npm --prefix web install

# 2. Configure .env  (DATABASE_URL is the only hard requirement to boot)
cp .env.example .env
# edit .env — set DATABASE_URL, DYNAMICS_WEBHOOK_SECRET, MARKETO_WEBHOOK_SECRET
# generate secrets:
#   openssl rand -hex 32

# 3. Apply DB schema (one-shot)
psql "$DATABASE_URL" -f db/schema.sql
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# 4. Verify env + DB connectivity
npm run verify

# 5. Run — two terminals
npm run dev          # terminal 1 — backend on :3000
npm run dev:web      # terminal 2 — Vite SPA on :5173 (proxies API to :3000)
```

Open `http://localhost:5173`. Use the **Admin** tab to fill in Dynamics + Marketo credentials — they hot-reload within 60 seconds, no restart needed.

> **Heads up:** if you see `'dapr' is not recognized as an internal or external command`, you ran the wrong command. The Dapr / Service Bus path is **optional** (only used in Azure prod). Locally, just use `npm run dev`.

---

## Installation & Setup

1. **Clone and install dependencies**
  ```bash
  git clone <repo-url> dynamics-marketo-sync
  cd dynamics-marketo-sync
  npm run setup
  ```

2. **Create and configure `.env`**
  - Copy `.env.example` to `.env`
  - Fill in all required values (see below)
  - Generate webhook secrets:
    ```bash
    openssl rand -hex 32  # DYNAMICS_WEBHOOK_SECRET
    openssl rand -hex 32  # MARKETO_WEBHOOK_SECRET
    ```

3. **Apply PostgreSQL schema**
  - Paste `db/schema.sql` into the PostgreSQL client
  - Apply any migrations in `db/migrations/`

4. **Verify setup**
  ```bash
  npm run verify
  ```

5. **Run locally**
  - Backend: `npm run dev` (http://localhost:3000)
  - Frontend: `npm run dev:web` (http://localhost:5173)

6. **Enter Dynamics & Marketo credentials**
  - Use the Admin tab in the web UI, or seed directly in PostgreSQL

---

## Environment Variables

See `.env.example` for all required and optional variables. Key values:

- `DB_HOST`, `DB_PASSWORD`, `DATABASE_URL`
- `DYNAMICS_WEBHOOK_SECRET`, `MARKETO_WEBHOOK_SECRET`
- (Runtime) `DYNAMICS_TENANT_ID`, `DYNAMICS_CLIENT_ID`, `DYNAMICS_CLIENT_SECRET`, `DYNAMICS_RESOURCE_URL`, `MARKETO_BASE_URL`, `MARKETO_CLIENT_ID`, `MARKETO_CLIENT_SECRET`

---

## Common Commands

| Command                        | Description                                 |
|--------------------------------|---------------------------------------------|
| `npm run setup`                | Install all dependencies and preflight check |
| `npm run verify`               | Check env and PostgreSQL connectivity         |
| `npm run dev`                  | Start backend (nodemon) on :3000            |
| `npm run dev:web`              | Start Vite dev server on :5173              |
| `npm test`                     | Run all tests                               |
| `npm run precommit`            | Run linting, tests, build web, update docs  |
| `npm run build:web`            | Build SPA to `web/dist`                     |
| `docker compose up --build`    | Run full stack in Docker                    |

---

## Troubleshooting

- **Missing tables**: Ensure you have applied `db/schema.sql` in PostgreSQL.
- **Missing env vars**: Run `npm run verify` for details.
- **No dashboard events**: Check webhook secrets and credentials.
- **Invalid signature**: Ensure webhook secrets match in both source and backend.
- **Pipeline/container issues**: See `docs/AZURE_DEPLOY.md` for Azure setup.

---

## File/Directory Map

```
.
├── src/        # Backend (Node.js)
├── web/        # Frontend (React + Vite)
├── tests/      # Unit, integration, e2e tests
├── db/         # PostgreSQL schema and migrations
├── docs/       # Architecture, deployment, credentials, runbook
├── scripts/    # Utility scripts
├── Dockerfile, docker-compose.yml, azure-pipelines.yml
└── .env.example
```

---

## Further Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Engineering deep-dive
- [docs/PRODUCT_OVERVIEW.md](docs/PRODUCT_OVERVIEW.md): Product/feature overview

