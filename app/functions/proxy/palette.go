package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// Une couleur est un numéro de 1 à 255, sur un octet. 0 veut dire « pixel vide » : on ne le dessine pas.
// La palette (numéro -> nom, couleur) est dans config/palette.json, commun au back et au front.
// Terraform la lit et la passe dans PALETTE_JSON : le back ne garde que ce dont il a besoin ici
// (les numéros valides et leur nom), jamais de RGB.
type paletteColor struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type palette struct {
	Colors []paletteColor `json:"colors"`
}

// loadPalette lit PALETTE_JSON. Une palette absente ou mal formée est une erreur :
// on refuse alors tout dessin plutôt que d'accepter n'importe quel numéro.
func loadPalette() (map[int]string, error) {
	raw := os.Getenv("PALETTE_JSON")
	if raw == "" {
		return nil, errors.New("PALETTE_JSON absent")
	}
	var p palette
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return nil, fmt.Errorf("PALETTE_JSON illisible: %w", err)
	}
	colors := make(map[int]string, len(p.Colors))
	for _, c := range p.Colors {
		if c.ID < 1 || c.ID > 255 {
			return nil, fmt.Errorf("couleur %q : numéro %d hors de 1..255", c.Name, c.ID)
		}
		if _, dup := colors[c.ID]; dup {
			return nil, fmt.Errorf("numéro %d en double", c.ID)
		}
		colors[c.ID] = c.Name
	}
	if len(colors) == 0 {
		return nil, errors.New("palette vide")
	}
	return colors, nil
}

// validColor dit si le numéro existe dans la palette.
func validColor(id int) bool {
	colors, err := loadPalette()
	if err != nil {
		logger.Error("palette inutilisable", "error", err.Error())
		return false
	}
	_, ok := colors[id]
	return ok
}

// colorName donne le nom d'une couleur pour les messages ; à défaut, son numéro.
func colorName(id int) string {
	if colors, err := loadPalette(); err == nil {
		if name, ok := colors[id]; ok {
			return name
		}
	}
	return fmt.Sprintf("couleur %d", id)
}
