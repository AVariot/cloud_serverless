#!/usr/bin/env bash
#
# Enregistre les commandes slash de l'application Discord.
#
# ATTENTION : l'API remplace TOUTE la liste des commandes (« bulk overwrite »).
# Une commande qui n'est pas dans ce script est supprimée de Discord.
#
# Usage :
#   APP_ID=<id> ./scripts/register_discord_commands.sh                    commandes globales (jusqu'à ~1 h pour apparaître)
#   APP_ID=<id> GUILD_ID=<id> ./scripts/register_discord_commands.sh      commandes d'un serveur (immédiat, pratique pour tester)
#   ./scripts/register_discord_commands.sh --dry-run                      affiche le JSON envoyé, sans rien envoyer
#
# Le jeton du bot est lu dans DISCORD_TOKEN, sinon il est demandé sans écho.
# Il n'est jamais affiché ni écrit sur disque, et il est passé à curl par l'entrée standard (absent de `ps`).

set -euo pipefail

DISCORD_API="${DISCORD_API:-https://discord.com/api/v10}"

# Types d'options Discord : 1 sous-commande, 3 texte, 4 entier, 6 utilisateur.
COMMANDS='[
  {
    "name": "ping",
    "description": "Teste que le bot répond (temporaire)"
  },
  {
    "name": "draw",
    "description": "Dessiner un pixel",
    "options": [
      {"type": 4, "name": "x", "description": "Colonne", "required": true, "min_value": 0, "max_value": 9999},
      {"type": 4, "name": "y", "description": "Ligne", "required": true, "min_value": 0, "max_value": 9999},
      {"type": 3, "name": "color", "description": "Couleur au format #RRGGBB", "required": true, "min_length": 7, "max_length": 7}
    ]
  },
  {
    "name": "get",
    "description": "Affiche la grille actuelle"
  },
  {
    "name": "snapshot",
    "description": "Génère une image de la grille et renvoie un lien temporaire"
  },
  {
    "name": "admin",
    "description": "Commandes d'\''administration",
    "options": [
      {"type": 1, "name": "pause", "description": "Met le dessin en pause"},
      {"type": 1, "name": "resume", "description": "Reprend le dessin"},
      {"type": 1, "name": "clear", "description": "Efface toute la grille"},
      {
        "type": 1,
        "name": "ratelimit",
        "description": "Fixe la limite de pixels par minute d'\''un utilisateur",
        "options": [
          {"type": 6, "name": "user", "description": "Utilisateur concerné", "required": true},
          {"type": 4, "name": "limit", "description": "Pixels par minute", "required": true, "min_value": 0}
        ]
      }
    ]
  }
]'

die() {
  printf 'Erreur : %s\n' "$*" >&2
  exit 1
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) die "option inconnue : $arg (voir --help)" ;;
  esac
done

# --- Couleurs : la liste des choix de /draw vient de config/palette.json (numéro -> nom) -------------
# Le back et le front partagent ce fichier : changer la palette change aussi la commande Discord.
PALETTE_FILE="${PALETTE_FILE:-$(dirname "$0")/../config/palette.json}"
command -v jq >/dev/null || die "jq est requis (il lit $PALETTE_FILE)"
[ -f "$PALETTE_FILE" ] || die "palette introuvable : $PALETTE_FILE"
choices="$(jq -c '[.colors[] | {name: .name, value: .id}]' "$PALETTE_FILE")" || die "palette illisible : $PALETTE_FILE"
count="$(jq 'length' <<<"$choices")"
{ [ "$count" -ge 1 ] && [ "$count" -le 25 ]; } || die "Discord accepte 1 à 25 choix par option ($count couleurs dans la palette)"
COMMANDS="$(jq -c --argjson choices "$choices" '
  map(if .name == "draw"
      then .options |= map(if .name == "color"
          then .type = 4 | .description = "Couleur de la palette" | del(.min_length, .max_length) | .choices = $choices
          else . end)
      else . end)' <<<"$COMMANDS")"

if [ "$DRY_RUN" = 1 ]; then
  printf '%s\n' "$COMMANDS"
  exit 0
fi

# --- Paramètres -------------------------------------------------------------
[ -n "${APP_ID:-}" ] || die "APP_ID manquant (portail Discord > General Information > Application ID)"
[[ "$APP_ID" =~ ^[0-9]+$ ]] || die "APP_ID doit être un nombre (reçu : $APP_ID)"
if [ -n "${GUILD_ID:-}" ]; then
  [[ "$GUILD_ID" =~ ^[0-9]+$ ]] || die "GUILD_ID doit être un nombre (reçu : $GUILD_ID)"
  url="$DISCORD_API/applications/$APP_ID/guilds/$GUILD_ID/commands"
  scope="du serveur $GUILD_ID"
else
  url="$DISCORD_API/applications/$APP_ID/commands"
  scope="globales"
fi

if [ -z "${DISCORD_TOKEN:-}" ]; then
  [ -t 0 ] || die "DISCORD_TOKEN absent, et pas de terminal pour le demander"
  read -rsp "Jeton du bot (non affiché) : " DISCORD_TOKEN
  echo
fi
[ -n "$DISCORD_TOKEN" ] || die "jeton vide"

# --- Envoi ------------------------------------------------------------------
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.out"' EXIT
printf '%s' "$COMMANDS" >"$tmp"

echo "Enregistrement des commandes $scope..."
code="$(
  printf 'Authorization: Bot %s\n' "$DISCORD_TOKEN" |
    curl -sS --max-time 20 -X PUT -H @- -H 'Content-Type: application/json' \
      --data-binary "@$tmp" -o "$tmp.out" -w '%{http_code}' "$url"
)" || die "Discord injoignable (réseau ?)"

# --- Résultat ---------------------------------------------------------------
case "$code" in
  200)
    names="$(jq -r '[.[].name] | join(", ")' "$tmp.out" 2>/dev/null || true)"
    echo "OK : commandes $scope enregistrées${names:+ : $names}"
    ;;
  401) die "jeton refusé (HTTP 401) : refaites « Reset Token » dans l'onglet Bot du portail" ;;
  403) die "accès refusé (HTTP 403) : l'application doit être installée sur ce serveur avec le scope applications.commands" ;;
  404) die "application ou serveur introuvable (HTTP 404) : vérifiez APP_ID et GUILD_ID" ;;
  *)
    detail="$(jq -r '.message // empty' "$tmp.out" 2>/dev/null || true)"
    die "HTTP $code${detail:+ : $detail}"
    ;;
esac
