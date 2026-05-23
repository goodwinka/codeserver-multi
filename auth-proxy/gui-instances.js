'use strict';

const { spawn } = require('child_process');
const net = require('net');
const { getDisplayForUser } = require('./gui-display');

const GUI_PORT_MIN = parseInt(process.env.GUI_PORT_MIN || '9100', 10);
const GUI_PORT_MAX = parseInt(process.env.GUI_PORT_MAX || '9999', 10);
const GUI_VNC_PORT_MIN = parseInt(process.env.GUI_VNC_PORT_MIN || '10000', 10);
const GUI_VNC_PORT_MAX = parseInt(process.env.GUI_VNC_PORT_MAX || '14999', 10);
const GUI_STARTUP_TIMEOUT_MS = parseInt(process.env.GUI_STARTUP_TIMEOUT_MS || '15000', 10);

function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(min, max, label) {
  for (let i = 0; i < 300; i++) {
    const p = min + Math.floor(Math.random() * (max - min + 1));
    // eslint-disable-next-line no-await-in-loop
    if (await portAvailable(p)) return p;
  }
  throw new Error(`No free ${label} ports in range ${min}-${max}`);
}

function waitForTcpPort(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if ((Date.now() - started) >= timeoutMs) {
          reject(new Error(`TCP service on 127.0.0.1:${port} did not become ready in ${timeoutMs}ms`));
          return;
        }
        setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

class GuiInstanceManager {
  constructor() {
    this.instances = new Map();
  }

  async ensureRunning(username) {
    const existing = this.instances.get(username);
    if (existing) return existing;

    const port = await findFreePort(GUI_PORT_MIN, GUI_PORT_MAX, 'GUI');
    const vncPort = await findFreePort(GUI_VNC_PORT_MIN, GUI_VNC_PORT_MAX, 'GUI VNC');
    const display = getDisplayForUser(username);
    const script = [
      'set -euo pipefail',
      `export USERNAME=${JSON.stringify(username)}`,
      `export DISPLAY=${JSON.stringify(display)}`,
      'Xvfb "$DISPLAY" -screen 0 1600x900x24 >/tmp/xvfb-${USERNAME}.log 2>&1 &',
      'XVFB_PID=$!',
      'openbox >/tmp/openbox-${USERNAME}.log 2>&1 &',
      'OPENBOX_PID=$!',
      `export VNC_PORT=${JSON.stringify(String(vncPort))}`,
      'x11vnc -display "$DISPLAY" -rfbport "$VNC_PORT" -localhost -nopw -forever -shared >/tmp/x11vnc-${USERNAME}.log 2>&1 &',
      'X11VNC_PID=$!',
      'for i in $(seq 1 80); do',
      '  if (echo >"/dev/tcp/127.0.0.1/$VNC_PORT") >/dev/null 2>&1; then break; fi',
      '  if ! kill -0 "$X11VNC_PID" 2>/dev/null; then echo "x11vnc exited before listening" >&2; exit 1; fi',
      '  sleep 0.1',
      'done',
      'if ! (echo >"/dev/tcp/127.0.0.1/$VNC_PORT") >/dev/null 2>&1; then echo "x11vnc did not start listening on $VNC_PORT" >&2; exit 1; fi',
      `websockify --web=/usr/share/novnc ${port} 127.0.0.1:$VNC_PORT >/tmp/websockify-${username}.log 2>&1 &`,
      'WS_PID=$!',
      'cleanup(){ kill "$WS_PID" "$X11VNC_PID" "$OPENBOX_PID" "$XVFB_PID" 2>/dev/null || true; }',
      'trap cleanup EXIT INT TERM',
      'wait "$WS_PID"'
    ].join('\n');

    const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write(`[gui:${username}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[gui:${username}] ${d}`));

    const inst = { username, port, process: child, startedAt: Date.now(), ready: false };
    this.instances.set(username, inst);

    child.on('exit', () => {
      if (this.instances.get(username) === inst) this.instances.delete(username);
    });

    try {
      await Promise.race([
        waitForTcpPort(port, GUI_STARTUP_TIMEOUT_MS),
        new Promise((_, reject) => {
          child.once('exit', code => reject(new Error(`GUI process exited during startup with code ${code}`)));
        })
      ]);
      inst.ready = true;
    } catch (e) {
      this.stop(username);
      throw e;
    }

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
