# Repo Watch

GitHub releases notification service. Users subscribe to a repository with their email
address and receive a notification when a new release (or tag) is published.

**Stack:**

- TypeScript
- NodeJS
- Fastify
- PostgreSQL + Drizzle
- Redis + BullMQ
- Zod
- neverthrow
- Prometheus + Grafana

## Setup

1. Create `.env`

   ```bash
   cp .env.example .env
   ```

   Check required and optional environment variables in [`src/config/env.ts`](src/config/env.ts).

   Check the app config in [`src/config/config.ts`](src/config/config.ts), modify the default config there,
   or provide a custom one in [`src/main.ts`](src/main.ts).

2. Run
   - in Docker

     ```bash
     docker compose up
     ```

   - locally

     ```bash
     npm install
     npm run dev:infra:up
     npm run dev
     ```

## Database

The app applies database migrations when it starts, so a normal run needs no separate
migration step.

After changing the schema:

```bash
npm run db:gen     # generate a new migration from the schema
npm run db:migrate # apply migrations manually
```

## Testing

```bash
# unit tests (no infrastructure required)
npm run test:unit

# integration tests
cp .env.test.example .env.test
npm run test:int:db:up
npm run test:int
npm run test:int:db:down
```

Use a dedicated test database in `.env.test` (e.g. the one from [`docker-compose.test.yml`](docker-compose.test.yml)).

## Monitoring

The `monitoring/` directory contains a separate compose project with Prometheus and Grafana,
including provisioned datasources, dashboards, and alert rules.

```bash
cd monitoring
docker compose up -d
```

> Note: Prometheus scrapes the app's `/metrics` endpoint, the bearer token configured in
> `monitoring/prometheus/prometheus.yml` must match the admin API key (`env.ADMIN_API_KEY` by
> default) configured for the app.

## Project overview

Monolith built around three sub-systems: a web server, a scanner, and queue workers.

### 1. Web server

Documentation for public routes is generated from the route schemas and served at `/docs`.

Public API:

| Method | Path                      | Description                                                   |
| ------ | ------------------------- | ------------------------------------------------------------- |
| `POST` | `/api/subscribe`          | Create a pending subscription and queue a confirmation email. |
| `GET`  | `/api/confirm/:token`     | Confirm a subscription with a single-use token.               |
| `GET`  | `/api/unsubscribe/:token` | Soft-delete a subscription with a single-use token.           |
| `GET`  | `/api/subscriptions`      | List non-removed subscriptions for an email address.          |

`subscribe` returns `409` if an already confirmed subscription exists; `503` for GitHub failures and
rate limits.

HTML pages:

- `/` — subscription form
- `POST /subscribe` — form submission
- `/confirm/:token`, `/unsubscribe/:token` — confirmation and unsubscription result pages

Admin endpoints (`/health`, `/metrics`) require `Authorization: Bearer <ADMIN_API_KEY>`
and are hidden from the generated docs.

### 2. Scanner

Runs continuously on the configured interval:

- selects a batch of active repositories, least recently checked
- fetches the repository's latest release from GitHub, falling back to the latest tag
- a changed tag updates the repository in DB and enqueues a "notify subscribers" job
- GitHub rate limits are handled with retries and backoff until the request succeeds or the
  process shuts down; other fetch errors record the check and move on

A repository is marked inactive when a "notify subscribers" job finds no confirmed subscribers,
and is reactivated when someone subscribes or confirms.

### 3. Queue workers

There are three BullMQ queues/workers:

- `confirmation-emails` — renders and sends subscription confirmation emails
- `repo-subscriptions` — processes a new release: gets confirmed, active subscribers,
  enqueues a notification email for each, or marks the repository inactive when there
  are no active subscribers
- `release-notifications` — sends the new-release email

Both release-related jobs compare their tag with the repository's current latest tag and skip
themselves if they are stale, so a burst of releases cannot produce duplicate notifications.
Failed jobs are retried with exponential backoff.

### Additional notes

- **Caching.** GitHub API responses and the latest tag per repository are cached in Redis with
  configured TTLs. The latest-tag cache is also used by the workers to detect stale jobs.
- **Tokens.** Confirmation and unsubscribe links embed random tokens. Only an HMAC of the
  token is stored; tokens are single-use and expire after a configurable period.
  `env.SERVER_SECRET` must stay stable across restarts, otherwise existing links stop working.

### Known limitations

- Email delivery is not implemented, emails are written to `stdout`.
- All public routes are unauthenticated. `GET /api/subscriptions` can be queried by anyone.
- All public routes have no rate limiting.
- Expired tokens and removed subscriptions are not cleaned up.
- The HTML form has no CSRF protection.
