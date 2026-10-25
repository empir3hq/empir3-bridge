'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function defaultPidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves a process exists but is owned by somebody else. Only ESRCH
    // proves the recorded owner is gone, which is the sole safe delete case.
    if (error && error.code === 'ESRCH') return false;
    return true;
  }
}

function singletonOwnerPid(profileDir, fsApi = fs) {
  const lockPath = path.join(profileDir, 'SingletonLock');
  let stat;
  try {
    stat = fsApi.lstatSync(lockPath);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) return null;
  let target = '';
  try {
    target = String(fsApi.readlinkSync(lockPath));
  } catch {
    return null;
  }
  const match = /-(\d+)$/.exec(target);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function removeStaleChromeSingletons(profileDir, options = {}) {
  if ((options.platform || process.platform) !== 'linux') {
    return { checked: false, removed: [], reason: 'not-linux' };
  }
  const fsApi = options.fsApi || fs;
  const pid = singletonOwnerPid(profileDir, fsApi);
  if (!pid) return { checked: true, removed: [], reason: 'owner-unproven' };
  const pidIsAlive = options.pidIsAlive || defaultPidIsAlive;
  if (pidIsAlive(pid)) return { checked: true, removed: [], pid, reason: 'owner-alive' };

  const removed = [];
  for (const name of SINGLETON_FILES) {
    const target = path.join(profileDir, name);
    try {
      fsApi.unlinkSync(target);
      removed.push(name);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return { checked: true, removed, pid, reason: 'owner-dead' };
}

module.exports = {
  SINGLETON_FILES,
  defaultPidIsAlive,
  removeStaleChromeSingletons,
  singletonOwnerPid,
};
