package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"cloud.google.com/go/pubsub/v2"
)

var (
	publisherOnce sync.Once
	publisher     *pubsub.Publisher
	publisherErr  error
)

// getPublisher crée le client au premier appel puis le réutilise (instance chaude).
func getPublisher(ctx context.Context) (*pubsub.Publisher, error) {
	publisherOnce.Do(func() {
		client, err := pubsub.NewClient(ctx, os.Getenv("GCP_PROJECT"))
		if err != nil {
			publisherErr = err
			return
		}
		publisher = client.Publisher(os.Getenv("TOPIC_NAME"))
	})
	return publisher, publisherErr
}

// publishDraw envoie l'événement pixel.draw et attend l'accusé de Pub/Sub.
func publishDraw(ctx context.Context, req drawRequest, eventID, correlationID string) error {
	pub, err := getPublisher(ctx)
	if err != nil {
		return fmt.Errorf("client pubsub: %w", err)
	}
	data, err := json.Marshal(req)
	if err != nil {
		return err
	}
	res := pub.Publish(ctx, &pubsub.Message{
		Data: data,
		Attributes: map[string]string{
			"type":           "pixel.draw",
			"event_id":       eventID,
			"correlation_id": correlationID,
		},
	})
	_, err = res.Get(ctx)
	return err
}

// publish est une variable pour que les tests puissent remplacer la vraie publication.
var publish = publishDraw
