// Empir3 CLI supervisor. This is a lifecycle boundary for a trusted provider
// executable, not a sandbox for arbitrary malicious local programs.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

type launchConfig struct {
	Version   int      `json:"version"`
	Nonce     string   `json:"nonce"`
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	Cwd       string   `json:"cwd"`
	TimeoutMS int64    `json:"timeoutMs"`
}
type stopReceipt struct {
	Version         int    `json:"version"`
	Nonce           string `json:"nonce"`
	Mechanism       string `json:"mechanism"`
	Started         bool   `json:"started"`
	PID             uint32 `json:"pid"`
	ExitCode        uint32 `json:"exitCode"`
	Cancelled       bool   `json:"cancelled"`
	TimedOut        bool   `json:"timedOut"`
	ActiveProcesses uint32 `json:"activeProcesses"`
}

var noncePattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func loadConfig(path string) (launchConfig, error) {
	var config launchConfig
	info, err := os.Lstat(path)
	if err != nil {
		return config, err
	}
	if !filepath.IsAbs(path) || !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return config, errors.New("invalid supervisor configuration file")
	}
	file, err := os.Open(path)
	if err != nil {
		return config, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1024*1024+1))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&config); err != nil {
		return config, errors.New("invalid supervisor configuration")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return config, errors.New("unexpected supervisor configuration data")
	}
	if config.Version != 1 || !noncePattern.MatchString(config.Nonce) || filepath.Base(path) != "cli-job-"+config.Nonce+".json" ||
		!filepath.IsAbs(config.Command) || !filepath.IsAbs(config.Cwd) || config.TimeoutMS < 1 || config.TimeoutMS > 3600000 {
		return config, errors.New("invalid supervisor configuration identity or bounds")
	}
	if _, err = os.Lstat(path + ".result"); !os.IsNotExist(err) {
		return config, errors.New("supervisor result already exists or cannot be checked")
	}
	return config, nil
}

// Cancellation is a permanent, original-nonce marker. It does not expire and
// cannot authorize a process launch. An unreadable/changed marker fails closed.
func cancelled(path, nonce string) (bool, error) {
	info, err := os.Lstat(path + ".cancel")
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	if !info.Mode().IsRegular() || info.Size() != int64(len(nonce)) {
		return true, errors.New("invalid cancellation marker")
	}
	data, err := os.ReadFile(path + ".cancel")
	if err != nil {
		return true, err
	}
	if string(data) != nonce {
		return true, errors.New("cancellation identity changed")
	}
	return true, nil
}

func saveReceipt(path string, receipt stopReceipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	temporary := path + ".result.tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(data, '\n'))
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	// No overwrite: a duplicate cannot replace the original execution evidence.
	return moveReceipt(temporary, path+".result")
}

func supervise(path string) (stopReceipt, error) {
	config, err := loadConfig(path)
	if err != nil {
		return stopReceipt{}, err
	}
	result := stopReceipt{Version: 1, Nonce: config.Nonce, Mechanism: "windows-job-v1"}
	// Remove prompt-bearing launch arguments before any executable can run.
	// Failure to remove this exact disposable file prevents launch.
	if err = os.Remove(path); err != nil {
		return result, err
	}
	stop, err := cancelled(path, config.Nonce)
	if err != nil {
		return result, err
	}
	if stop {
		result.Cancelled = true
		return result, saveReceipt(path, result)
	}
	job, err := newExecutionJob()
	if err != nil {
		return result, err
	}
	defer job.close()
	child, err := job.createSuspended(config)
	if err != nil {
		return result, err
	}
	defer child.close()
	result.PID = child.pid
	// The kernel has assigned this still-suspended process to the job. A
	// cancelled launch cannot race ahead of containment or its last start check.
	stop, err = cancelled(path, config.Nonce)
	if err != nil {
		return result, err
	}
	if stop {
		result.Cancelled = true
	} else {
		if err = child.resume(); err != nil {
			return result, err
		}
		result.Started = true
	}
	deadline := time.Now().Add(time.Duration(config.TimeoutMS) * time.Millisecond)
	for result.Started && !result.Cancelled && !result.TimedOut {
		done, code, waitErr := child.poll()
		if waitErr != nil {
			return result, waitErr
		}
		if done {
			result.ExitCode = code
			break
		}
		stop, err = cancelled(path, config.Nonce)
		if err != nil {
			return result, err
		}
		result.Cancelled = stop
		result.TimedOut = time.Now().After(deadline)
		if !result.Cancelled && !result.TimedOut {
			time.Sleep(20 * time.Millisecond)
		}
	}
	// Even a normal parent exit does not prove descendants stopped. Terminate
	// the owned job, then query its exact handle until the kernel reports zero.
	if err = job.terminate(); err != nil {
		return result, err
	}
	if err = job.waitEmpty(15 * time.Second); err != nil {
		return result, err
	}
	if result.Cancelled || result.TimedOut {
		_, result.ExitCode, err = child.poll()
		if err != nil {
			return result, err
		}
	}
	result.ActiveProcesses = 0
	return result, saveReceipt(path, result)
}

// This recovery path cannot create a process. Removing the original, still
// unconsumed configuration is the same exclusive claim required by supervise
// before process creation. If another helper has consumed it, absence is unknown
// and only that original helper's job receipt can prove termination.
func recoverCancelled(path string) (stopReceipt, error) {
	config, err := loadConfig(path)
	if err != nil {
		return stopReceipt{}, err
	}
	stop, err := cancelled(path, config.Nonce)
	if err != nil || !stop {
		return stopReceipt{}, errors.New("recovery requires original cancellation")
	}
	if err = os.Remove(path); err != nil {
		return stopReceipt{}, err
	}
	result := stopReceipt{Version: 1, Nonce: config.Nonce, Mechanism: "windows-job-v1", Cancelled: true}
	return result, saveReceipt(path, result)
}

func main() {
	var receipt stopReceipt
	var err error
	if len(os.Args) == 3 && os.Args[1] == "--recover-cancelled" {
		receipt, err = recoverCancelled(os.Args[2])
	} else if len(os.Args) == 2 {
		receipt, err = supervise(os.Args[1])
	} else {
		fmt.Fprintln(os.Stderr, "CLI supervisor requires one configuration file")
		os.Exit(125)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "CLI supervisor could not prove completion:", err)
		os.Exit(125)
	}
	if receipt.Cancelled || receipt.TimedOut {
		os.Exit(124)
	}
	os.Exit(int(receipt.ExitCode))
}
