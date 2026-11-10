package drawpixel

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

// saveFirestore écrit le pixel dans pixels/{x}_{y}.
// Pub/Sub ne garantit pas l'ordre : on n'écrase le pixel que si le message est plus récent
// que celui déjà écrit. La lecture et l'écriture sont dans la même transaction, sinon
// deux messages simultanés pourraient lire l'ancienne valeur et le plus vieux gagnerait.
func saveFirestore(ctx context.Context, evt drawEvent, at time.Time) error {
	c, err := getClient()
	if err != nil {
		return fmt.Errorf("client firestore: %w", err)
	}
	ref := c.Collection("pixels").Doc(fmt.Sprintf("%d_%d", evt.X, evt.Y))

	return c.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		switch {
		case status.Code(err) == codes.NotFound:
			// premier pixel à cet endroit : on écrit
		case err != nil:
			return err
		default:
			// un message périmé n'est pas une erreur : il n'a simplement plus d'effet
			current, err := snap.DataAt("updated_at")
			if err == nil {
				if t, ok := current.(time.Time); ok && !t.Before(at) {
					return nil
				}
			}
		}
		return tx.Set(ref, map[string]any{
			"x":          evt.X,
			"y":          evt.Y,
			"color":      evt.Color,
			"user_id":    evt.UserID,
			"updated_at": at,
		})
	})
}
