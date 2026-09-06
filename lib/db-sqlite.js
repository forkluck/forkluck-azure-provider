var fs = require('fs');
var path = require('path');

// Timestamps are stored as ISO-8601 UTC text so that string comparison, the
// MySQL DATETIME columns and JSON output all line up.
var NOW = 'strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')';
var AGO = 'strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\', \'-\' || ? || \' seconds\')';

var dialect = {
  now: NOW,
  utcAgo: AGO,
  serverAgo: AGO,
  fromUnixtime: function(expr) {
    return 'strftime(\'%Y-%m-%dT%H:%M:%fZ\', ' + expr + ', \'unixepoch\')';
  },
  unixTimestamp: function(expr) { return 'CAST(strftime(\'%s\', ' + expr + ') AS INTEGER)'; },
  greatest: function(a, b) { return 'MAX(' + a + ', ' + b + ')'; },
  // Row locks are unnecessary: claims run inside a BEGIN IMMEDIATE transaction.
  forUpdate: '',

  // recipient_emails has two unique constraints, so both conflict targets need
  // a clause to match the MySQL ON DUPLICATE KEY UPDATE behaviour.
  upsertRecipientEmail:
    'INSERT INTO recipient_emails (ses_message_id, batch_message_id, recipient, ghost_email_id, tags_json) ' +
    'VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(ses_message_id) DO UPDATE SET ' +
      'ghost_email_id = excluded.ghost_email_id, tags_json = excluded.tags_json ' +
    'ON CONFLICT(batch_message_id, recipient) DO UPDATE SET ' +
      'ghost_email_id = excluded.ghost_email_id, tags_json = excluded.tags_json',

  upsertEvent:
    'INSERT INTO events (' +
      'id, event_type, severity, recipient, timestamp, message_id, email_id, delivery_status_code,' +
      'delivery_status_message, delivery_status_enhanced, tags_json' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET ' +
      'event_type = excluded.event_type,' +
      'severity = excluded.severity,' +
      'delivery_status_code = excluded.delivery_status_code,' +
      'delivery_status_message = excluded.delivery_status_message,' +
      'delivery_status_enhanced = excluded.delivery_status_enhanced',

  upsertSuppression:
    'INSERT INTO suppressions (email, type, reason) VALUES (?, ?, ?) ' +
    'ON CONFLICT(email, type) DO UPDATE SET reason = excluded.reason, updated_at = ' + NOW,

  upsertHeartbeat:
    'INSERT INTO runtime_heartbeats (instance_id, role, state_json) VALUES (?, ?, ?) ' +
    'ON CONFLICT(instance_id) DO UPDATE SET ' +
      'role = excluded.role, state_json = excluded.state_json, updated_at = ' + NOW,

  schema: [
    'CREATE TABLE IF NOT EXISTS batches (' +
      'id TEXT PRIMARY KEY,' +
      'batch_message_id TEXT NOT NULL UNIQUE,' +
      'domain TEXT NOT NULL,' +
      'ghost_email_id TEXT DEFAULT \'\',' +
      'status TEXT NOT NULL,' +
      'from_header TEXT NOT NULL,' +
      'subject TEXT NOT NULL,' +
      'html_body TEXT,' +
      'text_body TEXT,' +
      'reply_to TEXT,' +
      'sender TEXT,' +
      'list_unsubscribe_template TEXT,' +
      'list_unsubscribe_post_template TEXT,' +
      'custom_headers_json TEXT NOT NULL,' +
      'recipient_variables_json TEXT NOT NULL,' +
      'tags_json TEXT NOT NULL,' +
      'recipients_json TEXT NOT NULL,' +
      'total_recipients INTEGER NOT NULL,' +
      'queued_recipients INTEGER NOT NULL DEFAULT 0,' +
      'processing_recipients INTEGER NOT NULL DEFAULT 0,' +
      'sent_recipients INTEGER NOT NULL DEFAULT 0,' +
      'failed_recipients INTEGER NOT NULL DEFAULT 0,' +
      'last_error TEXT,' +
      'created_at TEXT NOT NULL DEFAULT (' + NOW + '),' +
      'updated_at TEXT NOT NULL DEFAULT (' + NOW + '),' +
      'queued_at TEXT,' +
      'started_at TEXT,' +
      'completed_at TEXT' +
    ')',
    'CREATE INDEX IF NOT EXISTS idx_batches_status ON batches (status)',
    'CREATE INDEX IF NOT EXISTS idx_batches_created_at ON batches (created_at)',

    'CREATE TABLE IF NOT EXISTS send_jobs (' +
      'id TEXT PRIMARY KEY,' +
      'batch_id TEXT NOT NULL UNIQUE,' +
      'status TEXT NOT NULL,' +
      'total_recipients INTEGER NOT NULL,' +
      'sent_recipients INTEGER NOT NULL DEFAULT 0,' +
      'failed_recipients INTEGER NOT NULL DEFAULT 0,' +
      'attempt_count INTEGER NOT NULL DEFAULT 0,' +
      'worker_instance_id TEXT DEFAULT NULL,' +
      'last_error TEXT,' +
      'created_at TEXT NOT NULL DEFAULT (' + NOW + '),' +
      'updated_at TEXT NOT NULL DEFAULT (' + NOW + '),' +
      'queued_at TEXT,' +
      'started_at TEXT,' +
      'completed_at TEXT,' +
      'FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE' +
    ')',
    'CREATE INDEX IF NOT EXISTS idx_send_jobs_status ON send_jobs (status)',
    'CREATE INDEX IF NOT EXISTS idx_send_jobs_updated_at ON send_jobs (updated_at)',

    // ses_message_id stores the provider message id — see lib/db-mysql.js.
    'CREATE TABLE IF NOT EXISTS recipient_emails (' +
      'ses_message_id TEXT PRIMARY KEY,' +
      'batch_message_id TEXT NOT NULL,' +
      'recipient TEXT NOT NULL,' +
      'ghost_email_id TEXT DEFAULT \'\',' +
      'tags_json TEXT NOT NULL,' +
      'created_at TEXT NOT NULL DEFAULT (' + NOW + '),' +
      'UNIQUE (batch_message_id, recipient)' +
    ')',
    'CREATE INDEX IF NOT EXISTS idx_recipient_emails_batch ON recipient_emails (batch_message_id)',
    'CREATE INDEX IF NOT EXISTS idx_recipient_emails_recipient ON recipient_emails (recipient)',
    'CREATE INDEX IF NOT EXISTS idx_recipient_emails_created_at ON recipient_emails (created_at)',

    'CREATE TABLE IF NOT EXISTS events (' +
      'id TEXT PRIMARY KEY,' +
      'event_type TEXT NOT NULL,' +
      'severity TEXT DEFAULT NULL,' +
      'recipient TEXT NOT NULL,' +
      'timestamp INTEGER NOT NULL,' +
      'message_id TEXT DEFAULT NULL,' +
      'email_id TEXT DEFAULT NULL,' +
      'delivery_status_code INTEGER DEFAULT NULL,' +
      'delivery_status_message TEXT,' +
      'delivery_status_enhanced TEXT,' +
      'tags_json TEXT NOT NULL,' +
      'created_at TEXT NOT NULL DEFAULT (' + NOW + ')' +
    ')',
    'CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type)',
    'CREATE INDEX IF NOT EXISTS idx_events_message ON events (message_id)',
    'CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at)',

    'CREATE TABLE IF NOT EXISTS suppressions (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'email TEXT NOT NULL,' +
      'type TEXT NOT NULL,' +
      'reason TEXT,' +
      'created_at TEXT NOT NULL DEFAULT (' + NOW + '),' +
      'updated_at TEXT NOT NULL DEFAULT (' + NOW + '),' +
      'UNIQUE (email, type)' +
    ')',
    'CREATE INDEX IF NOT EXISTS idx_suppressions_created_at ON suppressions (created_at)',

    'CREATE TABLE IF NOT EXISTS runtime_heartbeats (' +
      'instance_id TEXT PRIMARY KEY,' +
      'role TEXT NOT NULL,' +
      'state_json TEXT NOT NULL,' +
      'created_at TEXT NOT NULL DEFAULT (' + NOW + '),' +
      'updated_at TEXT NOT NULL DEFAULT (' + NOW + ')' +
    ')',
    'CREATE INDEX IF NOT EXISTS idx_runtime_role_updated_at ON runtime_heartbeats (role, updated_at)'
  ]
};

function openDatabase(file) {
  var Database = require('better-sqlite3');

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  var db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

function createDriver(config) {
  var db = openDatabase(config.database.file);
  // better-sqlite3 is synchronous, so a transaction holds the single connection
  // for its whole body. Serialise transactions to keep concurrent callers in
  // this process from nesting BEGIN statements.
  var transactionQueue = Promise.resolve();

  function run(sql, params) {
    var statement = db.prepare(sql);
    if (statement.reader) return statement.all(params || []);
    var info = statement.run(params || []);
    return { affectedRows: info.changes, insertId: Number(info.lastInsertRowid) };
  }

  var connection = {
    query: async function(sql, params) { return run(sql, params); },
    execute: async function(sql, params) { return run(sql, params); }
  };

  async function runTransaction(fn) {
    run('BEGIN IMMEDIATE');
    try {
      var result = await fn(connection);
      run('COMMIT');
      return result;
    } catch (err) {
      try {
        run('ROLLBACK');
      } catch (_rollbackErr) {
        // Best effort rollback.
      }
      throw err;
    }
  }

  return {
    dialect: dialect,
    query: connection.query,
    execute: connection.execute,
    withTransaction: function(fn) {
      var next = transactionQueue.then(function() { return runTransaction(fn); });
      transactionQueue = next.catch(function() {});
      return next;
    },
    close: async function() { db.close(); }
  };
}

module.exports = { createDriver: createDriver, dialect: dialect };
