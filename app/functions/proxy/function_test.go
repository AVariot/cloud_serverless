package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func intPtr(n int) *int { return &n }

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		req     drawRequest
		wantErr bool
	}{
		{"valide", drawRequest{X: intPtr(10), Y: intPtr(20), Color: "#ff0000"}, false},
		{"coin haut-gauche", drawRequest{X: intPtr(0), Y: intPtr(0), Color: "#000000"}, false},
		{"coin bas-droit", drawRequest{X: intPtr(9999), Y: intPtr(9999), Color: "#FFFFFF"}, false},
		{"x absent", drawRequest{Y: intPtr(1), Color: "#ff0000"}, true},
		{"y absent", drawRequest{X: intPtr(1), Color: "#ff0000"}, true},
		{"x négatif", drawRequest{X: intPtr(-1), Y: intPtr(1), Color: "#ff0000"}, true},
		{"x hors grille", drawRequest{X: intPtr(10000), Y: intPtr(1), Color: "#ff0000"}, true},
		{"y hors grille", drawRequest{X: intPtr(1), Y: intPtr(10000), Color: "#ff0000"}, true},
		{"couleur sans #", drawRequest{X: intPtr(1), Y: intPtr(1), Color: "ff0000"}, true},
		{"couleur en toutes lettres", drawRequest{X: intPtr(1), Y: intPtr(1), Color: "rouge"}, true},
		{"couleur à 3 chiffres", drawRequest{X: intPtr(1), Y: intPtr(1), Color: "#f00"}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := validate(tc.req)
			if (got != "") != tc.wantErr {
				t.Errorf("validate() = %q, erreur attendue : %v", got, tc.wantErr)
			}
		})
	}
}

func TestBearerToken(t *testing.T) {
	tests := []struct{ name, header, want string }{
		{"valide", "Bearer abc", "abc"},
		{"sans préfixe", "abc", ""},
		{"vide", "", ""},
		{"autre schéma", "Basic abc", ""},
		{"préfixe seul", "Bearer ", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := bearerToken(tc.header); got != tc.want {
				t.Errorf("bearerToken(%q) = %q, attendu %q", tc.header, got, tc.want)
			}
		})
	}
}

// do envoie une requête authentifiée au handler, sans réseau, et renvoie la réponse.
func do(method, body, correlationID string) *httptest.ResponseRecorder {
	return doAs(method, body, correlationID, "Bearer jeton")
}

// doAs permet de choisir l'en-tête que la gateway aurait transmis ("" = aucun).
func doAs(method, body, correlationID, authorization string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	if correlationID != "" {
		req.Header.Set("X-Correlation-Id", correlationID)
	}
	if authorization != "" {
		req.Header.Set("X-Forwarded-Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	handle(rec, req)
	return rec
}

const validBody = `{"x":10,"y":20,"color":"#ff0000"}`

// utilisateurConnecte simule Discord : le jeton appartient à l'utilisateur u42.
func utilisateurConnecte(t *testing.T) {
	t.Helper()
	fauxDiscord(t, http.StatusOK, `{"id":"u42"}`)
}

func TestHandle(t *testing.T) {
	utilisateurConnecte(t)
	published := 0
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
		published++
		return nil
	}
	t.Cleanup(func() { publish = publishDraw })

	tests := []struct {
		name          string
		method        string
		body          string
		wantStatus    int
		wantPublished int
	}{
		{"valide", http.MethodPost, validBody, http.StatusAccepted, 1},
		{"GET refusé", http.MethodGet, "", http.StatusMethodNotAllowed, 0},
		{"JSON invalide", http.MethodPost, `{pas du json`, http.StatusBadRequest, 0},
		{"hors grille", http.MethodPost, `{"x":99999,"y":0,"color":"#ff0000"}`, http.StatusBadRequest, 0},
		{"x absent", http.MethodPost, `{"y":0,"color":"#ff0000"}`, http.StatusBadRequest, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			published = 0
			rec := do(tc.method, tc.body, "")
			if rec.Code != tc.wantStatus {
				t.Errorf("statut = %d, attendu %d", rec.Code, tc.wantStatus)
			}
			if published != tc.wantPublished {
				t.Errorf("publications = %d, attendu %d", published, tc.wantPublished)
			}
		})
	}
}

// Sans identité vérifiée par Discord, rien ne doit être publié : le statut dit pourquoi.
func TestAuthentification(t *testing.T) {
	tests := []struct {
		name          string
		authorization string
		discordStatus int
		wantStatus    int
		wantDiscord   bool // Discord doit-il avoir été interrogé ?
	}{
		{"sans jeton", "", http.StatusOK, http.StatusUnauthorized, false},
		{"jeton mal formé", "Basic abc", http.StatusOK, http.StatusUnauthorized, false},
		{"jeton refusé par Discord", "Bearer faux", http.StatusUnauthorized, http.StatusUnauthorized, true},
		{"Discord en panne", "Bearer ok", http.StatusInternalServerError, http.StatusServiceUnavailable, true},
		{"jeton valide", "Bearer ok", http.StatusOK, http.StatusAccepted, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			recu := fauxDiscord(t, tc.discordStatus, `{"id":"u42"}`)
			published := 0
			publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
				published++
				return nil
			}
			t.Cleanup(func() { publish = publishDraw })

			rec := doAs(http.MethodPost, validBody, "", tc.authorization)

			if rec.Code != tc.wantStatus {
				t.Errorf("statut = %d, attendu %d (corps : %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if interroge := recu.URL != nil; interroge != tc.wantDiscord {
				t.Errorf("Discord interrogé = %v, attendu %v", interroge, tc.wantDiscord)
			}
			if tc.wantStatus != http.StatusAccepted && published != 0 {
				t.Errorf("publications = %d : rien ne doit être publié sans authentification", published)
			}
		})
	}
}

// Le test le plus important : on ne peut pas dessiner au nom d'un autre.
func TestUserIDVientDeDiscord(t *testing.T) {
	utilisateurConnecte(t) // le jeton appartient à u42

	var got drawEvent
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
		got = evt
		return nil
	}
	t.Cleanup(func() { publish = publishDraw })

	body := `{"x":10,"y":20,"color":"#ff0000","user_id":"imposteur"}`
	if rec := do(http.MethodPost, body, ""); rec.Code != http.StatusAccepted {
		t.Fatalf("statut = %d, attendu 202", rec.Code)
	}
	if got.UserID != "u42" {
		t.Errorf("user_id publié = %q, attendu u42 (celui de Discord, pas celui du corps)", got.UserID)
	}
}

// Le message est le contrat avec le worker : ses champs ne doivent pas changer sans prévenir.
func TestContratDuMessage(t *testing.T) {
	data, err := json.Marshal(drawEvent{X: 10, Y: 20, Color: "#ff0000", UserID: "u42"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"x":10,"y":20,"color":"#ff0000","user_id":"u42"}`
	if string(data) != want {
		t.Errorf("message = %s, attendu %s", data, want)
	}
}

func TestCorrelationIDPropage(t *testing.T) {
	utilisateurConnecte(t)
	var got string
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
		got = correlationID
		return nil
	}
	t.Cleanup(func() { publish = publishDraw })

	rec := do(http.MethodPost, validBody, "abc")
	if h := rec.Header().Get("X-Correlation-Id"); h != "abc" {
		t.Errorf("header X-Correlation-Id = %q, attendu abc", h)
	}
	if got != "abc" {
		t.Errorf("correlation_id publié = %q, attendu abc", got)
	}
}

func TestCorrelationIDGenere(t *testing.T) {
	utilisateurConnecte(t)
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error { return nil }
	t.Cleanup(func() { publish = publishDraw })

	rec := do(http.MethodPost, validBody, "")
	if rec.Header().Get("X-Correlation-Id") == "" {
		t.Error("un correlation_id aurait dû être généré")
	}
}

func TestEchecPublication(t *testing.T) {
	utilisateurConnecte(t)
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
		return errors.New("pubsub injoignable")
	}
	t.Cleanup(func() { publish = publishDraw })

	rec := do(http.MethodPost, validBody, "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("statut = %d, attendu 503 (jamais un faux 202)", rec.Code)
	}
}
