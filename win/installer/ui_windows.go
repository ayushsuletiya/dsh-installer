//go:build windows

package main

import (
	"sync"
	"syscall"
	"unsafe"
)

// A small native window: title, one line of status, a progress bar, one line of
// detail. Deliberately built on nothing but syscall — no cgo, no module
// dependencies — so `GOOS=windows go build` produces the shipping binary from any
// machine, including the Mac this was written on.
//
// Threading rule that makes it safe: the window is created and pumped on the
// thread locked in init(), and the worker goroutine never touches a handle. It
// stores text under a mutex and posts a message; the window procedure, running on
// the UI thread, is the only code that calls into user32 for updates.

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")

	pRegisterClassExW      = user32.NewProc("RegisterClassExW")
	pCreateWindowExW       = user32.NewProc("CreateWindowExW")
	pDefWindowProcW        = user32.NewProc("DefWindowProcW")
	pShowWindow            = user32.NewProc("ShowWindow")
	pUpdateWindow          = user32.NewProc("UpdateWindow")
	pGetMessageW           = user32.NewProc("GetMessageW")
	pTranslateMessage      = user32.NewProc("TranslateMessage")
	pDispatchMessageW      = user32.NewProc("DispatchMessageW")
	pPostQuitMessage       = user32.NewProc("PostQuitMessage")
	pPostMessageW          = user32.NewProc("PostMessageW")
	pSendMessageW          = user32.NewProc("SendMessageW")
	pSetWindowTextW        = user32.NewProc("SetWindowTextW")
	pDestroyWindow         = user32.NewProc("DestroyWindow")
	pMessageBoxW           = user32.NewProc("MessageBoxW")
	pGetSystemMetrics      = user32.NewProc("GetSystemMetrics")
	pSetProcessDPIAware    = user32.NewProc("SetProcessDPIAware")
	pGetModuleHandleW      = kernel32.NewProc("GetModuleHandleW")
	pInitCommonControlsEx  = comctl32.NewProc("InitCommonControlsEx")
	pGetStockObject        = gdi32.NewProc("GetStockObject")
)

const (
	wsOverlapped   = 0x00000000
	wsCaption      = 0x00C00000
	wsSysMenu      = 0x00080000
	wsVisible      = 0x10000000
	wsChild        = 0x40000000
	wsMinimizeBox  = 0x00020000
	swShow         = 5
	wmDestroy      = 0x0002
	wmClose        = 0x0010
	wmSetFont      = 0x0030
	wmApp          = 0x8000
	msgRefresh     = wmApp + 1
	msgQuit        = wmApp + 2
	pbmSetRange32  = 0x0406
	pbmSetPos      = 0x0402
	defaultGUIFont = 17
	smCxScreen     = 0
	smCyScreen     = 1
	mbIconError    = 0x00000010
	mbIconInfo     = 0x00000040
	iccProgress    = 0x00000020
)

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     syscall.Handle
	hIcon         syscall.Handle
	hCursor       syscall.Handle
	hbrBackground syscall.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       syscall.Handle
}

type msgW struct {
	hwnd    syscall.Handle
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
}

type initCommonControlsExS struct {
	dwSize uint32
	dwICC  uint32
}

func u16(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		p, _ = syscall.UTF16PtrFromString("")
	}
	return p
}

type winUI struct {
	mu      sync.Mutex
	title   string
	status  string
	detail  string
	pct     int
	failed  bool
	hwnd    syscall.Handle
	hStatus syscall.Handle
	hBar    syscall.Handle
	hDetail syscall.Handle
	fell    *consoleUI // set when a window could not be created
}

func newUI(silent bool, title string) progressUI {
	if silent {
		return &consoleUI{}
	}
	u := &winUI{title: title, status: "Starting…"}
	if err := u.create(); err != nil {
		// Never fail the install because a window would not open: fall back to text.
		return &consoleUI{}
	}
	return u
}

func (u *winUI) create() error {
	// Crisp on a high-DPI laptop. Absent on very old Windows, and not worth failing.
	pSetProcessDPIAware.Call()
	icc := initCommonControlsExS{dwSize: uint32(unsafe.Sizeof(initCommonControlsExS{})), dwICC: iccProgress}
	pInitCommonControlsEx.Call(uintptr(unsafe.Pointer(&icc)))

	hInst, _, _ := pGetModuleHandleW.Call(0)
	className := u16("DshInstallerWindow")
	wc := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   syscall.NewCallback(u.wndProc),
		hInstance:     syscall.Handle(hInst),
		lpszClassName: className,
		// COLOR_BTNFACE + 1: the standard dialog grey, so it looks like Windows.
		hbrBackground: syscall.Handle(16),
	}
	if ret, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); ret == 0 {
		return err
	}

	const w, h = 470, 200
	sw, _, _ := pGetSystemMetrics.Call(smCxScreen)
	sh, _, _ := pGetSystemMetrics.Call(smCyScreen)
	x := (int(sw) - w) / 2
	y := (int(sh) - h) / 3

	hwnd, _, err := pCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(u16(u.title))),
		wsOverlapped|wsCaption|wsSysMenu|wsMinimizeBox,
		uintptr(x), uintptr(y), w, h,
		0, 0, hInst, 0,
	)
	if hwnd == 0 {
		return err
	}
	u.hwnd = syscall.Handle(hwnd)

	font, _, _ := pGetStockObject.Call(defaultGUIFont)
	mkStatic := func(text string, top, height int) syscall.Handle {
		c, _, _ := pCreateWindowExW.Call(
			0,
			uintptr(unsafe.Pointer(u16("STATIC"))),
			uintptr(unsafe.Pointer(u16(text))),
			wsChild|wsVisible,
			24, uintptr(top), w-70, uintptr(height),
			hwnd, 0, hInst, 0,
		)
		pSendMessageW.Call(c, wmSetFont, font, 1)
		return syscall.Handle(c)
	}

	u.hStatus = mkStatic(u.status, 26, 22)
	bar, _, _ := pCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(u16("msctls_progress32"))),
		uintptr(unsafe.Pointer(u16(""))),
		wsChild|wsVisible,
		24, 60, w-70, 22,
		hwnd, 0, hInst, 0,
	)
	u.hBar = syscall.Handle(bar)
	pSendMessageW.Call(bar, pbmSetRange32, 0, 100)
	u.hDetail = mkStatic("", 94, 40)

	pShowWindow.Call(hwnd, swShow)
	pUpdateWindow.Call(hwnd)
	return nil
}

func (u *winUI) wndProc(hwnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case msgRefresh:
		u.mu.Lock()
		status, detail, pct := u.status, u.detail, u.pct
		u.mu.Unlock()
		pSetWindowTextW.Call(uintptr(u.hStatus), uintptr(unsafe.Pointer(u16(status))))
		pSetWindowTextW.Call(uintptr(u.hDetail), uintptr(unsafe.Pointer(u16(detail))))
		pSendMessageW.Call(uintptr(u.hBar), pbmSetPos, uintptr(pct), 0)
		return 0
	case msgQuit:
		pDestroyWindow.Call(uintptr(hwnd))
		return 0
	case wmClose:
		// Closing the window must not abandon a half-finished install, so it only
		// hides; the process exits when the work does.
		pShowWindow.Call(uintptr(hwnd), 0)
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := pDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

func (u *winUI) refresh() {
	pPostMessageW.Call(uintptr(u.hwnd), msgRefresh, 0, 0)
}

func (u *winUI) Stage(text string, pct int) {
	u.mu.Lock()
	u.status, u.pct, u.detail = text, pct, ""
	u.mu.Unlock()
	u.refresh()
}

func (u *winUI) Progress(pct int, detail string) {
	u.mu.Lock()
	u.pct = pct
	if detail != "" {
		u.detail = detail
	}
	u.mu.Unlock()
	u.refresh()
}

func (u *winUI) Note(text string) {
	u.mu.Lock()
	u.detail = text
	u.mu.Unlock()
	u.refresh()
}

func (u *winUI) Fail(text string) {
	u.mu.Lock()
	u.failed = true
	u.status = "Something went wrong"
	u.mu.Unlock()
	u.refresh()
	// Owner 0 on purpose: this runs on the worker thread, and a modal dialog owned
	// by another thread's window is how you deadlock a UI.
	pMessageBoxW.Call(0,
		uintptr(unsafe.Pointer(u16(text))),
		uintptr(unsafe.Pointer(u16(u.title))),
		mbIconError)
}

func (u *winUI) Done(text string) {
	u.Stage("Ready", 100)
	if text != "" {
		pMessageBoxW.Call(0,
			uintptr(unsafe.Pointer(u16(text))),
			uintptr(unsafe.Pointer(u16(u.title))),
			mbIconInfo)
	}
}

// Run pumps Win32 messages on this (locked) thread until the worker reports back.
func (u *winUI) Run(done <-chan error) error {
	result := make(chan error, 1)
	go func() {
		err := <-done
		result <- err
		pPostMessageW.Call(uintptr(u.hwnd), msgQuit, 0, 0)
	}()

	var m msgW
	for {
		ret, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(ret) <= 0 { // WM_QUIT or error
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	select {
	case err := <-result:
		return err
	default:
		// The message loop ended before the worker did, which only happens if
		// something destroyed the window; wait for the real answer.
		return <-result
	}
}

func (u *winUI) Wait()  {}
func (u *winUI) Close() {}
