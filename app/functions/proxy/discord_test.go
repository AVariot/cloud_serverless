package proxy

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testTimestamp = "1700000000"

// newKey génère une paire de clés et configure la clé publique comme le ferait Secret Manager.
func newKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("DISCORD_PUBLIC_KEY", hex.EncodeToString(pub))
	return priv
}

// signedRequest signe horodatage + corps, comme Discord.
func signedRequest(priv ed25519.PrivateKey, body string) *http.Request {
	sig := ed25519.Sign(priv, append([]byte(testTimestamp), body...))
	req := httptest.NewRequest(http.MethodPost, "/discord", strings.NewReader(body))
	req.Header.Set("X-Signature-Timestamp", testTimestamp)
	req.Header.Set("X-Signature-Ed25519", hex.EncodeToString(sig))
	return req
}

func serve(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handleDiscord(rec, req)
	return rec
}

// adminCommand : une commande qui passe par discord-command (draw a son propre chemin, testé plus bas).
const adminCommand = `{
	"id": "i1", "application_id": "app1", "type": 2, "token": "tok",
	"guild_id": "g1", "channel_id": "c1",
	"data": {"name": "admin", "options": [{"name":"x","type":4,"value":10},{"name":"y","type":4,"value":20}]},
	"member": {"user": {"id": "u42"}, "roles": ["r1", "r2"]}
}`

func TestDiscordPing(t *testing.T) {
	priv := newKey(t)
	rec := serve(signedRequest(priv, `{"type":1}`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"type":1`) {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDiscordSignatureRefusee(t *testing.T) {
	priv := newKey(t)

	t.Run("signature fausse", func(t *testing.T) {
		req := signedRequest(priv, `{"type":1}`)
		req.Header.Set("X-Signature-Ed25519", strings.Repeat("00", ed25519.SignatureSize))
		if rec := serve(req); rec.Code != http.StatusUnauthorized {
			t.Errorf("code=%d, attendu 401", rec.Code)
		}
	})

	t.Run("corps modifié après signature", func(t *testing.T) {
		req := signedRequest(priv, `{"type":1}`)
		tampered := httptest.NewRequest(http.MethodPost, "/discord", strings.NewReader(`{"type":2}`))
		tampered.Header = req.Header
		if rec := serve(tampered); rec.Code != http.StatusUnauthorized {
			t.Errorf("code=%d, attendu 401", rec.Code)
		}
	})

	t.Run("en-têtes absents", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/discord", strings.NewReader(`{"type":1}`))
		if rec := serve(req); rec.Code != http.StatusUnauthorized {
			t.Errorf("code=%d, attendu 401", rec.Code)
		}
	})

	t.Run("clé publique non configurée", func(t *testing.T) {
		req := signedRequest(priv, `{"type":1}`)
		t.Setenv("DISCORD_PUBLIC_KEY", "")
		if rec := serve(req); rec.Code != http.StatusUnauthorized {
			t.Errorf("code=%d, attendu 401", rec.Code)
		}
	})
}

func TestDiscordMethodeRefusee(t *testing.T) {
	rec := serve(httptest.NewRequest(http.MethodGet, "/discord", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("code=%d, attendu 405", rec.Code)
	}
}

func TestDiscordCommandePubliee(t *testing.T) {
	priv := newKey(t)

	var got discordCommand
	var gotCorrelation string
	calls := 0
	publishDiscord = func(ctx context.Context, cmd discordCommand, eventID, correlationID string) error {
		calls++
		got, gotCorrelation = cmd, correlationID
		return nil
	}
	t.Cleanup(func() { publishDiscord = publishCommand })

	rec := serve(signedRequest(priv, adminCommand))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"type":5`) {
		t.Fatalf("code=%d body=%s, attendu l'accusé différé (type 5)", rec.Code, rec.Body.String())
	}
	if calls != 1 {
		t.Fatalf("publications = %d, attendu 1", calls)
	}
	if got.Command != "admin" || got.UserID != "u42" || got.Token != "tok" || got.InteractionID != "i1" {
		t.Errorf("événement inattendu : %+v", got)
	}
	if len(got.Roles) != 2 || got.Roles[0] != "r1" {
		t.Errorf("rôles = %v, attendu [r1 r2]", got.Roles)
	}
	if !strings.Contains(string(got.Options), `"name":"x"`) {
		t.Errorf("options perdues : %s", got.Options)
	}
	if gotCorrelation == "" || rec.Header().Get("X-Correlation-Id") != gotCorrelation {
		t.Errorf("correlation_id : publié=%q, en-tête=%q", gotCorrelation, rec.Header().Get("X-Correlation-Id"))
	}
}

func TestDiscordCommandeEnMessagePrive(t *testing.T) {
	priv := newKey(t)

	var got discordCommand
	publishDiscord = func(ctx context.Context, cmd discordCommand, eventID, correlationID string) error {
		got = cmd
		return nil
	}
	t.Cleanup(func() { publishDiscord = publishCommand })

	body := `{"id":"i2","application_id":"app1","type":2,"token":"tok","data":{"name":"get"},"user":{"id":"u7"}}`
	if rec := serve(signedRequest(priv, body)); rec.Code != http.StatusOK {
		t.Fatalf("code=%d", rec.Code)
	}
	if got.UserID != "u7" || got.Command != "get" {
		t.Errorf("événement inattendu : %+v", got)
	}
}

func TestDiscordCommandeIncomplete(t *testing.T) {
	priv := newKey(t)
	calls := 0
	publishDiscord = func(ctx context.Context, cmd discordCommand, eventID, correlationID string) error {
		calls++
		return nil
	}
	t.Cleanup(func() { publishDiscord = publishCommand })

	for name, body := range map[string]string{
		"sans utilisateur": `{"type":2,"data":{"name":"draw"}}`,
		"sans commande":    `{"type":2,"member":{"user":{"id":"u1"}},"data":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if rec := serve(signedRequest(priv, body)); rec.Code != http.StatusBadRequest {
				t.Errorf("code=%d, attendu 400", rec.Code)
			}
		})
	}
	if calls != 0 {
		t.Errorf("publications = %d, attendu 0", calls)
	}
}

func TestDiscordEchecPublication(t *testing.T) {
	priv := newKey(t)
	publishDiscord = func(ctx context.Context, cmd discordCommand, eventID, correlationID string) error {
		return errors.New("pubsub injoignable")
	}
	t.Cleanup(func() { publishDiscord = publishCommand })

	rec := serve(signedRequest(priv, adminCommand))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("code=%d, attendu 503 (jamais un faux accusé)", rec.Code)
	}
}

func TestDiscordTypeNonGere(t *testing.T) {
	priv := newKey(t)
	if rec := serve(signedRequest(priv, `{"type":3}`)); rec.Code != http.StatusBadRequest {
		t.Errorf("code=%d, attendu 400", rec.Code)
	}
}

// drawBody construit une interaction /draw avec les options données (JSON brut).
func drawBody(options string) string {
	return `{"id":"i1","application_id":"app1","type":2,"token":"tok",
		"data":{"name":"draw","options":` + options + `},
		"member":{"user":{"id":"u42"},"roles":[]}}`
}

const validOptions = `[{"name":"x","type":4,"value":10},{"name":"y","type":4,"value":20},{"name":"color","type":4,"value":2}]`

// drawReply décode la réponse de type 4 : son contenu et si elle est privée (flags 64).
func drawReply(t *testing.T, body string) (content string, ephemeral bool, typ int) {
	t.Helper()
	var r struct {
		Type int `json:"type"`
		Data struct {
			Content string `json:"content"`
			Flags   int    `json:"flags"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		t.Fatalf("réponse illisible : %s", body)
	}
	return r.Data.Content, r.Data.Flags == 64, r.Type
}

func TestDiscordDrawPublieSurLeTopicDesPixels(t *testing.T) {
	priv := newKey(t)

	var got drawEvent
	calls := 0
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
		calls++
		got = evt
		return nil
	}
	t.Cleanup(func() { publish = publishDraw })
	// draw ne doit jamais passer par discord-command
	publishDiscord = func(ctx context.Context, cmd discordCommand, eventID, correlationID string) error {
		t.Error("draw ne doit pas être publié sur discord-command")
		return nil
	}
	t.Cleanup(func() { publishDiscord = publishCommand })

	rec := serve(signedRequest(priv, drawBody(validOptions)))
	content, ephemeral, typ := drawReply(t, rec.Body.String())

	if rec.Code != http.StatusOK || typ != 4 || ephemeral {
		t.Fatalf("code=%d type=%d privé=%v, attendu une réponse directe publique (type 4)", rec.Code, typ, ephemeral)
	}
	if !strings.Contains(content, "10") || !strings.Contains(content, "20") {
		t.Errorf("la réponse devrait rappeler les coordonnées : %q", content)
	}
	if calls != 1 || got != (drawEvent{X: 10, Y: 20, Color: 2, UserID: "u42"}) {
		t.Errorf("publications=%d, événement=%+v", calls, got)
	}
}

// Le user_id vient de la requête signée par Discord, jamais des options.
func TestDiscordDrawUserIDVientDeLaSignature(t *testing.T) {
	priv := newKey(t)

	var got drawEvent
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
		got = evt
		return nil
	}
	t.Cleanup(func() { publish = publishDraw })

	options := `[{"name":"x","type":4,"value":1},{"name":"y","type":4,"value":1},{"name":"color","type":4,"value":3},{"name":"user_id","type":3,"value":"imposteur"}]`
	serve(signedRequest(priv, drawBody(options)))

	if got.UserID != "u42" {
		t.Errorf("user_id = %q, attendu u42 (celui de la signature)", got.UserID)
	}
}

func TestDiscordDrawRefuse(t *testing.T) {
	priv := newKey(t)

	tests := map[string]string{
		"x hors grille":        `[{"name":"x","type":4,"value":10000},{"name":"y","type":4,"value":0},{"name":"color","type":4,"value":2}]`,
		"y négatif":            `[{"name":"x","type":4,"value":0},{"name":"y","type":4,"value":-1},{"name":"color","type":4,"value":2}]`,
		"couleur hors palette": `[{"name":"x","type":4,"value":1},{"name":"y","type":4,"value":1},{"name":"color","type":4,"value":99}]`,
		"couleur 0 (vide)":     `[{"name":"x","type":4,"value":1},{"name":"y","type":4,"value":1},{"name":"color","type":4,"value":0}]`,
		"couleur en texte":     `[{"name":"x","type":4,"value":1},{"name":"y","type":4,"value":1},{"name":"color","type":3,"value":"rouge"}]`,
		"x absent":             `[{"name":"y","type":4,"value":1},{"name":"color","type":4,"value":2}]`,
		"couleur absente":      `[{"name":"x","type":4,"value":1},{"name":"y","type":4,"value":1}]`,
		"aucune option":        `[]`,
		"x pas un entier":      `[{"name":"x","type":3,"value":"abc"},{"name":"y","type":4,"value":1},{"name":"color","type":4,"value":2}]`,
		"options cassées":      `"pas un tableau"`,
	}
	for name, options := range tests {
		t.Run(name, func(t *testing.T) {
			calls := 0
			publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
				calls++
				return nil
			}
			t.Cleanup(func() { publish = publishDraw })

			rec := serve(signedRequest(priv, drawBody(options)))
			content, ephemeral, typ := drawReply(t, rec.Body.String())

			// Un statut d'erreur s'afficherait « L'application ne répond plus » : on répond 200 avec un message privé.
			if rec.Code != http.StatusOK || typ != 4 || !ephemeral || content == "" {
				t.Errorf("code=%d type=%d privé=%v contenu=%q, attendu un message d'erreur privé", rec.Code, typ, ephemeral, content)
			}
			if calls != 0 {
				t.Errorf("publications = %d, attendu 0", calls)
			}
		})
	}
}

func TestDiscordDrawEchecPublication(t *testing.T) {
	priv := newKey(t)
	publish = func(ctx context.Context, evt drawEvent, eventID, correlationID string) error {
		return errors.New("pubsub injoignable")
	}
	t.Cleanup(func() { publish = publishDraw })

	rec := serve(signedRequest(priv, drawBody(validOptions)))
	content, ephemeral, typ := drawReply(t, rec.Body.String())

	if typ != 4 || !ephemeral || strings.Contains(content, "Pixel envoyé") {
		t.Errorf("type=%d privé=%v contenu=%q : jamais un faux « pixel envoyé »", typ, ephemeral, content)
	}
}
