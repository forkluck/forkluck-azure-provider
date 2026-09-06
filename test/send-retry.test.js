var test = require('node:test');
var assert = require('node:assert');
var { loadLib } = require('./helpers');

function throttled(retryAfterSeconds) {
  return {
    statusCode: 429,
    message: 'Too many requests',
    response: { headers: { 'retry-after': String(retryAfterSeconds) } }
  };
}

function batch() {
  return {
    from: 'The Example <news@example.com>',
    subject: 'Hello',
    html: '<p>hi</p>',
    text: 'hi',
    replyTo: '',
    sender: '',
    batchMessageId: '<batch-1@example.com>',
    recipientVars: {},
    customHeaders: {}
  };
}

// The provider's Retry-After wins over MAIL_RETRY_MAX_MS (10 s by default) so
// an ACS 429 backs off for as long as ACS asked, capped at five minutes.
async function retryDelayFor(t, retryAfterSeconds) {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var email = requireLib('providers/azure/email');
  var newsletterMessage = requireLib('newsletter-message');
  var attempts = 0;
  var warnings = [];

  email.sendEmail = function() {
    attempts += 1;
    if (attempts === 1) return Promise.reject(throttled(retryAfterSeconds));
    return Promise.resolve({ messageId: 'op-1' });
  };

  t.mock.method(console, 'warn', function(line) { warnings.push(line); });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  var pending = newsletterMessage.sendRecipient(batch(), 'reader@example.com');
  await new Promise(function(resolve) { setImmediate(resolve); });

  assert.strictEqual(warnings.length, 1);
  t.mock.timers.tick(300000);

  var sent = await pending;
  assert.strictEqual(sent.attempts, 2);

  return parseInt(/retrying in (\d+)ms/.exec(warnings[0])[1], 10);
}

test('waits the full provider Retry-After instead of capping at retryMaxMs', async function(t) {
  assert.strictEqual(await retryDelayFor(t, 60), 60000);
});

test('caps the provider Retry-After at five minutes', async function(t) {
  assert.strictEqual(await retryDelayFor(t, 600), 300000);
});
