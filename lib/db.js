var config = require('./config');

var driver;
var cleanupTimer;

function getDriver() {
  if (!driver) {
    var factory = config.database.driver === 'sqlite'
      ? require('./db-sqlite')
      : require('./db-mysql');

    driver = factory.createDriver(config);
  }

  return driver;
}

// SQL fragments that differ between MySQL and SQLite. Also used by the admin
// dashboard queries.
function getDialect() {
  return getDriver().dialect;
}

async function query(sql, params) {
  return getDriver().query(sql, params);
}

async function execute(sql, params) {
  return getDriver().execute(sql, params);
}

async function queryOne(sql, params) {
  var rows = await query(sql, params);
  return rows[0] || null;
}

async function withTransaction(fn) {
  return getDriver().withTransaction(fn);
}

function unwrapCount(row, key) {
  return Number(row && row[key]) || 0;
}

async function ensureSchema() {
  var statements = getDialect().schema;

  for (var i = 0; i < statements.length; i += 1) {
    await query(statements[i]);
  }
}

async function initDb() {
  await ensureSchema();
  return getDriver();
}

async function getTableCounts() {
  var counts = await Promise.all([
    queryOne('SELECT COUNT(*) AS c FROM batches'),
    queryOne('SELECT COUNT(*) AS c FROM send_jobs'),
    queryOne('SELECT COUNT(*) AS c FROM recipient_emails'),
    queryOne('SELECT COUNT(*) AS c FROM events'),
    queryOne('SELECT COUNT(*) AS c FROM suppressions')
  ]);

  return {
    batches: unwrapCount(counts[0], 'c'),
    send_jobs: unwrapCount(counts[1], 'c'),
    recipient_emails: unwrapCount(counts[2], 'c'),
    events: unwrapCount(counts[3], 'c'),
    suppressions: unwrapCount(counts[4], 'c')
  };
}

async function createBatchWithJob(input) {
  var now = getDialect().now;

  return withTransaction(async function(connection) {
    await connection.execute(
      'INSERT INTO batches (' +
        'id, batch_message_id, domain, ghost_email_id, status, from_header, subject, html_body, text_body,' +
        'reply_to, sender, list_unsubscribe_template, list_unsubscribe_post_template,' +
        'custom_headers_json, recipient_variables_json, tags_json, recipients_json, total_recipients,' +
        'queued_recipients, processing_recipients, sent_recipients, failed_recipients, queued_at' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ' + now + ')',
      [
        input.batchId,
        input.batchMessageId,
        input.domain,
        input.ghostEmailId || '',
        'queued',
        input.from,
        input.subject,
        input.html || '',
        input.text || '',
        input.replyTo || '',
        input.sender || '',
        input.listUnsubscribe || '',
        input.listUnsubscribePost || '',
        input.customHeadersJson,
        input.recipientVariablesJson,
        input.tagsJson,
        input.recipientsJson,
        input.totalRecipients,
        input.totalRecipients,
        0,
        0,
        0
      ]
    );

    await connection.execute(
      'INSERT INTO send_jobs (' +
        'id, batch_id, status, total_recipients, sent_recipients, failed_recipients, queued_at' +
      ') VALUES (?, ?, ?, ?, ?, ?, ' + now + ')',
      [
        input.jobId,
        input.batchId,
        'queued',
        input.totalRecipients,
        0,
        0
      ]
    );

    return {
      batchId: input.batchId,
      jobId: input.jobId
    };
  });
}

async function getSendJobWithBatch(jobId) {
  return queryOne(
    'SELECT ' +
      'j.id AS job_id, j.status AS job_status, j.total_recipients AS job_total_recipients,' +
      'j.sent_recipients AS job_sent_recipients, j.failed_recipients AS job_failed_recipients,' +
      'j.attempt_count, j.worker_instance_id, j.last_error AS job_last_error,' +
      'j.queued_at AS job_queued_at, j.started_at AS job_started_at, j.completed_at AS job_completed_at,' +
      'b.id AS batch_id, b.batch_message_id, b.domain, b.ghost_email_id, b.status AS batch_status,' +
      'b.from_header, b.subject, b.html_body, b.text_body, b.reply_to, b.sender,' +
      'b.list_unsubscribe_template, b.list_unsubscribe_post_template, b.custom_headers_json,' +
      'b.recipient_variables_json, b.tags_json, b.recipients_json, b.total_recipients,' +
      'b.queued_recipients, b.processing_recipients, b.sent_recipients, b.failed_recipients,' +
      'b.last_error AS batch_last_error, b.created_at, b.updated_at, b.started_at, b.completed_at ' +
    'FROM send_jobs j INNER JOIN batches b ON b.id = j.batch_id WHERE j.id = ?',
    [jobId]
  );
}

async function claimSendJob(jobId, workerInstanceId) {
  var d = getDialect();

  return withTransaction(async function(connection) {
    var rows = await connection.query(
      'SELECT id, batch_id, status FROM send_jobs WHERE id = ?' + d.forUpdate,
      [jobId]
    );
    var job = rows[0];

    if (!job) {
      return { claimed: false, reason: 'missing' };
    }

    if (job.status === 'processing') {
      return { claimed: false, reason: 'processing' };
    }

    if (job.status === 'completed') {
      return { claimed: false, reason: 'completed' };
    }

    await connection.execute(
      'UPDATE send_jobs SET status = ?, worker_instance_id = ?, attempt_count = attempt_count + 1,' +
      'started_at = COALESCE(started_at, ' + d.now + '), completed_at = NULL, last_error = NULL,' +
      'updated_at = ' + d.now + ' WHERE id = ?',
      ['processing', workerInstanceId, jobId]
    );

    await connection.execute(
      'UPDATE batches SET status = ?, queued_recipients = 0,' +
      'processing_recipients = ' + d.greatest('total_recipients - sent_recipients - failed_recipients', '0') + ',' +
      'started_at = COALESCE(started_at, ' + d.now + '), completed_at = NULL, last_error = NULL,' +
      'updated_at = ' + d.now + ' WHERE id = ?',
      ['processing', job.batch_id]
    );

    return { claimed: true };
  });
}

async function setSendJobResult(jobId, batchId, result) {
  var now = getDialect().now;

  return withTransaction(async function(connection) {
    await connection.execute(
      'UPDATE send_jobs SET status = ?, sent_recipients = ?, failed_recipients = ?,' +
      'completed_at = ' + now + ', last_error = ?, updated_at = ' + now + ' WHERE id = ?',
      [
        result.status,
        result.sentRecipients,
        result.failedRecipients,
        result.lastError || null,
        jobId
      ]
    );

    await connection.execute(
      'UPDATE batches SET status = ?, queued_recipients = ?, processing_recipients = ?, sent_recipients = ?, failed_recipients = ?,' +
      'completed_at = ' + now + ', last_error = ?, updated_at = ' + now + ' WHERE id = ?',
      [
        result.status,
        result.queuedRecipients || 0,
        0,
        result.sentRecipients,
        result.failedRecipients,
        result.lastError || null,
        batchId
      ]
    );
  });
}

async function setSendJobRetryState(jobId, batchId, result) {
  var now = getDialect().now;

  return withTransaction(async function(connection) {
    await connection.execute(
      'UPDATE send_jobs SET status = ?, sent_recipients = ?, failed_recipients = ?, completed_at = NULL, last_error = ?, updated_at = ' + now + ' WHERE id = ?',
      [
        result.status,
        result.sentRecipients,
        result.failedRecipients,
        result.lastError || null,
        jobId
      ]
    );

    await connection.execute(
      'UPDATE batches SET status = ?, queued_recipients = ?, processing_recipients = ?, sent_recipients = ?, failed_recipients = ?,' +
      'completed_at = NULL, last_error = ?, updated_at = ' + now + ' WHERE id = ?',
      [
        result.status,
        result.queuedRecipients,
        0,
        result.sentRecipients,
        result.failedRecipients,
        result.lastError || null,
        batchId
      ]
    );
  });
}

async function recordRecipientEmail(record) {
  await execute(getDialect().upsertRecipientEmail, [
    record.providerMessageId,
    record.batchMessageId,
    record.recipient,
    record.ghostEmailId || '',
    record.tagsJson || '[]'
  ]);
}

async function getExistingRecipientsForBatch(batchMessageId) {
  var rows = await query(
    'SELECT recipient FROM recipient_emails WHERE batch_message_id = ?',
    [batchMessageId]
  );

  return rows.map(function(row) { return row.recipient; });
}

async function lookupRecipientEmail(providerMessageId) {
  return queryOne(
    'SELECT * FROM recipient_emails WHERE ses_message_id = ?',
    [providerMessageId]
  );
}

async function countRecipientEmailsSince(seconds) {
  var row = await queryOne(
    'SELECT COUNT(*) AS c FROM recipient_emails WHERE created_at >= ' + getDialect().serverAgo,
    [seconds]
  );

  return unwrapCount(row, 'c');
}

async function insertEvent(record) {
  await execute(getDialect().upsertEvent, [
    record.id,
    record.eventType,
    record.severity || null,
    record.recipient,
    record.timestamp,
    record.messageId || null,
    record.emailId || null,
    record.deliveryStatusCode === undefined ? null : record.deliveryStatusCode,
    record.deliveryStatusMessage || '',
    record.deliveryStatusEnhanced || '',
    record.tagsJson || '[]'
  ]);
}

async function upsertSuppression(email, type, reason) {
  await execute(getDialect().upsertSuppression, [email, type, reason || null]);
}

async function deleteSuppression(email, type) {
  await execute(
    'DELETE FROM suppressions WHERE email = ? AND type = ?',
    [email, type]
  );
}

async function updateRuntimeHeartbeat(instanceId, role, state) {
  await execute(getDialect().upsertHeartbeat, [instanceId, role, JSON.stringify(state || {})]);
}

async function listRuntimeHeartbeats(role, maxAgeSeconds) {
  var rows = await query(
    'SELECT instance_id, role, state_json, created_at, updated_at FROM runtime_heartbeats ' +
    'WHERE role = ? AND updated_at >= ' + getDialect().utcAgo + ' ORDER BY updated_at DESC',
    [role, maxAgeSeconds]
  );

  return rows.map(function(row) {
    var state = {};
    try {
      state = JSON.parse(row.state_json || '{}');
    } catch (_err) {
      state = {};
    }

    return {
      instanceId: row.instance_id,
      role: row.role,
      state: state,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

async function cleanupExpiredData() {
  var ago = getDialect().utcAgo;

  await query(
    'DELETE FROM batches WHERE created_at < ' + ago,
    [config.batchRetentionDays * 86400]
  );

  await query(
    'DELETE FROM recipient_emails WHERE created_at < ' + ago,
    [config.batchRetentionDays * 86400]
  );

  await query(
    'DELETE FROM events WHERE created_at < ' + ago,
    [config.eventRetentionDays * 86400]
  );

  await query(
    'DELETE FROM runtime_heartbeats WHERE updated_at < ' + ago,
    [7 * 86400]
  );

  if (config.suppressionRetentionDays > 0) {
    await query(
      'DELETE FROM suppressions WHERE created_at < ' + ago,
      [config.suppressionRetentionDays * 86400]
    );
  }
}

function startCleanupTask() {
  if (cleanupTimer) return cleanupTimer;

  cleanupTimer = setInterval(function() {
    cleanupExpiredData().catch(function(err) {
      console.error('Cleanup error:', err && err.message ? err.message : String(err));
    });
  }, config.cleanupIntervalMs);

  return cleanupTimer;
}

function stopCleanupTask() {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

async function closeDb() {
  stopCleanupTask();

  if (!driver) return;

  var current = driver;
  driver = null;
  await current.close();
}

module.exports = {
  initDb: initDb,
  closeDb: closeDb,
  query: query,
  queryOne: queryOne,
  execute: execute,
  withTransaction: withTransaction,
  getDialect: getDialect,
  getTableCounts: getTableCounts,
  createBatchWithJob: createBatchWithJob,
  getSendJobWithBatch: getSendJobWithBatch,
  claimSendJob: claimSendJob,
  setSendJobResult: setSendJobResult,
  setSendJobRetryState: setSendJobRetryState,
  recordRecipientEmail: recordRecipientEmail,
  getExistingRecipientsForBatch: getExistingRecipientsForBatch,
  lookupRecipientEmail: lookupRecipientEmail,
  countRecipientEmailsSince: countRecipientEmailsSince,
  insertEvent: insertEvent,
  upsertSuppression: upsertSuppression,
  deleteSuppression: deleteSuppression,
  updateRuntimeHeartbeat: updateRuntimeHeartbeat,
  listRuntimeHeartbeats: listRuntimeHeartbeats,
  cleanupExpiredData: cleanupExpiredData,
  startCleanupTask: startCleanupTask,
  stopCleanupTask: stopCleanupTask
};
