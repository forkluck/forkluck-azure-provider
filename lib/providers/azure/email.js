// Azure Communication Services email transport.

var config = require('../../config');
var { parseAddress } = require('./address');

var client = null;
var throttle = null;

function getClient() {
  if (!client) {
    var { EmailClient } = require('@azure/communication-email');
    // http endpoints are only ever local emulators (scripts/fake-acs-email.js).
    var insecure = /endpoint=http:\/\//i.test(config.azureCommunicationConnectionString);
    client = new EmailClient(config.azureCommunicationConnectionString, { allowInsecureConnection: insecure });
  }

  return client;
}

// Tests inject a fake EmailClient.
function setClient(injected) {
  client = injected;
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function createBucket(capacity, windowMs) {
  return {
    capacity: capacity,
    tokens: capacity,
    ratePerMs: capacity / windowMs,
    updatedAt: null
  };
}

// Token bucket pair: ACS custom domains default to 30 emails/minute and
// 100 emails/hour, and exceeding either returns 429.
function createThrottle(options) {
  var now = (options && options.now) || Date.now;
  var wait = (options && options.sleep) || sleep;
  var buckets = [
    createBucket(options.perMinute, 60000),
    createBucket(options.perHour, 3600000)
  ];
  var chain = Promise.resolve();

  function refill(bucket, at) {
    if (bucket.updatedAt === null) {
      bucket.updatedAt = at;
      return;
    }

    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + (at - bucket.updatedAt) * bucket.ratePerMs);
    bucket.updatedAt = at;
  }

  async function acquire() {
    for (;;) {
      var at = now();
      var waitMs = 0;

      for (var i = 0; i < buckets.length; i += 1) {
        refill(buckets[i], at);
        if (buckets[i].tokens < 1) {
          waitMs = Math.max(waitMs, Math.ceil((1 - buckets[i].tokens) / buckets[i].ratePerMs));
        }
      }

      if (waitMs === 0) {
        for (var j = 0; j < buckets.length; j += 1) {
          buckets[j].tokens -= 1;
        }
        return;
      }

      await wait(waitMs);
    }
  }

  return function take() {
    chain = chain.then(acquire, acquire);
    return chain;
  };
}

function getThrottle() {
  if (!throttle) {
    throttle = createThrottle({
      perMinute: config.azureEmailRatePerMinute,
      perHour: config.azureEmailRatePerHour
    });
  }

  return throttle;
}

function buildEmailMessage(message) {
  var from = parseAddress(message.from);
  var to = parseAddress(message.to);
  var headers = {};

  if (message.listUnsubscribe) headers['List-Unsubscribe'] = message.listUnsubscribe;
  if (message.listUnsubscribePost) headers['List-Unsubscribe-Post'] = message.listUnsubscribePost;
  if (message.sender) headers.Sender = message.sender;
  if (message.messageId) headers['Message-ID'] = message.messageId;

  var customHeaders = message.customHeaders || {};
  Object.keys(customHeaders).forEach(function(name) {
    headers[name] = customHeaders[name];
  });

  var recipient = { address: to.address };
  if (to.displayName) recipient.displayName = to.displayName;

  var senderAddress = config.azureEmailSenderAddress || from.address;

  var built = {
    // ACS validates senderAddress as a bare address; the display name is set on the sender username in Azure.
    senderAddress: senderAddress,
    recipients: { to: [recipient] },
    content: {
      subject: message.subject
    },
    userEngagementTrackingDisabled: config.azureEmailDisableEngagementTracking
  };

  if (message.text) built.content.plainText = message.text;
  if (message.html) built.content.html = message.html;

  if (message.replyTo) {
    var replyTo = parseAddress(message.replyTo);
    var replyRecipient = { address: replyTo.address };
    if (replyTo.displayName) replyRecipient.displayName = replyTo.displayName;
    built.replyTo = [replyRecipient];
  }

  if (Object.keys(headers).length > 0) {
    built.headers = headers;
  }

  return built;
}

function operationIdFromLocation(location) {
  if (!location) return '';
  var path = String(location).split('?')[0].replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

// The ACS send status endpoint is aggressively rate limited, so we never call
// pollUntilDone. beginSend already performed the initial POST, so the poller's
// operation state carries either the parsed result (fast Succeeded responses)
// or the Operation-Location header URL, whose last path segment is the
// operation id used as data.messageId in Event Grid delivery reports.
function extractOperationId(poller) {
  var state = poller && typeof poller.getOperationState === 'function' ? poller.getOperationState() : null;
  if (!state) return '';

  if (state.result && state.result.id) return state.result.id;

  return operationIdFromLocation(state.config ? state.config.operationLocation : '');
}

function idFromRawResponse(rawResponse) {
  if (!rawResponse) return '';

  var status = parseInt(rawResponse.status, 10);
  if (Number.isFinite(status) && status >= 300) return '';

  if (rawResponse.parsedBody && rawResponse.parsedBody.id) return rawResponse.parsedBody.id;

  var headers = rawResponse.headers;
  var location = headers && typeof headers.get === 'function'
    ? headers.get('operation-location')
    : (headers ? headers['operation-location'] : '');

  return operationIdFromLocation(location);
}

async function sendEmail(message) {
  await getThrottle()();

  // beginSend performs one status GET of its own before returning the poller.
  // Capture the id from the initial 202 so a rate-limited status GET cannot
  // make us resend an email that ACS already accepted.
  var accepted = { seen: false, id: '' };
  var options = {
    onResponse: function(rawResponse) {
      if (accepted.seen) return;
      accepted.seen = true;
      accepted.id = idFromRawResponse(rawResponse);
    }
  };

  var messageId;

  try {
    messageId = extractOperationId(await getClient().beginSend(buildEmailMessage(message), options)) || accepted.id;
  } catch (err) {
    if (!accepted.id) throw err;

    console.warn('ACS send was accepted as ' + accepted.id + ' but its status check failed: ' +
      (err && err.message ? err.message : String(err)));
    messageId = accepted.id;
  }

  if (!messageId) {
    throw new Error('Azure Communication Services did not return a send operation id');
  }

  return { messageId: messageId };
}

function getStatusCode(err) {
  if (!err) return null;
  var status = err.statusCode !== undefined ? err.statusCode : (err.response ? err.response.status : undefined);
  var parsed = parseInt(status, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getHeader(err, name) {
  var headers = err && err.response ? err.response.headers : null;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] !== undefined ? headers[name] : null;
}

function getRetryDelayMs(err) {
  if (getStatusCode(err) !== 429) return null;

  var retryAfter = getHeader(err, 'retry-after');
  if (!retryAfter) return null;

  var seconds = parseInt(retryAfter, 10);
  if (Number.isFinite(seconds)) return seconds * 1000;

  var date = Date.parse(retryAfter);
  if (Number.isNaN(date)) return null;

  return Math.max(0, date - Date.now());
}

function isRetriableError(err) {
  if (!err) return false;

  var status = getStatusCode(err);
  if (status === 429) return true;
  if (status !== null && status >= 500) return true;
  if (status !== null) return false;

  var errorText = [err.code, err.name, err.message].filter(Boolean).join(' ').toLowerCase();

  if (errorText.indexOf('econnreset') !== -1) return true;
  if (errorText.indexOf('econnrefused') !== -1) return true;
  if (errorText.indexOf('etimedout') !== -1) return true;
  if (errorText.indexOf('enotfound') !== -1) return true;
  if (errorText.indexOf('eai_again') !== -1) return true;
  if (errorText.indexOf('epipe') !== -1) return true;
  if (errorText.indexOf('socket hang up') !== -1) return true;
  if (errorText.indexOf('timeout') !== -1) return true;
  if (errorText.indexOf('network') !== -1) return true;

  return false;
}

function classifyFailure(err) {
  var status = getStatusCode(err);
  var errorText = [err && err.code, err && err.name, err && err.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (status === 400 && (errorText.indexOf('sender') !== -1 || errorText.indexOf('domain') !== -1)) {
    return { severity: 'permanent', code: 554 };
  }

  if (status === 401 || status === 403) {
    return { severity: 'permanent', code: 550 };
  }

  return { severity: 'temporary', code: 451 };
}

module.exports = {
  sendEmail: sendEmail,
  isRetriableError: isRetriableError,
  classifyFailure: classifyFailure,
  getRetryDelayMs: getRetryDelayMs,
  buildEmailMessage: buildEmailMessage,
  extractOperationId: extractOperationId,
  createThrottle: createThrottle,
  setClient: setClient
};
