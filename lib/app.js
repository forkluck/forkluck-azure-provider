var express = require('express');
var config = require('./config');
var authMiddleware = require('./auth');
var { getTableCounts } = require('./db');
var handleSendEmail = require('./send-email');
var handleGetEvents = require('./events-api');
var handleDeleteSuppression = require('./suppression-api');
var { createAdminRouter } = require('./admin-dashboard');
var { getProvider } = require('./providers');
var httpErrorStatus = require('./http-error-status');

function withAsync(handler) {
  return function(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// The API application without any process concerns: no database bootstrap,
// no heartbeat, no listen. server.js wires those around it; tests mount it
// on an ephemeral port.
function createApp(options) {
  var getRuntimeStatus = (options && options.getRuntimeStatus) || function() { return {}; };
  var app = express();

  app.get('/health', withAsync(async function(_req, res) {
    res.json({
      status: 'ok',
      mailProvider: config.mailProvider,
      tables: await getTableCounts(),
      // sesAccount is kept as the key name for dashboard/API compatibility.
      sesAccount: await getProvider().account.getAccountStatus()
    });
  }));

  app.use(config.adminBasePath, createAdminRouter(getRuntimeStatus));
  app.use('/v3', authMiddleware);
  app.post('/v3/:domain/messages', withAsync(handleSendEmail));
  app.get('/v3/:domain/events', withAsync(handleGetEvents));
  app.get('/v3/:domain/events/:pageToken', withAsync(handleGetEvents));
  app.delete('/v3/:domain/:type/:email', withAsync(handleDeleteSuppression));

  app.use(function(err, _req, res, _next) {
    var status = httpErrorStatus(err);
    var detail = err && err.message ? err.message : String(err);
    console.error('API error:', detail);
    res.status(status).json({
      message: status >= 500 ? 'Internal server error' : detail,
      error: detail
    });
  });

  return app;
}

module.exports = { createApp: createApp };
