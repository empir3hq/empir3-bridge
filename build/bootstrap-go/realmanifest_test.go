package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRealDistManifestVerifies proves the manifest that build.js just signed is
// accepted by the production verifier with the REAL embedded PubKeyHex — the
// end-to-end signer↔verifier contract across Node (signer) and Go (verifier).
// Skipped when no dist manifest is present (fresh checkout / CI without a build).
func TestRealDistManifestVerifies(t *testing.T) {
	manifestPath := filepath.Join("..", "dist", "bridge-version.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Skipf("no dist manifest (%v) — run `node build/build.js` first", err)
	}
	pub, err := loadPubKey(PubKeyHex)
	if err != nil {
		t.Fatalf("embedded pubkey bad: %v", err)
	}
	m, err := ParseAndVerifyManifest(raw, pub)
	if err != nil {
		t.Fatalf("production verifier REJECTED the freshly-signed manifest: %v", err)
	}
	if m.Platform() != "win32" || m.Arch() != "x64" {
		t.Fatalf("unexpected platform/arch: %s/%s", m.Platform(), m.Arch())
	}
	t.Logf("verified real manifest: payload v%s, node v%s (abi %s)",
		m.Version(), m.NodeVersion(), m.get("nodeAbi"))
}
