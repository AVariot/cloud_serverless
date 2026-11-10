package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
)

const gridSize = 10000

var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// drawRequest : ce que le client envoie. Il n'y a pas de user_id : on ne fait pas confiance au corps.
type drawRequest struct {
	X     *int   `json:"x"`
	Y     *int   `json:"y"`
	Color string `json:"color"`
}

// drawEvent : le message publié pour le worker (le contrat avec l'équipe).
// Le user_id vient de Discord, jamais du corps de la requête.
type drawEvent struct {
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Color  string `json:"color"`
	UserID string `json:"user_id"`
}

func init() {
	functions.HTTP("Proxy", handle)
}

func handle(w http.ResponseWriter, r *http.Request) {
	// 1. Correlation
	correlationID := r.Header.Get("X-Correlation-Id")
	if correlationID == "" {
		correlationID = newID()
	}
	w.Header().Set("X-Correlation-Id", correlationID)

	// 2. Method
	if r.Method != http.MethodPost {
		logger.Warn("méthode refusée", "correlation_id", correlationID, "method", r.Method)
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST uniquement", "correlation_id": correlationID})
		return
	}
	// 3. Auth : le jeton Discord de l'utilisateur (la gateway déplace l'en-tête d'origine dans X-Forwarded-Authorization)
	token := bearerToken(r.Header.Get("X-Forwarded-Authorization"))
	if token == "" {
		logger.Warn("authentification requise", "correlation_id", correlationID)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentification requise", "correlation_id": correlationID})
		return
	}

	authCtx, cancelAuth := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancelAuth()
	userID, err := discordUserID(authCtx, token)
	if err != nil {
		if errors.Is(err, errUnauthorized) {
			logger.Warn("jeton invalide", "correlation_id", correlationID)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "jeton invalide", "correlation_id": correlationID})
		} else {
			logger.Error("authentification impossible", "correlation_id", correlationID, "error", err.Error())
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentification indisponible", "correlation_id": correlationID})
		}
		return
	}

	// 4. Read the body
	var req drawRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		logger.Warn("JSON invalide", "correlation_id", correlationID)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON invalide", "correlation_id": correlationID})
		return
	}
	// 5. Validate the content
	if msg := validate(req); msg != "" {
		logger.Warn("requête refusée", "correlation_id", correlationID, "reason", msg)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg, "correlation_id": correlationID})
		return
	}
	// 6. Publish
	eventID := newID()

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	evt := drawEvent{X: *req.X, Y: *req.Y, Color: req.Color, UserID: userID}
	if err := publish(ctx, evt, eventID, correlationID); err != nil {
		logger.Error("publication impossible", "correlation_id", correlationID, "event_id", eventID, "error", err.Error())
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "file indisponible", "correlation_id": correlationID})
		return
	}

	logger.Info("pixel.draw accepté", "correlation_id", correlationID, "event_id", eventID, "user_id", userID, "x", evt.X, "y", evt.Y)
	writeJSON(w, http.StatusAccepted, map[string]string{"event_id": eventID, "correlation_id": correlationID})
}

func validate(req drawRequest) string {
	if req.X == nil || req.Y == nil || *req.X < 0 || *req.X >= gridSize || *req.Y < 0 || *req.Y >= gridSize {
		return "x et y doivent être des entiers entre 0 et 9999"
	}
	if !colorRe.MatchString(req.Color) {
		return "color doit être au format #RRGGBB"
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

func bearerToken(header string) string {
	token, found := strings.CutPrefix(header, "Bearer ")
	if !found {
		return ""
	}
	return token
}
