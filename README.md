# Forkluck Azure mail provider

**Use AWS SES or Azure Communication Services to send your Ghost newsletter emails without changing anything in Ghost.**

Ghost has built-in support for Mailgun to send newsletters. But if you'd rather use AWS SES (it's cheaper), this bridge sits between Ghost and SES and translates between them. Ghost thinks it's talking to Mailgun. SES does the actual sending.

Set `MAIL_PROVIDER=azure` to send through Azure Communication Services (ACS) Email with Azure Storage Queues and Event Grid instead. `MAIL_PROVIDER=ses` is the default and is unchanged.

No Ghost code changes.

> Maintained by Forkluck, based on [ghost-mail-bridge](https://github.com/ifrederico/ghost-mail-bridge) and
> [ghost-ses-proxy](https://github.com/josephsellers/ghost-ses-proxy).
> Original copyright notices remain in [LICENSE](LICENSE).

---

## What happens?

Ghost sends emails through two separate “lanes”:

| Lane | What it sends | How it works with the bridge |
|------|--------------|------|
| **Transactional** | Magic links, password resets, staff invites | SES via SMTP (no bridge needed) |
| **Newsletter** | Bulk subscriber emails | Ghost → bridge API (Fake Mailgun) → MySQL + SQS → bridge worker → SES |

For **event tracking** (deliveries, opens, clicks, bounces, complaints), the flow goes the other direction:

```
Ghost send request → API → MySQL batch/job rows → SQS send queue → worker → SES
SES → SNS → SQS → worker → MySQL events/suppressions
                               ↑
                    Ghost reads events from here
```

Ghost mail bridge also includes a **admin dashboard** so you can see what's going on without digging through logs.

---

## Getting started

### 1. Clone and configure

```bash
git clone https://github.com/forkluck/forkluck-azure-provider.git
cd forkluck-azure-provider
cp .env.example .env
```

Open `.env` and fill in your AWS credentials and settings. At minimum you'll need:

- `DATABASE_URL` — database connection string for the bridge (MySQL, or [SQLite](#sqlite))
- `MAILGUN_DOMAIN` — the domain value Ghost sends (for example `yourdomain.com`)
- `PROXY_API_KEY` — the API key Ghost will use to authenticate (you pick this)
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- `SES_EVENTS_QUEUE_URL` — your SQS queue that receives SES events
- `NEWSLETTER_SEND_QUEUE_URL` — your dedicated SQS queue for outbound newsletter jobs
- `GHOST_ADMIN_URL` — recommended if you want Ghost session auth on `/ghost/mail`

See [Configuration variables](#configuration-variables) for quick-start options.
For advanced tuning, see [Advanced configuration](./site/docs/advanced-config.md).

### 2. Start the bridge

**With Docker (recommended):**

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

**Without Docker:**

You'll need Node.js 20+ and a reachable MySQL instance.

```bash
npm ci
npm run dev
```

### 3. Check that it's running

```bash
curl http://localhost:3003/health
```

You should see something like:

```json
{
  "status": "ok",
  "tables": {
    "batches": 0,
    "send_jobs": 0,
    "recipient_emails": 0,
    "events": 0,
    "suppressions": 0
  }
}
```

### 4. Point Ghost at the bridge

Ghost uses two lanes:

- transactional mail goes straight to SES SMTP
- newsletter mail goes to the bridge over Docker's internal network

#### Same Docker Compose project

If Ghost and the bridge are in the same Compose project, set up both email lanes in your Ghost service config:

```yaml
services:
  ghost:
    environment:
      # --- Transactional emails (direct to SES via SMTP) ---
      mail__transport: SMTP
      mail__from: '"Your Site" <noreply@yourdomain.com>'
      mail__options__host: email-smtp.us-east-1.amazonaws.com
      mail__options__port: 587
      mail__options__secure: "false"
      mail__options__auth__user: ${SES_SMTP_USERNAME}
      mail__options__auth__pass: ${SES_SMTP_PASSWORD}

      # --- Newsletter emails (through the bridge) ---
      bulkEmail__mailgun__baseUrl: http://ghost-mail-bridge:3003/v3
      bulkEmail__mailgun__apiKey: ${PROXY_API_KEY}
      bulkEmail__mailgun__domain: ${MAILGUN_DOMAIN}
```

#### Official `ghost-docker` sidecar install

If Ghost is running from the official `ghost-docker` stack in `/opt/ghost` and the bridge is running separately in `/opt/ghost-mail-bridge`, use this tested pattern:

1. Attach only the bridge API service to Ghost's existing Docker network.

Detect the real network name:

```bash
docker network ls --format '{{.Name}}' | grep ghost_network
```

Then update `/opt/ghost-mail-bridge/docker-compose.yml` so `ghost-mail-bridge` joins that external network:

```yaml
services:
  ghost-mail-bridge:
    networks:
      - default
      - ghost_network

networks:
  ghost_network:
    external: true
    name: your_real_ghost_network_name
```

2. Set Ghost's transactional SMTP lane in `/opt/ghost/.env`:

```env
mail__transport=SMTP
mail__from="Your Site <hello@yourdomain.com>"
mail__options__host=email-smtp.YOUR_AWS_REGION.amazonaws.com
mail__options__port=587
mail__options__secure=false
mail__options__auth__user=YOUR_SES_SMTP_USERNAME
mail__options__auth__pass=YOUR_SES_SMTP_PASSWORD
```

3. Set Ghost's newsletter lane in `/opt/ghost/.env`:

```env
bulkEmail__mailgun__baseUrl=http://ghost-mail-bridge:3003/v3
bulkEmail__mailgun__apiKey=your-secure-api-key-here
bulkEmail__mailgun__domain=yourdomain.com
```

4. Expose the bridge dashboard in `/opt/ghost/caddy/Caddyfile` before the default Ghost proxy:

```caddy
handle /ghost/mail* {
	reverse_proxy ghost-mail-bridge:3003
}

handle {
	reverse_proxy ghost:2368
}
```

5. Restart Caddy and Ghost:

```bash
cd /opt/ghost
docker compose up -d --force-recreate caddy ghost
```

6. Sync Ghost's stored Mailgun settings once so old DB values do not override the new bridge target:

```bash
cd /opt/ghost-mail-bridge
bash scripts/sync-ghost-mailgun-settings.sh
```

Ghost should continue calling the bridge internally at `http://ghost-mail-bridge:3003/v3`. You do not need to expose `/v3` publicly.

Ghost and `ghost-mail-bridge` should be on the same Docker network. If you are migrating an existing Ghost install that was already configured for Mailgun, update the stored `mailgun_base_url` once so Ghost stops calling the old host.

For Docker-based Ghost installs, you can use the migration helper instead of opening the database manually:

```bash
bash scripts/sync-ghost-mailgun-settings.sh
```

Optional convenience alias:

```bash
npm run ghost:sync-mailgun-settings
```

It reads the existing Ghost DB credentials from the running Ghost container, updates the stored Mailgun settings to `http://ghost-mail-bridge:3003/v3`, and restarts Ghost. Treat it as part of install and upgrade hygiene for migrated sites or any Ghost instance that previously pointed at Mailgun.

If you ever want to switch the stored settings back to Mailgun, run:

```bash
MAILGUN_BASE_URL=https://api.mailgun.net/v3 \
MAILGUN_API_KEY=your-real-mailgun-api-key \
MAILGUN_DOMAIN=mg.yourdomain.com \
bash scripts/reset-ghost-mailgun-settings.sh
```

### 5. Optional isolated host install

If you want a Ghost-like `/opt/ghost-mail-bridge` deployment with separate API and worker services, use the templates in [`deploy/README.md`](./deploy/README.md), [`deploy/systemd/ghost-mail-bridge-api.service`](./deploy/systemd/ghost-mail-bridge-api.service), [`deploy/systemd/ghost-mail-bridge-worker.service`](./deploy/systemd/ghost-mail-bridge-worker.service), and [`deploy/caddy/Caddyfile.example`](./deploy/caddy/Caddyfile.example).

---

### Redeploying on the Forkluck host

`deploy/deploy-to-compose.sh` syncs a clean checkout to the host, rebuilds the
image inside the Ghost compose project, restarts the api and worker, and waits
for both health checks. It tags the running image `ghost-mail-bridge:rollback`
first, so `deploy/deploy-to-compose.sh rollback` restores it without a rebuild.
Host and paths are overridable through `BRIDGE_*` environment variables listed
at the top of the script.

## Verify everything works

Run through this checklist after setup:

- [ ] **Magic link sign-in** works (transactional lane)
- [ ] **Password reset** works (transactional lane)
- [ ] **Staff invite emails** arrive (transactional lane)
- [ ] **Newsletter send** goes through the bridge (newsletter lane)
- [ ] **Events show up in Ghost** — delivery, opens, clicks

---

## Admin dashboard

The bridge includes a simple dashboard for monitoring at `/ghost/mail` (configurable via `ADMIN_BASE_PATH`).

It shows send summaries, queued/processing/failed batch counts, worker status, and SES-event poller status. Authentication uses your Ghost admin session by default. Set `GHOST_ADMIN_URL` to your Ghost HTTPS URL.

If you're using the official Ghost Docker stack, Caddy must proxy `/ghost/mail*` to `ghost-mail-bridge:3003` before the default Ghost route. The bridge dashboard is the only path that needs public proxying. Keep `/v3` internal between Ghost and the bridge.

For local styling/development work without a Ghost session, you can use demo mode:

```
/ghost/mail/?demo=1
```

If you're running behind Nginx, add a proxy rule:

```nginx
location /ghost/mail/ {
  proxy_pass http://ghost-mail-bridge:3003/ghost/mail/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Cookie $http_cookie;
}
```

---

## AWS setup

You'll need these AWS resources:

1. **SES** — a verified domain identity and a Configuration Set
2. **SNS** — a topic that SES publishes events to
3. **SQS (events)** — a queue subscribed to that SNS topic for SES delivery/open/click/bounce/complaint events
4. **SQS (newsletter send)** — a dedicated outbound queue for newsletter batch jobs
5. **SQS DLQ (optional)** — useful for operations, but not required for the app to run
6. **MySQL** — a dedicated bridge database (preferred over sharing Ghost’s DB)
7. **Bridge IAM user** — AWS API credentials for SES + SQS
8. **SES SMTP credentials** — separate credentials for Ghost transactional mail

The IAM user/role for the bridge needs these permissions:

- `ses:SendRawEmail`
- `ses:GetAccount` if you want `/ghost/mail` to show SES sandbox/account status
- `sqs:SendMessage` on the newsletter send queue
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on the newsletter send queue and SES event queue

Make sure:

- your SNS topic policy allows `ses.amazonaws.com` to publish to the topic
- your SQS queue policy only allows your SNS topic to publish to it (`aws:SourceArn`)
- SES, SNS, SQS, and credentials all use the same AWS region
- if your SES account is still in sandbox, test sends must go only to verified recipients or mailbox simulator addresses

---

## Azure setup

Set `MAIL_PROVIDER=azure`. You'll need these Azure resources:

1. **Communication Services resource** — plus an **Email Communication Services** resource with a verified custom domain, linked to the Communication Services resource. Turn on user engagement tracking if you want `opened`/`clicked` events.
2. **Storage account** — with two queues: `newsletter-send` (outbound newsletter batch jobs) and `mail-events` (delivery and engagement events). Override the names with `AZURE_SEND_QUEUE_NAME` / `AZURE_EVENTS_QUEUE_NAME`.
3. **Event Grid system topic** — on the Communication Services resource, with a subscription that delivers `Microsoft.Communication.EmailDeliveryReportReceived` and `Microsoft.Communication.EmailEngagementTrackingReportReceived` to the `mail-events` Storage Queue.
4. **MySQL** — a dedicated bridge database, exactly as for SES.
5. **SMTP credentials** — ACS SMTP (or any provider you like) for Ghost transactional mail, which does not go through this bridge.

Then set:

```bash
MAIL_PROVIDER=azure
AZURE_COMMUNICATION_CONNECTION_STRING=endpoint=https://your-acs.communication.azure.com/;accesskey=...
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
```

The `From` address Ghost sends must be on the linked domain, or set `AZURE_EMAIL_SENDER_ADDRESS` to a MailFrom address that is.

### Azure limitations

- **Sending quota.** New ACS custom domains default to **30 emails/minute and 100 emails/hour**. The bridge throttles itself to those numbers client-side (`AZURE_EMAIL_RATE_PER_MINUTE`, `AZURE_EMAIL_RATE_PER_HOUR`) so it doesn't collect 429s. For real newsletters, raise the quota through an Azure support request and raise those two values to match.
- **No complaint feed.** ACS exposes no spam-complaint events, so `complained` events and complaint suppressions never appear. Bounces, suppressions and hard failures still record bounce suppressions.
- **Send status is not polled.** The bridge stores the `beginSend` operation id and never calls `pollUntilDone` on the rate-limited send-status endpoint; delivery outcome comes from Event Grid. (The ACS SDK itself makes one status GET per send; if that call fails the bridge keeps the already-accepted operation id rather than resending.)
- **Slower queue polling.** Storage Queues have no long poll, so an idle event poller sleeps for `EVENT_POLL_WAIT_SECONDS` between reads.

### Local Azure development

`docker-compose.azure-dev.yml` runs MySQL, [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) (Storage Queue emulator) and `scripts/fake-acs-email.js` — a stub ACS Email endpoint that accepts sends and pushes matching Event Grid messages into the events queue. No Azure subscription needed:

```bash
docker compose -f docker-compose.azure-dev.yml up --build
```

---

## Limitations

A few things to be aware of:

- Only implements the slice of the Mailgun API that Ghost actually uses — this isn't a general-purpose Mailgun replacement.
- Azure mode has provider-specific caveats — see [Azure limitations](#azure-limitations).
- **No attachment support**.
- Event tracking is not instant.
- This release does not migrate old SQLite data. Keep the old file as backup/reference only.

---

## Reference

### API endpoints

#### Mailgun-compatible (used by Ghost)

| Method | Path | What it does |
|--------|------|-------------|
| `POST` | `/v3/:domain/messages` | Queue bulk email send via SES worker |
| `GET` | `/v3/:domain/events` | Fetch events in Mailgun format |
| `GET` | `/v3/:domain/events/:pageToken` | Fetch next event page |
| `DELETE` | `/v3/:domain/:type/:email` | Delete a suppression record |
| `GET` | `/health` | Service status and table counts |

#### Dashboard API

All routes relative to `ADMIN_BASE_PATH` (default: `/ghost/mail`).

| Method | Path | What it does |
|--------|------|-------------|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/health` | Health + poller status |
| `GET` | `/api/summary` | 24h send/event summary |
| `GET` | `/api/failures` | Recent failures and complaints |

### Event mapping

| SES event | Mailgun event | Creates suppression? |
|-----------|--------------|---------------------|
| Delivery | `delivered` | No |
| Open | `opened` | No |
| Click | `clicked` | No |
| Bounce (Permanent) | `failed` (permanent) | Yes |
| Bounce (Transient) | `failed` (temporary) | No |
| Complaint | `complained` | Yes |
| Reject | `failed` (permanent) | Yes |
| Send, DeliveryDelay | *(skipped)* | — |

With `MAIL_PROVIDER=azure`:

| ACS Event Grid event | Mailgun event | Creates suppression? |
|----------------------|--------------|---------------------|
| Delivery report `Delivered` | `delivered` | No |
| Delivery report `Bounced` | `failed` (permanent, 607) | Yes |
| Delivery report `Suppressed` | `failed` (permanent, 607) | Yes |
| Delivery report `Quarantined`, `FilteredSpam` | `failed` (permanent, 554) | No |
| Delivery report `Failed` | `failed` (temporary, 450) | No |
| Delivery report `Expired` | `failed` (temporary, 450) | No |
| Delivery report `Expanded` | *(skipped)* | — |
| Engagement `View` | `opened` | No |
| Engagement `Click` | `clicked` | No |

### Configuration variables

#### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Database connection string — `mysql://...` or `sqlite://...` |
| `PROXY_API_KEY` | API key Ghost uses to authenticate (you choose this) |
| `MAILGUN_DOMAIN` | Domain value Ghost sends (e.g., `mg.yourdomain.com`) |
| `AWS_ACCESS_KEY_ID` | IAM access key — SES mode only |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key — SES mode only |
| `SES_EVENTS_QUEUE_URL` | SQS queue URL for SES events — SES mode only |
| `NEWSLETTER_SEND_QUEUE_URL` | Dedicated SQS queue URL for outbound newsletter jobs — SES mode only |
| `AZURE_COMMUNICATION_CONNECTION_STRING` | ACS connection string — Azure mode only |
| `AZURE_STORAGE_CONNECTION_STRING` | Storage account connection string — Azure mode only |

#### SQLite

Small servers can skip MySQL entirely and use a SQLite file instead:

- `DATABASE_URL=sqlite:///var/lib/ghost-mail-bridge/bridge.db` (three slashes for an absolute path; `sqlite://bridge.db` is relative to the working directory).
- In Docker, mount the directory holding the file — for example `-v ghost-mail-bridge-data:/var/lib/ghost-mail-bridge` — so the database survives restarts.
- The API and worker processes share the file over WAL, so they must run on the same host; run **one worker process only**.
- Everything else is unchanged: the schema is created on start and both `mysql://` and `sqlite://` support the same features.

#### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `MAIL_PROVIDER` | `ses` | Email provider: `ses` or `azure` |
| `QUEUE_PROVIDER` | *(mail provider)* | Queue transport, if it differs from the mail provider |
| `AWS_REGION` | `us-east-1` | AWS region |
| `APP_ROLE` | `all` | Runtime role: `api`, `worker`, or `all` |
| `SES_CONFIGURATION_SET` | `ghost-mail-bridge` | SES Configuration Set name |
| `PORT` | `3003` | HTTP port |
| `LOG_LEVEL` | `info` | Set `debug` for per-recipient logs |
| `SEND_CONCURRENCY` | `10` | Max parallel SES sends |
| `SEND_BATCH_SIZE` | `1000` | Max recipients per Ghost-like worker batch |
| `SEND_BATCH_CONCURRENCY` | `2` | Max parallel worker batches per send job |
| `SUPPRESSION_RETENTION_DAYS` | `0` | Suppression retention (`0` = forever) |
| `ADMIN_BASE_PATH` | `/ghost/mail` | Dashboard URL path. Plain segments only: letters, digits, `.`, `_`, `~`, `-` and `/` |
| `GHOST_ADMIN_URL` | *(empty)* | Ghost HTTPS base URL for dashboard auth (required if using dashboard) |
| `ALLOW_INSECURE_GHOST_ADMIN_URL` | `false` | Allow `http://` Ghost admin URL only for trusted local/private setups |
| `NEWSLETTER_SEND_DLQ_URL` | *(empty)* | Optional DLQ URL for docs/ops parity |
| `AZURE_SEND_QUEUE_NAME` | `newsletter-send` | Storage Queue for newsletter jobs |
| `AZURE_EVENTS_QUEUE_NAME` | `mail-events` | Storage Queue that Event Grid delivers to |
| `AZURE_EMAIL_SENDER_ADDRESS` | *(from header)* | Overrides the address in the ACS `senderAddress`; the From display name is kept |
| `AZURE_EMAIL_RATE_PER_MINUTE` | `30` | Client-side send throttle per minute |
| `AZURE_EMAIL_RATE_PER_HOUR` | `100` | Client-side send throttle per hour |
| `AZURE_EMAIL_DISABLE_ENGAGEMENT_TRACKING` | `false` | Disable ACS open/click tracking |
| `AZURE_QUEUE_VISIBILITY_TIMEOUT_SECONDS` | `3600` | Visibility timeout while a batch is being sent |
| `AZURE_QUEUE_MAX_DEQUEUE_COUNT` | `5` | Dequeues before a message is dropped as poison |

<details>
<summary>Advanced configuration (optional)</summary>

For retry/backoff tuning, request-size limits, Ghost Admin API compatibility overrides, and local dev/testing switches, see [Advanced configuration](./site/docs/advanced-config.md) and [`.env.advanced.example`](./.env.advanced.example).

</details>

### Storage

The bridge supports MySQL and SQLite. SQLite deployments use one worker
on the same host as the API; see [SQLite](#sqlite).

Core tables: `batches`, `send_jobs`, `recipient_emails`, `events`, `suppressions`, `runtime_heartbeats`.

Daily cleanup removes batch/send/event data older than the configured retention windows. Suppressions are kept forever unless `SUPPRESSION_RETENTION_DAYS` is set.

### Local development

See [Contributing](CONTRIBUTING.md) for the source map and checks.

```bash
cp .env.example .env
npm ci
npm run dev         # API + worker in one process
# or split roles locally:
npm run dev:api
npm run dev:worker

npm run lint
npm test            # node:test, no framework
```

For dashboard-only work without AWS, use the local dev/testing switches documented in [Advanced configuration](./site/docs/advanced-config.md).

---

## License

MIT

Bundled Inter fonts retain their [SIL Open Font License](lib/admin-dashboard-assets/fonts/OFL.txt).
