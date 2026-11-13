#!/usr/bin/env bash
#
# deploy_site.sh : construit le front pour un environnement et l'envoie sur Firebase Hosting.
#
# CE QUE FAIT CE SCRIPT
#   1. Lit dans les sorties Terraform l'adresse de la gateway, sa clé API et le site Firebase de l'environnement
#      (stacks serverless et frontend : elles doivent déjà être appliquées).
#   2. Construit le front (app/frontend) avec ces valeurs.
#   3. Envoie le dossier construit sur Firebase Hosting.
#
# C'est aussi ce qu'exécute la CI (.github/workflows/deploy-site.yml) : une seule version de la logique, donc ce
# que vous lancez à la main est ce que fait une release.
#
# USAGE
#   DISCORD_CLIENT_ID=<identifiant> ./scripts/deploy_site.sh <env> [--build-only]
#   --build-only : construit le front, n'envoie rien (pour vérifier que ça compile).
#
# PRÉREQUIS
#   - DISCORD_CLIENT_ID : identifiant de l'application Discord (public). S'il manque, il est demandé sur un terminal.
#   - Identifiants GCP : gcloud auth application-default login en local ; en CI, ceux de l'action d'authentification.
#   - terraform, node et npm. L'outil firebase est téléchargé à la version figée ci-dessous.
#
# RIEN DE SECRET : les variables VITE_* finissent dans le JavaScript servi aux navigateurs (clé de la gateway
# comprise : elle est visible dans l'onglet Réseau, la vraie protection est le jeton Discord vérifié côté serveur).
#
# TESTÉ : lecture des sorties et construction. L'envoi lui-même n'a pas encore tourné par ce script.

set -euo pipefail

FIREBASE_TOOLS="${FIREBASE_TOOLS:-15.34.2}" # version publiée depuis plus de deux semaines

die() {
  printf 'Erreur : %s\n' "$*" >&2
  exit 1
}
info() { printf '%s\n' "$*"; }

[ $# -ge 1 ] || die "usage : $0 <env> [--build-only]"
ENV="$1"
BUILD_ONLY=0
[ "${2:-}" = "--build-only" ] && BUILD_ONLY=1
[[ "$ENV" =~ ^[a-z][a-z0-9]{1,9}$ ]] || die "env invalide : $ENV"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in "infra/serverless/backends/$ENV.hcl" "infra/frontend/backends/$ENV.hcl" "infra/frontend/$ENV.tfvars"; do
  [ -f "$ROOT/$f" ] || die "$f absent : l'environnement $ENV n'existe pas (voir scripts/new_env.sh)"
done
command -v terraform >/dev/null || die "terraform est requis"
command -v npm >/dev/null || die "npm est requis"

if [ -z "${DISCORD_CLIENT_ID:-}" ]; then
  [ -t 0 ] || die "DISCORD_CLIENT_ID absent (variable GitHub de l'environnement $ENV, ou à exporter)"
  read -rp "Identifiant de l'application Discord (public) : " DISCORD_CLIENT_ID
fi
[[ "$DISCORD_CLIENT_ID" =~ ^[0-9]{5,25}$ ]] || die "DISCORD_CLIENT_ID doit être un nombre (reçu : $DISCORD_CLIENT_ID)"

# --- 1. adresses lues dans Terraform --------------------------------------------------------------------
info "Lecture des sorties Terraform ($ENV)..."
terraform -chdir="$ROOT/infra/serverless" init -reconfigure -input=false -backend-config="backends/$ENV.hcl" >/dev/null
GATEWAY_URL="$(terraform -chdir="$ROOT/infra/serverless" output -raw gateway_url)" || die "sortie gateway_url introuvable : la stack serverless est-elle appliquée sur $ENV ?"
API_KEY="$(terraform -chdir="$ROOT/infra/serverless" output -raw api_key)" || die "sortie api_key introuvable"
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$API_KEY" # jamais dans les journaux de la CI

terraform -chdir="$ROOT/infra/frontend" init -reconfigure -input=false -backend-config="backends/$ENV.hcl" >/dev/null
SITE_ID="$(terraform -chdir="$ROOT/infra/frontend" output -raw site_id)" || die "sortie site_id introuvable : la stack frontend est-elle appliquée sur $ENV ?"
SITE_URL="$(terraform -chdir="$ROOT/infra/frontend" output -raw site_url)"
PROJECT_ID="$(awk -F'"' '/^project_id/ {print $2; exit}' "$ROOT/infra/frontend/$ENV.tfvars")"
[ -n "$PROJECT_ID" ] || die "project_id introuvable dans infra/frontend/$ENV.tfvars"
info "  site     : $SITE_URL"
info "  gateway  : $GATEWAY_URL"
info "  projet   : $PROJECT_ID"

# --- 2. construction --------------------------------------------------------------------------------------
info "Construction du front..."
cd "$ROOT/app/frontend"
export VITE_DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID"
export VITE_DISCORD_REDIRECT_URI="$SITE_URL"
export VITE_GATEWAY_URL="$GATEWAY_URL"
export VITE_PIXEL_API_KEY="$API_KEY"
export VITE_FIREBASE_PROJECT_ID="$PROJECT_ID"
npm ci --no-audit --no-fund
npm run build

if [ "$BUILD_ONLY" = 1 ]; then
  info "Construction réussie (--build-only : rien n'est envoyé)."
  exit 0
fi

# --- 3. envoi ----------------------------------------------------------------------------------------------
info "Envoi sur Firebase Hosting..."
npx --yes "firebase-tools@$FIREBASE_TOOLS" target:apply hosting main "$SITE_ID" --project "$PROJECT_ID"
npx --yes "firebase-tools@$FIREBASE_TOOLS" deploy --only hosting:main --project "$PROJECT_ID"
info ""
info "Site en ligne : $SITE_URL"
info "Rappel : l'adresse $SITE_URL doit figurer dans les redirections OAuth2 du portail Discord."
