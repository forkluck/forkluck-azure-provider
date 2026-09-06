var Busboy = require('busboy');
var crypto = require('crypto');
var Transform = require('stream').Transform;
var config = require('./config');
var { getProvider } = require('./providers');
var substituteVars = require('./template-vars');

var HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function createRequestError(message, status) {
  var err = new Error(message);
  err.status = status;
  return err;
}

function ByteLimitStream(maxBytes) {
  Transform.call(this);
  this.maxBytes = maxBytes;
  this.bytesSeen = 0;
}

ByteLimitStream.prototype = Object.create(Transform.prototype);
ByteLimitStream.prototype.constructor = ByteLimitStream;

ByteLimitStream.prototype._transform = function(chunk, _encoding, callback) {
  this.bytesSeen += chunk.length;
  if (this.bytesSeen > this.maxBytes) {
    return callback(createRequestError('Request body too large', 413));
  }

  return callback(null, chunk);
};

function sanitizeHeaderValue(value, fieldName) {
  var output = String(value === undefined || value === null ? '' : value);
  if (/[\r\n]/.test(output)) {
    throw createRequestError('Invalid header value for ' + fieldName, 400);
  }
  return output;
}

function sanitizeHeaderName(name) {
  if (!HEADER_NAME_PATTERN.test(name)) {
    throw createRequestError('Invalid custom header name: ' + name, 400);
  }
  return name;
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function stripAngleBrackets(str) {
  if (!str) return str;
  return str.replace(/^</, '').replace(/>$/, '');
}

function computeRetryDelayMs(attemptNumber) {
  var exponent = Math.max(0, attemptNumber - 1);
  var backoff = config.retryBaseMs * Math.pow(2, exponent);
  var jitter = Math.floor(Math.random() * config.retryBaseMs);
  return Math.min(config.retryMaxMs, backoff + jitter);
}

function sendWithRetry(message, recipient) {
  var email = getProvider().email;
  var attempts = 0;

  function runAttempt() {
    attempts += 1;

    return email.sendEmail(message).then(function(result) {
      return {
        result: result,
        attempts: attempts
      };
    }).catch(function(err) {
      var retriesLeft = attempts <= config.sendMaxRetries;
      if (!retriesLeft || !email.isRetriableError(err)) {
        throw err;
      }

      var providerDelayMs = typeof email.getRetryDelayMs === 'function' ? email.getRetryDelayMs(err) : null;
      var delayMs = providerDelayMs ? Math.min(300000, providerDelayMs) : computeRetryDelayMs(attempts);
      var errorMessage = err && err.message ? err.message : String(err);

      console.warn(
        'Transient send error for ' + recipient + ', retrying in ' + delayMs +
        'ms (attempt ' + (attempts + 1) + '/' + (config.sendMaxRetries + 1) + '): ' + errorMessage
      );

      return sleep(delayMs).then(runAttempt);
    });
  }

  return runAttempt();
}

function parseFormData(req) {
  return new Promise(function(resolve, reject) {
    var fields = {};
    var arrayFields = {};
    var settled = false;
    var contentLength = parseInt(req.headers['content-length'] || '', 10);
    var busboy;
    var byteLimitStream;

    if (Number.isFinite(contentLength) && contentLength > config.maxRequestBytes) {
      return reject(createRequestError('Request body too large', 413));
    }

    function stopReading() {
      if (byteLimitStream) {
        req.unpipe(byteLimitStream);
        byteLimitStream.unpipe(busboy);
      } else if (busboy) {
        req.unpipe(busboy);
      }

      req.resume();
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      stopReading();
      reject(err);
    }

    function done() {
      if (settled) return;
      settled = true;
      resolve(fields);
    }

    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 0,
          fields: config.maxFormFields,
          parts: config.maxFormFields,
          fieldSize: config.maxFieldSizeBytes
        }
      });
    } catch (err) {
      return reject(createRequestError('Invalid multipart form-data: ' + err.message, 400));
    }

    busboy.on('field', function(name, value) {
      if (name === 'to' || name === 'o:tag') {
        if (!arrayFields[name]) arrayFields[name] = [];
        arrayFields[name].push(value);
      } else {
        fields[name] = value;
      }
    });

    busboy.on('finish', function() {
      var keys = Object.keys(arrayFields);
      for (var i = 0; i < keys.length; i += 1) {
        fields[keys[i]] = arrayFields[keys[i]];
      }
      done();
    });

    busboy.on('file', function(_name, stream) {
      stream.resume();
      fail(createRequestError('Attachments are not supported', 400));
    });

    busboy.on('fieldsLimit', function() {
      fail(createRequestError('Too many form fields', 413));
    });

    busboy.on('partsLimit', function() {
      fail(createRequestError('Too many form parts', 413));
    });

    busboy.on('filesLimit', function() {
      fail(createRequestError('Attachments are not supported', 400));
    });

    busboy.on('error', function(err) {
      fail(createRequestError('Invalid multipart form-data: ' + err.message, 400));
    });

    req.on('aborted', function() {
      fail(createRequestError('Request aborted', 400));
    });

    byteLimitStream = new ByteLimitStream(config.maxRequestBytes);
    byteLimitStream.on('error', function(err) {
      fail(err && err.status ? err : createRequestError('Request body too large', 413));
    });

    req.pipe(byteLimitStream).pipe(busboy);
  });
}

function normalizeSendRequest(fields, domain) {
  var from = fields.from;
  var subject = fields.subject;
  var html = fields.html || '';
  var text = fields.text || '';
  var recipientVarsStr = fields['recipient-variables'];
  var toList = fields.to || [];
  var tags = fields['o:tag'] || [];
  var emailId = fields['v:email-id'] || '';

  if (!Array.isArray(toList)) toList = [toList];
  if (!Array.isArray(tags)) tags = [tags];

  if (!from || !subject || toList.length === 0) {
    throw createRequestError('Missing required fields: from, subject, to', 400);
  }

  if (toList.length > config.maxRecipients) {
    throw createRequestError('Too many recipients in one request', 413);
  }

  from = sanitizeHeaderValue(from, 'from');
  subject = sanitizeHeaderValue(subject, 'subject');
  emailId = emailId ? sanitizeHeaderValue(emailId, 'v:email-id') : '';
  toList = toList.map(function(recipient) {
    return sanitizeHeaderValue(recipient, 'to');
  });

  var recipientVars = {};
  if (recipientVarsStr) {
    try {
      recipientVars = JSON.parse(recipientVarsStr);
    } catch (_err) {
      throw createRequestError('Invalid recipient-variables JSON', 400);
    }
  }

  var batchId = crypto.randomUUID() + '@' + domain;
  var batchMessageId = '<' + batchId + '>';
  var tagsJson = JSON.stringify(tags);
  var customHeaders = {};
  var customHeaderCount = 0;
  var fieldKeys = Object.keys(fields);

  for (var i = 0; i < fieldKeys.length; i += 1) {
    var key = fieldKeys[i];
    if (
      key.startsWith('h:') &&
      key !== 'h:Reply-To' &&
      key !== 'h:Sender' &&
      key !== 'h:List-Unsubscribe' &&
      key !== 'h:List-Unsubscribe-Post'
    ) {
      customHeaderCount += 1;
      if (customHeaderCount > config.maxCustomHeaders) {
        throw createRequestError('Too many custom headers', 413);
      }
      var headerName = sanitizeHeaderName(key.slice(2));
      customHeaders[headerName] = sanitizeHeaderValue(fields[key], key);
    }
  }

  if (emailId) {
    customHeaders['X-Ghost-Email-Id'] = emailId;
  }

  var replyTo = fields['h:Reply-To'] || '';
  var sender = fields['h:Sender'] || '';
  replyTo = replyTo ? sanitizeHeaderValue(replyTo, 'h:Reply-To') : '';
  sender = sender ? sanitizeHeaderValue(sender, 'h:Sender') : '';

  return {
    batchId: batchId,
    batchMessageId: batchMessageId,
    domain: domain,
    from: from,
    subject: subject,
    html: html,
    text: text,
    recipientVars: recipientVars,
    recipients: toList,
    tags: tags,
    tagsJson: tagsJson,
    emailId: emailId,
    customHeaders: customHeaders,
    replyTo: replyTo,
    sender: sender,
    listUnsubscribeTemplate: fields['h:List-Unsubscribe'] || '',
    listUnsubscribePostTemplate: fields['h:List-Unsubscribe-Post'] || ''
  };
}

function resolveRecipientHeaders(batch, recipient) {
  var vars = batch.recipientVars && batch.recipientVars[recipient] ? batch.recipientVars[recipient] : {};
  var listUnsubscribe = batch.listUnsubscribeTemplate || '';
  var listUnsubscribePost = batch.listUnsubscribePostTemplate || '';

  if (listUnsubscribe) {
    listUnsubscribe = substituteVars(listUnsubscribe, vars);
    listUnsubscribe = listUnsubscribe.replace(/,?\s*<%tag_unsubscribe_email%>/g, '');
    listUnsubscribe = listUnsubscribe.replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
    listUnsubscribe = sanitizeHeaderValue(listUnsubscribe, 'h:List-Unsubscribe');
  }

  if (listUnsubscribePost) {
    listUnsubscribePost = substituteVars(listUnsubscribePost, vars);
    listUnsubscribePost = sanitizeHeaderValue(listUnsubscribePost, 'h:List-Unsubscribe-Post');
  }

  return {
    vars: vars,
    listUnsubscribe: listUnsubscribe,
    listUnsubscribePost: listUnsubscribePost
  };
}

async function sendRecipient(batch, recipient) {
  var resolved = resolveRecipientHeaders(batch, recipient);
  var recipientHtml = substituteVars(batch.html || '', resolved.vars);
  var recipientText = substituteVars(batch.text || '', resolved.vars);
  var message = {
    from: batch.from,
    to: recipient,
    subject: batch.subject,
    html: recipientHtml,
    text: recipientText,
    replyTo: batch.replyTo,
    sender: batch.sender,
    messageId: batch.batchMessageId,
    listUnsubscribe: resolved.listUnsubscribe || undefined,
    listUnsubscribePost: resolved.listUnsubscribePost || undefined,
    customHeaders: batch.customHeaders || {}
  };

  return sendWithRetry(message, recipient);
}

function buildImmediateSendFailureEvent(opts) {
  var timestamp = Math.floor(Date.now() / 1000);
  var normalizedMessageId = stripAngleBrackets(opts.batchMessageId);
  var failureClass = getProvider().email.classifyFailure(opts.err);

  return {
    id: crypto
      .createHash('sha256')
      .update([
        'send-failure',
        normalizedMessageId || '',
        opts.recipient || '',
        String(timestamp),
        opts.errorMessage || ''
      ].join('|'))
      .digest('hex'),
    eventType: 'failed',
    severity: failureClass.severity,
    recipient: opts.recipient,
    timestamp: timestamp,
    messageId: normalizedMessageId,
    emailId: opts.emailId || '',
    deliveryStatusCode: failureClass.code,
    deliveryStatusMessage: opts.errorMessage || '',
    deliveryStatusEnhanced: '',
    tagsJson: opts.tagsJson || '[]'
  };
}

function chunkRecipients(recipients, size) {
  var chunks = [];
  for (var i = 0; i < recipients.length; i += size) {
    chunks.push(recipients.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  parseFormData: parseFormData,
  normalizeSendRequest: normalizeSendRequest,
  sendRecipient: sendRecipient,
  buildImmediateSendFailureEvent: buildImmediateSendFailureEvent,
  chunkRecipients: chunkRecipients,
  stripAngleBrackets: stripAngleBrackets,
  createRequestError: createRequestError
};
