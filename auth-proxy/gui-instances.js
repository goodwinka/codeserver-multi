'use strict';

const { spawn } = require('child_process');
const net = require('net');
const { getDisplayForUser } = require('./gui-display');

const GUI_PORT_MIN = parseInt(process.env.GUI_PORT_MIN || '9100', 10);
const GUI_PORT_MAX = parseInt(process.env.GUI_PORT_MAX || '9999', 10);

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
    const p = GUI_PORT_MIN + Math.floor(Math.random() * (GUI_PORT_MAX - GUI_PORT_MIN));
    // eslint-disable-next-line no-await-in-loop
    if (await portAvailable(p)) return p;
  }
  throw new Error('No free GUI ports in range');
}

function waitForTcp(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) return reject(new Error(`GUI port ${port} did not open in time`));
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

    const port = await findFreePort();
    let vncPort = await findFreePort();
    while (vncPort === port) vncPort = await findFreePort();
    const display = getDisplayForUser(username);
    const script = [
      'set -euo pipefail',
      `export USERNAME=${JSON.stringify(username)}`,
      `export DISPLAY=${JSON.stringify(display)}`,
      'Xvfb "$DISPLAY" -screen 0 1600x900x24 >/tmp/xvfb-${USERNAME}.log 2>&1 &',
      'XVFB_PID=$!',
      'DISPLAY_NUM="${DISPLAY#:}"',
      'DISPLAY_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"',
      'for i in {1..80}; do',
      '  if ! kill -0 "$XVFB_PID" 2>/dev/null; then',
      '    echo "Xvfb exited early for $DISPLAY" >>/tmp/x11vnc-${USERNAME}.log',
      '    exit 1',
      '  fi',
      '  if [ -S "$DISPLAY_SOCKET" ]; then',
      '    if command -v xdpyinfo >/dev/null 2>&1; then',
      '      if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi',
      '    else',
      '      break',
      '    fi',
      '  fi',
      '  sleep 0.1',
      'done',
      'if [ ! -S "$DISPLAY_SOCKET" ]; then',
      '  echo "Xvfb did not create X11 socket for $DISPLAY" >>/tmp/x11vnc-${USERNAME}.log',
      '  exit 1',
      'fi',
      'if command -v xdpyinfo >/dev/null 2>&1 && ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then',
      '  echo "Xvfb did not become queryable on $DISPLAY" >>/tmp/x11vnc-${USERNAME}.log',
      '  exit 1',
      'fi',
      'openbox >/tmp/openbox-${USERNAME}.log 2>&1 &',
      'OPENBOX_PID=$!',
      `x11vnc -display "$DISPLAY" -rfbport ${vncPort} -localhost -nopw -forever -shared -noxdamage >/tmp/x11vnc-\${USERNAME}.log 2>&1 &`,
      'X11VNC_PID=$!',
      `websockify --web=/usr/share/novnc ${port} 127.0.0.1:${vncPort} >/tmp/websockify-${username}.log 2>&1 &`,
      'WS_PID=$!',
      'cleanup(){ kill "$WS_PID" "$X11VNC_PID" "$OPENBOX_PID" "$XVFB_PID" 2>/dev/null || true; }',
      'trap cleanup EXIT INT TERM',
      'wait "$WS_PID"'
    ].join('\n');

    const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write(`[gui:${username}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[gui:${username}] ${d}`));

    const inst = { username, port, vncPort, process: child, startedAt: Date.now(), startingPromise: null };
    this.instances.set(username, inst);

    child.on('exit', () => {
      if (this.instances.get(username) === inst) this.instances.delete(username);
    });

    inst.startingPromise = waitForTcp(port)
      .then(() => { inst.startingPromise = null; })
      .catch(err => {
        this.stop(username);
        throw err;
      });

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
