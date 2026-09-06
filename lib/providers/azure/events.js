// Event Grid (ACS email) event → Mailgun event normalization.
// Pure functions: no DB access, no side effects.

var DELIVERY_EVENT = 'Microsoft.Communication.EmailDeliveryReportReceived';
var ENGAGEMENT_EVENT = 'Microsoft.Communication.EmailEngagementTrackingReportReceived';

var HANDLED_EVENT_TYPES = {};
HANDLED_EVENT_TYPES[DELIVERY_EVENT] = true;
HANDLED_EVENT_TYPES[ENGAGEMENT_EVENT] = true;

// ACS delivery statuses. Expanded is a fan-out notice with no Mailgun equivalent.
var DELIVERY_STATUS_MAP = {
  Delivered: {
    event: 'delivered', severity: null, code: 250, message: 'OK'
  },
  Bounced: {
    event: 'failed', severity: 'permanent', code: 607, message: 'Not delivering to previously bounced address',
    suppressionType: 'bounces', suppressionReason: 'Permanent bounce'
  },
  Suppressed: {
    event: 'failed', severity: 'permanent', code: 607, message: 'Suppressed by ACS',
    suppressionType: 'bounces', suppressionReason: 'Suppressed by ACS'
  },
  Quarantined: {
    event: 'failed', severity: 'permanent', code: 554, message: 'Quarantined by the recipient server'
  },
  FilteredSpam: {
    event: 'failed', severity: 'permanent', code: 554, message: 'Filtered as spam by the recipient server'
  },
  Failed: {
    event: 'failed', severity: 'temporary', code: 450, message: 'Delivery failed'
  },
  Expired: {
    event: 'failed', severity: 'temporary', code: 450, message: 'Delivery attempts expired'
  }
};

var ENGAGEMENT_TYPE_MAP = {
  view: 'opened',
  click: 'clicked'
};

function toEpochSeconds(value, fallback) {
  var parsed = value ? Date.parse(value) : NaN;
  if (!Number.isNaN(parsed)) return parsed / 1000;

  var parsedFallback = fallback ? Date.parse(fallback) : NaN;
  if (!Number.isNaN(parsedFallback)) return parsedFallback / 1000;

  return Date.now() / 1000;
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch (_err) {
    return false;
  }
}

// Event Grid pushes base64-encoded JSON into a Storage Queue; a single event or
// an array of them.
function parseQueueMessage(body) {
  var text = String(body === undefined || body === null ? '' : body);

  if (text && !isJson(text) && /^[A-Za-z0-9+/\s]+={0,2}$/.test(text)) {
    text = Buffer.from(text, 'base64').toString('utf8');
  }

  var parsed = JSON.parse(text);
  var candidates = Array.isArray(parsed) ? parsed : [parsed];
  var events = candidates.filter(function(event) {
    return event && HANDLED_EVENT_TYPES[event.eventType];
  });

  if (events.length === 0) return null;

  return {
    events: events,
    sourceMessageId: 'eg:' + (events[0].id || '')
  };
}

function mapDeliveryReport(event) {
  var data = event.data || {};
  var mapping = DELIVERY_STATUS_MAP[data.status];

  if (!mapping) return [];

  var details = data.deliveryStatusDetails || {};
  var statusMessage = details.statusMessage || '';

  return [{
    event_type: mapping.event,
    severity: mapping.severity,
    recipient: data.recipient || null,
    timestamp: toEpochSeconds(data.deliveryAttemptTimeStamp, event.eventTime),
    provider_message_id: data.messageId || null,
    ghost_email_id: null,
    batch_message_id: null,
    delivery_status_code: mapping.code,
    delivery_status_message: statusMessage || mapping.message,
    delivery_status_enhanced: statusMessage,
    is_suppression: !!mapping.suppressionType,
    suppression_type: mapping.suppressionType || null,
    suppression_reason: mapping.suppressionReason || null
  }];
}

function mapEngagementReport(event) {
  var data = event.data || {};
  var eventType = ENGAGEMENT_TYPE_MAP[String(data.engagementType || '').toLowerCase()];

  if (!eventType) return [];

  return [{
    event_type: eventType,
    severity: null,
    // Engagement events carry no recipient — the poller fills it in from the
    // recipient_emails row matched on provider_message_id.
    recipient: data.recipient || null,
    timestamp: toEpochSeconds(data.userActionTimeStamp, event.eventTime),
    provider_message_id: data.messageId || null,
    ghost_email_id: null,
    batch_message_id: null,
    delivery_status_code: null,
    delivery_status_message: data.engagementContext || null,
    delivery_status_enhanced: '',
    is_suppression: false,
    suppression_type: null,
    suppression_reason: null
  }];
}

function mapEvent(event) {
  if (!event || !event.eventType) return [];

  if (event.eventType === DELIVERY_EVENT) return mapDeliveryReport(event);
  if (event.eventType === ENGAGEMENT_EVENT) return mapEngagementReport(event);

  return [];
}

function describeEvent(event) {
  if (!event || !event.eventType) return 'unknown';

  var data = event.data || {};
  var suffix = event.eventType === ENGAGEMENT_EVENT ? data.engagementType : data.status;
  var name = event.eventType.replace('Microsoft.Communication.', '');

  return suffix ? name + ' ' + suffix : name;
}

module.exports = {
  parseQueueMessage: parseQueueMessage,
  mapEvent: mapEvent,
  describeEvent: describeEvent
};
