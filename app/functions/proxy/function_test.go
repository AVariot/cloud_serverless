package proxy

import (
	"context"
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
		{"valide", drawRequest{X: intPtr(10), Y: intPtr(20), Color: "#ff0000", UserID: "u1"}, false},
		{"coin haut-gauche", drawRequest{X: intPtr(0), Y: intPtr(0), Color: "#000000", UserID: "u1"}, false},
		{"coin bas-droit", drawRequest{X: intPtr(9999), Y: intPtr(9999), Color: "#FFFFFF", UserID: "u1"}, false},
		{"x absent", drawRequest{Y: intPtr(1), Color: "#ff0000", UserID: "u1"}, true},
		{"y absent", drawRequest{X: intPtr(1), Color: "#ff0000", UserID: "u1"}, true},
		{"x négatif", drawRequest{X: intPtr(-1), Y: intPtr(1), Color: "#ff0000", UserID: "u1"}, true},
		{"x hors grille", drawRequest{X: intPtr(10000), Y: intPtr(1), Color: "#ff0000", UserID: "u1"}, true},
		{"y hors grille", drawRequest{X: intPtr(1), Y: intPtr(10000), Color: "#ff0000", UserID: "u1"}, true},
		{"couleur sans #", drawRequest{X: intPtr(1), Y: intPtr(1), Color: "ff0000", UserID: "u1"}, true},
		{"couleur en toutes lettres", drawRequest{X: intPtr(1), Y: intPtr(1), Color: "rouge", UserID: "u1"}, true},
		{"couleur à 3 chiffres", drawRequest{X: intPtr(1), Y: intPtr(1), Color: "#f00", UserID: "u1"}, true},
		{"user_id vide", drawRequest{X: intPtr(1), Y: intPtr(1), Color: "#ff0000", UserID: ""}, true},
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

// do envoie une requête au handler sans réseau et renvoie la réponse.
func do(method, body, correlationID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	if correlationID != "" {
		req.Header.Set("X-Correlation-Id", correlationID)
	}
	rec := httptest.NewRecorder()
	handle(rec, req)
	return rec
}

const validBody = `{"x":10,"y":20,"color":"#ff0000","user_id":"u1"}`

func TestHandle(t *testing.T) {
	published := 0
	publish = func(ctx context.Context, req drawRequest, eventID, correlationID string) error {
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
		{"hors grille", http.MethodPost, `{"x":99999,"y":0,"color":"#ff0000","user_id":"u1"}`, http.StatusBadRequest, 0},
		{"x absent", http.MethodPost, `{"y":0,"color":"#ff0000","user_id":"u1"}`, http.StatusBadRequest, 0},
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

func TestCorrelationIDPropage(t *testing.T) {
	var got string
	publish = func(ctx context.Context, req drawRequest, eventID, correlationID string) error {
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
	publish = func(ctx context.Context, req drawRequest, eventID, correlationID string) error { return nil }
	t.Cleanup(func() { publish = publishDraw })

	rec := do(http.MethodPost, validBody, "")
	if rec.Header().Get("X-Correlation-Id") == "" {
		t.Error("un correlation_id aurait dû être généré")
	}
}

func TestEchecPublication(t *testing.T) {
	publish = func(ctx context.Context, req drawRequest, eventID, correlationID string) error {
		return errors.New("pubsub injoignable")
	}
	t.Cleanup(func() { publish = publishDraw })

	rec := do(http.MethodPost, validBody, "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("statut = %d, attendu 503 (jamais un faux 202)", rec.Code)
	}
}
