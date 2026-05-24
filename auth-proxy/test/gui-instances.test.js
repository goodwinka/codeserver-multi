'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const events = require('node:events');
const childProcess = require('node:child_process');

const ORIGINAL_SPAWN = childProcess.spawn;

function loadFreshGuiManager() {
  const modPath = require.resolve('../gui-instances');
  delete require.cache[modPath];
  return require('../gui-instances');
}

function extractWebsockifyPort(script) {
  const m = script.match(/websockify --web=\/usr\/share\/novnc\s+(\d+)\s+127\.0\.0\.1:(\d+)/);
  if (!m) throw new Error('websockify command not found in script');
  return { wsPort: Number(m[1]), vncPort: Number(m[2]) };
}

test('ensureRunning waits for reachable websockify port and uses distinct VNC port', async (t) => {
  const openedServers = [];

  childProcess.spawn = (cmd, args) => {
    assert.equal(cmd, 'bash');
    const script = args[1];
    const { wsPort, vncPort } = extractWebsockifyPort(script);
    assert.notEqual(wsPort, vncPort, 'websockify and x11vnc ports must differ');

    const child = new events.EventEmitter();
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.kill = () => child.emit('exit', 0);

    const srv = net.createServer();
    srv.listen(wsPort, '127.0.0.1');
    openedServers.push(srv);

    return child;
  };

  t.after(async () => {
    childProcess.spawn = ORIGINAL_SPAWN;
    await Promise.all(openedServers.map(s => new Promise(r => s.close(() => r()))));
  });

  const manager = loadFreshGuiManager();
  const inst = await manager.ensureRunning('alice');
  assert.equal(inst.username, 'alice');
  assert.ok(Number.isInteger(inst.port));
  assert.ok(Number.isInteger(inst.vncPort));
  assert.equal(inst.startingPromise, null);
  manager.stop('alice');
});

test('ensureRunning fails when websockify port never opens', async (t) => {
  childProcess.spawn = () => {
    const child = new events.EventEmitter();
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.kill = () => child.emit('exit', 0);
    return child;
  };

  t.after(() => {
    childProcess.spawn = ORIGINAL_SPAWN;
  });

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms, 1), ...rest);
  t.after(() => {
    global.setTimeout = realSetTimeout;
  });

  const realNow = Date.now;
  let now = realNow();
  Date.now = () => {
    now += 5000;
    return now;
  };
  t.after(() => {
    Date.now = realNow;
  });

  const manager = loadFreshGuiManager();
  await assert.rejects(() => manager.ensureRunning('bob'), /did not open in time/);
});
