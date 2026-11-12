package getpixel

// Lecture d'un pixel : GET /pixel?x=..&y=.. renvoie ce que contient la case.

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
)

const gridSize = 10000

// pixelData est le document Firestore pixels/{x}_{y}, tel que l'écrit draw-pixel.
type pixelData struct {
	X         int
	Y         int
	Color     int
	UserID    string
	Chunk     string
	UpdatedAt time.Time
}

// pixelResponse est la réponse JSON. Une case jamais dessinée est une réponse normale (200),
// pas une erreur : color vaut 0, comme dans la palette (0 = vide), et le reste est omis.
type pixelResponse struct {
	X         int        `json:"x"`
	Y         int        `json:"y"`
	Color     int        `json:"color"`
	ColorName string     `json:"color_name"`
	Empty     bool       `json:"empty"`
	UserID    string     `json:"user_id,omitempty"`
	Chunk     string     `json:"chunk,omitempty"`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
}

func init() {
	functions.HTTP("GetPixel", handle)
}

func handle(w http.ResponseWriter, r *http.Request) {
	// CORS d'abord : les erreurs doivent porter les en-têtes aussi (comme dans le proxy)
	setCORS(w, r)

	if r.Method == http.MethodOptions {
		handlePreflight(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodOptions)
		http.Error(w, "GET uniquement", http.StatusMethodNotAllowed)
		return
	}

	x, y, ok := parseCoords(r)
	if !ok {
		http.Error(w, "x et y doivent être des entiers entre 0 et 9999", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	px, found, err := load(ctx, x, y)
	if err != nil {
		logger.Error("lecture impossible", "x", x, "y", y, "error", err.Error())
		http.Error(w, "lecture impossible", http.StatusInternalServerError)
		return
	}

	resp := pixelResponse{X: x, Y: y, Empty: !found, ColorName: colorName(0)}
	if found {
		resp.Color = px.Color
		resp.ColorName = colorName(px.Color)
		resp.UserID = px.UserID
		resp.Chunk = px.Chunk
		resp.UpdatedAt = &px.UpdatedAt
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store") // un pixel change à tout moment
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		logger.Warn("réponse non écrite", "error", err.Error())
	}
}

// parseCoords lit x et y dans l'URL. Strict : « 3abc », « 3.5 » ou un paramètre absent sont refusés.
func parseCoords(r *http.Request) (x, y int, ok bool) {
	q := r.URL.Query()
	x, errX := strconv.Atoi(q.Get("x"))
	y, errY := strconv.Atoi(q.Get("y"))
	if errX != nil || errY != nil {
		return 0, 0, false
	}
	if x < 0 || x >= gridSize || y < 0 || y >= gridSize {
		return 0, 0, false
	}
	return x, y, true
}

// load est une variable pour que les tests remplacent la vraie lecture (comme "save" dans draw-pixel).
var load = loadFirestore
