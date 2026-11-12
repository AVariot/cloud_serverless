package getpixel

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// La palette (numéro -> nom) est dans config/palette.json, commune au back et au front ;
// Terraform la passe dans PALETTE_JSON. Ici on ne s'en sert que pour nommer une couleur.
type paletteColor struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type palette struct {
	Colors []paletteColor `json:"colors"`
}

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
		colors[c.ID] = c.Name
	}
	return colors, nil
}

// colorName donne le nom d'une couleur ; 0 est « vide ». Une palette illisible ne casse pas la lecture :
// le numéro, lui, est toujours renvoyé, seul le nom se dégrade.
func colorName(id int) string {
	if id == 0 {
		return "vide"
	}
	if colors, err := loadPalette(); err == nil {
		if name, ok := colors[id]; ok {
			return name
		}
	} else {
		logger.Warn("palette inutilisable", "error", err.Error())
	}
	return fmt.Sprintf("couleur %d", id)
}
