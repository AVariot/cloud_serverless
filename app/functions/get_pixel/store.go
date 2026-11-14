package getpixel

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var (
	clientOnce sync.Once
	client     *firestore.Client
	clientErr  error
)

// getClient crée le client au premier appel, puis le réutilise (instance chaude).
func getClient() (*firestore.Client, error) {
	clientOnce.Do(func() {
		// context.Background : le client doit survivre à la requête qui le crée.
		client, clientErr = firestore.NewClient(context.Background(), os.Getenv("GCP_PROJECT"))
	})
	return client, clientErr
}

// loadFirestore lit pixels/{x}_{y}. found vaut false si la case n'a jamais été dessinée.
func loadFirestore(ctx context.Context, x, y int) (pixelData, bool, error) {
	c, err := getClient()
	if err != nil {
		return pixelData{}, false, fmt.Errorf("client firestore: %w", err)
	}
	snap, err := c.Collection("pixels").Doc(fmt.Sprintf("%d_%d", x, y)).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return pixelData{}, false, nil
	}
	if err != nil {
		return pixelData{}, false, err
	}

	// Champs de draw-pixel : color est un entier, les autres des chaînes / une date
	var doc struct {
		X         int       `firestore:"x"`
		Y         int       `firestore:"y"`
		Color     int       `firestore:"color"`
		UserID    string    `firestore:"user_id"`
		Chunk     string    `firestore:"chunk"`
		UpdatedAt time.Time `firestore:"updated_at"`
	}
	if err := snap.DataTo(&doc); err != nil {
		return pixelData{}, false, fmt.Errorf("document illisible: %w", err)
	}
	return pixelData{X: doc.X, Y: doc.Y, Color: doc.Color, UserID: doc.UserID, Chunk: doc.Chunk, UpdatedAt: doc.UpdatedAt}, true, nil
}
