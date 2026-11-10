package drawpixel

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"time"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
)

const gridSize = 10000

var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type pushEnvelope struct {
	Message struct {
		Data        []byte            `json:"data"`
		Attributes  map[string]string `json:"attributes"`
		MessageID   string            `json:"messageId"`
		PublishTime time.Time         `json:"publishTime"`
	} `json:"message"`
}

type drawEvent struct {
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Color  string `json:"color"`
	UserID string `json:"user_id"`
}

func init() {
	functions.HTTP("DrawPixel", handle)
}

func handle(w http.ResponseWriter, r *http.Request) {
	// 1. Méthode
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST uniquement", http.StatusMethodNotAllowed)
		return
	}

	// 2. Enveloppe Pub/Sub
	var env pushEnvelope
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		logger.Warn("enveloppe invalide", "error", err.Error())
		http.Error(w, "enveloppe invalide", http.StatusBadRequest)
		return
	}
	messageID := env.Message.MessageID
	correlationID := env.Message.Attributes["correlation_id"]

	// 3. Contenu du message
	var evt drawEvent
	if err := json.Unmarshal(env.Message.Data, &evt); err != nil {
		logger.Warn("message illisible", "message_id", messageID, "correlation_id", correlationID, "error", err.Error())
		http.Error(w, "message illisible", http.StatusBadRequest)
		return
	}

	// 4. Validation : on ne fait pas confiance au message, même venant de nos proxys
	if msg := validate(evt); msg != "" {
		logger.Warn("événement refusé", "message_id", messageID, "correlation_id", correlationID, "reason", msg)
		http.Error(w, msg, http.StatusBadRequest)
		return
	}

	// 5. Écriture : une panne de la base est temporaire, donc 500 (réessai utile)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := save(ctx, evt, env.Message.PublishTime); err != nil {
		logger.Error("écriture impossible", "message_id", messageID, "correlation_id", correlationID, "error", err.Error())
		http.Error(w, "écriture impossible", http.StatusInternalServerError)
		return
	}

	// 6. Acquittement
	logger.Info("pixel traité", "message_id", messageID, "correlation_id", correlationID, "user_id", evt.UserID, "x", evt.X, "y", evt.Y)
	w.WriteHeader(http.StatusOK)
}

func validate(evt drawEvent) string {
	if evt.X < 0 || evt.X >= gridSize || evt.Y < 0 || evt.Y >= gridSize {
		return "x et y doivent être des entiers entre 0 et 9999"
	}
	if !colorRe.MatchString(evt.Color) {
		return "color doit être au format #RRGGBB"
	}
	if evt.UserID == "" {
		return "user_id manquant"
	}
	return ""
}

// save est une variable pour que les tests remplacent la vraie écriture (comme "publish" dans le proxy).
var save = saveFirestore
