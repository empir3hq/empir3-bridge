'use strict';

const { basename } = require('node:path');

const VERSIONED_DISTRIBUTABLE = /\.(exe|zip|nupkg|deb|rpm)$/i;

function staleVersionArtifacts(files, version) {
  const expected = String(version || '').trim();
  if (!expected) throw new Error('release version is required');
  return files.filter((file) => {
    const name = basename(file);
    if (!VERSIONED_DISTRIBUTABLE.test(name)) return false;
    return !name.includes(expected);
  });
}

module.exports = { staleVersionArtifacts };
