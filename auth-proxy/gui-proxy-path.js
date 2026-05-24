'use strict';

function stripGuiPrefix(url, username) {
  const prefix = `/_auth/gui/${username}`;
  if (!url) return '/';
  if (!(url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))) return url;
  const stripped = url.slice(prefix.length);
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

module.exports = { stripGuiPrefix };
