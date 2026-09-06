var test = require('node:test');
var assert = require('node:assert');
var { loadLib } = require('./helpers');

test('defaults to the SES provider', function() {
  var requireLib = loadLib({});
  var provider = requireLib('providers').getProvider();

  assert.strictEqual(provider.name, 'ses');
  assert.deepStrictEqual(provider.describe(), {
    provider: 'ses',
    sendQueue: 'https://sqs.us-east-1.amazonaws.com/1/send',
    eventsQueue: 'https://sqs.us-east-1.amazonaws.com/1/events',
    region: 'us-east-1'
  });
});

test('MAIL_PROVIDER=azure selects ACS and Storage Queues', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure' });
  var provider = requireLib('providers').getProvider();

  assert.strictEqual(provider.name, 'azure');
  assert.strictEqual(provider.queue, requireLib('providers/azure/queue'));
  assert.strictEqual(provider.events, requireLib('providers/azure/events'));
  assert.deepStrictEqual(provider.describe(), {
    provider: 'azure',
    sendQueue: 'newsletter-send',
    eventsQueue: 'mail-events',
    endpoint: 'https://test.communication.azure.com'
  });
});

test('azure queue names come from AZURE_*_QUEUE_NAME', function() {
  var requireLib = loadLib({
    MAIL_PROVIDER: 'azure',
    AZURE_SEND_QUEUE_NAME: 'send-q',
    AZURE_EVENTS_QUEUE_NAME: 'events-q'
  });
  var config = requireLib('config');

  assert.strictEqual(config.newsletterSendQueueUrl, 'send-q');
  assert.strictEqual(config.sesEventsQueueUrl, 'events-q');
});

test('QUEUE_PROVIDER overrides only the queue transport', function() {
  var requireLib = loadLib({ MAIL_PROVIDER: 'azure', QUEUE_PROVIDER: 'ses' });
  var provider = requireLib('providers').getProvider();

  assert.strictEqual(provider.name, 'azure');
  assert.strictEqual(provider.email, requireLib('providers/azure/email'));
  assert.strictEqual(provider.queue, requireLib('providers/ses/queue'));
  assert.strictEqual(provider.describe().sendQueue, 'https://sqs.us-east-1.amazonaws.com/1/send');
});

test('generalized retry env vars fall back to the SES names', function() {
  var requireLib = loadLib({ SES_SEND_MAX_RETRIES: '7' });
  assert.strictEqual(requireLib('config').sendMaxRetries, 7);

  requireLib = loadLib({ SES_SEND_MAX_RETRIES: '7', MAIL_SEND_MAX_RETRIES: '2' });
  assert.strictEqual(requireLib('config').sendMaxRetries, 2);
});
