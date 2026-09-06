var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { loadLib, purgeLibCache } = require('./helpers');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-sqlite-'));
var dbFile = path.join(tmpDir, 'bridge.db');
var requireLib = loadLib({ DATABASE_URL: 'sqlite://' + dbFile });
var db = requireLib('db.js');

function batchInput(suffix) {
  return {
    batchId: 'batch-' + suffix,
    jobId: 'job-' + suffix,
    batchMessageId: 'msg-' + suffix,
    domain: 'example.com',
    ghostEmailId: 'ghost-' + suffix,
    from: 'Newsletter <news@example.com>',
    subject: 'Hello',
    html: '<p>hi</p>',
    text: 'hi',
    customHeadersJson: '{}',
    recipientVariablesJson: '{}',
    tagsJson: '[]',
    recipientsJson: JSON.stringify(['a@example.com']),
    totalRecipients: 1
  };
}

test.after(async function() {
  await db.closeDb();
  purgeLibCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('schema init is idempotent', async function() {
  await db.initDb();
  await db.initDb();

  assert.deepStrictEqual(await db.getTableCounts(), {
    batches: 0,
    send_jobs: 0,
    recipient_emails: 0,
    events: 0,
    suppressions: 0
  });
});

test('batch and job round trip through a claim', async function() {
  await db.createBatchWithJob(batchInput('1'));

  var job = await db.getSendJobWithBatch('job-1');
  assert.strictEqual(job.job_status, 'queued');
  assert.strictEqual(job.batch_message_id, 'msg-1');
  assert.strictEqual(job.total_recipients, 1);
  assert.match(job.job_queued_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

  assert.deepStrictEqual(await db.claimSendJob('job-1', 'worker-1'), { claimed: true });

  var claimed = await db.getSendJobWithBatch('job-1');
  assert.strictEqual(claimed.job_status, 'processing');
  assert.strictEqual(claimed.batch_status, 'processing');
  assert.strictEqual(claimed.worker_instance_id, 'worker-1');
  assert.strictEqual(claimed.attempt_count, 1);
  assert.strictEqual(claimed.processing_recipients, 1);

  assert.deepStrictEqual(
    await db.claimSendJob('job-1', 'worker-2'),
    { claimed: false, reason: 'processing' }
  );
  assert.deepStrictEqual(
    await db.claimSendJob('missing-job', 'worker-2'),
    { claimed: false, reason: 'missing' }
  );

  await db.setSendJobResult('job-1', 'batch-1', {
    status: 'completed',
    sentRecipients: 1,
    failedRecipients: 0
  });

  var done = await db.getSendJobWithBatch('job-1');
  assert.strictEqual(done.job_status, 'completed');
  assert.strictEqual(done.sent_recipients, 1);

  assert.deepStrictEqual(
    await db.claimSendJob('job-1', 'worker-2'),
    { claimed: false, reason: 'completed' }
  );
});

test('concurrent transactions are serialised', async function() {
  await Promise.all([
    db.createBatchWithJob(batchInput('c1')),
    db.createBatchWithJob(batchInput('c2'))
  ]);

  assert.ok(await db.getSendJobWithBatch('job-c1'));
  assert.ok(await db.getSendJobWithBatch('job-c2'));
});

test('recipient emails upsert and look up by provider message id', async function() {
  await db.recordRecipientEmail({
    providerMessageId: 'ses-1',
    batchMessageId: 'msg-1',
    recipient: 'a@example.com',
    ghostEmailId: 'ghost-1',
    tagsJson: '["one"]'
  });

  // Same provider message id: updates in place.
  await db.recordRecipientEmail({
    providerMessageId: 'ses-1',
    batchMessageId: 'msg-1',
    recipient: 'a@example.com',
    ghostEmailId: 'ghost-2',
    tagsJson: '["two"]'
  });

  // Same (batch, recipient) under a new provider message id: also an update,
  // matching MySQL's ON DUPLICATE KEY UPDATE across both unique keys.
  await db.recordRecipientEmail({
    providerMessageId: 'ses-2',
    batchMessageId: 'msg-1',
    recipient: 'a@example.com',
    ghostEmailId: 'ghost-3',
    tagsJson: '["three"]'
  });

  var row = await db.lookupRecipientEmail('ses-1');
  assert.strictEqual(row.ghost_email_id, 'ghost-3');
  assert.strictEqual(row.tags_json, '["three"]');
  assert.strictEqual(await db.lookupRecipientEmail('nope'), null);

  assert.deepStrictEqual(
    await db.getExistingRecipientsForBatch('msg-1'),
    ['a@example.com']
  );
  assert.strictEqual(await db.countRecipientEmailsSince(3600), 1);

  await db.query('UPDATE recipient_emails SET created_at = ?', ['2000-01-01T00:00:00.000Z']);
  assert.strictEqual(await db.countRecipientEmailsSince(3600), 0);
  await db.query('UPDATE recipient_emails SET created_at = ' + db.getDialect().now);
});

test('events dedupe on id', async function() {
  var event = {
    id: 'evt-1',
    eventType: 'delivered',
    severity: null,
    recipient: 'a@example.com',
    timestamp: Date.now(),
    messageId: 'ses-1',
    emailId: null,
    deliveryStatusCode: 250,
    deliveryStatusMessage: 'ok',
    deliveryStatusEnhanced: '2.0.0',
    tagsJson: '[]'
  };

  await db.insertEvent(event);
  await db.insertEvent(Object.assign({}, event, { eventType: 'failed', deliveryStatusCode: 550 }));

  var rows = await db.query('SELECT * FROM events WHERE id = ?', ['evt-1']);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].event_type, 'failed');
  assert.strictEqual(rows[0].delivery_status_code, 550);
});

test('suppressions upsert on (email, type) and delete', async function() {
  await db.upsertSuppression('a@example.com', 'bounces', 'hard bounce');
  await db.upsertSuppression('a@example.com', 'bounces', 'still bouncing');
  await db.upsertSuppression('a@example.com', 'complaints', null);

  var rows = await db.query('SELECT email, type, reason FROM suppressions ORDER BY type');
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], { email: 'a@example.com', type: 'bounces', reason: 'still bouncing' });
  assert.strictEqual(rows[1].reason, null);

  await db.deleteSuppression('a@example.com', 'complaints');
  assert.strictEqual((await db.getTableCounts()).suppressions, 1);
});

test('runtime heartbeats power the account status view', async function() {
  await db.updateRuntimeHeartbeat('worker-1', 'worker', { queue: 1 });
  await db.updateRuntimeHeartbeat('worker-1', 'worker', { queue: 2 });

  var live = await db.listRuntimeHeartbeats('worker', 60);
  assert.strictEqual(live.length, 1);
  assert.deepStrictEqual(live[0].state, { queue: 2 });
  assert.strictEqual(live[0].instanceId, 'worker-1');
  assert.strictEqual((await db.listRuntimeHeartbeats('api', 60)).length, 0);

  await db.query('UPDATE runtime_heartbeats SET updated_at = ?', ['2000-01-01T00:00:00.000Z']);
  assert.strictEqual((await db.listRuntimeHeartbeats('worker', 60)).length, 0);
  await db.query('UPDATE runtime_heartbeats SET updated_at = ' + db.getDialect().now);
});

test('table counts and dashboard time bucketing work', async function() {
  var counts = await db.getTableCounts();
  assert.strictEqual(counts.batches, 3);
  assert.strictEqual(counts.send_jobs, 3);
  assert.strictEqual(counts.recipient_emails, 1);
  assert.strictEqual(counts.events, 1);

  var d = db.getDialect();
  var since = Math.floor(Date.now() / 1000) - 3600;
  var rows = await db.query(
    'SELECT FLOOR(' + d.unixTimestamp('created_at') + ' / ?) * ? AS bucket, COUNT(*) AS c ' +
    'FROM recipient_emails WHERE created_at >= ' + d.fromUnixtime('?') + ' GROUP BY bucket',
    [3600, 3600, since]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(Number(rows[0].c), 1);
  assert.ok(Number(rows[0].bucket) >= since - 3600);
});

test('cleanup drops expired rows and cascades to send jobs', async function() {
  await db.cleanupExpiredData();
  var kept = await db.getTableCounts();
  assert.strictEqual(kept.batches, 3);
  assert.strictEqual(kept.send_jobs, 3);

  await db.query('UPDATE batches SET created_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', 'batch-c2']);
  await db.cleanupExpiredData();

  var after = await db.getTableCounts();
  assert.strictEqual(after.batches, 2);
  assert.strictEqual(after.send_jobs, 2);
});
