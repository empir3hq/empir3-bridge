package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Hold a real Windows file handle that denies deletion. These tests do not
// enumerate processes, edit the real user's registry, or touch an installation.
func holdUninstallFixture(t *testing.T, name string) func() {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("synthetic state"), 0o600); err != nil {
		t.Fatal(err)
	}
	wide, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(wide, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	close := func() {
		once.Do(func() {
			syscall.CloseHandle(handle)
		})
	}
	t.Cleanup(close)
	return close
}

func TestUninstallWaitsForReleasedHandle(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".empir3-bridge")
	unlock := holdUninstallFixture(t, filepath.Join(root, "profile", "Account Web Data"))
	done := make(chan struct{})
	go func() {
		time.Sleep(150 * time.Millisecond)
		unlock()
		close(done)
	}()
	err := removeUninstallState(root, "")
	<-done
	if err != nil {
		t.Fatalf("an exiting browser's released handle should permit removal: %v", err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("state directory retained after handle release: %v", err)
	}
}

func TestNativeUninstallRejectsRetainedState(t *testing.T) {
	for _, area := range []string{"browser", "application"} {
		t.Run(area, func(t *testing.T) {
			root := t.TempDir()
			p := &paths{home: root, bridgeHome: filepath.Join(root, ".empir3-bridge"), appData: filepath.Join(root, "Empir3")}
			t.Setenv("EMPIR3_UNINSTALL_TEST", "1")
			t.Setenv("EMPIR3_UNINSTALL_TEST_REG", "")
			t.Setenv("APPDATA", root)
			name := filepath.Join(p.bridgeHome, "profile", "Default", "Account Web Data")
			if area == "application" {
				name = filepath.Join(p.appData, "auth.json")
			}
			unlock := holdUninstallFixture(t, name)
			if _, err := nativeUninstall(p); err == nil || !strings.Contains(err.Error(), filepath.Base(name)) {
				t.Fatalf("locked user state must report incomplete removal: %v", err)
			}
			if _, err := os.Stat(name); err != nil {
				t.Fatalf("expected real retained file: %v", err)
			}
			unlock()
			if _, err := nativeUninstall(p); err != nil {
				t.Fatalf("unlocked state should be removable: %v", err)
			}
			for _, dir := range []string{p.bridgeHome, p.appData} {
				if _, err := os.Stat(dir); !os.IsNotExist(err) {
					t.Fatalf("state directory retained: %s (%v)", dir, err)
				}
			}
		})
	}
}

func TestUninstallAllowsOnlyExactRunningExecutable(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Empir3")
	self := filepath.Join(root, "Empir3Setup.exe")
	holdUninstallFixture(t, self)
	state := filepath.Join(root, "auth.json")
	unlockState := holdUninstallFixture(t, state)
	if err := removeUninstallState(root, self); err == nil {
		t.Fatal("a running installer must not excuse retained auth state")
	}
	unlockState()
	if err := removeUninstallState(root, filepath.Join(root, "other.exe")); err == nil {
		t.Fatal("only the exact running executable may remain")
	}
	if err := removeUninstallState(root, self); err != nil {
		t.Fatalf("only the expected locked installer remains: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 || entries[0].Name() != "Empir3Setup.exe" {
		t.Fatalf("unexpected surviving state: %v %v", entries, err)
	}
}

func TestNativeUninstallRemovesEmptyStateDirectories(t *testing.T) {
	root := t.TempDir()
	p := &paths{home: root, bridgeHome: filepath.Join(root, ".empir3-bridge"), appData: filepath.Join(root, "Empir3")}
	t.Setenv("EMPIR3_UNINSTALL_TEST", "1")
	t.Setenv("EMPIR3_UNINSTALL_TEST_REG", "")
	t.Setenv("APPDATA", root)
	for _, dir := range []string{p.bridgeHome, p.appData} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := nativeUninstall(p); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{p.bridgeHome, p.appData} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("empty state directory retained: %s (%v)", dir, err)
		}
	}
}
