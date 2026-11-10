package proxy

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
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

const drawCommand = `{
	"id": "i1", "application_id": "app1", "type": 2, "token": "tok",
	"guild_id": "g1", "channel_id": "c1",
	"data": {"name": "draw", "options": [{"name":"x","type":4,"value":10},{"name":"y","type":4,"value":20}]},
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

	rec := serve(signedRequest(priv, drawCommand))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"type":5`) {
		t.Fatalf("code=%d body=%s, attendu l'accusé différé (type 5)", rec.Code, rec.Body.String())
	}
	if calls != 1 {
		t.Fatalf("publications = %d, attendu 1", calls)
	}
	if got.Command != "draw" || got.UserID != "u42" || got.Token != "tok" || got.InteractionID != "i1" {
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

	rec := serve(signedRequest(priv, drawCommand))
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
