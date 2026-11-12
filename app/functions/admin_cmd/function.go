package admincmd

import (
	"encoding/json"
	"net/http"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
)

// pushEnvelope : ce que Pub/Sub envoie à la fonction (souscription push).
type pushEnvelope struct {
	Message struct {
		Data       []byte            `json:"data"`
		Attributes map[string]string `json:"attributes"`
		MessageID  string            `json:"messageId"`
	} `json:"message"`
}

type adminCommand struct {
	Command string          `json:"command"`
	Options json.RawMessage `json:"options"`
	UserID  string          `json:"user_id"`
	Roles   []string        `json:"roles"`
}

func init() {
	functions.HTTP("AdminCmd", handle)
}

func handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST uniquement", http.StatusMethodNotAllowed)
		return
	}

	var env pushEnvelope
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		logger.Warn("enveloppe invalide", "error", err.Error())
		http.Error(w, "enveloppe invalide", http.StatusBadRequest)
		return
	}
	correlationID := env.Message.Attributes["correlation_id"]

	var cmd adminCommand
	if err := json.Unmarshal(env.Message.Data, &cmd); err != nil {
		logger.Warn("message illisible", "message_id", env.Message.MessageID, "correlation_id", correlationID, "error", err.Error())
		http.Error(w, "message illisible", http.StatusBadRequest)
		return
	}

	logger.Info("commande admin reçue", "message_id", env.Message.MessageID, "correlation_id", correlationID, "command", cmd.Command, "user_id", cmd.UserID)
	w.WriteHeader(http.StatusOK)
}
