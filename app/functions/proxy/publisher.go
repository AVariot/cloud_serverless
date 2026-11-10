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
	clientOnce sync.Once
	client     *pubsub.Client
	clientErr  error

	publishersMu sync.Mutex
	publishers   = map[string]*pubsub.Publisher{}
)

// getPublisher crée le client au premier appel, puis garde un publisher par topic (instance chaude).
func getPublisher(topic string) (*pubsub.Publisher, error) {
	clientOnce.Do(func() {
		// context.Background : le client doit survivre à la requête qui le crée.
		client, clientErr = pubsub.NewClient(context.Background(), os.Getenv("GCP_PROJECT"))
	})
	if clientErr != nil {
		return nil, clientErr
	}

	publishersMu.Lock()
	defer publishersMu.Unlock()
	if p, ok := publishers[topic]; ok {
		return p, nil
	}
	p := client.Publisher(topic)
	publishers[topic] = p
	return p, nil
}

// publishMessage envoie un message sur un topic et attend l'accusé de Pub/Sub.
func publishMessage(ctx context.Context, topic string, data []byte, attrs map[string]string) error {
	pub, err := getPublisher(topic)
	if err != nil {
		return fmt.Errorf("client pubsub: %w", err)
	}
	res := pub.Publish(ctx, &pubsub.Message{Data: data, Attributes: attrs})
	_, err = res.Get(ctx)
	return err
}

// publishDraw envoie l'événement pixel.draw (chemin web).
func publishDraw(ctx context.Context, req drawRequest, eventID, correlationID string) error {
	data, err := json.Marshal(req)
	if err != nil {
		return err
	}
	return publishMessage(ctx, os.Getenv("TOPIC_NAME"), data, map[string]string{
		"type":           "pixel.draw",
		"event_id":       eventID,
		"correlation_id": correlationID,
	})
}

// publishCommand envoie l'événement discord.command (chemin Discord).
func publishCommand(ctx context.Context, cmd discordCommand, eventID, correlationID string) error {
	data, err := json.Marshal(cmd)
	if err != nil {
		return err
	}
	return publishMessage(ctx, os.Getenv("DISCORD_TOPIC_NAME"), data, map[string]string{
		"type":           "discord.command",
		"command":        cmd.Command,
		"event_id":       eventID,
		"correlation_id": correlationID,
	})
}

// publish et publishDiscord sont des variables pour que les tests remplacent la vraie publication.
var (
	publish        = publishDraw
	publishDiscord = publishCommand
)
