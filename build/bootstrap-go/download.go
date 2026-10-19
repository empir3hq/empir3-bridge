package main

// Network fetch + hardened tar.gz extraction. All bytes are verified
// (sha256 + Ed25519) in memory BEFORE any file is written, then extracted to a
// temp dir and atomically renamed into the versioned cache.

import (
	"archive/tar"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	manifestTimeout = 15 * time.Second
	artifactTimeout = 5 * time.Minute
	maxRedirects    = 3
	maxArtifactSize = 250 << 20 // 250 MiB hard ceiling (node ~85MB, payload ~31MB)
)

// httpGetBytes fetches a URL into memory, following a bounded number of
// redirects. Caps the body size.
func httpGetBytes(url string, timeout time.Duration) ([]byte, error) {
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("too many redirects (%d)", len(via))
			}
			return nil
		},
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "empir3-bootstrap/"+BootstrapVersion)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxArtifactSize+1))
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// verifyArtifact checks sha256 (from the signed manifest) AND the artifact's
// own detached Ed25519 signature. Both must pass (defense-in-depth).
func verifyArtifact(name string, data, sig []byte, wantSha string, pub ed25519.PublicKey) error {
	if len(data) > maxArtifactSize {
		return fmt.Errorf("%s exceeds size ceiling", name)
	}
	got := sha256Hex(data)
	if !strings.EqualFold(got, wantSha) {
		return fmt.Errorf("%s sha256 mismatch (got %s, want %s)", name, got, wantSha)
	}
	if len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("%s signature wrong size (%d)", name, len(sig))
	}
	if !ed25519.Verify(pub, data, sig) {
		return fmt.Errorf("%s SIGNATURE INVALID — refusing", name)
	}
	return nil
}

// extractTarGzHardened gunzips + untars `data` into destDir with strict path
// safety. Rejects absolute paths, drive letters, UNC, backslash separators,
// `..` escapes, symlinks, hardlinks, devices. Only regular files + dirs.
func extractTarGzHardened(data []byte, destDir string) error {
	gz, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()

	absDest, err := filepath.Abs(destDir)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}

		name := hdr.Name
		if name == "" {
			continue
		}
		// Reject anything that isn't a clean relative path.
		if strings.ContainsRune(name, '\\') {
			return fmt.Errorf("tar entry has backslash: %q", name)
		}
		if strings.HasPrefix(name, "/") || filepath.IsAbs(name) {
			return fmt.Errorf("tar entry is absolute: %q", name)
		}
		if len(name) >= 2 && name[1] == ':' { // drive letter C:
			return fmt.Errorf("tar entry has drive letter: %q", name)
		}
		if strings.HasPrefix(name, "//") || strings.HasPrefix(name, "\\\\") {
			return fmt.Errorf("tar entry is UNC: %q", name)
		}

		clean := filepath.Clean(name)
		target := filepath.Join(absDest, clean)
		rel, err := filepath.Rel(absDest, target)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return fmt.Errorf("tar entry escapes dest: %q", name)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			// Bound per-file copy to the artifact ceiling.
			if _, err := io.Copy(out, io.LimitReader(tr, maxArtifactSize)); err != nil {
				out.Close()
				return err
			}
			out.Close()
		case tar.TypeSymlink, tar.TypeLink, tar.TypeChar, tar.TypeBlock, tar.TypeFifo:
			return fmt.Errorf("tar entry has disallowed type %d: %q", hdr.Typeflag, name)
		default:
			// Skip unknown metadata-only types (pax headers handled by archive/tar).
			continue
		}
	}
	return nil
}

// extractVerifiedToCache extracts into a temp dir next to finalDir, then
// atomically renames into place. If finalDir already exists (another racer or a
// prior run), the temp is discarded.
func extractVerifiedToCache(data []byte, finalDir string) error {
	if dirHasEntry(finalDir) {
		return nil // already present
	}
	parent := filepath.Dir(finalDir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(parent, ".tmp-extract-*")
	if err != nil {
		return err
	}
	cleanup := true
	defer func() {
		if cleanup {
			os.RemoveAll(tmp)
		}
	}()
	if err := extractTarGzHardened(data, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, finalDir); err != nil {
		// Lost the race (someone else renamed first) — fine if final now exists.
		if dirHasEntry(finalDir) {
			return nil
		}
		return err
	}
	cleanup = false
	return nil
}

func dirHasEntry(dir string) bool {
	info, err := os.Stat(dir)
	return err == nil && info.IsDir()
}
