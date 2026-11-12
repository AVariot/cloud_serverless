package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const frontOrigin = "http://localhost:3000"

// preflight simule la requête OPTIONS du navigateur : ni clé API, ni jeton.
func preflight(origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodOptions, "/draw", nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type,x-api-key")
	rec := httptest.NewRecorder()
	handle(rec, req)
	return rec
}

// drawFrom envoie un vrai POST /draw, avec l'en-tête Origin d'un navigateur.
func drawFrom(origin, authorization string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/draw", strings.NewReader(validBody))
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if authorization != "" {
		req.Header.Set("X-Forwarded-Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	handle(rec, req)
	return rec
}

func TestPreflightOrigineAutorisee(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", frontOrigin)

	rec := preflight(frontOrigin)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("statut = %d, attendu 204", rec.Code)
	}
	h := rec.Header()
	if h.Get("Access-Control-Allow-Origin") != frontOrigin {
		t.Errorf("Allow-Origin = %q, attendu %q", h.Get("Access-Control-Allow-Origin"), frontOrigin)
	}
	if !strings.Contains(h.Get("Access-Control-Allow-Methods"), "POST") {
		t.Errorf("Allow-Methods = %q, attendu POST", h.Get("Access-Control-Allow-Methods"))
	}
	for _, want := range []string{"Authorization", "Content-Type", "X-Api-Key"} {
		if !strings.Contains(h.Get("Access-Control-Allow-Headers"), want) {
			t.Errorf("Allow-Headers = %q, attendu %s", h.Get("Access-Control-Allow-Headers"), want)
		}
	}
}

// Le préflight ne porte aucun jeton : il ne doit jamais interroger Discord ni publier.
func TestPreflightNInterroguePasDiscord(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", frontOrigin)
	discord := fauxDiscord(t, http.StatusOK, `{"id":"u42"}`)
	publications := 0
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
		publications++
		return nil
	}
	t.Cleanup(func() { publish = publishDraw })

	preflight(frontOrigin)

	if discord.URL != nil || publications != 0 {
		t.Errorf("Discord interrogé=%v, publications=%d : un préflight ne doit rien déclencher", discord.URL != nil, publications)
	}
}

func TestPreflightOrigineRefusee(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", frontOrigin)

	rec := preflight("https://pirate.exemple")

	if rec.Code != http.StatusForbidden {
		t.Errorf("statut = %d, attendu 403", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("une origine refusée ne doit recevoir aucun Allow-Origin")
	}
}

// Sans configuration, CORS est fermé : aucune origine n'est autorisée.
func TestPreflightSansConfiguration(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", "")

	if rec := preflight(frontOrigin); rec.Code != http.StatusForbidden {
		t.Errorf("statut = %d, attendu 403 : sans ALLOWED_ORIGINS, personne n'est autorisé", rec.Code)
	}
}

func TestPlusieursOriginesAutorisees(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", "https://front.exemple, "+frontOrigin)

	for _, origin := range []string{"https://front.exemple", frontOrigin} {
		if rec := preflight(origin); rec.Code != http.StatusNoContent {
			t.Errorf("%s : statut = %d, attendu 204", origin, rec.Code)
		}
	}
}

// Les erreurs doivent porter les en-têtes, sinon le navigateur affiche une erreur CORS qui masque le vrai 401.
func TestEnTetesCORSSurLesErreurs(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", frontOrigin)

	rec := drawFrom(frontOrigin, "") // sans jeton : 401

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("statut = %d, attendu 401", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != frontOrigin {
		t.Errorf("Allow-Origin = %q sur un 401, attendu %q", rec.Header().Get("Access-Control-Allow-Origin"), frontOrigin)
	}
	if !strings.Contains(rec.Header().Get("Access-Control-Expose-Headers"), "X-Correlation-Id") {
		t.Error("le front doit pouvoir lire X-Correlation-Id")
	}
}

func TestEnTetesCORSSurUnSucces(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", frontOrigin)
	utilisateurConnecte(t)
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error { return nil }
	t.Cleanup(func() { publish = publishDraw })

	rec := drawFrom(frontOrigin, "Bearer jeton")

	if rec.Code != http.StatusAccepted || rec.Header().Get("Access-Control-Allow-Origin") != frontOrigin {
		t.Errorf("statut=%d Allow-Origin=%q, attendu 202 et %q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"), frontOrigin)
	}
}

func TestPOSTOrigineRefusee(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", frontOrigin)

	rec := drawFrom("https://pirate.exemple", "")

	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("une origine refusée ne doit recevoir aucun Allow-Origin, même sur une erreur")
	}
}

// curl et Discord n'envoient pas d'Origin : leur réponse ne doit pas changer.
func TestSansOriginAucunEnTeteCORS(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", frontOrigin)

	rec := drawFrom("", "")

	for _, h := range []string{"Access-Control-Allow-Origin", "Access-Control-Expose-Headers", "Vary"} {
		if rec.Header().Get(h) != "" {
			t.Errorf("en-tête %s = %q, attendu absent sans Origin", h, rec.Header().Get(h))
		}
	}
}
