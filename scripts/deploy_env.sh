#!/usr/bin/env bash
#
# deploy_env.sh : déploie un environnement complet depuis ce poste, comme le ferait une release (tag).
#
# CE QUE FAIT CE SCRIPT
#   Applique les stacks dans l'ordre : foundation, serverless, frontend. Pour chacune : plan, résumé, confirmation,
#   apply du plan relu. Puis envoie le site (scripts/deploy_site.sh).
#   Une stack sans changement est sautée. Un plan qui détruit des ressources arrête tout.
#
# CE QU'IL NE FAIT PAS
#   - Il n'applique pas la stack access (l'identité de la CI) : voir scripts/bootstrap_env.sh.
#   - Il ne remplace pas le circuit de release : la prod doit être déployée par un tag, via la CI (sujet §5.3).
#     Ce script sert à tester sur dev, ou à dépanner.
#   - Le jeton du bot Discord et l'enregistrement des commandes restent manuels.
#
# USAGE
#   DISCORD_CLIENT_ID=<identifiant> ./scripts/deploy_env.sh <env> [--check] [--skip-site] [--yes]
#   --check      affiche les plans de toutes les stacks, n'applique rien et n'envoie pas le site
#   --skip-site  n'envoie pas le front
#   --yes        sans confirmation (à éviter sur un terminal)
#
# COÛT : la stack foundation crée un cluster GKE et ses nœuds, facturés en continu tant qu'ils existent.
#        Le script le signale avant de demander la confirmation.
#
# À SAVOIR : il laisse chaque dossier infra/<stack> initialisé sur l'environnement traité.
#
# TESTÉ : --check sur dev. Le chemin qui applique n'a pas tourné par ce script.

set -euo pipefail

die() {
  printf 'Erreur : %s\n' "$*" >&2
  exit 1
}
info() { printf '%s\n' "$*"; }

[ $# -ge 1 ] || die "usage : $0 <env> [--check] [--skip-site] [--yes]"
ENV="$1"
shift
CHECK=0
SKIP_SITE=0
YES=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --skip-site) SKIP_SITE=1 ;;
    --yes) YES=1 ;;
    *) die "option inconnue : $a" ;;
  esac
done
[[ "$ENV" =~ ^[a-z][a-z0-9]{1,9}$ ]] || die "env invalide : $ENV"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v terraform >/dev/null || die "terraform est requis"
for s in foundation serverless frontend; do
  for f in "backends/$ENV.hcl" "$ENV.tfvars"; do
    [ -f "$ROOT/infra/$s/$f" ] || die "infra/$s/$f absent : l'environnement $ENV n'existe pas (voir scripts/new_env.sh)"
  done
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$CHECK" = 0 ] && [ "$ENV" = "prd" ]; then
  info "ATTENTION : prd est la référence de la soutenance et doit être déployée par un tag (sujet §5.3)."
  [ "$YES" = 1 ] || [ ! -t 0 ] || {
    read -rp "Continuer quand même depuis ce poste ? [oui/N] " ans
    [ "$ans" = "oui" ] || die "annulé"
  }
fi

for stack in foundation serverless frontend; do
  info ""
  info "=== $stack ($ENV) ==="
  cd "$ROOT/infra/$stack"
  terraform init -reconfigure -input=false -backend-config="backends/$ENV.hcl" >/dev/null
  terraform plan -input=false -no-color -lock=false -var-file="$ENV.tfvars" -out="$TMP/$stack.plan" >"$TMP/$stack.log" 2>&1 || {
    cat "$TMP/$stack.log" >&2
    die "le plan de $stack a échoué"
  }
  summary="$(grep -E '^Plan:|No changes' "$TMP/$stack.log" | head -1)"
  info "  $summary"
  if grep -q 'No changes' "$TMP/$stack.log"; then
    continue
  fi
  # la sortie est d'abord capturée : « grep -q » dans un tube avec pipefail ferait échouer le test (SIGPIPE)
  SHOWN="$(terraform show -no-color "$TMP/$stack.plan")"
  printf '%s\n' "$SHOWN" | grep -E '^\s*# .*(will be|must be)' | sed -E 's/^\s+# /    /' | head -40 || true

  if grep -q 'will be destroyed\|must be replaced' "$TMP/$stack.log"; then
    die "le plan de $stack détruit ou remplace des ressources : arrêt. Mettez la branche à jour (git merge origin/dev) et relisez."
  fi
  if grep -q 'google_container_cluster.*will be created' <<<"$SHOWN"; then
    info "  COÛT : ce plan CRÉE un cluster GKE avec ses nœuds, facturés en continu sur vos crédits."
  fi
  [ "$CHECK" = 1 ] && continue

  if [ "$YES" != 1 ]; then
    [ -t 0 ] || die "pas de terminal pour confirmer (utilisez --yes en connaissance de cause)"
    read -rp "  Appliquer ce plan sur $ENV ? [oui/N] " ans
    [ "$ans" = "oui" ] || die "annulé avant l'apply de $stack"
  fi
  # le plan sauvegardé est appliqué tel quel : on applique ce qui a été relu
  terraform apply -input=false "$TMP/$stack.plan" >/dev/null
  info "  appliqué"
done

if [ "$CHECK" = 1 ]; then
  info ""
  info "Mode --check : rien n'a été appliqué ni envoyé."
  exit 0
fi
if [ "$SKIP_SITE" = 1 ]; then
  info ""
  info "Stacks appliquées. Site non envoyé (--skip-site)."
  exit 0
fi

info ""
info "=== site ($ENV) ==="
"$ROOT/scripts/deploy_site.sh" "$ENV"
