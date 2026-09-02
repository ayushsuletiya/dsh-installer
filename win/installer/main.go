// DeepSeek Harness for Windows — one binary that installs, launches, serves and
// updates. Double-click, wait, use it.
//
// Why this exists: the harness used to arrive as a PowerShell line that installed
// Docker Desktop, which meant a ~600 MB download, a WSL2 dependency, usually a
// reboot, and a second paste of the same command afterwards. None of that is the
// harness. This carries the harness instead: a pre-built tree with its own Node
// runtime, downloaded once and verified by hash.
//
// The enrollment token is not typed by anyone. get.xovi.pro stamps it into the two
// fixed-width slots below as the file is served, so the download IS the machine's
// identity and there is nothing to copy.
//
// Modes:
//
//	(none)          install, then open the UI
//	--open          start the harness if it is down, then open the browser
//	--serve         run the harness in the foreground (what the logon task calls)
//	--update        fetch a newer payload if one was published, then restart
//	--uninstall     remove tasks, shortcuts and the program (keeps chats)
//	--silent        no window; progress on stdout (CI)
//	--selftest-ui   draw the window, tick it, exit (proves the GUI cannot crash)
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ── stamped at download time ─────────────────────────────────────────────────
// Fixed width on purpose: the server overwrites the bytes in place and a Go
// string's length lives elsewhere in the binary, so the slot may never grow or
// shrink. The value is written after the prefix and terminated with a NUL.
var (
	baseSlot  = "DSHBASE=00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
	tokenSlot = "DSHTOKEN=0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
)

const (
	appName    = "DeepSeek Harness"
	dirName    = "DeepSeekHarness"
	exeName    = "DeepSeekHarness.exe"
	serveTask  = "DeepSeek Harness"
	updateTask = "DeepSeek Harness Update"
	qwenTask   = "Qwen (debugging port)"
	webPort    = 3080
	fallback   = "https://get.xovi.pro"
)

// unslot returns the value stamped into a slot, or "" when the binary was never
// stamped. NUL-terminated rather than padding-trimmed: a token can legitimately
// end in the padding character.
func unslot(slot, prefix string) string {
	s := strings.TrimPrefix(slot, prefix)
	if i := strings.IndexByte(s, 0); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return ""
}

type config struct {
	base    string
	token   string
	root    string
	silent  bool
	verbose bool
}

// manifest is the slice of get.xovi.pro/manifest.json this installer needs.
type manifest struct {
	Version string `json:"version"`
	Windows *struct {
		Version string `json:"version"`
		Payload struct {
			URL    string `json:"url"`
			SHA256 string `json:"sha256"`
			Bytes  int64  `json:"bytes"`
		} `json:"payload"`
	} `json:"windows"`
}

var ui progressUI

func main() {
	cfg := parseArgs()

	mode := "install"
	for _, a := range os.Args[1:] {
		switch a {
		case "--open", "--serve", "--update", "--uninstall", "--selftest-ui":
			mode = strings.TrimPrefix(a, "--")
		}
	}

	// --serve is the long-lived task: it must never draw a window.
	if mode == "serve" {
		if err := serve(cfg); err != nil {
			fmt.Fprintln(os.Stderr, "serve:", err)
			os.Exit(1)
		}
		return
	}

	ui = newUI(cfg.silent, appName)
	defer ui.Close()

	// The window has to keep painting while the download runs, so the work goes to
	// a goroutine and this thread — the one locked in init() — does nothing but pump
	// Win32 messages. Doing it the other way round is exactly how an installer ends
	// up greyed out and titled "Not Responding".
	done := make(chan error, 1)
	go func() {
		switch mode {
		case "open":
			done <- open(cfg)
		case "update":
			done <- update(cfg)
		case "uninstall":
			done <- uninstall(cfg)
		case "selftest-ui":
			done <- selftestUI()
		default:
			done <- install(cfg)
		}
	}()

	if err := ui.Run(done); err != nil {
		ui.Fail(err.Error())
		fmt.Fprintln(os.Stderr, "error:", err)
		ui.Wait()
		os.Exit(1)
	}
	ui.Wait()
}

func parseArgs() config {
	cfg := config{
		base:  unslot(baseSlot, "DSHBASE="),
		token: unslot(tokenSlot, "DSHTOKEN="),
	}
	args := os.Args[1:]
	for i, a := range args {
		next := func() string {
			if i+1 < len(args) {
				return args[i+1]
			}
			return ""
		}
		switch a {
		case "--base":
			cfg.base = next()
		case "--token":
			cfg.token = next()
		case "--root":
			cfg.root = next()
		case "--silent":
			cfg.silent = true
		case "--verbose":
			cfg.verbose = true
		}
	}
	if cfg.base == "" {
		cfg.base = fallback
	}
	cfg.base = strings.TrimRight(cfg.base, "/")
	if cfg.root == "" {
		cfg.root = defaultRoot()
	}
	return cfg
}

func defaultRoot() string {
	if la := os.Getenv("LOCALAPPDATA"); la != "" {
		return filepath.Join(la, dirName)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), dirName)
	}
	return filepath.Join(home, dirName)
}

// ── install ─────────────────────────────────────────────────────────────────

func install(cfg config) error {
	ui.Stage("Checking for the latest release", 2)
	man, err := fetchManifest(cfg)
	if err != nil {
		return err
	}
	if man.Windows == nil || man.Windows.Payload.URL == "" {
		return errors.New("this service has not published a Windows payload yet")
	}
	want := man.Windows.Version
	if want == "" {
		want = man.Version
	}

	if installedVersion(cfg.root) == want && fileExists(filepath.Join(cfg.root, "bootstrap.mjs")) {
		ui.Note("already up to date")
	} else {
		if err := fetchAndPlace(cfg, man); err != nil {
			return err
		}
	}

	ui.Stage("Setting up this machine", 70)
	if err := runNode(cfg, []string{filepath.Join(cfg.root, "bootstrap.mjs"), "--configure-only"}, true); err != nil {
		return fmt.Errorf("configuring: %w", err)
	}

	ui.Stage("Installing the launcher", 78)
	if err := installSelf(cfg); err != nil {
		return err
	}
	if err := registerTasks(cfg); err != nil {
		ui.Note("could not register a scheduled task: " + err.Error())
	}
	if err := makeShortcuts(cfg); err != nil {
		ui.Note("could not create the shortcut: " + err.Error())
	}

	ui.Stage("Installing the Qwen desktop app", 84)
	if err := ensureQwen(cfg); err != nil {
		ui.Note("Qwen app: " + err.Error())
	}

	ui.Stage("Starting the harness", 90)
	if err := startService(cfg); err != nil {
		return err
	}
	if !waitForPort(webPort, 150*time.Second) {
		return fmt.Errorf("the harness did not answer on 127.0.0.1:%d — see %s",
			webPort, filepath.Join(cfg.root, "home", ".dsh", "logs", "harness.log"))
	}

	ui.Stage("Ready", 100)
	openBrowser(fmt.Sprintf("http://127.0.0.1:%d", webPort))
	ui.Done("Open \"" + appName + "\" from your Desktop any time.\n" +
		"One thing left, once: sign into the Qwen app that just opened.")
	return nil
}

func fetchAndPlace(cfg config, man *manifest) error {
	ui.Stage("Downloading the harness", 5)
	tmp, err := os.CreateTemp("", "dsh-payload-*.zip")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	sum, err := download(man.Windows.Payload.URL, tmp, man.Windows.Payload.Bytes, 5, 55)
	tmp.Close()
	if err != nil {
		return fmt.Errorf("downloading the harness: %w", err)
	}
	if want := strings.ToLower(strings.TrimSpace(man.Windows.Payload.SHA256)); want != "" && want != sum {
		return fmt.Errorf("the download is corrupt (sha256 %s, expected %s)", sum[:12], want[:12])
	}
	ui.Note("verified " + sum[:12])

	ui.Stage("Installing", 58)
	staged := cfg.root + ".new"
	os.RemoveAll(staged)
	if err := unzip(tmpName, staged, 58, 68); err != nil {
		return fmt.Errorf("unpacking: %w", err)
	}

	// An update replaces the program and keeps the person's data: chats, sessions
	// and the task board all live under home\.
	oldHome := filepath.Join(cfg.root, "home")
	if fileExists(oldHome) {
		os.RemoveAll(filepath.Join(staged, "home"))
		if err := os.Rename(oldHome, filepath.Join(staged, "home")); err != nil {
			return fmt.Errorf("keeping your existing data: %w", err)
		}
	}

	stopService(cfg)
	if fileExists(cfg.root) {
		prev := cfg.root + ".old"
		os.RemoveAll(prev)
		if err := os.Rename(cfg.root, prev); err != nil {
			return fmt.Errorf("replacing the old version: %w", err)
		}
		defer os.RemoveAll(prev)
	}
	if err := os.Rename(staged, cfg.root); err != nil {
		return fmt.Errorf("moving the new version into place: %w", err)
	}
	return nil
}

// installSelf keeps a copy of this binary inside the install, so the shortcut and
// both scheduled tasks point at something permanent rather than at whatever
// download folder the installer was run from.
func installSelf(cfg config) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	dest := filepath.Join(cfg.root, exeName)
	if sameFile(self, dest) {
		return nil
	}
	in, err := os.Open(self)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(cfg.root, 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// ── the other modes ─────────────────────────────────────────────────────────

func open(cfg config) error {
	url := fmt.Sprintf("http://127.0.0.1:%d", webPort)
	if portOpen(webPort) {
		openBrowser(url)
		return nil
	}
	ui.Stage("Starting the harness", 20)
	if err := startService(cfg); err != nil {
		return err
	}
	if !waitForPort(webPort, 120*time.Second) {
		return errors.New("the harness is not answering. Open it again in a moment, or run --update")
	}
	openBrowser(url)
	ui.Done("")
	return nil
}

func serve(cfg config) error {
	script := filepath.Join(cfg.root, "bootstrap.mjs")
	if !fileExists(script) {
		return fmt.Errorf("%s is missing — reinstall", script)
	}
	return runNode(cfg, []string{script}, false)
}

func update(cfg config) error {
	ui.Stage("Checking for a newer release", 5)
	man, err := fetchManifest(cfg)
	if err != nil {
		return err
	}
	if man.Windows == nil || man.Windows.Payload.URL == "" {
		return nil
	}
	want := man.Windows.Version
	if want == "" {
		want = man.Version
	}
	if installedVersion(cfg.root) == want {
		ui.Done("already up to date")
		return nil
	}
	if err := fetchAndPlace(cfg, man); err != nil {
		return err
	}
	ui.Stage("Applying", 80)
	if err := runNode(cfg, []string{filepath.Join(cfg.root, "bootstrap.mjs"), "--configure-only"}, true); err != nil {
		return err
	}
	_ = installSelf(cfg)
	if err := startService(cfg); err != nil {
		return err
	}
	waitForPort(webPort, 120*time.Second)
	ui.Done("updated to " + want)
	return nil
}

func uninstall(cfg config) error {
	ui.Stage("Removing", 20)
	stopService(cfg)
	for _, t := range []string{serveTask, updateTask, qwenTask} {
		_ = runHidden("schtasks", "/Delete", "/TN", t, "/F")
	}
	removeShortcuts()
	ui.Stage("Deleting the program", 60)
	// The program goes; home\ stays, so a reinstall still has every conversation.
	for _, name := range []string{"app", "baked", "installer", "runtime", "bootstrap.mjs", "version.txt", exeName} {
		os.RemoveAll(filepath.Join(cfg.root, name))
	}
	ui.Done("Removed. Your chats are still in " + filepath.Join(cfg.root, "home"))
	return nil
}

func selftestUI() error {
	for i := 0; i <= 100; i += 10 {
		ui.Stage(fmt.Sprintf("Self test %d%%", i), i)
		time.Sleep(15 * time.Millisecond)
	}
	ui.Done("ui ok")
	return nil
}

// ── plumbing ────────────────────────────────────────────────────────────────

func httpClient() *http.Client {
	return &http.Client{Timeout: 0, Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}}
}

func fetchManifest(cfg config) (*manifest, error) {
	url := cfg.base + "/manifest.json"
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "dsh-win-installer")
	res, err := httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s (%v)", cfg.base, err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("%s returned HTTP %d", url, res.StatusCode)
	}
	var man manifest
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&man); err != nil {
		return nil, fmt.Errorf("the release manifest is unreadable: %w", err)
	}
	return &man, nil
}

// download streams to w, reports progress between the two percentages, and returns
// the payload's sha256 so the caller can refuse a corrupt file.
func download(url string, w io.Writer, expect int64, from, to int) (string, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "dsh-win-installer")
	res, err := httpClient().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	total := res.ContentLength
	if total <= 0 {
		total = expect
	}

	h := sha256.New()
	buf := make([]byte, 512*1024)
	var done int64
	last := time.Now()
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return "", werr
			}
			h.Write(buf[:n])
			done += int64(n)
			if time.Since(last) > 200*time.Millisecond {
				last = time.Now()
				pct := from
				if total > 0 {
					pct = from + int(float64(to-from)*float64(done)/float64(total))
				}
				ui.Progress(pct, fmt.Sprintf("%s of %s", mb(done), mb(total)))
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", rerr
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func mb(n int64) string {
	if n <= 0 {
		return "?"
	}
	return fmt.Sprintf("%.0f MB", float64(n)/(1024*1024))
}

func unzip(zipPath, dest string, from, to int) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	for i, f := range r.File {
		// Reject any entry that would escape the destination.
		target := filepath.Join(dest, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			return fmt.Errorf("refusing unsafe path in archive: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, f.Mode()|0o200)
		if err != nil {
			rc.Close()
			return err
		}
		_, cerr := io.Copy(out, rc)
		out.Close()
		rc.Close()
		if cerr != nil {
			return cerr
		}
		if i%200 == 0 {
			ui.Progress(from+int(float64(to-from)*float64(i)/float64(len(r.File))), "")
		}
	}
	return nil
}

func nodeExe(root string) string { return filepath.Join(root, "runtime", "node", "node.exe") }

// runNode runs the bundled Node with the enrollment identity in its environment.
func runNode(cfg config, args []string, wait bool) error {
	exe := nodeExe(cfg.root)
	if !fileExists(exe) {
		return fmt.Errorf("the bundled Node runtime is missing at %s", exe)
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = cfg.root
	cmd.Env = append(os.Environ(),
		"DSH_DIST_BASE="+cfg.base,
		"DSH_DIST_TOKEN="+cfg.token,
		fmt.Sprintf("DSH_WEB_PORT=%d", webPort),
	)
	hideWindow(cmd)
	if !wait {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		tail := strings.TrimSpace(string(out))
		if len(tail) > 1200 {
			tail = tail[len(tail)-1200:]
		}
		return fmt.Errorf("%v\n%s", err, tail)
	}
	if cfg.verbose {
		fmt.Println(string(out))
	}
	return nil
}

func installedVersion(root string) string {
	b, err := os.ReadFile(filepath.Join(root, "version.txt"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func sameFile(a, b string) bool {
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(ai, bi)
}

func portOpen(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 1200*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func waitForPort(port int, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if portOpen(port) {
			return true
		}
		time.Sleep(1500 * time.Millisecond)
	}
	return false
}

func init() {
	// Keep the Win32 message pump on one thread; see ui_windows.go.
	runtime.LockOSThread()
}
