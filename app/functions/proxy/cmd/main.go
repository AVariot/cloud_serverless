package main

import (
	"log"
	"os"

	_ "github.com/AVariot/cloud_serverless/app/functions/proxy"
	"github.com/GoogleCloudPlatform/functions-framework-go/funcframework"
)

func main() {
	port := "8080"
	if p := os.Getenv("PORT"); p != "" {
		port = p
	}
	if err := funcframework.Start(port); err != nil {
		log.Fatalf("funcframework.Start: %v", err)
	}
}
