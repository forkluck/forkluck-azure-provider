// ACS has no quota API — report the operator-declared client-side limits.

var config = require('../../config');
var { countRecipientEmailsSince } = require('../../db');

async function getAccountStatus() {
  var sentLast24Hours = null;

  try {
    sentLast24Hours = await countRecipientEmailsSince(86400);
  } catch (_err) {
    sentLast24Hours = null;
  }

  return {
    available: true,
    mode: 'production',
    productionAccessEnabled: true,
    sendingEnabled: true,
    enforcementStatus: '',
    sendQuota: {
      maxSendRate: config.azureEmailRatePerMinute / 60,
      max24HourSend: config.azureEmailRatePerHour * 24,
      sentLast24Hours: sentLast24Hours
    },
    checkedAt: new Date().toISOString(),
    error: '',
    note: 'ACS quotas are operator-declared'
  };
}

module.exports = {
  getAccountStatus: getAccountStatus
};
