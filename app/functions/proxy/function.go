package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"time"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
)

const gridSize = 10000

var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type drawRequest struct {
	X      *int   `json:"x"`
	Y      *int   `json:"y"`
	Color  string `json:"color"`
	UserID string `json:"user_id"`
}

func init() {
	functions.HTTP("Proxy", route)
}

// route aiguille selon le chemin : /discord vers les interactions Discord, le reste vers le dessin web.
func route(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/discord" {
		handleDiscord(w, r)
		return
	}
	handle(w, r)
}

func handle(w http.ResponseWriter, r *http.Request) {
	correlationID := r.Header.Get("X-Correlation-Id")
	if correlationID == "" {
		correlationID = newID()
	}
	w.Header().Set("X-Correlation-Id", correlationID)

	if r.Method != http.MethodPost {
		logger.Warn("méthode refusée", "correlation_id", correlationID, "method", r.Method)
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST uniquement", "correlation_id": correlationID})
		return
	}

	var req drawRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		logger.Warn("JSON invalide", "correlation_id", correlationID)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON invalide", "correlation_id": correlationID})
		return
	}
	if msg := validate(req); msg != "" {
		logger.Warn("requête refusée", "correlation_id", correlationID, "reason", msg)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg, "correlation_id": correlationID})
		return
	}

	eventID := newID()

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := publish(ctx, req, eventID, correlationID); err != nil {
		logger.Error("publication impossible", "correlation_id", correlationID, "event_id", eventID, "error", err.Error())
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "file indisponible", "correlation_id": correlationID})
		return
	}

	logger.Info("pixel.draw accepté", "correlation_id", correlationID, "event_id", eventID, "x", *req.X, "y", *req.Y)
	writeJSON(w, http.StatusAccepted, map[string]string{"event_id": eventID, "correlation_id": correlationID})
}

func validate(req drawRequest) string {
	if req.X == nil || req.Y == nil || *req.X < 0 || *req.X >= gridSize || *req.Y < 0 || *req.Y >= gridSize {
		return "x et y doivent être des entiers entre 0 et 9999"
	}
	if !colorRe.MatchString(req.Color) {
		return "color doit être au format #RRGGBB"
	}
	if req.UserID == "" {
		return "user_id est requis"
	}
	return ""
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
