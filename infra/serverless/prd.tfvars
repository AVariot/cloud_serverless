project_id = "servtkt-cloudnative-prd"
region     = "europe-west1"

# Origines des fronts autorisées par CORS : l'adresse du front de production, à renseigner (jamais "*").
# Vide = aucun navigateur n'est autorisé à appeler l'API.
cors_allowed_origins = []

# Clé publique Discord (publique par nature). prd reprend celle de dev tant qu'aucune application Discord dédiée n'existe.
discord_public_key = "04d7fccf748aa62cc9207881b043b6d64bfc42c99171efcab034c68cfa3f78d9"
