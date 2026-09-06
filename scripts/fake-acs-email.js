// Minimal stand-in for the ACS Email REST API, for local Azure-mode development.
//
//   POST /emails:send                 -> 202 {id, status:"NotStarted"} + Operation-Location
//   GET  /emails/operations/:id       -> 200 {id, status:"Succeeded"}
//
// Every accepted send also pushes a base64 Event Grid EmailDeliveryReportReceived
// message into the Azurite events queue, so the event poller has something to
// read. Add ?engage=1 to the send to also push a View engagement event.
//
// Point the bridge at it with a connection string such as:
//   AZURE_COMMUNICATION_CONNECTION_STRING=endpoint=http://fake-acs:4010/;accesskey=ZmFrZQ==

var crypto = require('crypto');
var express = require('express');
var { QueueClient } = require('@azure/storage-queue');

var PORT = parseInt(process.env.FAKE_ACS_PORT || '4010', 10);
var STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING || 'UseDevelopmentStorage=true';
var EVENTS_QUEUE_NAME = process.env.AZURE_EVENTS_QUEUE_NAME || 'mail-events';

var queueClient = new QueueClient(STORAGE_CONNECTION_STRING, EVENTS_QUEUE_NAME);
var app = express();

app.use(express.json({ limit: '25mb' }));

function recipientOf(message) {
  var recipients = message && message.recipients && message.recipients.to;
  return recipients && recipients[0] ? recipients[0].address : 'unknown@example.com';
}

function deliveryEvent(operationId, sender, recipient) {
  return {
    id: crypto.randomUUID(),
    topic: '/fake/acs',
    subject: 'sender/' + sender + '/message/' + operationId,
    eventType: 'Microsoft.Communication.EmailDeliveryReportReceived',
    eventTime: new Date().toISOString(),
    dataVersion: '1.0',
    data: {
      sender: sender,
      recipient: recipient,
      messageId: operationId,
      status: 'Delivered',
      deliveryStatusDetails: { statusMessage: 'DestinationMailboxDelivered' },
      deliveryAttemptTimeStamp: new Date().toISOString()
    }
  };
}

function engagementEvent(operationId, sender) {
  return {
    id: crypto.randomUUID(),
    topic: '/fake/acs',
    subject: 'sender/' + sender + '/message/' + operationId,
    eventType: 'Microsoft.Communication.EmailEngagementTrackingReportReceived',
    eventTime: new Date().toISOString(),
    dataVersion: '1.0',
    data: {
      sender: sender,
      messageId: operationId,
      userActionTimeStamp: new Date().toISOString(),
      engagementContext: 'https://example.com/post',
      userAgent: 'fake-acs',
      engagementType: 'View'
    }
  };
}

async function pushEvent(event) {
  await queueClient.sendMessage(Buffer.from(JSON.stringify(event), 'utf8').toString('base64'));
}

app.post('/emails:send', function(req, res) {
  var operationId = crypto.randomUUID();
  var message = req.body || {};
  var sender = message.senderAddress || 'news@example.com';
  var recipient = recipientOf(message);

  // The ACS SDK performs one status GET before returning its poller, so this
  // must be an absolute URL it can reach.
  var baseUrl = process.env.FAKE_ACS_PUBLIC_URL || (req.protocol + '://' + req.get('host'));
  res.setHeader('Operation-Location', baseUrl + '/emails/operations/' + operationId + '?api-version=2023-03-31');
  res.setHeader('retry-after', '1');
  res.status(202).json({ id: operationId, status: 'NotStarted' });

  console.log('fake-acs: accepted send ' + operationId + ' for ' + recipient);

  pushEvent(deliveryEvent(operationId, sender, recipient)).then(function() {
    if (req.query.engage === '1') {
      return pushEvent(engagementEvent(operationId, sender));
    }
  }).catch(function(err) {
    console.error('fake-acs: failed to push event:', err && err.message ? err.message : String(err));
  });
});

app.get('/emails/operations/:id', function(req, res) {
  res.json({ id: req.params.id, status: 'Succeeded' });
});

async function main() {
  await queueClient.createIfNotExists();
  app.listen(PORT, function() {
    console.log('fake-acs listening on port ' + PORT + ' (events queue: ' + EVENTS_QUEUE_NAME + ')');
  });
}

main().catch(function(err) {
  console.error('fake-acs startup error:', err && err.message ? err.message : String(err));
  process.exit(1);
});
