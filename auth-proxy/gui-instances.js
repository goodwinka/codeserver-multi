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
    const p = GUI_PORT_MIN + Math.floor(Math.random() * (GUI_PORT_MAX - GUI_PORT_MIN + 1));
    // eslint-disable-next-line no-await-in-loop
    if (await portAvailable(p)) return p;
  }
  throw new Error('No free GUI ports in range');
}

class GuiInstanceManager {
  constructor() {
    this.instances = new Map();
  }

  async ensureRunning(username) {
    const existing = this.instances.get(username);
    if (existing) return existing;

    const port = await findFreePort();
    const display = getDisplayForUser(username);
    const script = [
      'set -euo pipefail',
      `export USERNAME=${JSON.stringify(username)}`,
      `export DISPLAY=${JSON.stringify(display)}`,
      'Xvfb "$DISPLAY" -screen 0 1600x900x24 >/tmp/xvfb-${USERNAME}.log 2>&1 &',
      'XVFB_PID=$!',
      'openbox >/tmp/openbox-${USERNAME}.log 2>&1 &',
      'OPENBOX_PID=$!',
      'x11vnc -display "$DISPLAY" -rfbport 0 -localhost -nopw -forever -shared >/tmp/x11vnc-${USERNAME}.log 2>&1 &',
      'X11VNC_PID=$!',
      'for i in $(seq 1 40); do',
      '  VNC_PORT=$(awk \'match($0,/PORT=[0-9]+/){print substr($0,RSTART+5,RLENGTH-5)}\' /tmp/x11vnc-${USERNAME}.log | tail -n1)',
      '  [ -n "$VNC_PORT" ] && break',
      '  sleep 0.25',
      'done',
      'if [ -z "$VNC_PORT" ]; then echo "x11vnc did not report PORT" >&2; exit 1; fi',
      `websockify --web=/usr/share/novnc ${port} 127.0.0.1:$VNC_PORT >/tmp/websockify-${username}.log 2>&1 &`,
      'WS_PID=$!',
      'cleanup(){ kill "$WS_PID" "$X11VNC_PID" "$OPENBOX_PID" "$XVFB_PID" 2>/dev/null || true; }',
      'trap cleanup EXIT INT TERM',
      'wait "$WS_PID"'
    ].join('\n');

    const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write(`[gui:${username}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[gui:${username}] ${d}`));

    const inst = { username, port, process: child, startedAt: Date.now() };
    this.instances.set(username, inst);

    child.on('exit', () => {
      if (this.instances.get(username) === inst) this.instances.delete(username);
    });

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
