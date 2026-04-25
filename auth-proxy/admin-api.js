'use strict';

const express = require('express');
const users = require('./users');
const instances = require('./instances');
const extensions = require('./extensions');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.user?.isAdmin) return res.status(403).json({ error: 'Admin required' });
  next();
}

// ---------- Public (authenticated) endpoints ----------

router.get('/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

router.post('/me/password', requireAuth, express.json(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const ok = await users.verify(req.session.user.username, currentPassword);
    if (!ok) return res.status(403).json({ error: 'Current password is incorrect' });
    await users.setPassword(req.session.user.username, newPassword);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Admin-only endpoints ----------

router.use('/admin', requireAdmin, express.json());

// Users
router.get('/admin/users', (req, res) => {
  res.json(users.list());
});

router.post('/admin/users', async (req, res) => {
  try {
    const { username, password, isAdmin } = req.body || {};
    const u = await users.add({ username, password, isAdmin: !!isAdmin });
    res.json(u);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/admin/users/:username', (req, res) => {
  try {
    if (req.params.username === req.session.user.username) {
      return res.status(400).json({ error: 'You cannot delete yourself' });
    }
    instances.stop(req.params.username);
    users.remove(req.params.username);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/admin/users/:username/password', async (req, res) => {
  try {
    await users.setPassword(req.params.username, req.body?.password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/admin/users/:username/admin', (req, res) => {
  try {
    if (req.params.username === req.session.user.username && !req.body?.isAdmin) {
      return res.status(400).json({ error: 'You cannot demote yourself' });
    }
    users.setAdmin(req.params.username, !!req.body?.isAdmin);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/admin/users/:username/disabled', (req, res) => {
  try {
    if (req.params.username === req.session.user.username) {
      return res.status(400).json({ error: 'You cannot disable yourself' });
    }
    users.setDisabled(req.params.username, !!req.body?.disabled);
    if (req.body?.disabled) instances.stop(req.params.username);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Instances
router.get('/admin/instances', (req, res) => {
  res.json(instances.list());
});

router.post('/admin/instances/:username/stop', (req, res) => {
  const stopped = instances.stop(req.params.username);
  res.json({ ok: true, stopped });
});

// Extensions
router.get('/admin/extensions', async (req, res) => {
  try {
    res.json(await extensions.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/extensions', async (req, res) => {
  try {
    const result = await extensions.install(req.body?.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/admin/extensions/:id', async (req, res) => {
  try {
    const result = await extensions.uninstall(req.params.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
