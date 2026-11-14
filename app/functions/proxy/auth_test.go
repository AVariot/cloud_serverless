package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fauxDiscord remplace l'API Discord par un serveur local qui répond ce qu'on lui demande.
// Il renvoie la requête reçue pour que le test puisse la contrôler.
func fauxDiscord(t *testing.T, status int, body string) *http.Request {
	t.Helper()
	received := &http.Request{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*received = *r
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))

	old := discordAPI
	discordAPI = srv.URL
	t.Cleanup(func() {
		discordAPI = old
		srv.Close()
	})
	return received
}

func TestUserIDValide(t *testing.T) {
	fauxDiscord(t, http.StatusOK, `{"id":"u42"}`)

	id, err := discordUserID(context.Background(), "jeton")
	if err != nil {
		t.Fatalf("erreur inattendue : %v", err)
	}
	if id != "u42" {
		t.Errorf("id = %q, attendu u42", id)
	}
}

// Le jeton doit partir dans l'en-tête, sur la bonne route : c'est ce que Discord vérifie.
func TestRequeteEnvoyeeADiscord(t *testing.T) {
	received := fauxDiscord(t, http.StatusOK, `{"id":"u42"}`)

	if _, err := discordUserID(context.Background(), "jeton123"); err != nil {
		t.Fatal(err)
	}
	if received.Method != http.MethodGet {
		t.Errorf("méthode = %s, attendu GET", received.Method)
	}
	if received.URL.Path != "/users/@me" {
		t.Errorf("chemin = %s, attendu /users/@me", received.URL.Path)
	}
	if got := received.Header.Get("Authorization"); got != "Bearer jeton123" {
		t.Errorf("Authorization = %q, attendu \"Bearer jeton123\"", got)
	}
}

func TestJetonRefuse(t *testing.T) {
	fauxDiscord(t, http.StatusUnauthorized, `{}`)

	_, err := discordUserID(context.Background(), "mauvais")
	if !errors.Is(err, errUnauthorized) {
		t.Errorf("erreur = %v, attendu errUnauthorized", err)
	}
}

// Une panne de Discord ne doit pas passer pour un jeton invalide : le proxy répondra 503, pas 401.
func TestDiscordEnPanne(t *testing.T) {
	fauxDiscord(t, http.StatusInternalServerError, `{}`)

	_, err := discordUserID(context.Background(), "jeton")
	if err == nil {
		t.Fatal("une erreur était attendue")
	}
	if errors.Is(err, errUnauthorized) {
		t.Error("une panne ne doit pas être prise pour un jeton refusé")
	}
}

func TestReponseSansIdentifiant(t *testing.T) {
	for name, body := range map[string]string{
		"objet vide":       `{}`,
		"identifiant vide": `{"id":""}`,
		"pas du JSON":      `pas du json`,
	} {
		t.Run(name, func(t *testing.T) {
			fauxDiscord(t, http.StatusOK, body)
			if _, err := discordUserID(context.Background(), "jeton"); err == nil {
				t.Error("une erreur était attendue")
			}
		})
	}
}

// Discord qui ne répond pas ne doit pas bloquer le proxy : l'appel s'arrête au délai prévu.
func TestDiscordTropLent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done(): // le client a abandonné
		case <-time.After(2 * time.Second):
		}
	}))

	oldAPI, oldClient := discordAPI, discordClient
	discordAPI = srv.URL
	discordClient = &http.Client{Timeout: 100 * time.Millisecond}
	t.Cleanup(func() {
		discordAPI, discordClient = oldAPI, oldClient
		srv.Close()
	})

	start := time.Now()
	_, err := discordUserID(context.Background(), "jeton")
	if err == nil {
		t.Fatal("une erreur de délai était attendue")
	}
	if errors.Is(err, errUnauthorized) {
		t.Error("un délai dépassé ne doit pas être pris pour un jeton refusé")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("l'appel a duré %v, il devait s'arrêter vers 100 ms", elapsed)
	}
}
