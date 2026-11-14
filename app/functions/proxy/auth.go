package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

var discordAPI = "https://discord.com/api/v10"

var discordClient = &http.Client{Timeout: 2 * time.Second}

var errUnauthorized = errors.New("jeton Discord invalide")

func discordUserID(ctx context.Context, token string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, discordAPI+"/users/@me", nil)

	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := discordClient.Do(req)

	if err != nil {
		return "", fmt.Errorf("discord injoignable: %w", err)
	}

	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return "", errUnauthorized
	default:
		return "", fmt.Errorf("discord: statut %d", resp.StatusCode)
	}

	var user struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil || user.ID == "" {
		return "", errors.New("réponse Discord illisible")
	}
	return user.ID, nil
}
