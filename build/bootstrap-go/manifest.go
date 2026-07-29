package main

// Signed release manifest: parsing, canonicalization, and Ed25519
// verification.
//
// Canonicalization contract (signer in build.js and verifier here MUST agree
// byte-for-byte; locked by golden tests):
//   - signed object = the manifest with `manifestSignature` removed entirely
//   - manifest is FLAT and ALL VALUES ARE STRINGS (no nested objects/arrays,
//     no numbers/floats/nulls) — so there is no number canonicalization
//   - keys sorted bytewise (ASCII field names → lexical == bytewise)
//   - compact JSON, UTF-8, NO insignificant whitespace, NO trailing newline
//   - string escaping: Go json with SetEscapeHTML(false) (matches JS
//     JSON.stringify, which never escapes < > &). Our values are printable
//     ASCII URLs/hashes/versions, so the two encoders agree.

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const manifestSignatureKey = "manifestSignature"

// isPrintableASCII reports whether every byte of s is in 0x20-0x7e.
func isPrintableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// requiredManifestFields must all be present (and non-empty) for a manifest to
// be considered well-formed by the Go stub. Legacy fields kept verbatim so old
// Node-SEA bootstrappers keep working.
var requiredManifestFields = []string{
	"version", "payloadUrl", "signatureUrl", "sha256",
	"nodeUrl", "nodeSignatureUrl", "nodeSha256", "nodeVersion",
	"platform", "arch", manifestSignatureKey,
}

// Manifest is the parsed, validated flat string map plus typed accessors.
type Manifest struct {
	fields map[string]string
}

func (m *Manifest) get(k string) string { return m.fields[k] }

func (m *Manifest) Version() string       { return m.get("version") }
func (m *Manifest) PayloadURL() string    { return m.get("payloadUrl") }
func (m *Manifest) PayloadSigURL() string { return m.get("signatureUrl") }
func (m *Manifest) PayloadSha256() string { return m.get("sha256") }
func (m *Manifest) NodeURL() string       { return m.get("nodeUrl") }
func (m *Manifest) NodeSigURL() string    { return m.get("nodeSignatureUrl") }
func (m *Manifest) NodeSha256() string    { return m.get("nodeSha256") }
func (m *Manifest) NodeVersion() string   { return m.get("nodeVersion") }
func (m *Manifest) Platform() string      { return m.get("platform") }
func (m *Manifest) Arch() string          { return m.get("arch") }

// parseFlatStringObject decodes a single top-level JSON object whose values are
// ALL strings. Rejects: non-object roots, nested values, non-string values,
// nulls, and DUPLICATE top-level keys (encoding/json silently keeps the last —
// we detect and reject). Returns the key→value map.
func parseFlatStringObject(raw []byte) (map[string]string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()

	tok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("manifest: not valid JSON: %w", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("manifest: root is not a JSON object")
	}

	out := make(map[string]string)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("manifest: bad key: %w", err)
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, errors.New("manifest: non-string key")
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("manifest: duplicate key %q", key)
		}
		valTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("manifest: bad value for %q: %w", key, err)
		}
		switch v := valTok.(type) {
		case string:
			out[key] = v
		case json.Delim:
			return nil, fmt.Errorf("manifest: value for %q is a nested object/array (only strings allowed)", key)
		case nil:
			return nil, fmt.Errorf("manifest: value for %q is null", key)
		default:
			return nil, fmt.Errorf("manifest: value for %q is not a string (got %T)", key, v)
		}
	}

	// Consume closing '}'.
	if _, err := dec.Token(); err != nil {
		return nil, fmt.Errorf("manifest: malformed object end: %w", err)
	}
	// Assert nothing trails the root object. dec.More() is NOT an EOF check at
	// top level, so decode one more value and require io.EOF — this rejects a
	// fully-valid object followed by extra bytes (trailing JSON or garbage).
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, errors.New("manifest: trailing data after root object")
	}
	return out, nil
}

// canonicalizeManifest serializes the manifest fields (with manifestSignature
// removed) to the canonical signing bytes. MUST match build.js exactly.
func canonicalizeManifest(fields map[string]string) ([]byte, error) {
	signed := make(map[string]string, len(fields))
	for k, v := range fields {
		if k == manifestSignatureKey {
			continue
		}
		// Restrict to PRINTABLE ASCII (0x20-0x7e), symmetric with the JS signer.
		// Eliminates every Go/JS escaping divergence (U+2028/U+2029, \b/\f): none
		// of those bytes can appear, so the two encoders agree byte-for-byte.
		if !isPrintableASCII(k) || !isPrintableASCII(v) {
			return nil, fmt.Errorf("manifest: field %q must be printable ASCII (canonicalization parity)", k)
		}
		signed[k] = v
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)                   // do NOT escape < > & (matches JS JSON.stringify)
	if err := enc.Encode(signed); err != nil { // map → sorted keys, compact
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil // strip Encoder's trailing \n
}

// ParseAndVerifyManifest parses the raw JSON, verifies the embedded Ed25519
// signature against pubKey, and enforces required fields. It does NOT enforce
// platform/arch or anti-downgrade — callers do that with run context.
func ParseAndVerifyManifest(raw []byte, pubKey ed25519.PublicKey) (*Manifest, error) {
	fields, err := parseFlatStringObject(raw)
	if err != nil {
		return nil, err
	}
	for _, f := range requiredManifestFields {
		if fields[f] == "" {
			return nil, fmt.Errorf("manifest: missing required field %q", f)
		}
	}

	sigB64 := fields[manifestSignatureKey]
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return nil, fmt.Errorf("manifest: manifestSignature is not valid base64: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return nil, fmt.Errorf("manifest: signature wrong size (%d, want %d)", len(sig), ed25519.SignatureSize)
	}

	canon, err := canonicalizeManifest(fields)
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(pubKey, canon, sig) {
		return nil, errors.New("manifest: SIGNATURE INVALID — refusing to trust manifest")
	}
	return &Manifest{fields: fields}, nil
}

// loadPubKey builds an Ed25519 public key from the 32-byte hex constant.
func loadPubKey(hexKey string) (ed25519.PublicKey, error) {
	raw, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, fmt.Errorf("pubkey hex invalid: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("pubkey wrong size (%d, want %d)", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}
