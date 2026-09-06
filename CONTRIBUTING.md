# Contributing

Use Node.js 22 and install the committed lockfile with `npm ci`. `npm run lint`
and `npm test` run without cloud accounts or real emails. To exercise Azure
queues and delivery locally, use the Azurite/fake-ACS compose stack documented
in the [README](README.md#local-azure-development).

| Change | Start here |
| --- | --- |
| Provider selection and configuration | `lib/providers/index.js`, `lib/config.js` |
| Azure send, queue, and event behavior | `lib/providers/azure/`, `test/azure-*.test.js` |
| SES send, queue, and event behavior | `lib/providers/ses/`, `test/ses-events.test.js` |
| Durable newsletter delivery | `lib/newsletter-worker.js`, `test/send-retry.test.js` |
| Dashboard and authentication | `lib/admin-dashboard.js`, `lib/auth.js` |
| HTTP routes and request behavior | `lib/app.js`, `test/http-api.test.js` |
| Storage | `lib/db-mysql.js`, `lib/db-sqlite.js`, `test/db-sqlite.test.js` |

Preserve accepted-send identity on retries so a transient status failure cannot
send a second email. Use synthetic recipients and local endpoints in fixtures.
Do not include credentials, subscriber lists, or captured production events.

Keep the MIT license and upstream attribution in derived files. Report security
issues through [Forkluck's private reporting process](https://github.com/forkluck/forkluck/blob/main/SECURITY.md).
