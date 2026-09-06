var crypto = require('crypto');
var config = require('./config');
var { insertEvent, upsertSuppression, lookupRecipientEmail } = require('./db');
var { getProvider } = require('./providers');

var pollerState = {
  startedAt: null,
  lastPollStartedAt: null,
  lastPollFinishedAt: null,
  lastErrorAt: null,
  lastErrorMessage: '',
  lastMessagesReceived: 0,
  totalMessagesReceived: 0,
  totalEventsStored: 0,
  isRunning: false
};

function getPollerState() {
  return {
    startedAt: pollerState.startedAt,
    lastPollStartedAt: pollerState.lastPollStartedAt,
    lastPollFinishedAt: pollerState.lastPollFinishedAt,
    lastErrorAt: pollerState.lastErrorAt,
    lastErrorMessage: pollerState.lastErrorMessage,
    lastMessagesReceived: pollerState.lastMessagesReceived,
    totalMessagesReceived: pollerState.totalMessagesReceived,
    totalEventsStored: pollerState.totalEventsStored,
    isRunning: pollerState.isRunning
  };
}

function stripAngleBrackets(str) {
  if (!str) return str;
  return str.replace(/^</, '').replace(/>$/, '');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function buildEventId(normalized, sourceMessageId) {
  var parts = [
    sourceMessageId || '',
    normalized.event_type || '',
    normalized.recipient || '',
    String(normalized.timestamp || ''),
    normalized.provider_message_id || '',
    normalized.batch_message_id || '',
    normalized.delivery_status_code === null || normalized.delivery_status_code === undefined ? '' : String(normalized.delivery_status_code),
    normalized.delivery_status_enhanced || ''
  ];

  return sha256Hex(parts.join('|'));
}

async function processEvent(normalized, sourceMessageId) {
  var batchMessageId = normalized.batch_message_id;
  var ghostEmailId = normalized.ghost_email_id;
  var recipient = normalized.recipient;
  var tagsJson = '[]';

  if (normalized.provider_message_id) {
    var row = await lookupRecipientEmail(normalized.provider_message_id);
    if (row) {
      batchMessageId = stripAngleBrackets(row.batch_message_id);
      ghostEmailId = row.ghost_email_id || ghostEmailId;
      tagsJson = row.tags_json || tagsJson;
      // Engagement events (ACS View/Click) carry no recipient — recover it here.
      recipient = recipient || row.recipient;
    }
  }

  if (!recipient) {
    console.warn('Event poller: no recipient for ' + normalized.event_type + ' event (message ' +
      (normalized.provider_message_id || 'unknown') + '), skipping');
    return false;
  }

  await insertEvent({
    id: buildEventId(normalized, sourceMessageId),
    eventType: normalized.event_type,
    severity: normalized.severity,
    recipient: recipient,
    timestamp: normalized.timestamp,
    messageId: stripAngleBrackets(batchMessageId),
    emailId: ghostEmailId,
    deliveryStatusCode: normalized.delivery_status_code,
    deliveryStatusMessage: normalized.delivery_status_message,
    deliveryStatusEnhanced: normalized.delivery_status_enhanced,
    tagsJson: tagsJson
  });

  if (normalized.is_suppression) {
    await upsertSuppression(
      recipient,
      normalized.suppression_type,
      normalized.suppression_reason
    );
    console.log('Suppression recorded: ' + normalized.suppression_type + ' for ' + recipient);
  }

  return true;
}

async function pollOnce() {
  var provider = getProvider();
  var messages = await provider.queue.receiveMessages(
    config.sesEventsQueueUrl,
    config.eventPollBatchSize,
    config.eventPollWaitSeconds
  );

  if (messages.length === 0) {
    return { messagesReceived: 0, eventsStored: 0 };
  }

  console.log('Event poller: received ' + messages.length + ' message(s)');

  var eventsStored = 0;

  for (var i = 0; i < messages.length; i += 1) {
    var msg = messages[i];
    var parsedBody;

    try {
      parsedBody = provider.events.parseQueueMessage(msg.body);
    } catch (err) {
      console.error('Event poller: failed to parse event body:', err.message);
      await provider.queue.deleteMessage(config.sesEventsQueueUrl, msg.receiptHandle);
      continue;
    }

    if (!parsedBody || !parsedBody.events || parsedBody.events.length === 0) {
      console.warn('Event poller: unrecognized event format, deleting');
      await provider.queue.deleteMessage(config.sesEventsQueueUrl, msg.receiptHandle);
      continue;
    }

    for (var e = 0; e < parsedBody.events.length; e += 1) {
      var nativeEvent = parsedBody.events[e];
      var normalized = provider.events.mapEvent(nativeEvent);
      var stored = 0;

      for (var j = 0; j < normalized.length; j += 1) {
        if (await processEvent(normalized[j], parsedBody.sourceMessageId)) {
          stored += 1;
        }
      }

      eventsStored += stored;

      if (stored > 0) {
        console.log('Event poller: stored ' + stored + ' event(s) [' + provider.events.describeEvent(nativeEvent) + ']');
      }
    }

    await provider.queue.deleteMessage(config.sesEventsQueueUrl, msg.receiptHandle);
  }

  return {
    messagesReceived: messages.length,
    eventsStored: eventsStored
  };
}

function startPolling() {
  var stopped = false;
  pollerState.startedAt = new Date().toISOString();
  pollerState.isRunning = true;
  pollerState.lastErrorAt = null;
  pollerState.lastErrorMessage = '';

  console.log('Mail event poller started (queue: ' + config.sesEventsQueueUrl + ')');

  async function loop() {
    if (stopped) return;

    pollerState.lastPollStartedAt = new Date().toISOString();

    try {
      var summary = await pollOnce();
      pollerState.lastPollFinishedAt = new Date().toISOString();
      pollerState.lastMessagesReceived = summary.messagesReceived;
      pollerState.totalMessagesReceived += summary.messagesReceived;
      pollerState.totalEventsStored += summary.eventsStored;
    } catch (err) {
      pollerState.lastErrorAt = new Date().toISOString();
      pollerState.lastErrorMessage = err && err.message ? err.message : String(err);
      console.error('Mail event poller error:', pollerState.lastErrorMessage);
      await new Promise(function(resolve) {
        setTimeout(resolve, 5000);
      });
    }

    if (!stopped) {
      return loop();
    }
  }

  loop();

  return function stopPolling() {
    stopped = true;
    pollerState.isRunning = false;
  };
}

module.exports = {
  startPolling: startPolling,
  getPollerState: getPollerState,
  buildEventId: buildEventId
};
