var test = require('node:test');
var assert = require('node:assert');
var { loadLib } = require('./helpers');

function fakeQueue(items) {
  return {
    name: '',
    sent: [],
    deleted: [],
    received: [],
    properties: { approximateMessagesCount: 7 },
    sendMessage: async function(text) {
      this.sent.push(text);
      return { messageId: 'sent-1' };
    },
    receiveMessages: async function(options) {
      this.received.push(options);
      return { receivedMessageItems: items.splice(0, options.numberOfMessages) };
    },
    deleteMessage: async function(messageId, popReceipt) {
      this.deleted.push([messageId, popReceipt]);
    },
    getProperties: async function() {
      return this.properties;
    }
  };
}

function loadQueue(env, items) {
  var requireLib = loadLib(Object.assign({ MAIL_PROVIDER: 'azure' }, env || {}));
  var queue = requireLib('providers/azure/queue');
  var client = fakeQueue(items || []);

  queue.setClientFactory(function(name) {
    client.name = name;
    return client;
  });

  return { queue: queue, client: client };
}

function item(extra) {
  return Object.assign({
    messageId: 'm1',
    popReceipt: 'pr1',
    dequeueCount: 1,
    messageText: Buffer.from(JSON.stringify({ jobId: 'job-1' }), 'utf8').toString('base64')
  }, extra || {});
}

test('encodes JSON bodies as base64 on send', async function() {
  var ctx = loadQueue();

  var result = await ctx.queue.sendMessage('newsletter-send', { jobId: 'job-1' });

  assert.strictEqual(result.messageId, 'sent-1');
  assert.strictEqual(ctx.client.name, 'newsletter-send');
  assert.strictEqual(Buffer.from(ctx.client.sent[0], 'base64').toString('utf8'), '{"jobId":"job-1"}');
});

test('decodes base64 and raw JSON message text', function() {
  var ctx = loadQueue();

  assert.strictEqual(ctx.queue.decodeBody(Buffer.from('{"a":1}').toString('base64')), '{"a":1}');
  assert.strictEqual(ctx.queue.decodeBody('{"a":1}'), '{"a":1}');
  assert.strictEqual(ctx.queue.decodeBody(''), '');
});

test('receiveMessages normalizes items and round-trips the receipt handle', async function() {
  var ctx = loadQueue({}, [item()]);

  var messages = await ctx.queue.receiveMessages('mail-events', 5, 1);

  assert.strictEqual(messages.length, 1);
  assert.deepStrictEqual(messages[0], {
    id: 'm1',
    body: '{"jobId":"job-1"}',
    receiptHandle: 'm1|pr1'
  });
  assert.strictEqual(ctx.client.received[0].visibilityTimeout, 3600);

  await ctx.queue.deleteMessage('mail-events', messages[0].receiptHandle);
  assert.deepStrictEqual(ctx.client.deleted, [['m1', 'pr1']]);
});

test('uses AZURE_QUEUE_VISIBILITY_TIMEOUT_SECONDS and caps the batch at 32', async function() {
  var ctx = loadQueue({ AZURE_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '120' }, [item()]);

  await ctx.queue.receiveMessages('mail-events', 100, 0);

  assert.strictEqual(ctx.client.received[0].visibilityTimeout, 120);
  assert.strictEqual(ctx.client.received[0].numberOfMessages, 32);
});

test('drops poison messages past the max dequeue count', async function() {
  var ctx = loadQueue({ AZURE_QUEUE_MAX_DEQUEUE_COUNT: '2' }, [
    item({ messageId: 'poison', dequeueCount: 3 }),
    item({ messageId: 'fresh', dequeueCount: 2 })
  ]);

  var messages = await ctx.queue.receiveMessages('mail-events', 10, 0);

  assert.deepStrictEqual(messages.map(function(m) { return m.id; }), ['fresh']);
  assert.deepStrictEqual(ctx.client.deleted, [['poison', 'pr1']]);
});

test('sleeps instead of long-polling when the queue is empty', async function() {
  var ctx = loadQueue({}, []);
  var startedAt = Date.now();

  var messages = await ctx.queue.receiveMessages('mail-events', 10, 0.05);

  assert.deepStrictEqual(messages, []);
  assert.ok(Date.now() - startedAt >= 45, 'expected the poll to idle');
});

test('rejects a receipt handle without a pop receipt', async function() {
  var ctx = loadQueue();

  await assert.rejects(ctx.queue.deleteMessage('mail-events', 'no-separator'), /Invalid Azure queue receipt handle/);
});

test('reports queue depth from approximateMessagesCount', async function() {
  var ctx = loadQueue();

  assert.deepStrictEqual(await ctx.queue.getQueueDepth('mail-events'), {
    visible: 7,
    inFlight: 0,
    delayed: 0
  });
});
