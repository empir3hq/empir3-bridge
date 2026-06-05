package main

// Empir3 Bridge native bootstrapper (Go). Replaces the Node-SEA bootstrapper:
// fetches + verifies the signed manifest, ensures the pinned Node runtime and
// the JS payload are cached, then spawns `node entry.js <args>`.

import (
	"crypto/ed25519"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ── Compile-time constants ──────────────────────────────────────────────
// Ed25519 public key (32-byte hex) — MUST match build/payload-signing-pub.json
// publicKeyHex and the old bootstrap.js PAYLOAD_PUBKEY_HEX.
const PubKeyHex = "a0813b51654fcb6026c0cfc9d0f367c8535b96c94b52c9fff15d2fe59f7cd68a"

// BootstrapVersion: native stub line. 2.0.0 = first Go release (0.3.0);
// 2.0.1 = fix so the launcher path (--daemon/no-args) does NOT put the spawned
// tray in a kill-on-close Job Object. The bump is REQUIRED so a fixed stub
// (2.0.1) overwrites an already-installed broken stable stub (2.0.0) during
// reconcile — equal versions would keep the broken one.
const BootstrapVersion = "2.0.2"

const defaultVersionURL = "https://app.empir3.com/downloads/bridge-version.json"

// ── Paths (resolved at runtime) ─────────────────────────────────────────

type paths struct {
	home, bridgeHome, payloadRoot, nodeRoot string
	appData, stableExe, pointer, lockFile   string
	versionURL                              string
}

func resolvePaths() (*paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	bridgeHome := filepath.Join(home, ".empir3-bridge")
	appRoaming := os.Getenv("APPDATA")
	if appRoaming == "" {
		appRoaming = filepath.Join(home, "AppData", "Roaming")
	}
	appData := filepath.Join(appRoaming, "Empir3")
	versionURL := os.Getenv("EMPIR3_BRIDGE_VERSION_URL")
	if versionURL == "" {
		versionURL = defaultVersionURL
	}
	return &paths{
		home:        home,
		bridgeHome:  bridgeHome,
		payloadRoot: filepath.Join(bridgeHome, "payload"),
		nodeRoot:    filepath.Join(bridgeHome, "node"),
		appData:     appData,
		stableExe:   filepath.Join(appData, "Empir3Setup.exe"),
		pointer:     filepath.Join(appData, "bridge-bootstrap.json"),
		lockFile:    filepath.Join(bridgeHome, ".runtime.lock"),
		versionURL:  versionURL,
	}, nil
}

func (p *paths) payloadDir(v string) string { return filepath.Join(p.payloadRoot, v) }
func (p *paths) nodeDir(v string) string    { return filepath.Join(p.nodeRoot, v) }
func (p *paths) nodeExe(v string) string    { return filepath.Join(p.nodeDir(v), "node.exe") }

func readVersionFile(f string) string {
	b, err := os.ReadFile(f)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func writeVersionFile(f, v string) error {
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		return err
	}
	tmp := f + ".new"
	if err := os.WriteFile(tmp, []byte(v), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, f)
}

func payloadExtracted(p *paths, v string) bool {
	if v == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(p.payloadDir(v), "entry.js"))
	return err == nil
}

func nodeExtracted(p *paths, v string) bool {
	if v == "" {
		return false
	}
	_, err := os.Stat(p.nodeExe(v))
	return err == nil
}

// ── semver compare (numeric a.b.c; returns -1/0/1) ──────────────────────

func semverCmp(a, b string) int {
	pa, pb := parseSemver(a), parseSemver(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] > pb[i] {
				return 1
			}
			return -1
		}
	}
	return 0
}

func parseSemver(s string) [3]int {
	var out [3]int
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	parts := strings.SplitN(s, ".", 3)
	for i := 0; i < 3 && i < len(parts); i++ {
		// stop at any non-numeric suffix (e.g. pre-release)
		num := parts[i]
		for j := 0; j < len(num); j++ {
			if num[j] < '0' || num[j] > '9' {
				num = num[:j]
				break
			}
		}
		if n, err := strconv.Atoi(num); err == nil {
			out[i] = n
		}
	}
	return out
}

// ── stderr logging (NEVER stdout — keeps --mcp JSON-RPC clean) ──────────

func logln(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[empir3-bootstrap] "+format+"\n", a...)
}

func fail(format string, a ...any) {
	logln("ERROR: "+format, a...)
	os.Exit(1)
}

// ── main ────────────────────────────────────────────────────────────────

func main() {
	args := os.Args[1:]

	// Native, network-free, stdout-allowed introspection.
	if hasFlag(args, "--bootstrap-version") {
		fmt.Println("empir3-bootstrap " + BootstrapVersion)
		return
	}
	if hasFlag(args, "--bootstrap-pubkey") {
		fmt.Println(PubKeyHex)
		return
	}
	if hasFlag(args, "--help") || hasFlag(args, "-h") {
		printHelp()
		return
	}

	p, err := resolvePaths()
	if err != nil {
		fail("cannot resolve paths: %v", err)
	}

	// Network-free teardown.
	if hasFlag(args, "--uninstall") {
		runUninstall(p)
		return
	}

	// --version: cached payload version, else bootstrap version. No network.
	if hasFlag(args, "--version") || hasFlag(args, "-v") {
		if v := readVersionFile(filepath.Join(p.payloadRoot, ".version")); v != "" && payloadExtracted(p, v) {
			fmt.Println(v)
		} else {
			fmt.Println(BootstrapVersion)
			logln("payload not installed; printed bootstrap version")
		}
		return
	}

	pub, err := loadPubKey(PubKeyHex)
	if err != nil {
		fail("bad embedded pubkey: %v", err)
	}

	// --mcp: NO network, NO stdout, cached runtime only. Long-running stdio shim
	// with no tray, so Go IS its supervisor → kill-on-close job (no orphan).
	if hasFlag(args, "--mcp") {
		payloadDir, nodeExe, ok := cachedRuntime(p)
		if !ok {
			fail("--mcp requires an installed runtime; none cached (run the bridge once first)")
		}
		os.Exit(spawnNode(p, nodeExe, payloadDir, args, p.stableExeForRun(args), true))
		return
	}

	// Install / run path (--daemon, --daemon-real, no args): network-enabled.
	authoritativeExe := reconcileStableExe(p, args) // may re-exec a newer stable and never return
	payloadDir, nodeExe := ensureRuntime(p, pub)

	// Release payloads contain Empir3Tray.exe. In that case, do the user-facing
	// tray launch from the native bootstrapper itself. Node still performs
	// registration/prep, but the critical tray process is not a silent
	// grandchild of a transient Node process.
	if !hasFlag(args, "--daemon-real") {
		trayExe := filepath.Join(payloadDir, "Empir3Tray.exe")
		if _, err := os.Stat(trayExe); err == nil {
			prepCode := spawnNode(p, nodeExe, payloadDir, []string{"--launcher-prep"}, authoritativeExe, false)
			if prepCode != 0 {
				appendBridgeLog(p, "launcher prep exited with code %d; starting tray anyway", prepCode)
				logln("launcher prep exited with code %d; starting tray anyway", prepCode)
			}
			os.Exit(spawnTray(p, payloadDir, authoritativeExe))
		}
	}

	// Kill-on-close Job Object ONLY when Go is the actual supervisor of the
	// long-running node it spawns — i.e. `--daemon-real` (the tray-supervised
	// daemon). For `--daemon` and no-args, node is a TRANSIENT launcher: it
	// spawns the detached tray (a grandchild) and exits, after which Go exits
	// too. A kill-on-close job there would tear the tray down the instant Go
	// exits (the tray inherits Go's job), so the tray never persists — which
	// also breaks autostart. The tray itself owns the daemon's lifetime via its
	// own kill-on-close job over `--daemon-real`.
	killOnClose := hasFlag(args, "--daemon-real")
	os.Exit(spawnNode(p, nodeExe, payloadDir, args, authoritativeExe, killOnClose))
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func printHelp() {
	fmt.Println("Empir3 Bridge (bootstrap " + BootstrapVersion + ")")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  Empir3Setup.exe              Install + start the bridge (first-time setup).")
	fmt.Println("  Empir3Setup.exe --daemon     Run the bridge (used by autostart; spawns the tray).")
	fmt.Println("  Empir3Setup.exe --uninstall  Remove all bridge components from this machine.")
	fmt.Println("  Empir3Setup.exe --version    Print the installed bridge version.")
}

// stableExeForRun returns the exe to advertise as EMPIR3_BOOTSTRAP_EXE without
// running the full reconcile (used by --mcp, which must not mutate state):
// prefer an existing stable exe, else this running exe.
func (p *paths) stableExeForRun(_ []string) string {
	if _, err := os.Stat(p.stableExe); err == nil {
		return p.stableExe
	}
	self, _ := os.Executable()
	return self
}

// cachedRuntime returns the active cached payload dir + node exe, or ok=false
// when either is missing. No network.
func cachedRuntime(p *paths) (string, string, bool) {
	pv := readVersionFile(filepath.Join(p.payloadRoot, ".version"))
	nv := readVersionFile(filepath.Join(p.nodeRoot, ".version"))
	if !payloadExtracted(p, pv) || !nodeExtracted(p, nv) {
		return "", "", false
	}
	return p.payloadDir(pv), p.nodeExe(nv), true
}

// reconcileStableExe implements the decision table in the design doc and
// returns the authoritative exe path to advertise for this run. May re-exec a
// newer installed stable and exit (never returning).
func reconcileStableExe(p *paths, args []string) string {
	self, err := os.Executable()
	if err != nil {
		return p.stableExe
	}
	stableVer := readExeBootstrapVersion(p.stableExe)

	if stableVer == "" {
		// No stable yet → install ourselves there.
		if copyExe(self, p.stableExe) == nil {
			writePointer(p, p.stableExe)
			return p.stableExe
		}
		writePointer(p, self)
		return self
	}

	switch cmp := semverCmp(stableVer, BootstrapVersion); {
	case cmp > 0:
		// Stable is NEWER → let it drive. Re-exec with same args, exit with code.
		logln("stable bootstrapper v%s is newer than this stub v%s; handing off", stableVer, BootstrapVersion)
		cmd := exec.Command(p.stableExe, args...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if runErr := cmd.Run(); runErr != nil {
			if ee, ok := runErr.(*exec.ExitError); ok {
				os.Exit(ee.ExitCode())
			}
			fail("re-exec of stable bootstrapper failed: %v", runErr)
		}
		os.Exit(0)
		return "" // unreachable
	case cmp == 0:
		writePointer(p, p.stableExe)
		return p.stableExe
	default: // stable older than running
		if copyExe(self, p.stableExe) == nil {
			writePointer(p, p.stableExe)
			return p.stableExe
		}
		// Locked/stale stable: advertise the running (newer) stub, not the older
		// stable. Retry replacement on a future run.
		logln("stable bootstrapper v%s is older and locked; using running stub for this session", stableVer)
		writePointer(p, self)
		return self
	}
}

// ensureRuntime fetches+verifies the manifest and ensures the payload + node
// are cached, under an exclusive install lock. Returns (payloadDir, nodeExe).
func ensureRuntime(p *paths, pub ed25519.PublicKey) (string, string) {
	if err := os.MkdirAll(p.bridgeHome, 0o755); err != nil {
		fail("cannot create %s: %v", p.bridgeHome, err)
	}
	release, err := acquireInstallLock(p.lockFile)
	if err != nil {
		fail("cannot acquire install lock: %v", err)
	}
	defer release()

	activePayload := readVersionFile(filepath.Join(p.payloadRoot, ".version"))
	activeNode := readVersionFile(filepath.Join(p.nodeRoot, ".version"))

	raw, err := httpGetBytes(p.versionURL, manifestTimeout)
	if err != nil {
		// Offline: fall back to cached runtime if complete.
		if pd, ne, ok := cachedRuntime(p); ok {
			logln("manifest fetch failed (%v); using cached runtime", err)
			return pd, ne
		}
		fail("manifest fetch failed and no cached runtime: %v", err)
	}
	m, err := ParseAndVerifyManifest(raw, pub)
	if err != nil {
		if pd, ne, ok := cachedRuntime(p); ok {
			logln("manifest rejected (%v); using cached runtime", err)
			return pd, ne
		}
		fail("manifest verification failed and no cached runtime: %v", err)
	}
	if m.Platform() != "win32" || m.Arch() != "x64" {
		fail("manifest platform/arch mismatch: %s/%s", m.Platform(), m.Arch())
	}

	// ── Payload ──
	payloadVer := m.Version()
	if payloadExtracted(p, activePayload) && semverCmp(activePayload, payloadVer) > 0 {
		logln("cached payload v%s newer than manifest v%s; keeping cached (anti-downgrade)", activePayload, payloadVer)
		payloadVer = activePayload
	} else if !payloadExtracted(p, payloadVer) {
		logln("fetching payload v%s", payloadVer)
		data, err := httpGetBytes(m.PayloadURL(), artifactTimeout)
		if err != nil {
			fail("payload download failed: %v", err)
		}
		sig, err := httpGetBytes(m.PayloadSigURL(), artifactTimeout)
		if err != nil {
			fail("payload sig download failed: %v", err)
		}
		if err := verifyArtifact("payload", data, sig, m.PayloadSha256(), pub); err != nil {
			fail("%v", err)
		}
		if err := extractVerifiedToCache(data, p.payloadDir(payloadVer)); err != nil {
			fail("payload extract failed: %v", err)
		}
		if err := writeVersionFile(filepath.Join(p.payloadRoot, ".version"), payloadVer); err != nil {
			fail("write payload .version: %v", err)
		}
	}

	// ── Node ──
	nodeVer := m.NodeVersion()
	if nodeExtracted(p, activeNode) && semverCmp(activeNode, nodeVer) > 0 {
		logln("cached node v%s newer than manifest v%s; keeping cached (anti-downgrade)", activeNode, nodeVer)
		nodeVer = activeNode
	} else if !nodeExtracted(p, nodeVer) {
		logln("fetching node runtime v%s", nodeVer)
		data, err := httpGetBytes(m.NodeURL(), artifactTimeout)
		if err != nil {
			fail("node download failed: %v", err)
		}
		sig, err := httpGetBytes(m.NodeSigURL(), artifactTimeout)
		if err != nil {
			fail("node sig download failed: %v", err)
		}
		if err := verifyArtifact("node", data, sig, m.NodeSha256(), pub); err != nil {
			fail("%v", err)
		}
		if err := extractVerifiedToCache(data, p.nodeDir(nodeVer)); err != nil {
			fail("node extract failed: %v", err)
		}
		if err := writeVersionFile(filepath.Join(p.nodeRoot, ".version"), nodeVer); err != nil {
			fail("write node .version: %v", err)
		}
	}

	if !nodeExtracted(p, nodeVer) {
		fail("node runtime missing after install (v%s)", nodeVer)
	}
	return p.payloadDir(payloadVer), p.nodeExe(nodeVer)
}

// spawnNode runs `<nodeExe> <payloadDir>/entry.js <args...>` with the payload
// env, inherits stdio, and returns its exit code. When killOnClose is true (Go
// is the supervisor of a long-running node — `--daemon-real`/`--mcp`), the node
// child is assigned to a kill-on-close Job Object so it can't orphan. When false
// (the transient `--daemon`/no-args launcher that spawns the detached tray and
// exits), NO job is used — otherwise the tray, a grandchild inside the job,
// would be killed the moment Go exits.
func spawnNode(p *paths, nodeExe, payloadDir string, args []string, bootstrapExe string, killOnClose bool) int {
	entry := filepath.Join(payloadDir, "entry.js")
	cmd := exec.Command(nodeExe, append([]string{entry}, args...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Dir = payloadDir
	cmd.Env = append(os.Environ(),
		"EMPIR3_BOOTSTRAP_EXE="+bootstrapExe,
		"EMPIR3_BRIDGE_PAYLOAD_DIR="+payloadDir,
		"EMPIR3_BRIDGE_PAYLOAD_VERSION="+filepath.Base(payloadDir),
		"EMPIR3_BRIDGE_BOOTSTRAP_VERSION="+BootstrapVersion,
	)

	var job syscall.Handle
	if killOnClose {
		job = newKillOnCloseJob()
	}
	if err := cmd.Start(); err != nil {
		fail("failed to spawn node: %v", err)
	}
	if job != 0 && cmd.Process != nil {
		if assignToJob(job, cmd.Process.Pid) {
			logln("node child assigned to kill-on-close job")
		}
	}
	if err := cmd.Wait(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		logln("node exited abnormally: %v", err)
		return 1
	}
	return 0
}

func appendBridgeLog(p *paths, format string, a ...any) {
	if p == nil || p.appData == "" {
		return
	}
	if err := os.MkdirAll(p.appData, 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(p.appData, "bridge.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	ts := time.Now().Format(time.RFC3339)
	fmt.Fprintf(f, "%s [empir3-bootstrap] %s\n", ts, fmt.Sprintf(format, a...))
}

func spawnTray(p *paths, payloadDir, bootstrapExe string) int {
	trayExe := filepath.Join(payloadDir, "Empir3Tray.exe")
	if _, err := os.Stat(trayExe); err != nil {
		appendBridgeLog(p, "tray exe missing: %s (%v)", trayExe, err)
		logln("tray exe missing: %s (%v)", trayExe, err)
		return 1
	}

	cmd := exec.Command(trayExe)
	cmd.Dir = filepath.Dir(trayExe)
	cmd.Env = append(os.Environ(),
		"EMPIR3_BOOTSTRAP_EXE="+bootstrapExe,
		"EMPIR3_BRIDGE_PAYLOAD_DIR="+payloadDir,
		"EMPIR3_BRIDGE_PAYLOAD_VERSION="+filepath.Base(payloadDir),
		"EMPIR3_BRIDGE_BOOTSTRAP_VERSION="+BootstrapVersion,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: detachedProcess | createNewProcessGroup,
	}

	appendBridgeLog(p, "spawning tray natively: %s", trayExe)
	if err := cmd.Start(); err != nil {
		appendBridgeLog(p, "native tray spawn failed: %v", err)
		logln("native tray spawn failed: %v", err)
		return 1
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
		_ = cmd.Process.Release()
	}
	appendBridgeLog(p, "native tray spawned pid=%d", pid)
	logln("native tray spawned pid=%d", pid)
	return 0
}
