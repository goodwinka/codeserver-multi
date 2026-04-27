'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
// Creates dir and ensures dir/filename is a symlink pointing to target.
// Skips silently if target file doesn't exist yet.
function ensureSettingsSymlink(dir, filename, target) {
  if (!fs.existsSync(target)) return;
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, filename);
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink() || fs.readlinkSync(link) !== target) {
      fs.unlinkSync(link);
      fs.symlinkSync(target, link);
    }
  } catch (e) {
    if (e.code === 'ENOENT') fs.symlinkSync(target, link);
  }
}

// Creates a system user with /bin/bash shell if it doesn't exist; fixes nologin shell if it does.
// Existing sessions bypass verify(), so the Linux user may be absent after a container restart.
function ensureLinuxUser(username) {
  try {
    execSync(`id -u ${username}`, { stdio: 'ignore' });
    const shell = execSync(`getent passwd ${username}`, { encoding: 'utf8' }).trim().split(':')[6];
    if (shell === '/usr/sbin/nologin' || shell === '/bin/false' || !shell) {
      execSync(`usermod --shell /bin/bash ${username}`, { stdio: 'ignore' });
    }
  } catch (_) {
    execSync(
      `useradd --no-create-home --shell /bin/bash --home-dir /users/${username} ${username}`,
      { stdio: 'ignore' }
    );
  }
}

// Returns { uid, gid } for the given Linux username, or null if not found.
function getLinuxUidGid(username) {
  try {
    const uid = parseInt(execSync(`id -u ${username}`, { encoding: 'utf8' }).trim(), 10);
    const gid = parseInt(execSync(`id -g ${username}`, { encoding: 'utf8' }).trim(), 10);
    return { uid, gid };
  } catch (_) {
    return null;
  }
}

const USERS_ROOT = process.env.USERS_ROOT || '/users';
const SHARED_EXT_DIR = process.env.SHARED_EXT_DIR || '/opt/shared-extensions';
const SHARED_CLAUDE_SETTINGS = process.env.SHARED_CLAUDE_SETTINGS || '/opt/shared-claude-settings/settings.json';
const SHARED_QWEN_SETTINGS = process.env.SHARED_QWEN_SETTINGS || '/opt/shared-qwen-settings/settings.json';
const SHARED_USER_SETTINGS = process.env.SHARED_USER_SETTINGS || '/opt/shared-user-settings/settings.json';
const PORT_MIN = 8100;
const PORT_MAX = 8999;
const READY_TIMEOUT_MS = 30_000;
// Через сколько мс неактивности гасим экземпляр code-server.
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '3600000', 10); // 1 час

function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort() {
  for (let i = 0; i < 200; i++) {
    const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
    // eslint-disable-next-line no-await-in-loop
    if (await portAvailable(p)) return p;
  }
  throw new Error('No free ports in range');
}

function waitForHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/healthz', method: 'GET', timeout: 1000 },
        res => { res.resume(); resolve(); }
      );
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
      req.end();
    };
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error('code-server did not start in time'));
      setTimeout(tick, 400);
    };
    tick();
  });
}

class InstanceManager {
  constructor() {
    this.instances = new Map(); // username -> { port, process, lastActivity, startingPromise }
    // Периодическая зачистка простаивающих процессов
    this._gcTimer = setInterval(() => this._gc(), 60_000);
    this._gcTimer.unref?.();
  }

  _gc() {
    const now = Date.now();
    for (const [user, inst] of this.instances) {
      if (now - inst.lastActivity > IDLE_TIMEOUT_MS) {
        console.log(`[instances] GC stop idle instance for ${user}`);
        this.stop(user);
      }
    }
  }

  async ensureRunning(username) {
    const existing = this.instances.get(username);
    if (existing) {
      if (existing.startingPromise) await existing.startingPromise;
      existing.lastActivity = Date.now();
      return existing;
    }

    const userHome = path.join(USERS_ROOT, username);
    const dataDir = path.join(userHome, '.local/share/code-server');
    const machineDir = path.join(dataDir, 'Machine');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(machineDir, { recursive: true });
    fs.mkdirSync(SHARED_EXT_DIR, { recursive: true });

    // Seed User/settings.json for first-time users.
    // Some extension settings (e.g. claudeCode.disableLoginPrompt) have "window"
    // scope, meaning VS Code reads them from User/settings.json, not Machine/settings.json.
    // We copy — not symlink — so users can later override their own settings freely.
    const userSettingsDir = path.join(dataDir, 'User');
    const userSettingsFile = path.join(userSettingsDir, 'settings.json');
    fs.mkdirSync(userSettingsDir, { recursive: true });
    if (!fs.existsSync(userSettingsFile) && fs.existsSync(SHARED_USER_SETTINGS)) {
      fs.copyFileSync(SHARED_USER_SETTINGS, userSettingsFile);
    }

    // Symlink shared machine settings so all users inherit the same VS Code
    // machine-level config (e.g. Claude Code / Qwen Code login disabled).
    const machineSettingsLink = path.join(machineDir, 'settings.json');
    const sharedMachineSettings = process.env.SHARED_MACHINE_SETTINGS ||
      '/opt/shared-machine-settings/settings.json';
    if (fs.existsSync(sharedMachineSettings)) {
      try {
        const stat = fs.lstatSync(machineSettingsLink);
        // Replace only if it's not already a symlink pointing to the right target.
        if (!stat.isSymbolicLink() || fs.readlinkSync(machineSettingsLink) !== sharedMachineSettings) {
          fs.unlinkSync(machineSettingsLink);
          fs.symlinkSync(sharedMachineSettings, machineSettingsLink);
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          fs.symlinkSync(sharedMachineSettings, machineSettingsLink);
        }
      }
    }

    // Symlink shared Claude Code CLI settings into ~/.claude/settings.json.
    ensureSettingsSymlink(
      path.join(userHome, '.claude'),
      'settings.json',
      SHARED_CLAUDE_SETTINGS
    );

    // Symlink shared Qwen Code CLI settings into ~/.qwen/settings.json.
    ensureSettingsSymlink(
      path.join(userHome, '.qwen'),
      'settings.json',
      SHARED_QWEN_SETTINGS
    );

    // Existing sessions bypass verify(), so the Linux user may not exist in /etc/passwd after a container restart.
    try { ensureLinuxUser(username); } catch (e) {
      console.warn(`[instances] ensureLinuxUser failed for ${username}:`, e.message);
    }

    // Transfer ownership to the Linux user and restrict access from other accounts.
    const ugid = getLinuxUidGid(username);
    if (ugid) {
      try {
        execSync(`chown -Rh ${username}:${username} ${userHome}`);
        execSync(`chmod 700 ${userHome}`);
      } catch (_) { /* ignore — may fail outside a real Linux container */ }
    }

    const port = await findFreePort();
    const args = [
      '--bind-addr', `127.0.0.1:${port}`,
      '--auth', 'none',
      '--disable-telemetry',
      '--disable-update-check',
      '--user-data-dir', dataDir,
      '--extensions-dir', SHARED_EXT_DIR,
      userHome
    ];

    console.log(`[instances] starting code-server for ${username} on :${port}`);
    const spawnOpts = {
      env: {
        ...process.env,
        HOME: userHome,
        USER: username,
        LOGNAME: username,
        SHELL: '/bin/bash',
        // Отключаем встроенный прокси code-server к marketplace — админ сам ставит расширения
      },
      stdio: ['ignore', 'pipe', 'pipe']
    };
    // Drop privileges so code-server runs as the Linux user, not as root.
    if (ugid) {
      spawnOpts.uid = ugid.uid;
      spawnOpts.gid = ugid.gid;
    }
    const child = spawn('code-server', args, spawnOpts);

    child.stdout.on('data', d => process.stdout.write(`[cs:${username}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[cs:${username}] ${d}`));

    const inst = {
      username,
      port,
      process: child,
      lastActivity: Date.now(),
      startedAt: Date.now(),
      startingPromise: null
    };
    this.instances.set(username, inst);

    child.on('exit', (code, sig) => {
      console.log(`[instances] code-server for ${username} exited code=${code} sig=${sig}`);
      if (this.instances.get(username) === inst) this.instances.delete(username);
    });

    inst.startingPromise = waitForHttp(port, READY_TIMEOUT_MS)
      .then(() => { inst.startingPromise = null; })
      .catch(err => {
        this.stop(username);
        throw err;
      });

    await inst.startingPromise;
    return inst;
  }

  touch(username) {
    const inst = this.instances.get(username);
    if (inst) inst.lastActivity = Date.now();
  }

  stop(username) {
    const inst = this.instances.get(username);
    if (!inst) return false;
    try { inst.process.kill('SIGTERM'); } catch (_) { /* ignore */ }
    // Принудительный kill через 5с
    setTimeout(() => {
      try { inst.process.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, 5000).unref?.();
    this.instances.delete(username);
    return true;
  }

  list() {
    return [...this.instances.values()].map(i => ({
      username: i.username,
      port: i.port,
      pid: i.process.pid,
      startedAt: i.startedAt,
      lastActivity: i.lastActivity,
      idleMs: Date.now() - i.lastActivity
    }));
  }

  shutdownAll() {
    for (const user of [...this.instances.keys()]) this.stop(user);
  }
}

module.exports = new InstanceManager();
