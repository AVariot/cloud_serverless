package drawpixel

import (
	"os"
	"testing"
)

// testPalette : trois couleurs suffisent. Le numéro 0 (« vide ») n'y est jamais.
const testPalette = `{"colors":[{"id":1,"name":"Blanc"},{"id":2,"name":"Rouge"},{"id":3,"name":"Bleu"}]}`

func TestMain(m *testing.M) {
	os.Setenv("PALETTE_JSON", testPalette)
	os.Exit(m.Run())
}

func TestValidColor(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   int
		want bool
	}{
		{"première couleur", 1, true},
		{"dernière couleur", 3, true},
		{"0 est réservé à « vide »", 0, false},
		{"numéro absent de la palette", 4, false},
		{"au-delà d'un octet", 256, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validColor(tc.id); got != tc.want {
				t.Errorf("validColor(%d) = %v, attendu %v", tc.id, got, tc.want)
			}
		})
	}
}

func TestPaletteInutilisableRefuseTout(t *testing.T) {
	for name, value := range map[string]string{"absente": "", "JSON cassé": `{pas du json`, "vide": `{"colors":[]}`} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("PALETTE_JSON", value)
			if validColor(1) {
				t.Error("aucune couleur ne doit être acceptée avec une palette inutilisable")
			}
		})
	}
}
