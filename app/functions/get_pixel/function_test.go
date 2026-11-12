package getpixel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// Les tests fixent leur propre palette, indépendante de config/palette.json
	_ = os.Setenv("PALETTE_JSON", `{"colors":[{"id":1,"name":"rouge"},{"id":2,"name":"bleu"}]}`)
	_ = os.Setenv("ALLOWED_ORIGINS", "http://localhost:3000")
	os.Exit(m.Run())
}

func stubLoad(t *testing.T, px pixelData, found bool, err error) {
	t.Helper()
	old := load
	load = func(context.Context, int, int) (pixelData, bool, error) { return px, found, err }
	t.Cleanup(func() { load = old })
}

func get(target string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handle(rec, req)
	return rec
}

func TestPixelExistant(t *testing.T) {
	at := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	stubLoad(t, pixelData{X: 3, Y: 4, Color: 2, UserID: "42", Chunk: "0_0", UpdatedAt: at}, true, nil)

	rec := get("/pixel?x=3&y=4", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got pixelResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Color != 2 || got.ColorName != "bleu" || got.Empty || got.UserID != "42" || got.Chunk != "0_0" || got.UpdatedAt == nil || !got.UpdatedAt.Equal(at) {
		t.Fatalf("réponse inattendue : %+v", got)
	}
}

func TestPixelVide(t *testing.T) {
	stubLoad(t, pixelData{}, false, nil)

	rec := get("/pixel?x=9&y=9", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got pixelResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Empty || got.Color != 0 || got.ColorName != "vide" || got.UserID != "" || got.UpdatedAt != nil {
		t.Fatalf("réponse inattendue : %+v", got)
	}
}

func TestCoordonneesInvalides(t *testing.T) {
	stubLoad(t, pixelData{}, false, nil)
	for _, target := range []string{
		"/pixel", "/pixel?x=1", "/pixel?y=1", "/pixel?x=a&y=1", "/pixel?x=1.5&y=1",
		"/pixel?x=-1&y=0", "/pixel?x=0&y=10000", "/pixel?x=10000&y=0", "/pixel?x=3abc&y=1",
	} {
		if rec := get(target, nil); rec.Code != http.StatusBadRequest {
			t.Errorf("%s : code = %d, attendu 400", target, rec.Code)
		}
	}
}

func TestLimitesAcceptees(t *testing.T) {
	stubLoad(t, pixelData{}, false, nil)
	for _, target := range []string{"/pixel?x=0&y=0", "/pixel?x=9999&y=9999"} {
		if rec := get(target, nil); rec.Code != http.StatusOK {
			t.Errorf("%s : code = %d, attendu 200", target, rec.Code)
		}
	}
}

func TestPanneBase(t *testing.T) {
	stubLoad(t, pixelData{}, false, errors.New("boom"))
	if rec := get("/pixel?x=1&y=1", nil); rec.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, attendu 500", rec.Code)
	}
}

func TestMethodeRefusee(t *testing.T) {
	rec := httptest.NewRecorder()
	handle(rec, httptest.NewRequest(http.MethodPost, "/pixel?x=1&y=1", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("code = %d, attendu 405", rec.Code)
	}
}

func TestCORS(t *testing.T) {
	stubLoad(t, pixelData{}, false, nil)

	// origine autorisée : l'en-tête est présent, aussi sur une erreur
	rec := get("/pixel?x=zz&y=1", map[string]string{"Origin": "http://localhost:3000"})
	if rec.Code != http.StatusBadRequest || rec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatalf("CORS absent sur erreur : code %d, en-têtes %v", rec.Code, rec.Header())
	}
	// origine inconnue : pas d'en-tête
	rec = get("/pixel?x=1&y=1", map[string]string{"Origin": "http://autre.example"})
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("origine inconnue acceptée")
	}
}

func TestPreflight(t *testing.T) {
	pre := func(origin string) int {
		req := httptest.NewRequest(http.MethodOptions, "/pixel", nil)
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		handle(rec, req)
		return rec.Code
	}
	if c := pre("http://localhost:3000"); c != http.StatusNoContent {
		t.Errorf("origine autorisée : %d, attendu 204", c)
	}
	if c := pre("http://autre.example"); c != http.StatusForbidden {
		t.Errorf("origine inconnue : %d, attendu 403", c)
	}
}
