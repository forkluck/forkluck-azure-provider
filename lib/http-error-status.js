// Map an error to a response status. Only `status` is honored: http-errors
// (serve-static, the router's param decoding) and createRequestError set it.
// Provider SDK failures carry `statusCode` and must keep surfacing as 500,
// because they are upstream failures, not client mistakes. Express 5 rejects
// non-integer statuses, so anything else also collapses to 500.
module.exports = function httpErrorStatus(err) {
  var status = err && err.status;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
};
