package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// These are real disposable processes launched by the native tests only.
func TestFixtureProcess(t *testing.T) {
	split := -1
	for i, arg := range os.Args {
		if arg == "--" {
			split = i
			break
		}
	}
	if split < 0 {
		return
	}
	args := os.Args[split+1:]
	switch args[0] {
	case "supervisor":
		receipt, err := supervise(args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(125)
		}
		if receipt.Cancelled || receipt.TimedOut {
			os.Exit(124)
		}
		os.Exit(int(receipt.ExitCode))
	case "leaf":
		for {
			time.Sleep(time.Second)
		}
	case "echo":
		io.Copy(os.Stdout, os.Stdin)
		os.Exit(0)
	case "worker":
		exe, _ := os.Executable()
		child := exec.Command(exe, "-test.run=^TestFixtureProcess$", "--", "leaf")
		child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := child.Start(); err != nil {
			os.Exit(120)
		}
		if err := os.WriteFile(filepath.Join(args[1], "pids"), []byte(fmt.Sprintf("%d %d", os.Getpid(), child.Process.Pid)), 0600); err != nil {
			os.Exit(121)
		}
		for {
			if _, err := os.Stat(filepath.Join(args[1], "finish-root")); err == nil {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
	default:
		os.Exit(122)
	}
}
func configFor(t *testing.T, role string, timeout int64) (string, launchConfig) {
	t.Helper()
	dir := t.TempDir()
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	config := launchConfig{Version: 1, Nonce: hex.EncodeToString(nonce), Command: exe, Cwd: dir,
		Args: []string{"-test.run=^TestFixtureProcess$", "--", role, dir}, TimeoutMS: timeout}
	path := filepath.Join(dir, "cli-job-"+config.Nonce+".json")
	writeConfig(t, path, config)
	return path, config
}
func writeConfig(t *testing.T, path string, config launchConfig) {
	t.Helper()
	data, _ := json.Marshal(config)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}
func startSupervisor(t *testing.T, path string, input string) (*exec.Cmd, *bytes.Buffer) {
	t.Helper()
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "-test.run=^TestFixtureProcess$", "--", "supervisor", path)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Stdin = strings.NewReader(input)
	output := &bytes.Buffer{}
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	})
	return cmd, output
}
func waitSupervisor(t *testing.T, cmd *exec.Cmd, output *bytes.Buffer, code int) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
		if cmd.ProcessState.ExitCode() != code {
			t.Fatalf("supervisor exit %d want %d: %s", cmd.ProcessState.ExitCode(), code, output.String())
		}
	case <-time.After(20 * time.Second):
		cmd.Process.Kill()
		<-done
		t.Fatalf("supervisor did not settle: %s", output.String())
	}
}
func ownedHandles(t *testing.T, dir string) []syscall.Handle {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	var data []byte
	for time.Now().Before(deadline) {
		data, _ = os.ReadFile(filepath.Join(dir, "pids"))
		if len(strings.Fields(string(data))) == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	fields := strings.Fields(string(data))
	if len(fields) != 2 {
		t.Fatal("worker did not report its exact owned identities")
	}
	handles := []syscall.Handle{}
	for _, field := range fields {
		pid, err := strconv.ParseUint(field, 10, 32)
		if err != nil {
			t.Fatal(err)
		}
		handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE|0x1000|syscall.PROCESS_TERMINATE, false, uint32(pid))
		if err != nil {
			t.Fatal(err)
		}
		handles = append(handles, handle)
		t.Cleanup(func() {
			status, _ := syscall.WaitForSingleObject(handle, 0)
			if status == syscall.WAIT_TIMEOUT {
				syscall.TerminateProcess(handle, 123)
			}
			syscall.CloseHandle(handle)
		})
	}
	return handles
}
func assertStopped(t *testing.T, handles []syscall.Handle) {
	t.Helper()
	for _, handle := range handles {
		status, err := syscall.WaitForSingleObject(handle, 7000)
		if err != nil || status != syscall.WAIT_OBJECT_0 {
			t.Fatalf("owned process not stopped: %d %v", status, err)
		}
	}
}
func readReceipt(t *testing.T, path string, nonce string) stopReceipt {
	t.Helper()
	data, err := os.ReadFile(path + ".result")
	if err != nil {
		t.Fatal(err)
	}
	var result stopReceipt
	if err = json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result.Version != 1 || result.Nonce != nonce || result.Mechanism != "windows-job-v1" || result.ActiveProcesses != 0 {
		t.Fatalf("wrong stop identity: %+v", result)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("prompt-bearing launch configuration was retained")
	}
	return result
}
func TestNormalExitTerminatesDetachedDescendantAndPreservesUnrelatedProcess(t *testing.T) {
	path, config := configFor(t, "worker", 15000)
	cmd, output := startSupervisor(t, path, "")
	handles := ownedHandles(t, config.Cwd)
	exe, _ := os.Executable()
	unrelated := exec.Command(exe, "-test.run=^TestFixtureProcess$", "--", "leaf")
	unrelated.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := unrelated.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { unrelated.Process.Kill(); unrelated.Wait() }()
	peer, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(unrelated.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(peer)
	if err = os.WriteFile(filepath.Join(config.Cwd, "finish-root"), []byte("exit"), 0600); err != nil {
		t.Fatal(err)
	}
	waitSupervisor(t, cmd, output, 0)
	assertStopped(t, handles)
	receipt := readReceipt(t, path, config.Nonce)
	if !receipt.Started || receipt.Cancelled || receipt.TimedOut {
		t.Fatalf("unexpected terminal outcome: %+v", receipt)
	}
	if status, _ := syscall.WaitForSingleObject(peer, 0); status != syscall.WAIT_TIMEOUT {
		t.Fatal("unrelated process was stopped")
	}
	original, _ := os.ReadFile(path + ".result")
	writeConfig(t, path, config)
	if _, err = supervise(path); err == nil {
		t.Fatal("duplicate receipt allowed another execution")
	}
	after, _ := os.ReadFile(path + ".result")
	if !bytes.Equal(after, original) {
		t.Fatal("original receipt changed")
	}
}
func TestCancellationWaitsForEveryOwnedProcess(t *testing.T) {
	path, config := configFor(t, "worker", 15000)
	cmd, output := startSupervisor(t, path, "")
	handles := ownedHandles(t, config.Cwd)
	if _, err := os.Stat(path + ".result"); !os.IsNotExist(err) {
		t.Fatal("receipt escaped while processes were running")
	}
	if err := os.WriteFile(path+".cancel", []byte(config.Nonce), 0600); err != nil {
		t.Fatal(err)
	}
	waitSupervisor(t, cmd, output, 124)
	assertStopped(t, handles)
	receipt := readReceipt(t, path, config.Nonce)
	if !receipt.Cancelled || !receipt.Started || receipt.TimedOut {
		t.Fatalf("wrong cancellation: %+v", receipt)
	}
}
func TestTimeoutStopsTheOwnedJobBeforeReceipt(t *testing.T) {
	path, config := configFor(t, "worker", 1500)
	cmd, output := startSupervisor(t, path, "")
	handles := ownedHandles(t, config.Cwd)
	waitSupervisor(t, cmd, output, 124)
	assertStopped(t, handles)
	receipt := readReceipt(t, path, config.Nonce)
	if !receipt.TimedOut || receipt.Cancelled {
		t.Fatalf("wrong timeout: %+v", receipt)
	}
}
func TestSupervisorCrashKillsItsJobButDoesNotFabricateProof(t *testing.T) {
	path, config := configFor(t, "worker", 15000)
	cmd, _ := startSupervisor(t, path, "")
	handles := ownedHandles(t, config.Cwd)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	assertStopped(t, handles)
	if _, err := os.Stat(path + ".result"); !os.IsNotExist(err) {
		t.Fatal("crash produced an unproven receipt")
	}
}
func TestPreexistingCancellationCannotStartLater(t *testing.T) {
	path, config := configFor(t, "worker", 15000)
	if err := os.WriteFile(path+".cancel", []byte(config.Nonce), 0600); err != nil {
		t.Fatal(err)
	}
	cmd, output := startSupervisor(t, path, "")
	waitSupervisor(t, cmd, output, 124)
	receipt := readReceipt(t, path, config.Nonce)
	if receipt.Started || !receipt.Cancelled || receipt.PID != 0 {
		t.Fatalf("cancelled preparation started: %+v", receipt)
	}
	if _, err := os.Stat(filepath.Join(config.Cwd, "pids")); !os.IsNotExist(err) {
		t.Fatal("cancelled worker ran")
	}
}
func TestPrivateStreamsPreserveProviderInputAndUnicode(t *testing.T) {
	path, config := configFor(t, "echo", 10000)
	input := "private stdin: 東京 café 🔐\nsecond line\n"
	cmd, output := startSupervisor(t, path, input)
	waitSupervisor(t, cmd, output, 0)
	if output.String() != input {
		t.Fatalf("provider stream changed: %q", output.String())
	}
	readReceipt(t, path, config.Nonce)
}
func TestWrongCancellationIdentityFailsClosed(t *testing.T) {
	path, config := configFor(t, "worker", 15000)
	os.WriteFile(path+".cancel", []byte(strings.Repeat("0", 64)), 0600)
	cmd, output := startSupervisor(t, path, "")
	waitSupervisor(t, cmd, output, 125)
	if _, err := os.Stat(path + ".result"); !os.IsNotExist(err) {
		t.Fatal("invalid cancellation produced proof")
	}
	if _, err := os.Stat(filepath.Join(config.Cwd, "pids")); !os.IsNotExist(err) {
		t.Fatal("invalid cancellation started work")
	}
}

func TestCancelOnlyRecoveryRequiresOriginalMarkerAndConsumesWithoutExecution(t *testing.T) {
	path, config := configFor(t, "worker", 15000)
	if _, err := recoverCancelled(path); err == nil {
		t.Fatal("recovery accepted absent cancellation")
	}
	os.WriteFile(path+".cancel", []byte(strings.Repeat("0", 64)), 0600)
	if _, err := recoverCancelled(path); err == nil {
		t.Fatal("recovery accepted changed cancellation")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("invalid recovery consumed original configuration")
	}
	if err := os.WriteFile(path+".cancel", []byte(config.Nonce), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := recoverCancelled(path); err != nil {
		t.Fatal(err)
	}
	result := readReceipt(t, path, config.Nonce)
	if result.Started || result.PID != 0 || !result.Cancelled {
		t.Fatalf("recovery claimed a process launch: %+v", result)
	}
	if _, err := supervise(path); err == nil {
		t.Fatal("late original helper could run")
	}
	if _, err := os.Stat(filepath.Join(config.Cwd, "pids")); !os.IsNotExist(err) {
		t.Fatal("cancellation-only recovery launched a provider")
	}
}

func TestCancelOnlyRecoveryCannotProveAnAlreadyRunningJobStopped(t *testing.T) {
	path, config := configFor(t, "worker", 15000)
	cmd, output := startSupervisor(t, path, "")
	handles := ownedHandles(t, config.Cwd)
	if _, err := recoverCancelled(path); err == nil {
		t.Fatal("missing consumed configuration was treated as no execution")
	}
	if _, err := os.Stat(path + ".result"); !os.IsNotExist(err) {
		t.Fatal("recovery produced proof for a running job")
	}
	if err := os.WriteFile(path+".cancel", []byte(config.Nonce), 0600); err != nil {
		t.Fatal(err)
	}
	waitSupervisor(t, cmd, output, 124)
	assertStopped(t, handles)
	if !readReceipt(t, path, config.Nonce).Started {
		t.Fatal("original running job evidence was lost")
	}
}

func TestOriginalAndRecoveryHelperRaceHasOnlyOneConsumer(t *testing.T) {
	for i := 0; i < 12; i++ {
		path, config := configFor(t, "worker", 15000)
		if err := os.WriteFile(path+".cancel", []byte(config.Nonce), 0600); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		go func() { <-start; _, err := supervise(path); results <- err }()
		go func() { <-start; _, err := recoverCancelled(path); results <- err }()
		close(start)
		first, second := <-results, <-results
		if (first == nil) == (second == nil) {
			t.Fatalf("expected one exclusive consumer, got %v / %v", first, second)
		}
		result := readReceipt(t, path, config.Nonce)
		if result.Started || !result.Cancelled {
			t.Fatalf("cancelled race launched a provider: %+v", result)
		}
		if _, err := os.Stat(filepath.Join(config.Cwd, "pids")); !os.IsNotExist(err) {
			t.Fatal("cancelled race executed worker")
		}
	}
}
