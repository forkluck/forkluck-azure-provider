var test = require('node:test');
var assert = require('node:assert');
var { loadLib } = require('./helpers');

test('ADMIN_BASE_PATH is normalized to a leading slash without a trailing one', function() {
  var config = loadLib({ ADMIN_BASE_PATH: 'ghost/mail/' })('config');
  assert.strictEqual(config.adminBasePath, '/ghost/mail');
});

test('ADMIN_BASE_PATH accepts dots, dashes and digits in segments', function() {
  var config = loadLib({ ADMIN_BASE_PATH: '/ops/mail-2.0' })('config');
  assert.strictEqual(config.adminBasePath, '/ops/mail-2.0');
});

test('ADMIN_BASE_PATH refuses route-pattern characters at startup', function(t) {
  var exits = [];
  t.mock.method(process, 'exit', function(code) {
    exits.push(code);
    throw new Error('process.exit ' + code);
  });
  t.mock.method(console, 'error', function() {});

  assert.throws(function() {
    loadLib({ ADMIN_BASE_PATH: '/ghost/mail*' })('config');
  }, /process\.exit 1/);
  assert.deepStrictEqual(exits, [1]);
});
