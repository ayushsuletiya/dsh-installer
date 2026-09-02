package main

import (
	"fmt"
	"strings"
	"sync"
)

// progressUI is the whole surface the install logic is allowed to touch, so the
// same code drives a native window, a console, or nothing at all.
type progressUI interface {
	// Stage announces a new step and jumps the bar to pct.
	Stage(text string, pct int)
	// Progress moves the bar inside the current step, with an optional detail line.
	Progress(pct int, detail string)
	// Note records something worth saying that is not a failure.
	Note(text string)
	// Fail reports a fatal error to the human.
	Fail(text string)
	// Done reports success, with a closing instruction when there is one.
	Done(text string)
	// Run drives the UI until the worker finishes, and returns the worker's error.
	Run(done <-chan error) error
	// Wait holds the UI open long enough for the human to read it.
	Wait()
	Close()
}

// consoleUI is the fallback and the CI face: plain lines, no window, no cursor
// tricks that a log file would render as garbage.
type consoleUI struct {
	mu   sync.Mutex
	last int
}

func (c *consoleUI) Stage(text string, pct int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = pct
	fmt.Printf("[%3d%%] %s\n", pct, text)
}

func (c *consoleUI) Progress(pct int, detail string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Only speak when the number actually moved, so a slow download does not
	// produce a thousand identical lines in a CI log.
	if pct/5 == c.last/5 && detail == "" {
		return
	}
	c.last = pct
	if detail != "" {
		fmt.Printf("[%3d%%] %s\n", pct, detail)
	}
}

func (c *consoleUI) Note(text string) { fmt.Println("       " + text) }
func (c *consoleUI) Fail(text string) {
	fmt.Println()
	fmt.Println("failed: " + text)
}

func (c *consoleUI) Done(text string) {
	fmt.Println("[100%] done")
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) != "" {
			fmt.Println("       " + line)
		}
	}
}

func (c *consoleUI) Run(done <-chan error) error { return <-done }
func (c *consoleUI) Wait()                       {}
func (c *consoleUI) Close()                      {}
