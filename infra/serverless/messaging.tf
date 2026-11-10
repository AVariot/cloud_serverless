# messaging.tf

resource "google_project_service" "pubsub" {
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

resource "google_pubsub_topic" "pixel_events" {
  name                       = "pixel-events"
  message_retention_duration = "604800s"

  depends_on = [google_project_service.pubsub]
}

resource "google_pubsub_topic" "pixel_events_dlq" {
  name                       = "pixel-events-dlq"
  message_retention_duration = "604800s"

  depends_on = [google_project_service.pubsub]
}

resource "google_pubsub_subscription" "pixel_events_dlq_hold" {
  name  = "pixel-events-dlq-hold"
  topic = google_pubsub_topic.pixel_events_dlq.id

  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription" "pixel_events_worker" {
  name  = "pixel-events-worker"
  topic = google_pubsub_topic.pixel_events.id

  ack_deadline_seconds       = 60
  retain_acked_messages      = true
  message_retention_duration = "604800s"

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.pixel_events_dlq.id
    max_delivery_attempts = 5
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_project_service_identity" "pubsub" {
  provider = google-beta
  service  = "pubsub.googleapis.com"

  depends_on = [google_project_service.pubsub]
}

resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  topic  = google_pubsub_topic.pixel_events_dlq.id
  role   = "roles/pubsub.publisher"
  member = google_project_service_identity.pubsub.member
}

resource "google_pubsub_subscription_iam_member" "worker_subscriber" {
  subscription = google_pubsub_subscription.pixel_events_worker.id
  role         = "roles/pubsub.subscriber"
  member       = google_project_service_identity.pubsub.member
}

resource "google_pubsub_topic" "discord_command" {
  name                       = "discord-command"
  message_retention_duration = "604800s"

  depends_on = [google_project_service.pubsub]
}

resource "google_pubsub_topic" "discord_command_dlq" {
  name                       = "discord-command-dlq"
  message_retention_duration = "604800s"

  depends_on = [google_project_service.pubsub]
}

resource "google_pubsub_subscription" "discord_command_dlq_hold" {
  name  = "discord-command-dlq-hold"
  topic = google_pubsub_topic.discord_command_dlq.id

  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription" "discord_command_worker" {
  name  = "discord-command-worker"
  topic = google_pubsub_topic.discord_command.id

  ack_deadline_seconds       = 60
  retain_acked_messages      = true
  message_retention_duration = "604800s"

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.discord_command_dlq.id
    max_delivery_attempts = 5
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_topic_iam_member" "discord_command_dlq_publisher" {
  topic  = google_pubsub_topic.discord_command_dlq.id
  role   = "roles/pubsub.publisher"
  member = google_project_service_identity.pubsub.member
}

resource "google_pubsub_subscription_iam_member" "discord_command_worker_subscriber" {
  subscription = google_pubsub_subscription.discord_command_worker.id
  role         = "roles/pubsub.subscriber"
  member       = google_project_service_identity.pubsub.member
}
