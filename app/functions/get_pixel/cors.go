package getpixel

import (
	"net/http"
	"os"
	"strings"
)

// allowedOrigin dit si une origine peut appeler la fonction depuis un navigateur.
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

// setCORS ajoute les en-têtes qui autorisent le navigateur à lire la réponse, erreurs comprises.
// Sans en-tête Origin (curl), rien n'est ajouté.
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
}

// handlePreflight répond à la requête OPTIONS que le navigateur envoie avant le GET
// (l'en-tête X-Api-Key la déclenche).
func handlePreflight(w http.ResponseWriter, r *http.Request) {
	if !allowedOrigin(r.Header.Get("Origin")) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "X-Api-Key, Content-Type")
	w.Header().Set("Access-Control-Max-Age", "3600")
	w.WriteHeader(http.StatusNoContent)
}
