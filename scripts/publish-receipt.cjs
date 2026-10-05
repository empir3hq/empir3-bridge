'use strict';

const { createHash } = require('crypto');

function sha256OfObject(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildCandidate({ releaseKind, version, target, immutableFiles, fixedFiles }) {
  return {
    schemaVersion: 1,
    releaseKind,
    version,
    target,
    immutableFiles,
    fixedFiles,
  };
}

function buildPrestageReceipt(candidate, createdAt = new Date().toISOString()) {
  return {
    receiptSchemaVersion: 1,
    status: 'prestaged',
    createdAt,
    candidateSha256: sha256OfObject(candidate),
    candidate,
  };
}

function validatePrestageReceipt(receipt, candidate) {
  if (receipt?.receiptSchemaVersion !== 1 || receipt?.status !== 'prestaged') {
    throw new Error('pre-stage receipt is not an unused schema 1 receipt');
  }
  const localSha = sha256OfObject(candidate);
  if (receipt.candidateSha256 !== localSha
    || sha256OfObject(receipt.candidate) !== localSha
    || JSON.stringify(receipt.candidate) !== JSON.stringify(candidate)) {
    throw new Error('pre-stage receipt does not match the exact local candidate and publish target');
  }
  return receipt;
}

function finalizeReceipt(receipt, finalizedAt = new Date().toISOString()) {
  return {
    ...receipt,
    status: 'finalized',
    finalizedAt,
  };
}

module.exports = {
  buildCandidate,
  buildPrestageReceipt,
  finalizeReceipt,
  sha256OfObject,
  validatePrestageReceipt,
};
