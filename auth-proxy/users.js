'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { execSync } = require('child_process');

const USERS_FILE = process.env.USERS_FILE || '/config/users.json';
const USERS_ROOT = process.env.USERS_ROOT || '/users';

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Creates a no-login system user if one does not already exist.
function ensureLinuxUser(username) {
  try {
    execSync(`id -u ${username}`, { stdio: 'ignore' });
  } catch (_) {
    execSync(
      `useradd --no-create-home --shell /usr/sbin/nologin --home-dir /users/${username} ${username}`,
      { stdio: 'ignore' }
    );
  }
}

// Removes the Linux system user (home directory is intentionally kept).
function removeLinuxUser(username) {
  try {
    execSync(`userdel ${username}`, { stdio: 'ignore' });
  } catch (_) { /* ignore — user may not exist */ }
}

class UserStore {
  constructor() {
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      this.users = Array.isArray(parsed.users) ? parsed.users : [];
    } catch (_) {
      this.users = [];
      this._save();
    }
  }

  _save() {
    ensureDir(path.dirname(USERS_FILE));
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2));
    fs.renameSync(tmp, USERS_FILE);
  }

  _ensureHome(username) {
    ensureLinuxUser(username);
    const home = path.join(USERS_ROOT, username);
    ensureDir(home);
    // Readable sample file on first start, only if the directory is empty.
    try {
      const entries = fs.readdirSync(home);
      if (entries.length === 0) {
        fs.writeFileSync(
          path.join(home, 'README.md'),
          `# Welcome, ${username}\n\nЭто ваше рабочее пространство в code-server.\n` +
          `Файлы из этой папки сохраняются на хост-машине в /users/${username}.\n`
        );
      }
    } catch (_) { /* ignore */ }
    // Give the Linux user full ownership; block access from every other account.
    try {
      execSync(`chown -R ${username}:${username} ${home}`);
      execSync(`chmod 700 ${home}`);
    } catch (_) { /* ignore — may fail outside a real Linux container */ }
    return home;
  }

  list() {
    return this.users.map(u => ({
      username: u.username,
      isAdmin: !!u.isAdmin,
      createdAt: u.createdAt,
      disabled: !!u.disabled
    }));
  }

  find(username) {
    return this.users.find(u => u.username === username) || null;
  }

  async add({ username, password, isAdmin = false }) {
    if (!USERNAME_RE.test(username)) {
      throw new Error('Username must be 3–32 chars, lowercase, start with a letter, [a-z0-9_-]');
    }
    if (!password) {
      throw new Error('Password is required');
    }
    if (this.find(username)) {
      throw new Error('User already exists');
    }
    const user = {
      username,
      passwordHash: await bcrypt.hash(password, 10),
      isAdmin: !!isAdmin,
      createdAt: new Date().toISOString(),
      disabled: false
    };
    this.users.push(user);
    this._save();
    this._ensureHome(username);
    return { username: user.username, isAdmin: user.isAdmin };
  }

  async verify(username, password) {
    const user = this.find(username);
    if (!user || user.disabled) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return null;
    this._ensureHome(username);
    return { username: user.username, isAdmin: !!user.isAdmin };
  }

  remove(username) {
    const before = this.users.length;
    this.users = this.users.filter(u => u.username !== username);
    if (this.users.length === before) throw new Error('User not found');
    this._save();
    removeLinuxUser(username);
    // Home directory НЕ удаляется — это осознанно, чтобы не терять данные пользователя.
    // Чистка — задача администратора на хосте.
  }

  async setPassword(username, password) {
    if (!password) throw new Error('Password is required');
    const user = this.find(username);
    if (!user) throw new Error('User not found');
    user.passwordHash = await bcrypt.hash(password, 10);
    this._save();
  }

  setAdmin(username, isAdmin) {
    const user = this.find(username);
    if (!user) throw new Error('User not found');
    user.isAdmin = !!isAdmin;
    this._save();
  }

  setDisabled(username, disabled) {
    const user = this.find(username);
    if (!user) throw new Error('User not found');
    user.disabled = !!disabled;
    this._save();
  }

  async bootstrap({ username, password }) {
    if (!username || !password) return;
    if (this.find(username)) return;
    if (this.users.some(u => u.isAdmin)) return; // уже есть какой-то админ — не трогаем
    await this.add({ username, password, isAdmin: true });
    console.log(`[users] bootstrap admin "${username}" created`);
  }
}

module.exports = new UserStore();
