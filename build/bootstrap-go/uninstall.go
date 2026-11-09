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
	"errors"
	"fmt"
	"io/fs"
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
	steps, err := nativeUninstall(p)
	if err != nil {
		if !uninstallTestMode() {
			messageBox("Empir3 Bridge could not be fully uninstalled. Some installation files or settings may remain.\n\n"+
				"Close the Bridge and its browser windows, then run uninstall again.\n\n"+err.Error(),
				"Empir3 Bridge — Uninstall incomplete", mbOK|mbIconError|mbSetForeground|mbTopmost)
		}
		fail("uninstall incomplete (%d steps completed): %v", steps, err)
		return
	}
	logln("uninstall complete (%d steps)", steps)
	if !uninstallTestMode() {
		showUninstallDoneDialog(steps)
	}
}

func nativeUninstall(p *paths) (int, error) {
	steps := 0
	var problems []error
	bump := func() { steps++ }

	if !uninstallTestMode() {
		stopped, err := stopInstalledProcesses(p)
		if err != nil {
			return steps, fmt.Errorf("cannot safely stop this installation: %w", err)
		}
		steps += stopped
	}

	if !uninstallTestMode() || os.Getenv("EMPIR3_UNINSTALL_TEST_REG") == "1" {
		// 3. Autostart.
		if regValueExists(autostartKey, autostartValueName) {
			if runHidden("reg", "delete", autostartKey, "/v", autostartValueName, "/f") {
				logln("  removed Windows autostart")
				bump()
			} else {
				problems = append(problems, fmt.Errorf("could not remove Windows autostart"))
			}
		}
		// 4. Chrome force-install policy slots that hold OUR extension.
		for _, slot := range forcelistSlotsForExtension() {
			if runHidden("reg", "delete", forcelistKey, "/v", slot, "/f") {
				logln("  removed Chrome force-install policy (slot %s)", slot)
				bump()
			} else {
				problems = append(problems, fmt.Errorf("could not remove Chrome extension policy slot %s", slot))
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
		if err := os.Remove(lnk); err == nil {
			logln("  removed Start Menu shortcut")
			bump()
		} else {
			problems = append(problems, fmt.Errorf("could not remove Start Menu shortcut: %w", err))
		}
		folder := filepath.Dir(lnk)
		if entries, err := os.ReadDir(folder); err == nil && len(entries) == 0 {
			os.Remove(folder)
		}
	}

	// 6. The whole ~/.empir3-bridge (payloads, node cache, runtime files).
	if _, err := os.Stat(p.bridgeHome); !os.IsNotExist(err) {
		if err := removeUninstallState(p.bridgeHome, ""); err != nil {
			problems = append(problems, fmt.Errorf("could not fully clear %s: %w", p.bridgeHome, err))
		} else {
			logln("  cleared ~/.empir3-bridge (payloads + node + runtime)")
			bump()
		}
	}

	// 7. %APPDATA%/Empir3 (auth, settings, logs). The running Empir3Setup.exe
	// may live here and can't delete itself — children still go; that's
	// expected and documented.
	if _, err := os.Stat(p.appData); !os.IsNotExist(err) {
		self, _ := os.Executable()
		if err := removeUninstallState(p.appData, self); err != nil {
			problems = append(problems, fmt.Errorf("could not fully clear application state: %w", err))
		} else {
			logln("  cleared %%APPDATA%%/Empir3 state (the running installer may remain)")
			bump()
		}
	}

	return steps, errors.Join(problems...)
}

// A running Windows installer cannot delete itself. That exception applies to
// this exact executable only, never to retained auth, settings, or browser data.
func removeUninstallState(root, runningExe string) error {
	// Chrome's process exit can precede Windows releasing its database handles.
	// Retry only deletion of this already selected installation tree. A persistent
	// lock or permission error remains a failure; never expand process ownership.
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := removeUninstallStateOnce(root, runningExe)
		if err == nil || !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func removeUninstallStateOnce(root, runningExe string) error {
	err := os.RemoveAll(root)
	if err == nil {
		return nil
	}
	if runningExe == "" || !strings.EqualFold(filepath.Dir(runningExe), filepath.Clean(root)) {
		return err
	}
	walkErr := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if name == root || (!entry.IsDir() && strings.EqualFold(name, runningExe)) {
			return nil
		}
		return fmt.Errorf("state remains at %s", name)
	})
	if walkErr != nil {
		return errors.Join(err, walkErr)
	}
	return nil
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
