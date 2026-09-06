var test = require('node:test');
var assert = require('node:assert');
var { loadLib } = require('./helpers');

var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
var events = requireLib('providers/azure/events');

function deliveryEvent(status, extra) {
  return Object.assign({
    id: 'evt-1',
    eventType: 'Microsoft.Communication.EmailDeliveryReportReceived',
    eventTime: '2026-01-02T03:04:05.000Z',
    data: Object.assign({
      sender: 'news@example.com',
      recipient: 'reader@example.com',
      messageId: 'op-123',
      status: status,
      deliveryStatusDetails: { statusMessage: 'DestinationMailboxFull' },
      deliveryAttemptTimeStamp: '2026-01-02T03:04:06.000Z'
    }, extra || {})
  });
}

function engagementEvent(engagementType) {
  return {
    id: 'evt-2',
    eventType: 'Microsoft.Communication.EmailEngagementTrackingReportReceived',
    eventTime: '2026-01-02T03:04:05.000Z',
    data: {
      sender: 'news@example.com',
      messageId: 'op-123',
      userActionTimeStamp: '2026-01-02T04:00:00.000Z',
      engagementContext: 'https://example.com/post',
      engagementType: engagementType
    }
  };
}

function base64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

test('maps Delivered to a delivered event', function() {
  var mapped = events.mapEvent(deliveryEvent('Delivered'));

  assert.strictEqual(mapped.length, 1);
  assert.strictEqual(mapped[0].event_type, 'delivered');
  assert.strictEqual(mapped[0].severity, null);
  assert.strictEqual(mapped[0].delivery_status_code, 250);
  assert.strictEqual(mapped[0].recipient, 'reader@example.com');
  assert.strictEqual(mapped[0].provider_message_id, 'op-123');
  assert.strictEqual(mapped[0].is_suppression, false);
  assert.strictEqual(mapped[0].timestamp, Date.parse('2026-01-02T03:04:06.000Z') / 1000);
});

test('maps Bounced to a permanent failure and a bounce suppression', function() {
  var mapped = events.mapEvent(deliveryEvent('Bounced'))[0];

  assert.strictEqual(mapped.event_type, 'failed');
  assert.strictEqual(mapped.severity, 'permanent');
  assert.strictEqual(mapped.delivery_status_code, 607);
  assert.strictEqual(mapped.is_suppression, true);
  assert.strictEqual(mapped.suppression_type, 'bounces');
  assert.strictEqual(mapped.delivery_status_enhanced, 'DestinationMailboxFull');
});

test('maps Suppressed with an ACS suppression reason', function() {
  var mapped = events.mapEvent(deliveryEvent('Suppressed'))[0];

  assert.strictEqual(mapped.delivery_status_code, 607);
  assert.strictEqual(mapped.is_suppression, true);
  assert.strictEqual(mapped.suppression_reason, 'Suppressed by ACS');
});

test('maps Quarantined and FilteredSpam to 554 without suppression', function() {
  ['Quarantined', 'FilteredSpam'].forEach(function(status) {
    var mapped = events.mapEvent(deliveryEvent(status))[0];
    assert.strictEqual(mapped.delivery_status_code, 554, status);
    assert.strictEqual(mapped.severity, 'permanent', status);
    assert.strictEqual(mapped.is_suppression, false, status);
  });
});

test('maps Failed to a temporary 450 keeping the ACS status message', function() {
  var mapped = events.mapEvent(deliveryEvent('Failed'))[0];

  assert.strictEqual(mapped.severity, 'temporary');
  assert.strictEqual(mapped.delivery_status_code, 450);
  assert.strictEqual(mapped.delivery_status_message, 'DestinationMailboxFull');
});

test('maps Expired to a temporary 450', function() {
  var mapped = events.mapEvent(deliveryEvent('Expired'))[0];

  assert.strictEqual(mapped.severity, 'temporary');
  assert.strictEqual(mapped.delivery_status_code, 450);
});

test('skips Expanded and unknown statuses', function() {
  assert.deepStrictEqual(events.mapEvent(deliveryEvent('Expanded')), []);
  assert.deepStrictEqual(events.mapEvent(deliveryEvent('Bogus')), []);
});

test('falls back to eventTime when the attempt timestamp is missing', function() {
  var event = deliveryEvent('Delivered', { deliveryAttemptTimeStamp: undefined });
  var mapped = events.mapEvent(event)[0];

  assert.strictEqual(mapped.timestamp, Date.parse('2026-01-02T03:04:05.000Z') / 1000);
});

test('maps engagement View and Click without a recipient', function() {
  var view = events.mapEvent(engagementEvent('View'))[0];
  var click = events.mapEvent(engagementEvent('Click'))[0];

  assert.strictEqual(view.event_type, 'opened');
  assert.strictEqual(view.recipient, null);
  assert.strictEqual(view.provider_message_id, 'op-123');
  assert.strictEqual(view.timestamp, Date.parse('2026-01-02T04:00:00.000Z') / 1000);
  assert.strictEqual(click.event_type, 'clicked');
  assert.strictEqual(click.delivery_status_message, 'https://example.com/post');
});

test('parses a base64 single-event envelope', function() {
  var parsed = events.parseQueueMessage(base64(deliveryEvent('Delivered')));

  assert.strictEqual(parsed.events.length, 1);
  assert.strictEqual(parsed.sourceMessageId, 'eg:evt-1');
});

test('parses a base64 array envelope and drops unrelated event types', function() {
  var parsed = events.parseQueueMessage(base64([
    deliveryEvent('Delivered'),
    { id: 'x', eventType: 'Microsoft.Storage.BlobCreated', data: {} },
    engagementEvent('Click')
  ]));

  assert.strictEqual(parsed.events.length, 2);
  assert.strictEqual(parsed.sourceMessageId, 'eg:evt-1');
});

test('parses a raw (non base64) JSON envelope', function() {
  var parsed = events.parseQueueMessage(JSON.stringify(deliveryEvent('Delivered')));

  assert.strictEqual(parsed.events.length, 1);
});

test('returns null when no handled event is present', function() {
  assert.strictEqual(events.parseQueueMessage(base64({ id: 'x', eventType: 'Other' })), null);
});

test('describeEvent names the report and its status', function() {
  assert.strictEqual(events.describeEvent(deliveryEvent('Delivered')), 'EmailDeliveryReportReceived Delivered');
  assert.strictEqual(events.describeEvent(engagementEvent('View')), 'EmailEngagementTrackingReportReceived View');
});

test('dedupe ids are stable per event and differ across recipients', function() {
  var buildEventId = requireLib('event-poller').buildEventId;
  var parsed = events.parseQueueMessage(base64(deliveryEvent('Delivered')));
  var normalized = events.mapEvent(parsed.events[0])[0];
  var other = Object.assign({}, normalized, { recipient: 'other@example.com' });

  assert.strictEqual(
    buildEventId(normalized, parsed.sourceMessageId),
    buildEventId(normalized, parsed.sourceMessageId)
  );
  assert.notStrictEqual(
    buildEventId(normalized, parsed.sourceMessageId),
    buildEventId(other, parsed.sourceMessageId)
  );
});
