package main

// Windows primitives via kernel32/user32 (no external deps):
//   - Job Object (kill-on-close) so the spawned node.exe dies with us / the tray
//   - LockFileEx install lock so concurrent launches don't race the cache
//   - MessageBoxW for the native uninstall confirmation/completion dialogs

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")

	procCreateJobObject          = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procOpenProcess              = kernel32.NewProc("OpenProcess")
	procCloseHandle              = kernel32.NewProc("CloseHandle")
	procCreateFileW              = kernel32.NewProc("CreateFileW")
	procLockFileEx               = kernel32.NewProc("LockFileEx")
	procMessageBoxW              = user32.NewProc("MessageBoxW")
)

const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x00002000

	processTerminate = 0x0001
	processSetQuota  = 0x0100

	genericRead           = 0x80000000
	genericWrite          = 0x40000000
	fileShareRead         = 0x00000001
	fileShareWrite        = 0x00000002
	openAlways            = 4
	fileAttrNormal        = 0x80
	lockfileExclusive     = 0x00000002
	detachedProcess       = 0x00000008
	createNewProcessGroup = 0x00000200

	// MessageBox flags
	mbOK            = 0x0
	mbYesNo         = 0x4
	mbIconError     = 0x10
	mbIconWarning   = 0x30
	mbIconInfo      = 0x40
	mbDefButton2    = 0x100
	mbSetForeground = 0x10000
	mbTopmost       = 0x40000
	idYes           = 6
)

type ioCounters struct {
	ReadOperationCount, WriteOperationCount, OtherOperationCount uint64
	ReadTransferCount, WriteTransferCount, OtherTransferCount    uint64
}

type jobBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobExtendedLimitInformation struct {
	BasicLimitInformation jobBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

// newKillOnCloseJob creates a Job Object that terminates all assigned
// processes when the handle closes (i.e. when this stub exits or is killed).
// Returns 0 on failure (caller proceeds without the safety net).
func newKillOnCloseJob() syscall.Handle {
	h, _, _ := procCreateJobObject.Call(0, 0)
	if h == 0 {
		return 0
	}
	var info jobExtendedLimitInformation
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ret, _, _ := procSetInformationJobObject.Call(
		h, jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info),
	)
	if ret == 0 {
		procCloseHandle.Call(h)
		return 0
	}
	return syscall.Handle(h)
}

// assignToJob adds a PID to the job so it dies with us.
func assignToJob(job syscall.Handle, pid int) bool {
	if job == 0 || pid <= 0 {
		return false
	}
	ph, _, _ := procOpenProcess.Call(uintptr(processSetQuota|processTerminate), 0, uintptr(pid))
	if ph == 0 {
		return false
	}
	defer procCloseHandle.Call(ph)
	ret, _, _ := procAssignProcessToJobObject.Call(uintptr(job), ph)
	return ret != 0
}

// acquireInstallLock takes an exclusive LockFileEx on lockPath. Returns a
// release func. Blocks until the lock is available (other launches wait).
func acquireInstallLock(lockPath string) (func(), error) {
	p, err := syscall.UTF16PtrFromString(lockPath)
	if err != nil {
		return nil, err
	}
	h, _, callErr := procCreateFileW.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(genericRead|genericWrite),
		uintptr(fileShareRead|fileShareWrite),
		0, uintptr(openAlways), uintptr(fileAttrNormal), 0,
	)
	if h == 0 || h == uintptr(syscall.InvalidHandle) {
		return nil, callErr
	}
	var overlapped [unsafe.Sizeof(syscall.Overlapped{})]byte
	ret, _, lockErr := procLockFileEx.Call(
		h, uintptr(lockfileExclusive), 0,
		0xFFFFFFFF, 0xFFFFFFFF,
		uintptr(unsafe.Pointer(&overlapped[0])),
	)
	if ret == 0 {
		procCloseHandle.Call(h)
		return nil, lockErr
	}
	return func() { procCloseHandle.Call(h) }, nil // CloseHandle releases the lock
}

// messageBox shows a native modal dialog and returns the clicked-button code.
func messageBox(text, caption string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(caption)
	ret, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
	return int(ret)
}

// readExeBootstrapVersion runs `<exe> --bootstrap-version` and parses the
// trailing version token. Returns "" on any failure.
func readExeBootstrapVersion(exe string) string {
	if exe == "" {
		return ""
	}
	if _, err := os.Stat(exe); err != nil {
		return ""
	}
	out, err := exec.Command(exe, "--bootstrap-version").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) == 0 {
		return ""
	}
	return fields[len(fields)-1] // "empir3-bootstrap 2.0.0" → "2.0.0"
}
