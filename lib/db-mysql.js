var mysql = require('mysql2/promise');

var TABLE_OPTIONS = ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

var dialect = {
  // Current time expressions. `utcAgo` and `serverAgo` each take one `?` bound
  // to a number of seconds.
  now: 'UTC_TIMESTAMP()',
  utcAgo: 'FROM_UNIXTIME(UNIX_TIMESTAMP(UTC_TIMESTAMP()) - ?)',
  serverAgo: '(NOW() - INTERVAL ? SECOND)',
  fromUnixtime: function(expr) { return 'FROM_UNIXTIME(' + expr + ')'; },
  unixTimestamp: function(expr) { return 'UNIX_TIMESTAMP(' + expr + ')'; },
  greatest: function(a, b) { return 'GREATEST(' + a + ', ' + b + ')'; },
  forUpdate: ' FOR UPDATE',

  upsertRecipientEmail:
    'INSERT INTO recipient_emails (ses_message_id, batch_message_id, recipient, ghost_email_id, tags_json) ' +
    'VALUES (?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE ghost_email_id = VALUES(ghost_email_id), tags_json = VALUES(tags_json)',

  upsertEvent:
    'INSERT INTO events (' +
      'id, event_type, severity, recipient, timestamp, message_id, email_id, delivery_status_code,' +
      'delivery_status_message, delivery_status_enhanced, tags_json' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE ' +
      'event_type = VALUES(event_type),' +
      'severity = VALUES(severity),' +
      'delivery_status_code = VALUES(delivery_status_code),' +
      'delivery_status_message = VALUES(delivery_status_message),' +
      'delivery_status_enhanced = VALUES(delivery_status_enhanced)',

  upsertSuppression:
    'INSERT INTO suppressions (email, type, reason) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE reason = VALUES(reason), updated_at = UTC_TIMESTAMP()',

  upsertHeartbeat:
    'INSERT INTO runtime_heartbeats (instance_id, role, state_json) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE role = VALUES(role), state_json = VALUES(state_json), updated_at = UTC_TIMESTAMP()',

  schema: [
    'CREATE TABLE IF NOT EXISTS batches (' +
      'id CHAR(36) PRIMARY KEY,' +
      'batch_message_id VARCHAR(255) NOT NULL UNIQUE,' +
      'domain VARCHAR(255) NOT NULL,' +
      'ghost_email_id VARCHAR(255) DEFAULT \'\',' +
      'status VARCHAR(32) NOT NULL,' +
      'from_header TEXT NOT NULL,' +
      'subject TEXT NOT NULL,' +
      'html_body LONGTEXT,' +
      'text_body LONGTEXT,' +
      'reply_to TEXT,' +
      'sender TEXT,' +
      'list_unsubscribe_template TEXT,' +
      'list_unsubscribe_post_template TEXT,' +
      'custom_headers_json LONGTEXT NOT NULL,' +
      'recipient_variables_json LONGTEXT NOT NULL,' +
      'tags_json LONGTEXT NOT NULL,' +
      'recipients_json LONGTEXT NOT NULL,' +
      'total_recipients INT NOT NULL,' +
      'queued_recipients INT NOT NULL DEFAULT 0,' +
      'processing_recipients INT NOT NULL DEFAULT 0,' +
      'sent_recipients INT NOT NULL DEFAULT 0,' +
      'failed_recipients INT NOT NULL DEFAULT 0,' +
      'last_error TEXT,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'queued_at DATETIME NULL,' +
      'started_at DATETIME NULL,' +
      'completed_at DATETIME NULL,' +
      'KEY idx_batches_status (status),' +
      'KEY idx_batches_created_at (created_at)' +
    TABLE_OPTIONS,

    'CREATE TABLE IF NOT EXISTS send_jobs (' +
      'id CHAR(36) PRIMARY KEY,' +
      'batch_id CHAR(36) NOT NULL UNIQUE,' +
      'status VARCHAR(32) NOT NULL,' +
      'total_recipients INT NOT NULL,' +
      'sent_recipients INT NOT NULL DEFAULT 0,' +
      'failed_recipients INT NOT NULL DEFAULT 0,' +
      'attempt_count INT NOT NULL DEFAULT 0,' +
      'worker_instance_id VARCHAR(255) DEFAULT NULL,' +
      'last_error TEXT,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'queued_at DATETIME NULL,' +
      'started_at DATETIME NULL,' +
      'completed_at DATETIME NULL,' +
      'CONSTRAINT fk_send_jobs_batch FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,' +
      'KEY idx_send_jobs_status (status),' +
      'KEY idx_send_jobs_updated_at (updated_at)' +
    TABLE_OPTIONS,

    // ses_message_id stores the provider message id — the SES message id, or the
    // ACS beginSend operation id when MAIL_PROVIDER=azure. The column name is kept
    // for backwards compatibility with existing databases.
    'CREATE TABLE IF NOT EXISTS recipient_emails (' +
      'ses_message_id VARCHAR(255) PRIMARY KEY,' +
      'batch_message_id VARCHAR(255) NOT NULL,' +
      'recipient VARCHAR(320) NOT NULL,' +
      'ghost_email_id VARCHAR(255) DEFAULT \'\',' +
      'tags_json LONGTEXT NOT NULL,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'UNIQUE KEY uniq_batch_recipient (batch_message_id, recipient),' +
      'KEY idx_recipient_emails_batch (batch_message_id),' +
      'KEY idx_recipient_emails_recipient (recipient),' +
      'KEY idx_recipient_emails_created_at (created_at)' +
    TABLE_OPTIONS,

    'CREATE TABLE IF NOT EXISTS events (' +
      'id VARCHAR(64) PRIMARY KEY,' +
      'event_type VARCHAR(32) NOT NULL,' +
      'severity VARCHAR(32) DEFAULT NULL,' +
      'recipient VARCHAR(320) NOT NULL,' +
      'timestamp BIGINT NOT NULL,' +
      'message_id VARCHAR(255) DEFAULT NULL,' +
      'email_id VARCHAR(255) DEFAULT NULL,' +
      'delivery_status_code INT DEFAULT NULL,' +
      'delivery_status_message TEXT,' +
      'delivery_status_enhanced TEXT,' +
      'tags_json LONGTEXT NOT NULL,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'KEY idx_events_timestamp (timestamp),' +
      'KEY idx_events_type (event_type),' +
      'KEY idx_events_message (message_id),' +
      'KEY idx_events_created_at (created_at)' +
    TABLE_OPTIONS,

    'CREATE TABLE IF NOT EXISTS suppressions (' +
      'id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,' +
      'email VARCHAR(320) NOT NULL,' +
      'type VARCHAR(32) NOT NULL,' +
      'reason TEXT,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'UNIQUE KEY uniq_suppressions_email_type (email, type),' +
      'KEY idx_suppressions_created_at (created_at)' +
    TABLE_OPTIONS,

    'CREATE TABLE IF NOT EXISTS runtime_heartbeats (' +
      'instance_id VARCHAR(255) PRIMARY KEY,' +
      'role VARCHAR(32) NOT NULL,' +
      'state_json LONGTEXT NOT NULL,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'KEY idx_runtime_role_updated_at (role, updated_at)' +
    TABLE_OPTIONS
  ]
};

function wrapConnection(connection) {
  return {
    query: async function(sql, params) {
      var result = await connection.query(sql, params || []);
      return result[0];
    },
    execute: async function(sql, params) {
      var result = await connection.execute(sql, params || []);
      return result[0];
    }
  };
}

function createDriver(config) {
  var settings = config.database;
  var pool = mysql.createPool({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: config.dbConnectionLimit,
    connectTimeout: config.dbConnectTimeoutMs,
    timezone: 'Z'
  });

  var wrapped = wrapConnection(pool);

  return {
    dialect: dialect,
    query: wrapped.query,
    execute: wrapped.execute,
    withTransaction: async function(fn) {
      var connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        var result = await fn(wrapConnection(connection));
        await connection.commit();
        return result;
      } catch (err) {
        try {
          await connection.rollback();
        } catch (_rollbackErr) {
          // Best effort rollback.
        }
        throw err;
      } finally {
        connection.release();
      }
    },
    close: function() { return pool.end(); }
  };
}

module.exports = { createDriver: createDriver, dialect: dialect };
