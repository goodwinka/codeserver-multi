'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripGuiPrefix } = require('../gui-proxy-path');

test('stripGuiPrefix strips user GUI prefix and preserves path/query', () => {
  const out = stripGuiPrefix('/_auth/gui/alice/websockify/?token=abc', 'alice');
  assert.equal(out, '/websockify/?token=abc');
});

test('stripGuiPrefix returns root when path equals prefix', () => {
  const out = stripGuiPrefix('/_auth/gui/alice', 'alice');
  assert.equal(out, '/');
});

test('stripGuiPrefix leaves non-matching paths untouched', () => {
  const out = stripGuiPrefix('/_auth/gui/bob/websockify', 'alice');
  assert.equal(out, '/_auth/gui/bob/websockify');
});


test('stripGuiPrefix does not strip similar username prefixes', () => {
  const out = stripGuiPrefix('/_auth/gui/alice2/websockify', 'alice');
  assert.equal(out, '/_auth/gui/alice2/websockify');
});
