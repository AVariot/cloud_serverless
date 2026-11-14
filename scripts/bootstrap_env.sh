#!/usr/bin/env bash
#
# bootstrap_env.sh : amorce, ou vérifie, un environnement dont les fichiers existent déjà (voir new_env.sh).
#
# CE QUE FAIT CE SCRIPT
#   1. Bucket d'état Terraform : le crée s'il manque (versioning activé, accès public interdit).
#   2. Stack access : applique l'identité de la CI (OIDC + compte github-deployer et ses rôles) depuis ce poste,
#      après affichage du plan et confirmation. Il refuse d'appliquer un plan qui détruit des ressources.
#   3. Environnement GitHub : le crée, pose les variables WIF_PROVIDER et DEPLOYER_SA (sorties de la stack access)
#      et, avec --reviewer, règle les relecteurs obligatoires (exigés pour prd).
#
# CE QU'IL NE FAIT PAS
#   - La clé publique de l'application Discord (à mettre dans infra/serverless/<env>.tfvars) et le jeton du bot
#     (scripts/register_discord_commands.sh le demande sans écho) restent à la main : aucun jeton ne passe ici.
#   - Il n'applique ni foundation ni serverless : ce sont les workflows de déploiement qui s'en chargent.
#
# USAGE
#   ./scripts/bootstrap_env.sh <env> --check                      lecture seule : dit ce qui manque, ne modifie rien
#   ./scripts/bootstrap_env.sh <env> [--reviewer <login>]...      fait ce qui manque (confirmation avant l'apply)
#   ./scripts/bootstrap_env.sh <env> --yes ...                    sans confirmation (à éviter sur un terminal)
#   --reviewer REMPLACE la liste des relecteurs. Sans --reviewer, un environnement existant garde sa protection.
#
# À SAVOIR
#   - Il laisse infra/access initialisé sur l'environnement traité : refaites un « terraform init -reconfigure »
#     avant de travailler sur un autre environnement.
#   - Votre branche doit être à jour avec dev, sinon le plan voudra détruire des ressources d'autres stacks.
#
# TESTÉ : --check et le chemin complet (apply, variables, relecteurs) sur dev et prd, qui existaient déjà.
#         NON TESTÉ : la création du bucket d'état, faute de projet neuf.

set -euo pipefail

die() {
  printf 'Erreur : %s\n' "$*" >&2
  exit 1
}
info() { printf '%s\n' "$*"; }

[ $# -ge 1 ] || die "usage : $0 <env> [--check] [--reviewer <login>]... [--yes]"
ENV="$1"
shift
CHECK=0
YES=0
REVIEWERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --yes) YES=1 ;;
    --reviewer)
      [ $# -ge 2 ] || die "--reviewer demande un login GitHub"
      REVIEWERS+=("$2")
      shift
      ;;
    *) die "option inconnue : $1" ;;
  esac
  shift
done

[[ "$ENV" =~ ^[a-z][a-z0-9]{1,9}$ ]] || die "env invalide : $ENV"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACCESS="$ROOT/infra/access"
TFVARS="$ACCESS/$ENV.tfvars"
[ -f "$TFVARS" ] || die "$TFVARS absent : lancez d'abord scripts/new_env.sh"
[ -f "$ACCESS/backends/$ENV.hcl" ] || die "infra/access/backends/$ENV.hcl absent"

# lit une valeur « clé = "valeur" » dans un fichier tfvars
tfvar() { awk -F'"' -v k="$1" '$1 ~ "^"k"[[:space:]]*=" {print $2; exit}' "$TFVARS"; }
PROJECT="$(tfvar project_id)"
REGION="$(tfvar region)"
BUCKET="$(tfvar state_bucket)"
REPO="$(tfvar github_repo)"
for v in PROJECT REGION BUCKET REPO; do [ -n "${!v}" ] || die "$v introuvable dans $TFVARS"; done

command -v gcloud >/dev/null || die "gcloud est requis"
command -v terraform >/dev/null || die "terraform est requis"
command -v gh >/dev/null || die "gh est requis"
command -v jq >/dev/null || die "jq est requis"
gcloud projects describe "$PROJECT" >/dev/null 2>&1 || die "projet $PROJECT introuvable ou inaccessible avec le compte gcloud actuel"
gh auth status >/dev/null 2>&1 || die "gh n'est pas connecté"

info "Environnement $ENV : projet $PROJECT, région $REGION, dépôt $REPO"
[ "$CHECK" = 1 ] && info "(mode --check : rien n'est modifié)"
MISSING=0

# --- 1. bucket d'état ---------------------------------------------------------
info ""
info "1/3 bucket d'état gs://$BUCKET"
if gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  info "    présent"
elif [ "$CHECK" = 1 ]; then
  info "    ABSENT"
  MISSING=1
else
  # versioning : on garde l'historique du state ; accès uniforme ; jamais public
  gcloud storage buckets create "gs://$BUCKET" --project="$PROJECT" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention >/dev/null
  gcloud storage buckets update "gs://$BUCKET" --versioning >/dev/null
  info "    créé (versioning activé, accès public interdit)"
fi

# --- 2. stack access ----------------------------------------------------------
info ""
info "2/3 stack access (identité de la CI)"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  info "    impossible sans bucket d'état"
else
  cd "$ACCESS"
  terraform init -reconfigure -input=false -backend-config="backends/$ENV.hcl" >/dev/null
  PLAN="$(mktemp)"
  trap 'rm -f "$PLAN" "$PLAN.log"' EXIT
  terraform plan -input=false -lock=false -var-file="$ENV.tfvars" -out="$PLAN" -no-color >"$PLAN.log" 2>&1 || {
    cat "$PLAN.log" >&2
    die "terraform plan a échoué"
  }
  summary="$(grep -E '^Plan:|No changes' "$PLAN.log" | head -1)"
  info "    $summary"
  if grep -q '^Plan:' "$PLAN.log"; then
    DESTROYS=0
    if grep -q 'will be destroyed' "$PLAN.log"; then
      DESTROYS=1
      grep 'will be destroyed' "$PLAN.log" | sed 's/^/    /' >&2
      info "    ATTENTION : le plan détruirait des ressources. Votre branche est probablement en retard sur dev (git merge origin/dev)."
    fi
    if [ "$CHECK" = 1 ]; then
      [ "$DESTROYS" = 0 ] || info "    (ne jamais appliquer ce plan tel quel)"
      info "    des ressources sont à créer"
      MISSING=1
    else
      [ "$DESTROYS" = 0 ] || die "le plan détruit des ressources : arrêt. Mettez la branche à jour avec dev."
      if [ "$YES" != 1 ]; then
        [ -t 0 ] || die "pas de terminal pour confirmer (utilisez --yes en connaissance de cause)"
        read -rp "    Appliquer ce plan sur $PROJECT ? [oui/N] " ans
        [ "$ans" = "oui" ] || die "annulé"
      fi
      terraform apply -input=false "$PLAN" >/dev/null
      info "    appliqué"
    fi
  fi
fi

# --- 3. environnement GitHub --------------------------------------------------
info ""
info "3/3 environnement GitHub « $ENV » ($REPO)"
if gh api "repos/$REPO/environments/$ENV" >/dev/null 2>&1; then
  ENV_EXISTS=1
else
  ENV_EXISTS=0
fi

WIF=""
SA=""
if gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  cd "$ACCESS"
  WIF="$(terraform output -raw workload_identity_provider 2>/dev/null || true)"
  SA="$(terraform output -raw deployer_service_account 2>/dev/null || true)"
fi

if [ "$ENV_EXISTS" = 0 ]; then
  if [ "$CHECK" = 1 ]; then
    info "    environnement ABSENT"
    MISSING=1
  fi
fi

if [ "$CHECK" != 1 ]; then
  if [ "$ENV_EXISTS" = 0 ] || [ "${#REVIEWERS[@]}" -gt 0 ]; then
    body='{}'
    if [ "${#REVIEWERS[@]}" -gt 0 ]; then
      ids='[]'
      for login in "${REVIEWERS[@]}"; do
        id="$(gh api "users/$login" --jq .id 2>/dev/null)" || die "utilisateur GitHub introuvable : $login"
        ids="$(jq -c --argjson id "$id" '. + [{type:"User", id:$id}]' <<<"$ids")"
      done
      body="$(jq -c --argjson r "$ids" '{reviewers:$r}' <<<'{}')"
    fi
    gh api -X PUT "repos/$REPO/environments/$ENV" --input - <<<"$body" >/dev/null
    if [ "$ENV_EXISTS" = 0 ]; then info "    environnement créé"; else info "    relecteurs mis à jour"; fi
  fi
  if [ -n "$WIF" ] && [ -n "$SA" ]; then
    gh variable set WIF_PROVIDER --env "$ENV" --repo "$REPO" --body "$WIF" >/dev/null
    gh variable set DEPLOYER_SA --env "$ENV" --repo "$REPO" --body "$SA" >/dev/null
    info "    variables WIF_PROVIDER et DEPLOYER_SA posées"
  else
    info "    variables NON posées : les sorties de la stack access sont absentes"
  fi
fi

if gh api "repos/$REPO/environments/$ENV" >/dev/null 2>&1; then
  vars="$(gh variable list --env "$ENV" --repo "$REPO" --json name --jq '[.[].name]|sort|join(",")')"
  [ "$vars" = "DEPLOYER_SA,WIF_PROVIDER" ] && info "    variables : présentes" || {
    info "    variables : ABSENTES ou incomplètes ($vars)"
    MISSING=1
  }
  if [ -n "$WIF" ]; then
    cur="$(gh variable get WIF_PROVIDER --env "$ENV" --repo "$REPO" 2>/dev/null || true)"
    [ "$cur" = "$WIF" ] || {
      info "    WIF_PROVIDER ne correspond PAS à la sortie de Terraform"
      MISSING=1
    }
  fi
  revs="$(gh api "repos/$REPO/environments/$ENV" --jq '[.protection_rules[]?|select(.type=="required_reviewers")|.reviewers[]?.reviewer.login]|join(",")')"
  if [ -n "$revs" ]; then
    info "    relecteurs obligatoires : $revs"
  elif [ "$ENV" = "prd" ] || [ "$ENV" = "prod" ]; then
    info "    AUCUN relecteur obligatoire : un déploiement partirait sans approbation (relancez avec --reviewer <login>)"
    MISSING=1
  else
    info "    aucun relecteur obligatoire (facultatif hors prod ; --reviewer <login> pour en ajouter)"
  fi
fi

# --- reste à la main ----------------------------------------------------------
info ""
SERVERLESS_TFVARS="$ROOT/infra/serverless/$ENV.tfvars"
if [ -f "$SERVERLESS_TFVARS" ] && ! grep -Eq '^discord_public_key[[:space:]]*=[[:space:]]*"[0-9a-f]{64}"' "$SERVERLESS_TFVARS"; then
  info "À la main : discord_public_key est vide dans infra/serverless/$ENV.tfvars (le copier depuis le portail Discord)."
fi
info "À la main : le jeton du bot et l'enregistrement des commandes (scripts/register_discord_commands.sh)."
info "Le dossier infra/access est maintenant initialisé sur $ENV : refaites un init -reconfigure avant de travailler sur un autre environnement."
if [ "$MISSING" = 1 ]; then
  info ""
  info "=> $ENV n'est PAS complet (voir ci-dessus)."
  exit 1
fi
info ""
info "=> $ENV est complet."
