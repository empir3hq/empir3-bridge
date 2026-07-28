package main

import (
	"os"
	"testing"
)

// TestDumpCanonForParity writes the canonical bytes for the cross-language
// parity fixture to a file so a Node-side check can diff them. Skipped unless
// EMPIR3_CANON_DUMP is set (it is not a normal CI assertion — the in-repo
// golden test TestCanonicalGolden + the Node golden test are the real locks).
func TestDumpCanonForParity(t *testing.T) {
	out := os.Getenv("EMPIR3_CANON_DUMP")
	if out == "" {
		t.Skip("set EMPIR3_CANON_DUMP=<path> to dump parity bytes")
	}
	fields := map[string]string{
		"version":           "0.3.0",
		"payloadUrl":        "https://app.empir3.com/downloads/bridge-payload-v0.3.0.tar.gz?v=0.3.0&t=123",
		"signatureUrl":      "https://app.empir3.com/downloads/bridge-payload-v0.3.0.sig?v=0.3.0&t=123",
		"sha256":            "aaaa",
		"schemaVersion":     "2",
		"nodeUrl":           "https://app.empir3.com/downloads/node-win-x64-v24.13.0.tar.gz?v=24.13.0&t=123",
		"nodeSignatureUrl":  "https://app.empir3.com/downloads/node-win-x64-v24.13.0.sig?v=24.13.0&t=123",
		"nodeSha256":        "bbbb",
		"nodeVersion":       "24.13.0",
		"nodeAbi":           "137",
		"platform":          "win32",
		"arch":              "x64",
		"manifestSignature": "SHOULD_BE_EXCLUDED",
	}
	canon, err := canonicalizeManifest(fields)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, canon, 0o644); err != nil {
		t.Fatal(err)
	}
}
