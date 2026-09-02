//go:build !windows

// Non-Windows stubs. They exist so the whole installer still compiles, vets and
// type-checks on the machine it is developed on — a Mac — instead of only being
// checkable inside CI. Nothing here is shipped.
package main

import (
	"errors"
	"os/exec"
)

func newUI(silent bool, title string) progressUI { return &consoleUI{} }

func hideWindow(cmd *exec.Cmd) {}

func runHidden(name string, args ...string) error {
	return exec.Command(name, args...).Run()
}

func openBrowser(url string) {}

func startService(cfg config) error {
	return errors.New("the background service is Windows-only")
}

func stopService(cfg config) {}

func registerTasks(cfg config) error {
	return errors.New("scheduled tasks are Windows-only")
}

func makeShortcuts(cfg config) error { return errors.New("shortcuts are Windows-only") }

func removeShortcuts() {}

func ensureQwen(cfg config) error { return errors.New("the Qwen desktop app is Windows-only") }

func reclaimPort(cfg config) error { return nil }

func servingOurs(cfg config) bool { return true }
