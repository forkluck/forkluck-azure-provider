// SES email transport: raw MIME assembly, send, and error classification.

var crypto = require('crypto');
var { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
var config = require('../../config');

var MIME_BASE64_LINE_LENGTH = 76;
var sesClient = null;

function getClient() {
  if (!sesClient) {
    sesClient = new SESClient({
      region: config.awsRegion,
      credentials: {
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey
      }
    });
  }

  return sesClient;
}

function getHttpStatusCode(err) {
  if (!err || !err.$metadata) return null;
  var status = parseInt(err.$metadata.httpStatusCode, 10);
  if (!Number.isFinite(status)) return null;
  return status;
}

function isRetriableError(err) {
  if (!err) return false;
  if (err.$retryable) return true;

  var statusCode = getHttpStatusCode(err);
  if (statusCode !== null && statusCode >= 500) return true;

  var errorText = [err.name, err.code, err.Code, err.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (errorText.indexOf('throttl') !== -1) return true;
  if (errorText.indexOf('too many request') !== -1) return true;
  if (errorText.indexOf('rate exceeded') !== -1) return true;
  if (errorText.indexOf('service unavailable') !== -1) return true;
  if (errorText.indexOf('request timeout') !== -1) return true;
  if (errorText.indexOf('timeout') !== -1) return true;
  if (errorText.indexOf('temporar') !== -1) return true;
  if (errorText.indexOf('network') !== -1) return true;

  return false;
}

function classifyFailure(err) {
  if (isRetriableError(err)) {
    return { severity: 'temporary', code: 421 };
  }

  var errorText = [err && err.name, err && err.code, err && err.Code, err && err.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    errorText.indexOf('not authorized') !== -1 ||
    errorText.indexOf('accessdenied') !== -1 ||
    errorText.indexOf('access denied') !== -1
  ) {
    return { severity: 'permanent', code: 550 };
  }

  if (
    errorText.indexOf('message rejected') !== -1 ||
    errorText.indexOf('identity') !== -1 ||
    errorText.indexOf('mailfrom') !== -1 ||
    errorText.indexOf('from address') !== -1
  ) {
    return { severity: 'permanent', code: 554 };
  }

  return { severity: 'temporary', code: 451 };
}

function pushBase64Body(lines, value) {
  var encoded = Buffer.from(value).toString('base64');

  for (var i = 0; i < encoded.length; i += MIME_BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(i, i + MIME_BASE64_LINE_LENGTH));
  }
}

function generateBoundary() {
  return '----=_Part_' + crypto.randomBytes(16).toString('hex');
}

function buildRawMime(opts) {
  var boundary = generateBoundary();
  var lines = [];

  lines.push('From: ' + opts.from);
  lines.push('To: ' + opts.to);
  lines.push('Subject: ' + opts.subject);

  if (opts.replyTo) {
    lines.push('Reply-To: ' + opts.replyTo);
  }
  if (opts.sender) {
    lines.push('Sender: ' + opts.sender);
  }
  if (opts.messageId) {
    lines.push('Message-ID: ' + opts.messageId);
  }
  if (opts.listUnsubscribe) {
    lines.push('List-Unsubscribe: ' + opts.listUnsubscribe);
  }
  if (opts.listUnsubscribePost) {
    lines.push('List-Unsubscribe-Post: ' + opts.listUnsubscribePost);
  }

  if (opts.customHeaders) {
    var keys = Object.keys(opts.customHeaders);
    for (var i = 0; i < keys.length; i += 1) {
      lines.push(keys[i] + ': ' + opts.customHeaders[keys[i]]);
    }
  }

  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  lines.push('');

  if (opts.text) {
    lines.push('--' + boundary);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    pushBase64Body(lines, opts.text);
    lines.push('');
  }

  if (opts.html) {
    lines.push('--' + boundary);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    pushBase64Body(lines, opts.html);
    lines.push('');
  }

  lines.push('--' + boundary + '--');
  lines.push('');

  return lines.join('\r\n');
}

async function sendEmail(message) {
  var rawMessage = buildRawMime(message);
  var response = await getClient().send(new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(rawMessage) },
    ConfigurationSetName: config.sesConfigurationSet
  }));

  return { messageId: response.MessageId };
}

module.exports = {
  sendEmail: sendEmail,
  isRetriableError: isRetriableError,
  classifyFailure: classifyFailure,
  buildRawMime: buildRawMime
};
