var test = require('node:test');
var assert = require('node:assert');
var { loadLib } = require('./helpers');

function message(extra) {
  return Object.assign({
    from: 'The Example <news@example.com>',
    to: 'Reader Name <reader@example.com>',
    subject: 'Hello',
    html: '<p>hi</p>',
    text: 'hi',
    replyTo: 'Replies <replies@example.com>',
    sender: 'news@example.com',
    messageId: '<batch-1@example.com>',
    listUnsubscribe: '<https://example.com/unsub>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
    customHeaders: { 'X-Ghost-Email-Id': 'email-1' }
  }, extra || {});
}

function fakePoller(state) {
  return {
    getOperationState: function() { return state; }
  };
}

test('parses "Name <address>" header values', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var { parseAddress } = requireLib('providers/azure/address');

  assert.deepStrictEqual(parseAddress('The Example <news@example.com>'), {
    address: 'news@example.com',
    displayName: 'The Example'
  });
  assert.deepStrictEqual(parseAddress('"Quoted, Name" <news@example.com>'), {
    address: 'news@example.com',
    displayName: 'Quoted, Name'
  });
  assert.deepStrictEqual(parseAddress('news@example.com'), {
    address: 'news@example.com',
    displayName: ''
  });
});

test('builds an ACS EmailMessage with headers, reply-to and sender', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');
  var built = email.buildEmailMessage(message());

  assert.strictEqual(built.senderAddress, 'news@example.com');
  assert.deepStrictEqual(built.recipients.to, [{ address: 'reader@example.com', displayName: 'Reader Name' }]);
  assert.deepStrictEqual(built.replyTo, [{ address: 'replies@example.com', displayName: 'Replies' }]);
  assert.strictEqual(built.content.subject, 'Hello');
  assert.strictEqual(built.content.html, '<p>hi</p>');
  assert.strictEqual(built.content.plainText, 'hi');
  assert.strictEqual(built.userEngagementTrackingDisabled, false);
  assert.deepStrictEqual(built.headers, {
    'List-Unsubscribe': '<https://example.com/unsub>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    Sender: 'news@example.com',
    'Message-ID': '<batch-1@example.com>',
    'X-Ghost-Email-Id': 'email-1'
  });
});

test('AZURE_EMAIL_SENDER_ADDRESS overrides the parsed from address', function() {
  var requireLib = loadLib({
    MAIL_PROVIDER: 'azure',
    AZURE_EMAIL_SENDER_ADDRESS: 'donotreply@azurecomm.net',
    AZURE_EMAIL_DISABLE_ENGAGEMENT_TRACKING: '1'
  });
  var built = requireLib('providers/azure/email').buildEmailMessage(message());

  assert.strictEqual(built.senderAddress, 'donotreply@azurecomm.net');
  assert.strictEqual(built.userEngagementTrackingDisabled, true);
});

test('omits empty optional parts', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var built = requireLib('providers/azure/email').buildEmailMessage({
    from: 'news@example.com',
    to: 'reader@example.com',
    subject: 'Hello',
    html: '<p>hi</p>'
  });

  assert.strictEqual(built.senderAddress, 'news@example.com');
  assert.strictEqual(built.replyTo, undefined);
  assert.strictEqual(built.headers, undefined);
  assert.strictEqual(built.content.plainText, undefined);
});

test('sendEmail returns the operation id from the Operation-Location header', async function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');
  var sent = [];

  email.setClient({
    beginSend: async function(built) {
      sent.push(built);
      return fakePoller({
        status: 'running',
        config: {
          operationLocation: 'https://test.communication.azure.com/emails/operations/op-abc?api-version=2023-03-31'
        }
      });
    }
  });

  var result = await email.sendEmail(message());

  assert.deepStrictEqual(result, { messageId: 'op-abc' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].recipients.to[0].address, 'reader@example.com');
});

test('sendEmail prefers a completed result id', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');

  assert.strictEqual(email.extractOperationId(fakePoller({
    status: 'succeeded',
    result: { id: 'op-from-body', status: 'Succeeded' },
    config: { operationLocation: 'https://x/emails/operations/op-from-header' }
  })), 'op-from-body');
});

test('sendEmail fails loudly when no operation id is available', async function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');

  email.setClient({
    beginSend: async function() {
      return fakePoller({ status: 'running', config: {} });
    }
  });

  await assert.rejects(email.sendEmail(message()), /did not return a send operation id/);
});

test('throttle spends per-minute tokens and waits for a refill', async function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');
  var clock = 0;
  var slept = [];
  var take = email.createThrottle({
    perMinute: 2,
    perHour: 100,
    now: function() { return clock; },
    sleep: async function(ms) {
      slept.push(ms);
      clock += ms;
    }
  });

  await take();
  await take();
  assert.deepStrictEqual(slept, []);

  await take();
  assert.strictEqual(slept.length, 1);
  // 2 per 60s → one token back after ~30s.
  assert.ok(Math.abs(slept[0] - 30000) <= 1, 'expected ~30000ms, got ' + slept[0]);
});

test('throttle also enforces the hourly bucket', async function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');
  var clock = 0;
  var slept = [];
  var take = email.createThrottle({
    perMinute: 1000,
    perHour: 2,
    now: function() { return clock; },
    sleep: async function(ms) {
      slept.push(ms);
      clock += ms;
    }
  });

  await take();
  await take();
  await take();

  // 2 per hour → one token back after ~30 minutes.
  assert.strictEqual(slept.length, 1);
  assert.ok(Math.abs(slept[0] - 1800000) <= 1, 'expected ~1800000ms, got ' + slept[0]);
});

test('classifies ACS errors', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');

  assert.deepStrictEqual(
    email.classifyFailure({ statusCode: 400, message: 'The SenderAddress domain is not linked' }),
    { severity: 'permanent', code: 554 }
  );
  assert.deepStrictEqual(
    email.classifyFailure({ statusCode: 401, message: 'Unauthorized' }),
    { severity: 'permanent', code: 550 }
  );
  assert.deepStrictEqual(
    email.classifyFailure({ statusCode: 403, message: 'Forbidden' }),
    { severity: 'permanent', code: 550 }
  );
  assert.deepStrictEqual(
    email.classifyFailure({ statusCode: 400, message: 'Invalid content' }),
    { severity: 'temporary', code: 451 }
  );
  assert.deepStrictEqual(
    email.classifyFailure({ statusCode: 500, message: 'Server error' }),
    { severity: 'temporary', code: 451 }
  );
});

test('retries 429, 5xx and network errors only', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');

  assert.strictEqual(email.isRetriableError({ statusCode: 429 }), true);
  assert.strictEqual(email.isRetriableError({ statusCode: 503 }), true);
  assert.strictEqual(email.isRetriableError({ code: 'ECONNRESET' }), true);
  assert.strictEqual(email.isRetriableError({ message: 'socket hang up' }), true);
  assert.strictEqual(email.isRetriableError({ statusCode: 400, message: 'bad request' }), false);
  assert.strictEqual(email.isRetriableError(null), false);
});

test('honors Retry-After on 429', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');

  assert.strictEqual(email.getRetryDelayMs({
    statusCode: 429,
    response: { headers: { 'retry-after': '12' } }
  }), 12000);
  assert.strictEqual(email.getRetryDelayMs({
    statusCode: 429,
    response: { headers: new Map([['retry-after', '5']]) }
  }), 5000);
  assert.strictEqual(email.getRetryDelayMs({ statusCode: 429 }), null);
  assert.strictEqual(email.getRetryDelayMs({ statusCode: 500 }), null);
});

test('keeps the accepted operation id when the SDK status check fails', async function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');

  email.setClient({
    beginSend: async function(_built, options) {
      options.onResponse({
        status: 202,
        parsedBody: { id: 'op-accepted', status: 'NotStarted' },
        headers: new Map([['operation-location', 'https://x/emails/operations/op-accepted']])
      });
      var err = new Error('Too many requests');
      err.statusCode = 429;
      throw err;
    }
  });

  assert.deepStrictEqual(await email.sendEmail(message()), { messageId: 'op-accepted' });
});

test('rethrows when the send itself was never accepted', async function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');

  email.setClient({
    beginSend: async function() {
      throw new Error('connection refused');
    }
  });

  await assert.rejects(email.sendEmail(message()), /connection refused/);
});
