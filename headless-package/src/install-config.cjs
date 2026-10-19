'use strict';

function validateInstallConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Headless install config is malformed');
  const prefix = String(config.prefix || '');
  const serviceUser = String(config.serviceUser || '');
  const server = String(config.server || '');
  if (!/^\/(?:opt|usr\/local\/lib)\/[A-Za-z0-9._/-]+$/.test(prefix) || prefix.includes('..')) {
    throw new Error('Headless install prefix is unsafe');
  }
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(serviceUser)) throw new Error('Headless service user is unsafe');
  if (!/^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(server)
    && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(server)) {
    throw new Error('Headless Empir3 server URL is unsafe');
  }
  return { prefix, serviceUser, server };
}

module.exports = { validateInstallConfig };
