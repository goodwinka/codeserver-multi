'use strict';

function getDisplayForUser(username) {
  const base = 200;
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = ((hash * 31) + username.charCodeAt(i)) >>> 0;
  }
  return `:${base + (hash % 500)}`;
}

module.exports = { getDisplayForUser };
