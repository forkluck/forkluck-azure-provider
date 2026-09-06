// The API over a real socket: routes, auth, multipart parsing, paging,
// suppression and the admin router, with the provider stubbed. These pin the
// service's HTTP contract independently of the Express version.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var { loadLib, purgeLibCache } = require('./helpers');

var AUTH = 'Basic ' + Buffer.from('api:test-key').toString('base64');

async function startApp(t, env) {
  var dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-http-')), 'bridge.db');
  var requireLib = loadLib(Object.assign({ DATABASE_URL: 'sqlite://' + dbFile }, env || {}));
  var queue = requireLib('providers/ses/queue');
  var account = requireLib('providers/ses/account');
  var sent = [];

  queue.sendMessage = async function(_queueUrl, body) { sent.push(body); };
  queue.getQueueDepth = async function() { return { visible: 0, inFlight: 0, delayed: 0 }; };
  account.getAccountStatus = async function() { return { status: 'stub' }; };

  var db = requireLib('db');
  await db.initDb();

  var app = requireLib('app').createApp();
  var server = http.createServer(app);
  await new Promise(function(resolve) { server.listen(0, '127.0.0.1', resolve); });
  var base = 'http://127.0.0.1:' + server.address().port;

  t.after(async function() {
    await new Promise(function(resolve) { server.close(resolve); });
    await db.closeDb();
    purgeLibCache();
  });

  return { base: base, db: db, sent: sent, fetch: function(pathname, init) {
    return fetch(base + pathname, Object.assign({ redirect: 'manual' }, init || {}));
  } };
}

function sendForm(fields) {
  var form = new FormData();
  fields.forEach(function(pair) {
    if (pair.length > 2) form.append(pair[0], pair[1], pair[2]);
    else form.append(pair[0], pair[1]);
  });
  return form;
}

var BASIC_SEND = [
  ['from', 'News <news@example.com>'],
  ['to', 'one@example.org'],
  ['to', 'two@example.org'],
  ['subject', 'Hello'],
  ['html', '<p>Hi</p>'],
  ['o:tag', 'newsletter'],
  ['o:tag', 'weekly']
];

test('GET /health reports the provider and stubbed account', async function(t) {
  var app = await startApp(t);
  var res = await app.fetch('/health');
  assert.strictEqual(res.status, 200);
  var body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.mailProvider, 'ses');
  assert.deepStrictEqual(body.sesAccount, { status: 'stub' });
  assert.strictEqual(typeof body.tables, 'object');
});

test('the Mailgun routes require basic auth with the API key', async function(t) {
  var app = await startApp(t);

  var missing = await app.fetch('/v3/example.com/messages', { method: 'POST' });
  assert.strictEqual(missing.status, 401);
  assert.deepStrictEqual(await missing.json(), { message: 'Unauthorized: missing credentials' });

  var wrong = await app.fetch('/v3/example.com/messages', {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from('api:wrong').toString('base64') }
  });
  assert.strictEqual(wrong.status, 401);
  assert.deepStrictEqual(await wrong.json(), { message: 'Unauthorized: invalid API key' });
});

test('POST /v3/:domain/messages queues a multipart send', async function(t) {
  var app = await startApp(t);
  var res = await app.fetch('/v3/example.com/messages', {
    method: 'POST',
    headers: { authorization: AUTH },
    body: sendForm(BASIC_SEND)
  });
  assert.strictEqual(res.status, 200);
  var body = await res.json();
  assert.match(body.id, /^<.+>$/);
  assert.strictEqual(body.message, 'Queued. Thank you.');

  assert.strictEqual(app.sent.length, 1);
  assert.strictEqual(app.sent[0].batchMessageId, body.id);
  var job = await app.db.getSendJobWithBatch(app.sent[0].jobId);
  assert.strictEqual(job.job_status, 'queued');
  assert.strictEqual(job.total_recipients, 2);
  assert.deepStrictEqual(JSON.parse(job.tags_json), ['newsletter', 'weekly']);
  assert.strictEqual(job.domain, 'example.com');
});

test('a body over MAX_REQUEST_BYTES is refused with 413', async function(t) {
  var app = await startApp(t, { MAX_REQUEST_BYTES: '4096' });
  var res = await app.fetch('/v3/example.com/messages', {
    method: 'POST',
    headers: { authorization: AUTH },
    body: sendForm(BASIC_SEND.concat([['html', 'x'.repeat(10000)]]))
  });
  assert.strictEqual(res.status, 413);
  assert.deepStrictEqual(await res.json(), { message: 'Request body too large' });
  assert.strictEqual(app.sent.length, 0);
});

test('a file part is refused with 400', async function(t) {
  var app = await startApp(t);
  var res = await app.fetch('/v3/example.com/messages', {
    method: 'POST',
    headers: { authorization: AUTH },
    body: sendForm(BASIC_SEND.concat([['attachment', new Blob(['x']), 'x.txt']]))
  });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(await res.json(), { message: 'Attachments are not supported' });
});

test('GET /v3/:domain/events filters, limits and pages', async function(t) {
  var app = await startApp(t);
  var rows = [
    { id: 'e1', eventType: 'delivered', timestamp: 1000 },
    { id: 'e2', eventType: 'opened', timestamp: 1001 },
    { id: 'e3', eventType: 'delivered', timestamp: 1002 },
    { id: 'e4', eventType: 'failed', timestamp: 1003 }
  ];
  for (var i = 0; i < rows.length; i += 1) {
    await app.db.insertEvent(Object.assign({ recipient: 'r@example.org', messageId: '<m@example.com>' }, rows[i]));
  }

  // Repeated keys arrive as an array under both Express query parsers.
  var first = await app.fetch('/v3/example.com/events?event=delivered&event=opened&limit=2', {
    headers: { authorization: AUTH }
  });
  assert.strictEqual(first.status, 200);
  var page = await first.json();
  assert.deepStrictEqual(page.items.map(function(item) { return item.id; }), ['e1', 'e2']);
  assert.strictEqual(page.items[0].event, 'delivered');
  assert.strictEqual(page.items[0].message.headers['message-id'], '<m@example.com>');
  var next = new URL(page.paging.next);
  assert.deepStrictEqual(next.searchParams.getAll('event'), ['delivered', 'opened']);
  assert.strictEqual(next.searchParams.get('limit'), '2');
  assert.ok(next.searchParams.get('page'));

  var second = await app.fetch(next.pathname + next.search, { headers: { authorization: AUTH } });
  assert.strictEqual(second.status, 200);
  assert.deepStrictEqual((await second.json()).items.map(function(item) { return item.id; }), ['e3']);

  // Ghost's mailgun client sends the Mailgun "OR" form as one value.
  var joined = await app.fetch('/v3/example.com/events?event=delivered%20OR%20opened', {
    headers: { authorization: AUTH }
  });
  assert.strictEqual((await joined.json()).items.length, 3);

  var bad = await app.fetch('/v3/example.com/events?page=not-base64-json', { headers: { authorization: AUTH } });
  assert.strictEqual(bad.status, 400);
});

test('DELETE /v3/:domain/:type/:email removes a suppression', async function(t) {
  var app = await startApp(t);
  await app.db.upsertSuppression('user+tag@example.org', 'unsubscribes');
  await app.db.upsertSuppression('user%x@example.org', 'bounces');

  var res = await app.fetch('/v3/example.com/unsubscribes/user%2Btag%40example.org', {
    method: 'DELETE',
    headers: { authorization: AUTH }
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    message: 'Address has been removed',
    value: '',
    address: 'user+tag@example.org'
  });
  assert.strictEqual((await app.db.query('SELECT email FROM suppressions', [])).length, 1);

  // A literal "%" in the address used to throw on a second decode.
  var percent = await app.fetch('/v3/example.com/bounces/user%25x%40example.org', {
    method: 'DELETE',
    headers: { authorization: AUTH }
  });
  assert.strictEqual(percent.status, 200);
  assert.strictEqual((await percent.json()).address, 'user%x@example.org');
  assert.strictEqual((await app.db.query('SELECT email FROM suppressions', [])).length, 0);

  var unknown = await app.fetch('/v3/example.com/nope/a%40b.c', {
    method: 'DELETE',
    headers: { authorization: AUTH }
  });
  assert.strictEqual(unknown.status, 404);
  assert.deepStrictEqual(await unknown.json(), { message: 'Unknown suppression type: nope' });
});

test('the admin dashboard serves its page, assets and health with auth disabled', async function(t) {
  var app = await startApp(t, { DISABLE_ADMIN_AUTH: '1' });

  var bare = await app.fetch('/ghost/mail');
  assert.strictEqual(bare.status, 302);
  assert.strictEqual(bare.headers.get('location'), '/ghost/mail/');

  var index = await app.fetch('/ghost/mail/');
  assert.strictEqual(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.strictEqual(index.headers.get('cache-control'), 'no-store');
  var html = await index.text();
  assert.ok(html.indexOf('"basePath":"/ghost/mail"') !== -1);
  assert.ok(html.indexOf('__GMB_RUNTIME_JSON__') === -1);

  var font = await app.fetch('/ghost/mail/fonts/inter-variable.woff2');
  assert.strictEqual(font.status, 200);
  assert.match(font.headers.get('cache-control'), /immutable/);

  // A missing static file is a 404, not a 500 from the router's error handler.
  var missing = await app.fetch('/ghost/mail/fonts/missing.woff2');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);

  var health = await app.fetch('/ghost/mail/api/health');
  assert.strictEqual(health.status, 200);
  var body = await health.json();
  assert.strictEqual(body.service, 'ghost-mail-bridge');
  assert.strictEqual(body.path, '/ghost/mail');
});

test('the admin dashboard requires a Ghost session on a custom base path', async function(t) {
  var app = await startApp(t, { GHOST_ADMIN_URL: 'http://127.0.0.1:9', ADMIN_BASE_PATH: 'ops/mail-2.0' });

  var api = await app.fetch('/ops/mail-2.0/');
  assert.strictEqual(api.status, 401);
  assert.deepStrictEqual(await api.json(), { message: 'Unauthorized: Ghost admin session required' });

  var browser = await app.fetch('/ops/mail-2.0/', { headers: { accept: 'text/html' } });
  assert.strictEqual(browser.status, 302);
  assert.strictEqual(browser.headers.get('location'), 'http://127.0.0.1:9/ghost/#/signin');
});

test('unknown routes are 404', async function(t) {
  var app = await startApp(t);
  var res = await app.fetch('/nope');
  assert.strictEqual(res.status, 404);
});
