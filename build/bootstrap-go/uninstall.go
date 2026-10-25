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
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const (
	autostartKey       = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	autostartValueName = "Empir3Bridge"
	forcelistKey       = `HKCU\Software\Policies\Google\Chrome\ExtensionInstallForcelist`
	extensionID        = "gbigofjjgcpjkffhlfepjdglabhngeii"
)

// uninstallTestMode suppresses process termination, HKCU writes + the dialog so tests don't touch
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

	if !uninstallTestMode() {
		stopped, err := stopInstalledProcesses(p)
		if err != nil {
			fail("cannot safely stop this installation: %v", err)
		}
		steps += stopped
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
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run() == nil
}

//go:embed uninstall-processes.ps1
var uninstallProcessesScript string

func stopInstalledProcesses(p *paths) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", uninstallProcessesScript)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Env = append(os.Environ(), "EMPIR3_UNINSTALL_BRIDGE_ROOT="+p.bridgeHome,
		"EMPIR3_UNINSTALL_APP_ROOT="+p.appData, "EMPIR3_UNINSTALL_CALLER_PID="+itoa(os.Getpid()))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	var receipt struct {
		OK     bool  `json:"ok"`
		Killed []int `json:"killed"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &receipt); err != nil {
		return 0, err
	}
	if !receipt.OK {
		return 0, fmt.Errorf("missing process cleanup receipt")
	}
	return len(receipt.Killed), nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
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
