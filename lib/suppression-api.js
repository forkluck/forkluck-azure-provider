var { deleteSuppression } = require('./db');

var VALID_TYPES = { bounces: true, complaints: true, unsubscribes: true };

// Express already decodes route params once. Ghost (via mailgun.js) encodes
// the address exactly once, so this second decode only serves clients that
// double-encode; an address with a literal "%" must not turn into a 500.
function tryDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_err) {
    return value;
  }
}

async function handleDeleteSuppression(req, res) {
  var type = req.params.type;
  var email = tryDecode(req.params.email);

  if (!VALID_TYPES[type]) {
    return res.status(404).json({ message: 'Unknown suppression type: ' + type });
  }

  await deleteSuppression(email, type);

  res.json({
    message: 'Address has been removed',
    value: '',
    address: email
  });
}

module.exports = handleDeleteSuppression;
