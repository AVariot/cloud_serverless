# messaging.tf

resource "google_project_service" "pubsub" {
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

# google_pubsub_topic = ressource type
resource "google_pubsub_topic" "pixel_events" {
  name                       = "pixel_events"
  message_retention_duration = "604800s"

  depends_on = [google_project_service.pubsub]
}
