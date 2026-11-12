package proxy

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
	tests := []struct {
		name string
		id   int
		want bool
	}{
		{"première couleur", 1, true},
		{"dernière couleur", 3, true},
		{"0 est réservé à « vide »", 0, false},
		{"numéro absent de la palette", 4, false},
		{"négatif", -1, false},
		{"au-delà d'un octet", 256, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := validColor(tc.id); got != tc.want {
				t.Errorf("validColor(%d) = %v, attendu %v", tc.id, got, tc.want)
			}
		})
	}
}

// Une palette absente ou cassée ferme tout dessin : mieux vaut refuser que d'accepter n'importe quel numéro.
func TestPaletteInutilisableRefuseTout(t *testing.T) {
	for name, value := range map[string]string{
		"absente":           "",
		"JSON cassé":        `{pas du json`,
		"vide":              `{"colors":[]}`,
		"numéro 0":          `{"colors":[{"id":0,"name":"Vide"}]}`,
		"numéro trop grand": `{"colors":[{"id":256,"name":"X"}]}`,
		"numéro en double":  `{"colors":[{"id":1,"name":"A"},{"id":1,"name":"B"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("PALETTE_JSON", value)
			if validColor(1) {
				t.Error("aucune couleur ne doit être acceptée avec une palette inutilisable")
			}
		})
	}
}

func TestColorName(t *testing.T) {
	if got := colorName(2); got != "Rouge" {
		t.Errorf("colorName(2) = %q, attendu Rouge", got)
	}
	if got := colorName(99); got != "couleur 99" {
		t.Errorf("colorName(99) = %q, attendu le numéro en repli", got)
	}
}
