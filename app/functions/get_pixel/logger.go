package getpixel

import (
	"log/slog"
	"os"
)

// Cloud Logging lit "severity" et "message" ; le reste est indexé comme champs.
var logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
	ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
		switch a.Key {
		case slog.LevelKey:
			a.Key = "severity"
			if lvl, ok := a.Value.Any().(slog.Level); ok && lvl == slog.LevelWarn {
				a.Value = slog.StringValue("WARNING")
			}
		case slog.MessageKey:
			a.Key = "message"
		}
		return a
	},
}))
