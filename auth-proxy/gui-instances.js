'use strict';

const { spawn } = require('child_process');
const net = require('net');
const { getDisplayForUser } = require('./gui-display');

const GUI_PORT_MIN = parseInt(process.env.GUI_PORT_MIN || '9100', 10);
const GUI_PORT_MAX = parseInt(process.env.GUI_PORT_MAX || '9999', 10);
const VNC_PORT_MIN = parseInt(process.env.VNC_PORT_MIN || '5901', 10);
const VNC_PORT_MAX = parseInt(process.env.VNC_PORT_MAX || '6899', 10);
const GUI_READY_TIMEOUT_MS = parseInt(process.env.GUI_READY_TIMEOUT_MS || '10000', 10);

function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort() {
  for (let i = 0; i < 300; i++) {
    const p = GUI_PORT_MIN + Math.floor(Math.random() * (GUI_PORT_MAX - GUI_PORT_MIN + 1));
    // eslint-disable-next-line no-await-in-loop
    if (await portAvailable(p)) return p;
  }
  throw new Error('No free GUI ports in range');
}

async function findFreeVncPort() {
  for (let i = 0; i < 300; i++) {
    const p = VNC_PORT_MIN + Math.floor(Math.random() * (VNC_PORT_MAX - VNC_PORT_MIN + 1));
    // eslint-disable-next-line no-await-in-loop
    if (await portAvailable(p)) return p;
  }
  throw new Error('No free VNC ports in range');
}

function waitForTcp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', retry);
      socket.setTimeout(700, () => {
        socket.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error(`GUI gateway did not start on port ${port} in ${timeoutMs}ms`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

class GuiInstanceManager {
  constructor() {
    this.instances = new Map();
  }

  async ensureRunning(username) {
    const existing = this.instances.get(username);
    if (existing) {
      if (existing.startingPromise) await existing.startingPromise;
      return existing;
    }

    const port = await findFreePort();
    const vncPort = await findFreeVncPort();
    const display = getDisplayForUser(username);
    const script = [
      'set -euo pipefail',
      `export USERNAME=${JSON.stringify(username)}`,
      `export DISPLAY=${JSON.stringify(display)}`,
      'XVFB_PID=""',
      'if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then',
      '  echo "display $DISPLAY is already active, reusing"',
      'else',
      '  Xvfb "$DISPLAY" -screen 0 1600x900x24 >/tmp/xvfb-${USERNAME}.log 2>&1 &',
      '  XVFB_PID=$!',
      'fi',
      'openbox >/tmp/openbox-${USERNAME}.log 2>&1 &',
      'OPENBOX_PID=$!',
      `x11vnc -display "$DISPLAY" -rfbport ${vncPort} -localhost -nopw -forever -shared >/tmp/x11vnc-\${USERNAME}.log 2>&1 &`,
      'X11VNC_PID=$!',
      `websockify --web=/usr/share/novnc ${port} 127.0.0.1:${vncPort} >/tmp/websockify-${username}.log 2>&1 &`,
      'WS_PID=$!',
      'cleanup(){',
      '  [ -n "$WS_PID" ] && kill "$WS_PID" 2>/dev/null || true;',
      '  [ -n "$X11VNC_PID" ] && kill "$X11VNC_PID" 2>/dev/null || true;',
      '  [ -n "$OPENBOX_PID" ] && kill "$OPENBOX_PID" 2>/dev/null || true;',
      '  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true;',
      '}',
      'trap cleanup EXIT INT TERM',
      'wait "$WS_PID"'
    ].join('\n');

    const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write(`[gui:${username}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[gui:${username}] ${d}`));

    const inst = { username, port, process: child, startedAt: Date.now(), startingPromise: null };
    this.instances.set(username, inst);

    child.on('exit', () => {
      if (this.instances.get(username) === inst) this.instances.delete(username);
    });

    inst.startingPromise = Promise.race([
      waitForTcp(port, GUI_READY_TIMEOUT_MS),
      new Promise((_, reject) => {
        child.once('exit', code => reject(new Error(`GUI process exited before ready (code=${code})`)));
      })
    ]).finally(() => { inst.startingPromise = null; });

    await inst.startingPromise;
    return inst;
  }

  stop(username) {
    const inst = this.instances.get(username);
    if (!inst) return false;
    try { inst.process.kill('SIGTERM'); } catch (_) { /* ignore */ }
    this.instances.delete(username);
    return true;
  }
}

module.exports = new GuiInstanceManager();
