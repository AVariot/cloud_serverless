package proxy

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
)

func init() {
	functions.HTTP("DiscordProxy", handleDiscord)
}

// interaction : ce que Discord envoie (seuls les champs utiles au worker).
type interaction struct {
	ID            string `json:"id"`
	ApplicationID string `json:"application_id"`
	Type          int    `json:"type"`
	Token         string `json:"token"`
	GuildID       string `json:"guild_id"`
	ChannelID     string `json:"channel_id"`
	Data          struct {
		Name    string          `json:"name"`
		Options json.RawMessage `json:"options"`
	} `json:"data"`
	// Member est rempli dans un serveur, User en message privé.
	Member *struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
		Roles []string `json:"roles"`
	} `json:"member"`
	User *struct {
		ID string `json:"id"`
	} `json:"user"`
}

// discordCommand : l'événement publié pour le worker.
type discordCommand struct {
	InteractionID string          `json:"interaction_id"`
	ApplicationID string          `json:"application_id"`
	Token         string          `json:"token"` // sert au worker à répondre dans Discord, ne jamais le loguer
	Command       string          `json:"command"`
	Options       json.RawMessage `json:"options,omitempty"`
	UserID        string          `json:"user_id"`
	Roles         []string        `json:"roles"` // pour les vérifications admin du worker
	GuildID       string          `json:"guild_id,omitempty"`
	ChannelID     string          `json:"channel_id,omitempty"`
}

// userID et roles viennent de la requête signée, jamais d'un champ fourni par l'utilisateur.
func (it interaction) userID() string {
	if it.Member != nil {
		return it.Member.User.ID
	}
	if it.User != nil {
		return it.User.ID
	}
	return ""
}

func verifySignature(r *http.Request, body []byte) bool {
	// 1. clé publique : variable d'environnement DISCORD_PUBLIC_KEY, en hexadécimal
	pub, err := hex.DecodeString(os.Getenv("DISCORD_PUBLIC_KEY"))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}

	// 2. signature : en-tête X-Signature-Ed25519, en hexadécimal
	sig, err := hex.DecodeString(r.Header.Get("X-Signature-Ed25519"))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}

	// 3. horodatage : en-tête X-Signature-Timestamp
	ts := r.Header.Get("X-Signature-Timestamp")
	if ts == "" {
		return false
	}

	// 4. le message signé : horodatage + corps brut
	msg := append([]byte(ts), body...)

	return ed25519.Verify(pub, msg, sig)
}

func handleDiscord(w http.ResponseWriter, r *http.Request) {
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

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		logger.Warn("corps illisible", "correlation_id", correlationID)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "corps illisible", "correlation_id": correlationID})
		return
	}

	if !verifySignature(r, body) {
		logger.Warn("signature invalide", "correlation_id", correlationID)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "signature invalide", "correlation_id": correlationID})
		return
	}

	var it interaction
	if err := json.Unmarshal(body, &it); err != nil {
		logger.Warn("JSON invalide", "correlation_id", correlationID)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON invalide", "correlation_id": correlationID})
		return
	}

	switch it.Type {
	case 1: // PING : Discord vérifie que l'endpoint répond
		logger.Info("ping discord", "correlation_id", correlationID)
		writeJSON(w, http.StatusOK, map[string]int{"type": 1})
	case 2: // commande slash : on publie, puis on répond « accusé différé »
		if it.Data.Name == "ping" {
			logger.Info("discord ping command", "correlation_id", correlationID)
			writeJSON(w, http.StatusOK, map[string]any{
				"type": 4,
				"data": map[string]string{"content": "pong"},
			})
			return
		}
		if it.userID() == "" || it.Data.Name == "" {
			logger.Warn("commande incomplète", "correlation_id", correlationID)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "commande incomplète", "correlation_id": correlationID})
			return
		}

		cmd := discordCommand{
			InteractionID: it.ID,
			ApplicationID: it.ApplicationID,
			Token:         it.Token,
			Command:       it.Data.Name,
			Options:       it.Data.Options,
			UserID:        it.userID(),
			GuildID:       it.GuildID,
			ChannelID:     it.ChannelID,
		}
		if it.Member != nil {
			cmd.Roles = it.Member.Roles
		}

		eventID := newID()
		// Discord impose 3 secondes : on garde de la marge pour la réponse.
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := publishDiscord(ctx, cmd, eventID, correlationID); err != nil {
			logger.Error("publication impossible", "correlation_id", correlationID, "event_id", eventID, "command", cmd.Command, "error", err.Error())
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "file indisponible", "correlation_id": correlationID})
			return
		}

		logger.Info("discord.command accepté", "correlation_id", correlationID, "event_id", eventID, "command", cmd.Command, "user_id", cmd.UserID)
		writeJSON(w, http.StatusOK, map[string]int{"type": 5})
	default:
		logger.Warn("type d'interaction non géré", "correlation_id", correlationID, "type", it.Type)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type non géré", "correlation_id": correlationID})
	}
}
