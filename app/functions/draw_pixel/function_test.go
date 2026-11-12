package drawpixel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		evt     drawEvent
		wantErr bool
	}{
		{"valide", drawEvent{X: 10, Y: 20, Color: 2, UserID: "u42"}, false},
		{"coin haut-gauche", drawEvent{X: 0, Y: 0, Color: 1, UserID: "u42"}, false},
		{"coin bas-droit", drawEvent{X: 9999, Y: 9999, Color: 3, UserID: "u42"}, false},
		{"x négatif", drawEvent{X: -1, Y: 1, Color: 2, UserID: "u42"}, true},
		{"x hors grille", drawEvent{X: 10000, Y: 1, Color: 2, UserID: "u42"}, true},
		{"y négatif", drawEvent{X: 1, Y: -1, Color: 2, UserID: "u42"}, true},
		{"y hors grille", drawEvent{X: 1, Y: 10000, Color: 2, UserID: "u42"}, true},
		{"couleur 0 (vide)", drawEvent{X: 1, Y: 1, Color: 0, UserID: "u42"}, true},
		{"couleur hors palette", drawEvent{X: 1, Y: 1, Color: 4, UserID: "u42"}, true},
		{"couleur négative", drawEvent{X: 1, Y: 1, Color: -1, UserID: "u42"}, true},
		{"couleur au-delà d'un octet", drawEvent{X: 1, Y: 1, Color: 256, UserID: "u42"}, true},
		{"user_id vide", drawEvent{X: 1, Y: 1, Color: 2, UserID: ""}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := validate(tc.evt)
			if (got != "") != tc.wantErr {
				t.Errorf("validate() = %q, erreur attendue : %v", got, tc.wantErr)
			}
		})
	}
}

// envelope construit ce que Pub/Sub enverrait : data est encodé en base64 par json.Marshal.
func envelope(t *testing.T, data []byte, publishTime time.Time) string {
	t.Helper()
	var env pushEnvelope
	env.Message.Data = data
	env.Message.MessageID = "m1"
	env.Message.PublishTime = publishTime
	env.Message.Attributes = map[string]string{"correlation_id": "c1"}
	body, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func eventData(t *testing.T, evt drawEvent) []byte {
	t.Helper()
	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func send(method, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handle(rec, httptest.NewRequest(method, "/", strings.NewReader(body)))
	return rec
}

// fauxSave remplace l'écriture Firestore et compte les appels.
type fauxSave struct {
	calls int
	evt   drawEvent
	at    time.Time
}

func remplacerSave(t *testing.T, err error) *fauxSave {
	t.Helper()
	f := &fauxSave{}
	save = func(ctx context.Context, evt drawEvent, at time.Time) error {
		f.calls++
		f.evt, f.at = evt, at
		return err
	}
	t.Cleanup(func() { save = saveFirestore })
	return f
}

var validEvent = drawEvent{X: 10, Y: 20, Color: 2, UserID: "u42"}

func TestHandle(t *testing.T) {
	now := time.Date(2026, 11, 10, 14, 30, 0, 0, time.UTC)

	tests := []struct {
		name          string
		method        string
		body          string
		wantStatus    int
		wantPublished int
	}{
		{"valide", http.MethodPost, envelope(t, eventData(t, validEvent), now), http.StatusOK, 1},
		{"GET refusé", http.MethodGet, "", http.StatusMethodNotAllowed, 0},
		{"enveloppe cassée", http.MethodPost, `{pas du json`, http.StatusBadRequest, 0},
		{"data illisible", http.MethodPost, envelope(t, []byte(`{pas du json`), now), http.StatusBadRequest, 0},
		{"data vide", http.MethodPost, envelope(t, nil, now), http.StatusBadRequest, 0},
		{"hors grille", http.MethodPost, envelope(t, eventData(t, drawEvent{X: 99999, Y: 0, Color: 2, UserID: "u42"}), now), http.StatusBadRequest, 0},
		{"couleur invalide", http.MethodPost, envelope(t, eventData(t, drawEvent{X: 1, Y: 1, Color: 0, UserID: "u42"}), now), http.StatusBadRequest, 0},
		{"sans user_id", http.MethodPost, envelope(t, eventData(t, drawEvent{X: 1, Y: 1, Color: 2}), now), http.StatusBadRequest, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := remplacerSave(t, nil)
			rec := send(tc.method, tc.body)
			if rec.Code != tc.wantStatus {
				t.Errorf("statut = %d, attendu %d (corps : %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if f.calls != tc.wantPublished {
				t.Errorf("écritures = %d, attendu %d", f.calls, tc.wantPublished)
			}
		})
	}
}

// Ce qui est écrit doit être ce qui a été publié, avec l'heure de publication de Pub/Sub.
func TestSaveRecoitLeMessageEtSonHeure(t *testing.T) {
	f := remplacerSave(t, nil)
	publishedAt := time.Date(2026, 11, 10, 14, 30, 0, 0, time.UTC)

	if rec := send(http.MethodPost, envelope(t, eventData(t, validEvent), publishedAt)); rec.Code != http.StatusOK {
		t.Fatalf("statut = %d, attendu 200", rec.Code)
	}
	if f.evt != validEvent {
		t.Errorf("événement écrit = %+v, attendu %+v", f.evt, validEvent)
	}
	if !f.at.Equal(publishedAt) {
		t.Errorf("heure transmise = %v, attendu %v", f.at, publishedAt)
	}
}

// Une panne de la base est temporaire : 500, jamais un faux 200 qui perdrait le message.
func TestEchecEcriture(t *testing.T) {
	remplacerSave(t, errors.New("firestore injoignable"))

	rec := send(http.MethodPost, envelope(t, eventData(t, validEvent), time.Now()))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("statut = %d, attendu 500 (jamais un faux 200)", rec.Code)
	}
}

// Message définitivement inutilisable (400) et panne passagère (500) ne doivent pas se confondre :
// dans les deux cas Pub/Sub réessaie, mais seul le second peut réussir plus tard.
func TestStatutsDistincts(t *testing.T) {
	remplacerSave(t, errors.New("panne"))

	invalide := send(http.MethodPost, envelope(t, []byte(`{pas du json`), time.Now()))
	panne := send(http.MethodPost, envelope(t, eventData(t, validEvent), time.Now()))

	if invalide.Code != http.StatusBadRequest || panne.Code != http.StatusInternalServerError {
		t.Errorf("invalide=%d (attendu 400), panne=%d (attendu 500)", invalide.Code, panne.Code)
	}
}

// Le chunk est un contrat avec le front (500 × 500, origine 0_0 en haut à gauche) : ces valeurs ne doivent pas bouger sans prévenir.
func TestChunkID(t *testing.T) {
	tests := []struct {
		name string
		x, y int
		want string
	}{
		{"origine", 0, 0, "0_0"},
		{"dernier pixel du premier chunk", 499, 499, "0_0"},
		{"premier pixel du chunk suivant en x", 500, 0, "1_0"},
		{"premier pixel du chunk suivant en y", 0, 500, "0_1"},
		{"milieu", 1234, 4999, "2_9"},
		{"dernier pixel de la grille", 9999, 9999, "19_19"},
		{"pixel de test déjà en base", 10, 20, "0_0"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := chunkID(tc.x, tc.y); got != tc.want {
				t.Errorf("chunkID(%d, %d) = %q, attendu %q", tc.x, tc.y, got, tc.want)
			}
		})
	}
}

// Chaque coin de la grille doit tomber dans un des 20 × 20 chunks, sans en inventer un 21e.
func TestChunkIDResteDansLaGrille(t *testing.T) {
	seen := map[string]bool{}
	for x := 0; x < gridSize; x += chunkSize {
		for y := 0; y < gridSize; y += chunkSize {
			seen[chunkID(x, y)] = true
		}
	}
	if len(seen) != 400 {
		t.Errorf("chunks distincts = %d, attendu 400 (20 × 20)", len(seen))
	}
}

// Le message est le contrat avec les proxys : la couleur est un numéro, jamais une chaîne.
func TestContratDuMessage(t *testing.T) {
	var evt drawEvent
	if err := json.Unmarshal([]byte(`{"x":10,"y":20,"color":2,"user_id":"u42"}`), &evt); err != nil {
		t.Fatal(err)
	}
	if evt != (drawEvent{X: 10, Y: 20, Color: 2, UserID: "u42"}) {
		t.Errorf("événement lu = %+v", evt)
	}

	// L'ancien format (chaîne #RRGGBB) ne doit plus être accepté : il serait mal interprété.
	if err := json.Unmarshal([]byte(`{"x":10,"y":20,"color":"#ff0000","user_id":"u42"}`), &evt); err == nil {
		t.Error("une couleur en texte aurait dû être refusée")
	}
}
