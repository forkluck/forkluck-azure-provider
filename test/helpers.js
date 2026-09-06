var path = require('path');

var BASE_ENV = {
  DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/ghost_mail_bridge',
  PROXY_API_KEY: 'test-key',
  MAILGUN_DOMAIN: 'example.com',
  AWS_ACCESS_KEY_ID: 'AKIATEST',
  AWS_SECRET_ACCESS_KEY: 'secret',
  SES_EVENTS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/events',
  NEWSLETTER_SEND_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/send',
  AZURE_COMMUNICATION_CONNECTION_STRING: 'endpoint=https://test.communication.azure.com/;accesskey=' + Buffer.from('key').toString('base64'),
  AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true'
};

var libDir = path.join(__dirname, '..', 'lib');

function purgeLibCache() {
  Object.keys(require.cache).forEach(function(key) {
    if (key.indexOf(libDir) === 0) delete require.cache[key];
  });
}

// Reload lib/* with a fresh environment. config.js reads process.env once at
// require time, so every provider test needs its own module registry.
function loadLib(env) {
  var overrides = Object.assign({}, BASE_ENV, env || {});

  Object.keys(BASE_ENV).forEach(function(key) { delete process.env[key]; });
  ['MAIL_PROVIDER', 'QUEUE_PROVIDER', 'AZURE_SEND_QUEUE_NAME', 'AZURE_EVENTS_QUEUE_NAME',
    'AZURE_EMAIL_SENDER_ADDRESS', 'AZURE_EMAIL_DISABLE_ENGAGEMENT_TRACKING',
    'AZURE_EMAIL_RATE_PER_MINUTE', 'AZURE_EMAIL_RATE_PER_HOUR',
    'AZURE_QUEUE_VISIBILITY_TIMEOUT_SECONDS', 'AZURE_QUEUE_MAX_DEQUEUE_COUNT'].forEach(function(key) {
    delete process.env[key];
  });

  Object.keys(overrides).forEach(function(key) {
    if (overrides[key] === null) return;
    process.env[key] = String(overrides[key]);
  });

  purgeLibCache();

  return function requireLib(relative) {
    return require(path.join(libDir, relative));
  };
}

module.exports = {
  loadLib: loadLib,
  purgeLibCache: purgeLibCache
};
