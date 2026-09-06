// Provider selection. MAIL_PROVIDER picks the email transport, the event
// source and the account status reader; QUEUE_PROVIDER (defaulting to the mail
// provider) picks the queue transport.

var config = require('../config');

var memoized = null;

function loadModules(name) {
  if (name === 'azure') {
    return {
      email: require('./azure/email'),
      queue: require('./azure/queue'),
      events: require('./azure/events'),
      account: require('./azure/account')
    };
  }

  return {
    email: require('./ses/email'),
    queue: require('./ses/queue'),
    events: require('./ses/events'),
    account: require('./ses/account')
  };
}

function parseAcsEndpoint(connectionString) {
  var match = /(?:^|;)\s*endpoint=([^;]+)/i.exec(String(connectionString || ''));
  return match ? match[1].trim().replace(/\/+$/, '') : '';
}

function describe(name) {
  var described = {
    provider: name,
    sendQueue: config.newsletterSendQueueUrl,
    eventsQueue: config.sesEventsQueueUrl
  };

  if (name === 'azure') {
    described.endpoint = parseAcsEndpoint(config.azureCommunicationConnectionString);
  } else {
    described.region = config.awsRegion;
  }

  return described;
}

function getProvider() {
  if (memoized) return memoized;

  var mail = loadModules(config.mailProvider);
  var queueModules = config.queueProvider === config.mailProvider ? mail : loadModules(config.queueProvider);

  memoized = {
    name: config.mailProvider,
    email: mail.email,
    events: mail.events,
    account: mail.account,
    queue: queueModules.queue,
    describe: function() {
      return describe(config.mailProvider);
    }
  };

  return memoized;
}

module.exports = {
  getProvider: getProvider
};
