// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"context"
	"os"
	"time"

	"github.com/fsnotify/fsnotify"
)

type Watcher struct {
	root     string
	debounce time.Duration
	onChange func()
}

func NewWatcher(root string, debounce time.Duration, onChange func()) *Watcher {
	return &Watcher{root: root, debounce: debounce, onChange: onChange}
}

func (w *Watcher) Run(ctx context.Context) error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer fw.Close()
	if err := fw.Add(w.root); err != nil && !os.IsNotExist(err) {
		return err
	}

	var timer *time.Timer
	fire := func() {
		if timer != nil {
			timer.Stop()
		}
		timer = time.AfterFunc(w.debounce, w.onChange)
	}

	for {
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return nil
		case _, ok := <-fw.Events:
			if !ok {
				return nil
			}
			fire()
		case _, ok := <-fw.Errors:
			if !ok {
				return nil
			}
		}
	}
}
