package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var kernel = syscall.NewLazyDLL("kernel32.dll")
var createJob = kernel.NewProc("CreateJobObjectW")
var setJob = kernel.NewProc("SetInformationJobObject")
var queryJob = kernel.NewProc("QueryInformationJobObject")
var terminateJob = kernel.NewProc("TerminateJobObject")
var initializeAttributes = kernel.NewProc("InitializeProcThreadAttributeList")
var updateAttribute = kernel.NewProc("UpdateProcThreadAttribute")
var deleteAttributes = kernel.NewProc("DeleteProcThreadAttributeList")
var createProcess = kernel.NewProc("CreateProcessW")
var resumeThread = kernel.NewProc("ResumeThread")
var moveFile = kernel.NewProc("MoveFileExW")

type basicLimits struct {
	ProcessTime, JobTime         int64
	Flags                        uint32
	MinWorkingSet, MaxWorkingSet uintptr
	ActiveProcessLimit           uint32
	Affinity                     uintptr
	Priority, Scheduling         uint32
}
type ioCounts struct{ ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes uint64 }
type extendedLimits struct {
	Basic                                                      basicLimits
	IO                                                         ioCounts
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}
type accounting struct {
	UserTime, KernelTime, PeriodUserTime, PeriodKernelTime       int64
	Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses uint32
}
type startupEx struct {
	Info       syscall.StartupInfo
	Attributes *byte
}
type executionJob struct{ handle syscall.Handle }
type executionChild struct {
	process, thread syscall.Handle
	pid             uint32
}

func newExecutionJob() (*executionJob, error) {
	handle, _, err := createJob.Call(0, 0)
	if handle == 0 {
		return nil, fmt.Errorf("create job: %w", err)
	}
	job := &executionJob{syscall.Handle(handle)}
	limits := extendedLimits{}
	limits.Basic.Flags = 0x2000 // KILL_ON_JOB_CLOSE; never permit breakaway.
	ok, _, err := setJob.Call(handle, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		job.close()
		return nil, fmt.Errorf("set job containment: %w", err)
	}
	return job, nil
}
func (j *executionJob) close() {
	if j.handle != 0 {
		syscall.CloseHandle(j.handle)
		j.handle = 0
	}
}
func (c *executionChild) close() { syscall.CloseHandle(c.thread); syscall.CloseHandle(c.process) }
func (c *executionChild) resume() error {
	result, _, err := resumeThread.Call(uintptr(c.thread))
	if result == 0xffffffff {
		return fmt.Errorf("resume contained process: %w", err)
	}
	return nil
}
func (c *executionChild) poll() (bool, uint32, error) {
	status, err := syscall.WaitForSingleObject(c.process, 0)
	if err != nil {
		return false, 0, err
	}
	if status == syscall.WAIT_TIMEOUT {
		return false, 0, nil
	}
	if status != syscall.WAIT_OBJECT_0 {
		return false, 0, errors.New("unknown child wait result")
	}
	var code uint32
	if err = syscall.GetExitCodeProcess(c.process, &code); err != nil {
		return false, 0, err
	}
	return true, code, nil
}
func (j *executionJob) terminate() error {
	ok, _, err := terminateJob.Call(uintptr(j.handle), 124)
	if ok == 0 {
		return fmt.Errorf("terminate owned job: %w", err)
	}
	return nil
}
func (j *executionJob) active() (uint32, error) {
	var info accounting
	ok, _, err := queryJob.Call(uintptr(j.handle), 1, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), 0)
	if ok == 0 {
		return 0, fmt.Errorf("query owned job: %w", err)
	}
	return info.ActiveProcesses, nil
}
func (j *executionJob) waitEmpty(limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for {
		count, err := j.active()
		if err != nil {
			return err
		}
		if count == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("owned job termination remains uncertain")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (j *executionJob) createSuspended(config launchConfig) (*executionChild, error) {
	command, err := syscall.UTF16PtrFromString(config.Command)
	if err != nil {
		return nil, err
	}
	parts := []string{syscall.EscapeArg(config.Command)}
	for _, arg := range config.Args {
		if strings.ContainsRune(arg, 0) {
			return nil, errors.New("invalid child argument")
		}
		parts = append(parts, syscall.EscapeArg(arg))
	}
	line, err := syscall.UTF16FromString(strings.Join(parts, " "))
	if err != nil || len(line) > 32767 {
		return nil, errors.New("child command line exceeds Windows bounds")
	}
	cwd, err := syscall.UTF16PtrFromString(config.Cwd)
	if err != nil {
		return nil, err
	}
	var size uintptr
	initializeAttributes.Call(0, 2, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 || size > 1024*1024 {
		return nil, errors.New("invalid process attribute size")
	}
	buffer := make([]byte, size)
	ok, _, err := initializeAttributes.Call(uintptr(unsafe.Pointer(&buffer[0])), 2, 0, uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return nil, fmt.Errorf("initialize process attributes: %w", err)
	}
	defer deleteAttributes.Call(uintptr(unsafe.Pointer(&buffer[0])))
	// Creation-time job assignment eliminates the create/assign crash gap.
	// https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812
	jobHandle := j.handle
	ok, _, err = updateAttribute.Call(uintptr(unsafe.Pointer(&buffer[0])), 0, 0x2000d, uintptr(unsafe.Pointer(&jobHandle)), unsafe.Sizeof(jobHandle), 0, 0)
	if ok == 0 {
		return nil, fmt.Errorf("bind process job: %w", err)
	}
	handles := []syscall.Handle{}
	for _, file := range []*os.File{os.Stdin, os.Stdout, os.Stderr} {
		h := syscall.Handle(file.Fd())
		if h == 0 || h == syscall.InvalidHandle {
			return nil, errors.New("invalid supervisor stream")
		}
		duplicate := false
		for _, seen := range handles {
			if seen == h {
				duplicate = true
			}
		}
		if !duplicate {
			handles = append(handles, h)
		}
	}
	for _, h := range handles {
		if err = syscall.SetHandleInformation(h, syscall.HANDLE_FLAG_INHERIT, syscall.HANDLE_FLAG_INHERIT); err != nil {
			return nil, err
		}
	}
	ok, _, err = updateAttribute.Call(uintptr(unsafe.Pointer(&buffer[0])), 0, 0x20002, uintptr(unsafe.Pointer(&handles[0])), uintptr(len(handles))*unsafe.Sizeof(handles[0]), 0, 0)
	if ok == 0 {
		return nil, fmt.Errorf("bind process streams: %w", err)
	}
	info := startupEx{Attributes: &buffer[0]}
	info.Info.Cb = uint32(unsafe.Sizeof(info))
	info.Info.Flags = syscall.STARTF_USESTDHANDLES
	info.Info.StdInput = syscall.Handle(os.Stdin.Fd())
	info.Info.StdOutput = syscall.Handle(os.Stdout.Fd())
	info.Info.StdErr = syscall.Handle(os.Stderr.Fd())
	var child syscall.ProcessInformation
	// No shell, no breakaway, no new console; preserve ordinary pipes or ConPTY.
	ok, _, err = createProcess.Call(uintptr(unsafe.Pointer(command)), uintptr(unsafe.Pointer(&line[0])), 0, 0, 1,
		0x00080004, 0, uintptr(unsafe.Pointer(cwd)), uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&child)))
	runtime.KeepAlive(buffer)
	runtime.KeepAlive(handles)
	runtime.KeepAlive(jobHandle)
	runtime.KeepAlive(line)
	if ok == 0 {
		return nil, fmt.Errorf("create contained process: %w", err)
	}
	return &executionChild{process: child.Process, thread: child.Thread, pid: child.ProcessId}, nil
}

func moveReceipt(source, target string) error {
	src, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	dst, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	ok, _, err := moveFile.Call(uintptr(unsafe.Pointer(src)), uintptr(unsafe.Pointer(dst)), 8) // WRITE_THROUGH, no replace.
	if ok == 0 {
		return fmt.Errorf("commit stop receipt: %w", err)
	}
	return nil
}
