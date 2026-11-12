package proxy

import (
	"net/http"
	"os"
	"strings"
)

// allowedOrigin dit si une origine peut appeler /draw depuis un navigateur.
// ALLOWED_ORIGINS : adresses séparées par des virgules (jamais "*" : on liste les fronts connus).
func allowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	for _, o := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		if strings.TrimSpace(o) == origin {
			return true
		}
	}
	return false
}

// setCORS ajoute les en-têtes qui autorisent le navigateur à lire la réponse.
// Elle est appelée avant tout le reste : les erreurs (401, 400, 503) doivent les porter aussi,
// sinon le navigateur affiche une erreur CORS qui masque la vraie.
// Sans en-tête Origin (curl, Discord), rien n'est ajouté : le comportement est inchangé.
func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	w.Header().Add("Vary", "Origin")
	if !allowedOrigin(origin) {
		return // pas d'en-tête : le navigateur bloque
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Expose-Headers", "X-Correlation-Id")
}

// handlePreflight répond à la requête OPTIONS que le navigateur envoie avant le POST.
// Elle ne porte ni clé API ni jeton : on ne vérifie que l'origine.
func handlePreflight(w http.ResponseWriter, r *http.Request) {
	if !allowedOrigin(r.Header.Get("Origin")) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key, X-Correlation-Id")
	w.Header().Set("Access-Control-Max-Age", "3600")
	w.WriteHeader(http.StatusNoContent)
}
