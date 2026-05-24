'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const gui = require('../gui-instances');

function hasBin(bin) {
  try {
    execFileSync('bash', ['-lc', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

const REQUIRED = ['Xvfb', 'openbox', 'x11vnc', 'websockify'];
const missing = REQUIRED.filter(b => !hasBin(b));

const maybeTest = missing.length ? test.skip : test;

maybeTest('real GUI stack serves noVNC page over websockify', async () => {
  const username = 'integration_gui_user';
  const inst = await gui.ensureRunning(username);
  try {
    assert.ok(Number.isInteger(inst.port));
    assert.ok(Number.isInteger(inst.vncPort));
    assert.notEqual(inst.port, inst.vncPort);

    const { status, bytes } = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: inst.port, path: '/vnc.html' }, res => {
        let size = 0;
        res.on('data', c => { size += c.length; });
        res.on('end', () => resolve({ status: res.statusCode, bytes: size }));
      });
      req.on('error', reject);
    });

    assert.equal(status, 200);
    assert.ok(bytes > 1000);
  } finally {
    gui.stop(username);
  }
});
