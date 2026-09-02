//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	shell32          = syscall.NewLazyDLL("shell32.dll")
	pShellExecuteW   = shell32.NewProc("ShellExecuteW")
	createNoWindow   = uint32(0x08000000)
	detachedProcess  = uint32(0x00000008)
)

// hideWindow keeps every child process invisible: this binary is a windowsgui app,
// and a child console would flash a black rectangle over the installer.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

func runHidden(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			return err
		}
		return fmt.Errorf("%s: %s", err, msg)
	}
	return nil
}

// runPS is for the handful of jobs where a Windows one-liner is genuinely the
// simplest correct answer: making a .lnk, and finding a process by its image path.
func runPS(script string) (string, error) {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func openBrowser(url string) {
	pShellExecuteW.Call(0,
		uintptr(unsafe.Pointer(u16("open"))),
		uintptr(unsafe.Pointer(u16(url))),
		0, 0, 1 /* SW_SHOWNORMAL */)
}

// ── the harness as a background service ─────────────────────────────────────

func startService(cfg config) error {
	// Prefer the scheduled task, so what runs now is identical to what runs after a
	// reboot. Falling back to a detached child keeps a broken Task Scheduler from
	// being fatal.
	if err := runHidden("schtasks", "/Run", "/TN", serveTask); err == nil {
		if waitForPort(webPort, 30*time.Second) {
			return nil
		}
	}
	exe := filepath.Join(cfg.root, exeName)
	if !fileExists(exe) {
		var err error
		if exe, err = os.Executable(); err != nil {
			return err
		}
	}
	cmd := exec.Command(exe, "--serve")
	cmd.Dir = cfg.root
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedProcess}
	return cmd.Start()
}

func stopService(cfg config) {
	_ = runHidden("schtasks", "/End", "/TN", serveTask)
	// Anything still holding the port is one of ours, identified by image path so a
	// user's own node processes are never touched. The CALLER's root, not the default
	// one: an update or an uninstall against a non-default install would otherwise
	// look in the wrong place and leave a live process holding the files.
	root := cfg.root
	if root == "" {
		root = defaultRoot()
	}
	_, _ = runPS(fmt.Sprintf(
		`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '%s*' } | `+
			`ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
		strings.ReplaceAll(root, "'", "''")))
	for i := 0; i < 20 && portOpen(webPort); i++ {
		time.Sleep(500 * time.Millisecond)
	}
}

func registerTasks(cfg config) error {
	exe := filepath.Join(cfg.root, exeName)
	quoted := func(mode string) string { return `"` + exe + `" ` + mode }

	if err := runHidden("schtasks", "/Create", "/TN", serveTask,
		"/TR", quoted("--serve"), "/SC", "ONLOGON", "/RL", "LIMITED", "/F"); err != nil {
		return err
	}
	// Every six hours, and once thirty minutes from now so the first check does not
	// wait for the next logon.
	start := time.Now().Add(30 * time.Minute).Format("15:04")
	if err := runHidden("schtasks", "/Create", "/TN", updateTask,
		"/TR", quoted("--update --silent"), "/SC", "HOURLY", "/MO", "6",
		"/ST", start, "/RL", "LIMITED", "/F"); err != nil {
		return err
	}
	return nil
}

// ── shortcuts ───────────────────────────────────────────────────────────────

func makeShortcuts(cfg config) error {
	exe := filepath.Join(cfg.root, exeName)
	script := fmt.Sprintf(`
$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  $sc = $ws.CreateShortcut((Join-Path $dir '%s.lnk'))
  $sc.TargetPath       = '%s'
  $sc.Arguments        = '--open'
  $sc.WorkingDirectory = '%s'
  $sc.Description      = 'Open the DeepSeek Harness'
  $sc.Save()
}`, appName, exe, cfg.root)
	out, err := runPS(script)
	if err != nil {
		return errors.New(out)
	}
	return nil
}

func removeShortcuts() {
	_, _ = runPS(fmt.Sprintf(`
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $p = Join-Path $dir '%s.lnk'
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}`, appName))
}

// ── the Qwen desktop app ────────────────────────────────────────────────────
// The one thing that genuinely has to be a Windows GUI app, because a human signs
// into it. The bridge that drives it ships inside the payload and talks to its
// debugging port on 127.0.0.1:9222, so this is the only host-side dependency left
// — and it is installed here rather than left as a manual step.

func qwenPath() string {
	for _, p := range []string{
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Qwen", "Qwen.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Qwen", "Qwen.exe"),
	} {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

func ensureQwen(cfg config) error {
	exe := qwenPath()
	if exe == "" {
		url, err := qwenDownloadURL()
		if err != nil {
			return fmt.Errorf("%w — install it from https://qwen.ai/download", err)
		}
		setup := filepath.Join(os.TempDir(), "qwen-setup.exe")
		f, err := os.Create(setup)
		if err != nil {
			return err
		}
		ui.Progress(85, "downloading the Qwen app")
		_, derr := download(url, f, 0, 85, 88)
		f.Close()
		if derr != nil {
			os.Remove(setup)
			return derr
		}
		ui.Progress(88, "installing the Qwen app")
		if err := runHidden(setup, "/S"); err != nil {
			// Its silent switch is best-effort; the app may still have landed.
			ui.Note("the Qwen installer reported: " + err.Error())
		}
		os.Remove(setup)
		if exe = qwenPath(); exe == "" {
			return errors.New("the Qwen installer ran but the app was not found")
		}
	}

	// The bridge can only attach when the app was started WITH the debugging flag,
	// so a logon task owns that instead of the human remembering it.
	_ = runHidden("schtasks", "/Create", "/TN", qwenTask,
		"/TR", `"`+exe+`" --remote-debugging-port=9222`,
		"/SC", "ONLOGON", "/RL", "LIMITED", "/F")

	running, _ := runPS(`if (Get-Process -Name Qwen -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`)
	if strings.Contains(running, "yes") {
		ui.Note("Qwen is already running — restart it from the new shortcut to open its debugging port")
		return nil
	}
	cmd := exec.Command(exe, "--remote-debugging-port=9222")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess}
	return cmd.Start()
}

func qwenDownloadURL() (string, error) {
	req, _ := http.NewRequest("GET", "https://qwen.ai/api/config?api.app_download_url", nil)
	req.Header.Set("User-Agent", "dsh-win-installer")
	res, err := httpClient().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var payload struct {
		Data *struct {
			AppDownloadURL map[string]string `json:"app_download_url"`
		} `json:"data"`
		AppDownloadURL map[string]string `json:"app_download_url"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&payload); err != nil {
		return "", err
	}
	for _, m := range []map[string]string{
		func() map[string]string {
			if payload.Data != nil {
				return payload.Data.AppDownloadURL
			}
			return nil
		}(),
		payload.AppDownloadURL,
	} {
		if u := m["windows"]; u != "" {
			return u, nil
		}
	}
	return "", errors.New("the Qwen config carried no Windows download URL")
}
