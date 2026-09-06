var test = require('node:test');
var assert = require('node:assert');
var { loadLib } = require('./helpers');

var requireLib = loadLib({});
var events = requireLib('providers/ses/events');

var MAIL = {
  timestamp: '2026-01-02T03:04:05.000Z',
  messageId: 'ses-msg-1',
  destination: ['reader@example.com'],
  headers: [
    { name: 'Message-ID', value: '<batch-1@example.com>' },
    { name: 'X-Ghost-Email-Id', value: 'email-1' }
  ]
};

function sesEvent(extra) {
  return Object.assign({ mail: MAIL }, extra);
}

test('maps a Delivery event', function() {
  var mapped = events.mapEvent(sesEvent({
    eventType: 'Delivery',
    delivery: { timestamp: '2026-01-02T03:04:06.000Z', recipients: ['reader@example.com'] }
  }));

  assert.strictEqual(mapped.length, 1);
  assert.strictEqual(mapped[0].event_type, 'delivered');
  assert.strictEqual(mapped[0].delivery_status_code, 250);
  assert.strictEqual(mapped[0].provider_message_id, 'ses-msg-1');
  assert.strictEqual(mapped[0].batch_message_id, 'batch-1@example.com');
  assert.strictEqual(mapped[0].ghost_email_id, 'email-1');
  assert.strictEqual(mapped[0].timestamp, Date.parse('2026-01-02T03:04:06.000Z') / 1000);
});

test('maps a permanent Bounce with suppression and diagnostic code', function() {
  var mapped = events.mapEvent(sesEvent({
    eventType: 'Bounce',
    bounce: {
      timestamp: '2026-01-02T03:04:07.000Z',
      bounceType: 'Permanent',
      bouncedRecipients: [{ emailAddress: 'reader@example.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }]
    }
  }))[0];

  assert.strictEqual(mapped.event_type, 'failed');
  assert.strictEqual(mapped.severity, 'permanent');
  assert.strictEqual(mapped.delivery_status_code, 607);
  assert.strictEqual(mapped.is_suppression, true);
  assert.strictEqual(mapped.suppression_type, 'bounces');
  assert.strictEqual(mapped.delivery_status_enhanced, 'smtp; 550 5.1.1 user unknown');
});

test('maps a transient Bounce as temporary', function() {
  var mapped = events.mapEvent(sesEvent({
    eventType: 'Bounce',
    bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'reader@example.com' }] }
  }))[0];

  assert.strictEqual(mapped.severity, 'temporary');
  assert.strictEqual(mapped.delivery_status_code, 450);
  assert.strictEqual(mapped.is_suppression, false);
});

test('maps Complaint, Open, Click and Reject', function() {
  var complaint = events.mapEvent(sesEvent({
    eventType: 'Complaint',
    complaint: { complainedRecipients: [{ emailAddress: 'reader@example.com' }] }
  }))[0];
  var open = events.mapEvent(sesEvent({ eventType: 'Open', open: {} }))[0];
  var click = events.mapEvent(sesEvent({ eventType: 'Click', click: {} }))[0];
  var reject = events.mapEvent(sesEvent({ eventType: 'Reject', reject: {} }))[0];

  assert.strictEqual(complaint.event_type, 'complained');
  assert.strictEqual(complaint.suppression_type, 'complaints');
  assert.strictEqual(open.event_type, 'opened');
  assert.strictEqual(click.event_type, 'clicked');
  assert.strictEqual(reject.event_type, 'failed');
  assert.strictEqual(reject.delivery_status_code, 607);
  assert.strictEqual(reject.suppression_reason, 'Rejected by SES');
});

test('skips Send and DeliveryDelay', function() {
  assert.deepStrictEqual(events.mapEvent(sesEvent({ eventType: 'Send' })), []);
  assert.deepStrictEqual(events.mapEvent(sesEvent({ eventType: 'DeliveryDelay' })), []);
  assert.deepStrictEqual(events.mapEvent(null), []);
});

test('unwraps an SNS notification envelope', function() {
  var inner = JSON.stringify(sesEvent({ eventType: 'Open', open: {} }));
  var parsed = events.parseQueueMessage(JSON.stringify({
    Type: 'Notification',
    MessageId: 'sns-1',
    Message: inner
  }));

  assert.strictEqual(parsed.sourceMessageId, 'sns:sns-1');
  assert.strictEqual(parsed.events.length, 1);
  assert.strictEqual(parsed.events[0].eventType, 'Open');
});

test('accepts a raw SES event body and rejects anything else', function() {
  var parsed = events.parseQueueMessage(JSON.stringify(sesEvent({ eventType: 'Open', open: {} })));

  assert.ok(parsed.sourceMessageId.startsWith('raw:'));
  assert.strictEqual(events.parseQueueMessage(JSON.stringify({ hello: 'world' })), null);
});

test('describeEvent returns the SES event type', function() {
  assert.strictEqual(events.describeEvent({ eventType: 'Delivery' }), 'Delivery');
});
