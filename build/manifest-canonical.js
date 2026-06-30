'use strict';
/**
 * Shared manifest canonicalization + Ed25519 signing helpers for the SIGNED
 * release manifest (bridge-version.json). This Node implementation MUST produce
 * bytes BYTE-IDENTICAL to the Go stub's canonicalizeManifest()
 * (build/bootstrap-go/manifest.go) — the signer here and the verifier there are
 * one contract, locked by golden fixtures on both sides.
 *
 * Canonicalization contract:
 *   - signed object = the manifest with `manifestSignature` removed entirely
 *   - manifest is FLAT and ALL VALUES ARE STRINGS (no nested objects/arrays,
 *     no numbers/floats/nulls/booleans) — so there is NO number canonicalization
 *   - keys are ASCII; sorted lexicographically (== bytewise UTF-8 for ASCII)
 *   - compact JSON, UTF-8, NO insignificant whitespace, NO trailing newline
 *   - string escaping matches Go json.Encoder with SetEscapeHTML(false): neither
 *     encoder escapes < > & ; both emit raw UTF-8 for non-ASCII. (Go escapes the
 *     line/paragraph separators U+2028/U+2029 while JS does not — irrelevant
 *     because every manifest value we emit is printable ASCII. Keys + values
 *     MUST stay ASCII; this is asserted below.)
 *
 * JSON.stringify never escapes < > & (unlike Go's HTML-safe default), so with
 * SetEscapeHTML(false) on the Go side the two encoders agree on our inputs.
 */
const crypto = require('crypto');

const MANIFEST_SIGNATURE_KEY = 'manifestSignature';

// Restrict keys + values to PRINTABLE ASCII (0x20-0x7e). This is the explicit
// contract (the Go verifier enforces the same). It eliminates every Go/JS
// JSON-escaping divergence: Go escapes U+2028/U+2029 and uses \u00xx for \b/\f
// while JS does not — but none of those bytes can appear here. Within printable
// ASCII the only escaped chars are " and \, which both encoders emit identically.
// eslint-disable-next-line no-control-regex
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/;

/**
 * Produce the canonical signing bytes (Buffer) for a flat string manifest.
 * `manifestSignature` is excluded. Throws if any value is not a string or if a
 * key/value is not printable ASCII.
 *
 * Emits the sorted key/value pairs MANUALLY rather than via JSON.stringify(obj):
 * V8 enumerates integer-index string keys (e.g. "0", "12") numerically before
 * other keys, which would diverge from Go's lexical map-key marshaling for an
 * unknown numeric-looking field. Building the string from the sorted key array
 * removes that dependency entirely.
 */
function canonicalizeManifest(fields) {
  const keys = Object.keys(fields)
    .filter((k) => k !== MANIFEST_SIGNATURE_KEY)
    .sort(); // printable-ASCII keys → JS lexical == Go bytewise map-key sort

  const parts = [];
  for (const k of keys) {
    const v = fields[k];
    if (typeof v !== 'string') {
      throw new Error(`manifest field ${JSON.stringify(k)} must be a string (got ${typeof v})`);
    }
    if (NON_PRINTABLE_ASCII.test(k) || NON_PRINTABLE_ASCII.test(v)) {
      throw new Error(`manifest field ${JSON.stringify(k)} must be printable ASCII (Go/JS canonicalization parity)`);
    }
    // JSON.stringify on a single string emits the canonical "..."-quoted form;
    // for printable ASCII it escapes only " and \, identical to Go.
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  }
  return Buffer.from(`{${parts.join(',')}}`, 'utf8');
}

/**
 * Sign the canonical form with an Ed25519 private key (crypto.KeyObject or PEM
 * Buffer/string) and return the base64 signature string to embed as
 * `manifestSignature`.
 */
function signManifest(fields, privateKey) {
  const key = privateKey instanceof crypto.KeyObject
    ? privateKey
    : crypto.createPrivateKey(privateKey);
  const sig = crypto.sign(null, canonicalizeManifest(fields), key);
  return sig.toString('base64');
}

/**
 * Re-parse + verify a manifest exactly the way the Go stub will (defensive
 * self-check used by build.js before declaring a build done). `pubKeyHex` is the
 * 32-byte raw Ed25519 public key hex. Returns true/false; never throws on a
 * verification failure (only on a malformed pubkey).
 */
function verifyManifestBytes(rawJsonBuffer, pubKeyHex) {
  let obj;
  try {
    obj = JSON.parse(rawJsonBuffer.toString('utf8'));
  } catch {
    return false;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const sigB64 = obj[MANIFEST_SIGNATURE_KEY];
  if (typeof sigB64 !== 'string' || !sigB64) return false;
  let sig;
  try { sig = Buffer.from(sigB64, 'base64'); } catch { return false; }
  if (sig.length !== 64) return false;

  let canon;
  try { canon = canonicalizeManifest(obj); } catch { return false; }

  const raw = Buffer.from(pubKeyHex, 'hex');
  if (raw.length !== 32) throw new Error('pubkey hex must be 32 bytes');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  try {
    return crypto.verify(null, canon, pub, sig);
  } catch {
    return false;
  }
}

module.exports = {
  MANIFEST_SIGNATURE_KEY,
  canonicalizeManifest,
  signManifest,
  verifyManifestBytes,
};
