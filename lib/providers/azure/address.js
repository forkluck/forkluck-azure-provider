// Parse an RFC 5322 style address header value into ACS's {address, displayName}.

function parseAddress(value) {
  var raw = String(value === undefined || value === null ? '' : value).trim();
  var match = /^(.*)<([^>]*)>\s*$/.exec(raw);

  if (match) {
    return {
      address: match[2].trim(),
      displayName: match[1].trim().replace(/^"(.*)"$/, '$1').trim()
    };
  }

  return {
    address: raw,
    displayName: ''
  };
}

module.exports = {
  parseAddress: parseAddress
};
