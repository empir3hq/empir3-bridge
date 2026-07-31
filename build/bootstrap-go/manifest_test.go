package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"testing"
)

// Deterministic key for tests (NOT a real key).
func testKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	return priv.Public().(ed25519.PublicKey), priv
}

// Golden: format is locked. manifestSignature excluded; keys sorted; compact;
// no trailing newline; < > & NOT escaped (SetEscapeHTML(false)).
func TestCanonicalGolden(t *testing.T) {
	cases := []struct {
		name   string
		fields map[string]string
		want   string
	}{
		{
			name:   "excludes signature, sorts keys",
			fields: map[string]string{"b": "2", "a": "1", manifestSignatureKey: "SIG"},
			want:   `{"a":"1","b":"2"}`,
		},
		{
			name:   "does not html-escape & < >",
			fields: map[string]string{"u": "a&b<c>d"},
			want:   `{"u":"a&b<c>d"}`,
		},
		{
			name:   "url with query stays intact",
			fields: map[string]string{"nodeUrl": "https://x/n.tgz?v=1&t=2"},
			want:   `{"nodeUrl":"https://x/n.tgz?v=1&t=2"}`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := canonicalizeManifest(c.fields)
			if err != nil {
				t.Fatalf("canonicalize: %v", err)
			}
			if string(got) != c.want {
				t.Fatalf("canonical mismatch\n got: %s\nwant: %s", got, c.want)
			}
		})
	}
}

// Key order in the source JSON must not change the canonical bytes.
func TestCanonicalOrderIndependent(t *testing.T) {
	a := []byte(`{"version":"0.3.0","arch":"x64","nodeUrl":"u"}`)
	b := []byte(`{"nodeUrl":"u","version":"0.3.0","arch":"x64"}`)
	fa, err := parseFlatStringObject(a)
	if err != nil {
		t.Fatal(err)
	}
	fb, err := parseFlatStringObject(b)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := canonicalizeManifest(fa)
	cb, _ := canonicalizeManifest(fb)
	if string(ca) != string(cb) {
		t.Fatalf("order changed canonical: %s vs %s", ca, cb)
	}
}

func fullFixture() map[string]string {
	return map[string]string{
		"version":          "0.3.0",
		"payloadUrl":       "https://app.empir3.com/downloads/bridge-payload-v0.3.0.tar.gz",
		"signatureUrl":     "https://app.empir3.com/downloads/bridge-payload-v0.3.0.sig",
		"sha256":           "aaaa",
		"schemaVersion":    "2",
		"nodeUrl":          "https://app.empir3.com/downloads/node-win-x64-v24.13.0.tar.gz",
		"nodeSignatureUrl": "https://app.empir3.com/downloads/node-win-x64-v24.13.0.sig",
		"nodeSha256":       "bbbb",
		"nodeVersion":      "24.13.0",
		"nodeAbi":          "137",
		"platform":         "win32",
		"arch":             "x64",
	}
}

func signFixture(t *testing.T, priv ed25519.PrivateKey, fields map[string]string) []byte {
	t.Helper()
	canon, err := canonicalizeManifest(fields)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, canon)
	fields[manifestSignatureKey] = base64.StdEncoding.EncodeToString(sig)
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestVerifyRoundTrip(t *testing.T) {
	pub, priv := testKey(t)
	fields := fullFixture()
	raw := signFixture(t, priv, fields)
	m, err := ParseAndVerifyManifest(raw, pub)
	if err != nil {
		t.Fatalf("verify failed on valid manifest: %v", err)
	}
	if m.Version() != "0.3.0" || m.NodeVersion() != "24.13.0" || m.Arch() != "x64" {
		t.Fatalf("typed accessors wrong: %+v", m.fields)
	}
}

// Mutating ANY signed field must break verification.
func TestVerifyFailsOnAnyMutation(t *testing.T) {
	pub, priv := testKey(t)
	base := fullFixture()
	raw := signFixture(t, priv, base)

	// Re-parse to a map we can mutate while keeping the original signature.
	var obj map[string]string
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatal(err)
	}
	for k := range obj {
		if k == manifestSignatureKey {
			continue
		}
		mutated := make(map[string]string, len(obj))
		for kk, vv := range obj {
			mutated[kk] = vv
		}
		mutated[k] = obj[k] + "X" // tamper one field, keep the old signature
		raw2, _ := json.Marshal(mutated)
		if _, err := ParseAndVerifyManifest(raw2, pub); err == nil {
			t.Fatalf("verification passed after mutating field %q — signature not covering it", k)
		}
	}
}

func TestVerifyFailsWrongKey(t *testing.T) {
	pub1, priv1 := testKey(t)
	_ = pub1
	otherSeed := make([]byte, ed25519.SeedSize)
	for i := range otherSeed {
		otherSeed[i] = byte(200 - i)
	}
	otherPub := ed25519.NewKeyFromSeed(otherSeed).Public().(ed25519.PublicKey)
	raw := signFixture(t, priv1, fullFixture())
	if _, err := ParseAndVerifyManifest(raw, otherPub); err == nil {
		t.Fatal("verification passed against the wrong public key")
	}
}

func TestParseRejectsMalformed(t *testing.T) {
	pub, _ := testKey(t)
	cases := map[string]string{
		"duplicate key":    `{"version":"1","version":"2","manifestSignature":"x"}`,
		"null value":       `{"version":null}`,
		"nested object":    `{"version":{"x":"1"}}`,
		"array value":      `{"version":["1"]}`,
		"number value":     `{"version":1}`,
		"root not object":  `["a","b"]`,
		"trailing garbage": `{"version":"1"} junk`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseAndVerifyManifest([]byte(raw), pub); err == nil {
				t.Fatalf("expected rejection for %s", name)
			}
		})
	}
}

// A fully-valid, correctly-signed manifest with extra bytes after the root
// object must still be rejected (the trailing-data guard, not the required-field
// check, must do the rejecting — Codex P2).
func TestRejectsTrailingDataOnValidManifest(t *testing.T) {
	pub, priv := testKey(t)
	raw := signFixture(t, priv, fullFixture())
	for _, suffix := range []string{" {}", "x", "\n[]", " null"} {
		if _, err := ParseAndVerifyManifest(append(append([]byte{}, raw...), []byte(suffix)...), pub); err == nil {
			t.Fatalf("expected rejection of valid manifest with trailing %q", suffix)
		}
	}
	// Trailing whitespace alone is fine.
	if _, err := ParseAndVerifyManifest(append(append([]byte{}, raw...), []byte("  \n\t")...), pub); err != nil {
		t.Fatalf("trailing whitespace should be accepted: %v", err)
	}
}

// Non-printable / non-ASCII field values must be rejected symmetrically with the
// JS signer (Codex P2) — canonicalization parity.
func TestRejectsNonPrintableValues(t *testing.T) {
	pub, _ := testKey(t)
	// canonicalizeManifest cannot even sign these, so hand-build raw JSON with a
	// dummy signature and assert the verifier refuses (parity with the JS signer).
	bad := []string{
		"line" + string(rune(0x0a)) + "break",
		"tab" + string(rune(0x09)) + "here",
		"emoji" + string(rune(0x1F600)),
		"sep" + string(rune(0x2028)) + "x",
	}
	for _, b := range bad {
		fields := fullFixture()
		fields["payloadUrl"] = b
		fields[manifestSignatureKey] = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseAndVerifyManifest(raw, pub); err == nil {
			t.Fatalf("expected rejection of non-printable value %q", b)
		}
	}
}

func TestMissingRequiredField(t *testing.T) {
	pub, priv := testKey(t)
	fields := fullFixture()
	delete(fields, "nodeUrl")
	raw := signFixture(t, priv, fields) // validly signed but incomplete
	if _, err := ParseAndVerifyManifest(raw, pub); err == nil {
		t.Fatal("expected rejection for missing required field nodeUrl")
	}
}
