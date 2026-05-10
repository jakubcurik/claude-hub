// SPDX-License-Identifier: Apache-2.0
package logging

import (
	"io"

	"github.com/rs/zerolog"
)

func New(fileW, stderrW io.Writer, level string) zerolog.Logger {
	lvl, err := zerolog.ParseLevel(level)
	if err != nil || lvl == zerolog.NoLevel {
		lvl = zerolog.InfoLevel
	}
	mw := zerolog.MultiLevelWriter(fileW, stderrW)
	return zerolog.New(mw).Level(lvl).With().Timestamp().Logger()
}
