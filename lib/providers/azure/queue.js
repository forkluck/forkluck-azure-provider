// Azure Storage Queue transport. Queue refs are queue names.

var config = require('../../config');

var clients = {};
var clientFactory = null;

function defaultClientFactory(name) {
  var { QueueClient } = require('@azure/storage-queue');
  return new QueueClient(config.azureStorageConnectionString, name);
}

// Tests inject a fake QueueClient factory.
function setClientFactory(factory) {
  clientFactory = factory;
  clients = {};
}

function getQueueClient(name) {
  if (!clients[name]) {
    clients[name] = (clientFactory || defaultClientFactory)(name);
  }

  return clients[name];
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function encodeBody(body) {
  var text = typeof body === 'string' ? body : JSON.stringify(body);
  return Buffer.from(text, 'utf8').toString('base64');
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch (_err) {
    return false;
  }
}

// Messages written by this bridge are base64, and Event Grid writes base64 too,
// but a hand-queued message may be raw JSON.
function decodeBody(text) {
  var raw = String(text === undefined || text === null ? '' : text);

  if (raw && /^[A-Za-z0-9+/\s]+={0,2}$/.test(raw)) {
    var decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (isJson(decoded)) return decoded;
  }

  return raw;
}

async function sendMessage(queueName, body) {
  var response = await getQueueClient(queueName).sendMessage(encodeBody(body));

  return {
    messageId: (response && response.messageId) || ''
  };
}

async function receiveMessages(queueName, maxNumberOfMessages, waitTimeSeconds) {
  var client = getQueueClient(queueName);
  var response = await client.receiveMessages({
    numberOfMessages: Math.max(1, Math.min(maxNumberOfMessages, 32)),
    visibilityTimeout: config.azureQueueVisibilityTimeoutSeconds
  });

  var items = (response && response.receivedMessageItems) || [];

  // Storage Queues have no long poll — approximate one by idling.
  if (items.length === 0) {
    if (waitTimeSeconds > 0) await sleep(waitTimeSeconds * 1000);
    return [];
  }

  var messages = [];

  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    var dequeueCount = Number(item.dequeueCount) || 0;

    if (dequeueCount > config.azureQueueMaxDequeueCount) {
      console.warn('Storage queue ' + queueName + ': dropping poison message ' + item.messageId +
        ' after ' + dequeueCount + ' dequeues');
      await client.deleteMessage(item.messageId, item.popReceipt);
      continue;
    }

    messages.push({
      id: item.messageId,
      body: decodeBody(item.messageText),
      receiptHandle: item.messageId + '|' + item.popReceipt
    });
  }

  return messages;
}

async function deleteMessage(queueName, receiptHandle) {
  var separator = String(receiptHandle || '').indexOf('|');
  if (separator === -1) {
    throw new Error('Invalid Azure queue receipt handle');
  }

  var messageId = receiptHandle.slice(0, separator);
  var popReceipt = receiptHandle.slice(separator + 1);

  await getQueueClient(queueName).deleteMessage(messageId, popReceipt);
}

async function getQueueDepth(queueName) {
  var properties = await getQueueClient(queueName).getProperties();

  return {
    visible: Number(properties && properties.approximateMessagesCount) || 0,
    inFlight: 0,
    delayed: 0
  };
}

module.exports = {
  sendMessage: sendMessage,
  receiveMessages: receiveMessages,
  deleteMessage: deleteMessage,
  getQueueDepth: getQueueDepth,
  encodeBody: encodeBody,
  decodeBody: decodeBody,
  setClientFactory: setClientFactory
};
