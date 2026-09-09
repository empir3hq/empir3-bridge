package main

// Native, network-free uninstall for the Go stub.
//
// Why native (not "delegate to `node entry.js --uninstall`" as the payload does
// for old SEA installs): under the Go bootstrapper, node.exe runs FROM
// ~/.empir3-bridge/node/<v>/, so spawning it to delete ~/.empir3-bridge would
// lock the very cache being removed (a running exe can't delete itself on
// Windows) → partial uninstall. The Go stub does not live inside
// ~/.empir3-bridge, so it can remove the whole tree directly. (Deviation from
// the design doc's delegate-first rule — raised in code review.)

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	autostartKey       = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	autostartValueName = "Empir3Bridge"
	forcelistKey       = `HKCU\Software\Policies\Google\Chrome\ExtensionInstallForcelist`
	extensionID        = "gbigofjjgcpjkffhlfepjdglabhngeii"
)

// uninstallTestMode suppresses HKCU writes + the dialog so tests don't touch
// the real user environment (Codex test-plan item 19).
func uninstallTestMode() bool { return os.Getenv("EMPIR3_UNINSTALL_TEST") == "1" }

func runUninstall(p *paths) {
	// The tray confirms before invoking us; direct CLI use is a power-user path.
	// No second confirmation here.
	steps := nativeUninstall(p)
	logln("uninstall complete (%d steps)", steps)
	if !uninstallTestMode() {
		showUninstallDoneDialog(steps)
	}
}

func nativeUninstall(p *paths) int {
	steps := 0
	bump := func() { steps++ }

	// 1. Kill the tray first so it can't respawn anything we kill on a port.
	if runHidden("taskkill", "/F", "/IM", "Empir3Tray.exe") {
		logln("  killed Empir3Tray.exe")
		bump()
	}

	// 2. Kill any daemon listening on 3006-3306.
	for _, pid := range listeningBridgePids() {
		if runHidden("taskkill", "/F", "/PID", pid) {
			logln("  killed bridge daemon pid %s", pid)
			bump()
		}
	}

	if !uninstallTestMode() || os.Getenv("EMPIR3_UNINSTALL_TEST_REG") == "1" {
		// 3. Autostart.
		if regValueExists(autostartKey, autostartValueName) {
			if runHidden("reg", "delete", autostartKey, "/v", autostartValueName, "/f") {
				logln("  removed Windows autostart")
				bump()
			}
		}
		// 4. Chrome force-install policy slots that hold OUR extension.
		for _, slot := range forcelistSlotsForExtension() {
			if runHidden("reg", "delete", forcelistKey, "/v", slot, "/f") {
				logln("  removed Chrome force-install policy (slot %s)", slot)
				bump()
			}
		}
	}

	// 5. Start Menu shortcut + parent folder.
	appRoaming := os.Getenv("APPDATA")
	if appRoaming == "" {
		appRoaming = filepath.Join(p.home, "AppData", "Roaming")
	}
	lnk := filepath.Join(appRoaming, "Microsoft", "Windows", "Start Menu", "Programs", "Empir3", "Empir3.lnk")
	if fileExists(lnk) {
		if os.Remove(lnk) == nil {
			logln("  removed Start Menu shortcut")
			bump()
		}
		folder := filepath.Dir(lnk)
		if entries, err := os.ReadDir(folder); err == nil && len(entries) == 0 {
			os.Remove(folder)
		}
	}

	// 6. The whole ~/.empir3-bridge (payloads, node cache, runtime files).
	if dirHasEntry(p.bridgeHome) {
		if err := os.RemoveAll(p.bridgeHome); err != nil {
			logln("  WARN: could not fully clear %s: %v", p.bridgeHome, err)
		} else {
			logln("  cleared ~/.empir3-bridge (payloads + node + runtime)")
			bump()
		}
	}

	// 7. %APPDATA%/Empir3 (auth, settings, logs). The running Empir3Setup.exe
	// may live here and can't delete itself — children still go; that's
	// expected and documented.
	if dirHasEntry(p.appData) {
		if err := os.RemoveAll(p.appData); err != nil {
			logln("  note: %%APPDATA%%/Empir3 partially cleared (running exe can't self-delete): %v", err)
		} else {
			logln("  cleared %%APPDATA%%/Empir3 (auth, settings, logs)")
		}
		bump()
	}

	return steps
}

func showUninstallDoneDialog(steps int) {
	body := "Empir3 Bridge has been uninstalled.\n\n" +
		itoa(steps) + " item(s) were removed. You can delete Empir3Setup.exe whenever you like.\n\n" +
		"If Chrome is open, the helper extension disappears the next time you restart it."
	messageBox(body, "Empir3 Bridge", mbOK|mbIconInfo|mbSetForeground|mbTopmost)
}

// ── helpers ─────────────────────────────────────────────────────────────

func runHidden(name string, args ...string) bool {
	cmd := exec.Command(name, args...)
	return cmd.Run() == nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

var listenPidRe = regexp.MustCompile(`(\d+)\s*$`)

func listeningBridgePids() []string {
	out, err := exec.Command("netstat", "-ano").Output()
	if err != nil {
		return nil
	}
	ports := []string{"3006", "3106", "3206", "3306"}
	seen := map[string]bool{}
	var pids []string
	self := itoa(os.Getpid())
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "LISTENING") {
			continue
		}
		hit := false
		for _, port := range ports {
			if strings.Contains(line, "127.0.0.1:"+port) || strings.Contains(line, "0.0.0.0:"+port) {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		m := listenPidRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pid := m[1]
		if pid == self || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	return pids
}

func regValueExists(key, value string) bool {
	return exec.Command("reg", "query", key, "/v", value).Run() == nil
}

var forcelistRe = regexp.MustCompile(`(?m)\s+(\S+)\s+REG_SZ\s+(.+?)\s*$`)

func forcelistSlotsForExtension() []string {
	out, err := exec.Command("reg", "query", forcelistKey).Output()
	if err != nil {
		return nil
	}
	var slots []string
	for _, m := range forcelistRe.FindAllStringSubmatch(string(out), -1) {
		if strings.HasPrefix(m[2], extensionID+";") {
			slots = append(slots, m[1])
		}
	}
	return slots
}

func writePointer(p *paths, exePath string) {
	if err := os.MkdirAll(p.appData, 0o755); err != nil {
		return
	}
	body, _ := json.MarshalIndent(map[string]string{
		"bootstrapPath": exePath,
		"sourcePath":    exePath,
		"updatedAt":     time.Now().UTC().Format(time.RFC3339),
	}, "", "  ")
	tmp := p.pointer + ".new"
	if os.WriteFile(tmp, body, 0o644) == nil {
		os.Rename(tmp, p.pointer)
	}
}

func copyExe(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
