'use strict';

const fs = require('fs');
const path = require('path');

function buildGitconfig(username, settings) {
  const s = settings || {};
  const git = s.git || {};
  const name = (git.name || '').trim() || username;
  const email = (git.email || '').trim() || `${username}@localhost`;

  let content = `[user]\n\tname = ${name}\n\temail = ${email}\n`;

  const gitlabs = Array.isArray(s.gitlabs) ? s.gitlabs : [];
  for (const entry of gitlabs) {
    const rawUrl = (entry.url || '').trim().replace(/\/$/, '');
    const token = (entry.token || '').trim();
    if (!rawUrl || !token) continue;
    const authedUrl = rawUrl.replace(/^(https?:\/\/)/, `$1oauth2:${token}@`);
    content += `[url "${authedUrl}/"]\n\tinsteadOf = ${rawUrl}/\n`;
  }

  const redirects = Array.isArray(s.urlRedirects) ? s.urlRedirects : [];
  for (const r of redirects) {
    let from = (r.from || '').trim();
    let to = (r.to || '').trim();
    if (!from || !to) continue;
    if (/^https?:\/\//i.test(from) && !from.endsWith('/')) from += '/';
    if (/^https?:\/\//i.test(to) && !to.endsWith('/')) to += '/';
    content += `[url "${to}"]\n\tinsteadOf = ${from}\n`;
  }

  const proxyUrl = (git.proxy || '').trim() || process.env.GIT_PROXY_URL || process.env.HTTP_PROXY || '';
  const sslNoVerify = process.env.GIT_SSL_NO_VERIFY === 'true' || process.env.GIT_SSL_NO_VERIFY === '1';
  if (proxyUrl || sslNoVerify) {
    content += '[http]\n';
    if (proxyUrl) content += `\tproxy = ${proxyUrl}\n`;
    if (sslNoVerify) content += '\tsslVerify = false\n';
  }

  return content;
}

function writeUserGitconfig(username, settings, uid) {
  const home = `/users/${username}`;
  const gitconfigPath = path.join(home, '.gitconfig');
  const content = buildGitconfig(username, settings);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(gitconfigPath, content, { mode: 0o644 });
  if (typeof uid === 'number') {
    try { fs.chownSync(gitconfigPath, uid, uid); } catch (_) { /* ignore */ }
  }
  return gitconfigPath;
}

module.exports = { buildGitconfig, writeUserGitconfig };

