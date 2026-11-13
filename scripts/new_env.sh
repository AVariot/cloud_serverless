#!/usr/bin/env bash
#
# new_env.sh : prépare les FICHIERS d'un nouvel environnement (staging, demo...) à partir de ceux de dev.
#
# CE QUE FAIT CE SCRIPT
#   Pour chacune des 3 stacks (access, foundation, serverless) il copie les fichiers de dev :
#     - infra/<stack>/backends/<env>.hcl : bucket d'état Terraform du nouvel environnement
#     - infra/<stack>/<env>.tfvars       : projet, nom du VPC, plage réseau, CORS vide, clé Discord vide
#
# CE QU'IL NE FAIT PAS
#   Il n'appelle jamais GCP ni GitHub : il ne crée que des fichiers locaux, et refuse d'écraser un fichier
#   existant. Il ne crée ni le bucket, ni l'identité de la CI : c'est le rôle de scripts/bootstrap_env.sh.
#   Il ne relit pas à votre place : admin_member, github_repo et region sont repris de dev tels quels.
#
# USAGE
#   ./scripts/new_env.sh <env> <project_id> [cidr_block]
#   ex. : ./scripts/new_env.sh staging servtkt-cloudnative-staging 10.2.0.0/16
#   À la fin, il affiche les étapes à faire à la main.
#
# TESTÉ : sur une copie jetable du dépôt (fichiers générés, refus d'écraser, entrées invalides).

set -euo pipefail

die() {
  printf 'Erreur : %s\n' "$*" >&2
  exit 1
}

[ $# -ge 2 ] && [ $# -le 3 ] || die "usage : $0 <env> <project_id> [cidr_block]"
ENV="$1"
PROJECT="$2"
CIDR="${3:-}"

[[ "$ENV" =~ ^[a-z][a-z0-9]{1,9}$ ]] || die "env invalide : $ENV (minuscules et chiffres, 2 à 10 caractères)"
[ "$ENV" != "dev" ] || die "dev existe déjà : c'est le modèle"
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "project_id invalide : $PROJECT"
[ -z "$CIDR" ] || [[ "$CIDR" =~ ^10\.[0-9]{1,3}\.0\.0/16$ ]] || die "cidr_block attendu au format 10.N.0.0/16 (reçu : $CIDR)"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_PROJECT="servtkt-cloudnative-dev" # projet de dev, tel qu'écrit dans ses fichiers

for stack in access foundation serverless; do
  for f in "backends/dev.hcl" "dev.tfvars"; do
    [ -f "$ROOT/infra/$stack/$f" ] || die "modèle absent : infra/$stack/$f"
  done
  for f in "backends/$ENV.hcl" "$ENV.tfvars"; do
    [ ! -e "$ROOT/infra/$stack/$f" ] || die "existe déjà : infra/$stack/$f (rien n'a été écrit)"
  done
done

for stack in access foundation serverless; do
  dir="$ROOT/infra/$stack"
  sed "s/$DEV_PROJECT/$PROJECT/g" "$dir/backends/dev.hcl" >"$dir/backends/$ENV.hcl"
  sed -E \
    -e "s/$DEV_PROJECT/$PROJECT/g" \
    -e "s/servtkt-dev-vpc/servtkt-$ENV-vpc/g" \
    -e 's|^cors_allowed_origins.*|cors_allowed_origins = []|' \
    -e 's|^discord_public_key.*|discord_public_key = ""|' \
    -e 's|^# Clé publique Discord.*|# Clé publique Discord de cet environnement (publique par nature) ; vide = à saisir à la main.|' \
    "$dir/dev.tfvars" >"$dir/$ENV.tfvars"
  if [ -n "$CIDR" ]; then
    sed -i -E "s|^cidr_block.*|cidr_block = \"$CIDR\"|" "$dir/$ENV.tfvars"
  fi
  echo "créé : infra/$stack/backends/$ENV.hcl et infra/$stack/$ENV.tfvars"
done

cat <<EOF

Fichiers créés pour « $ENV » (projet $PROJECT). À faire maintenant, à la main :

 1. Relire les fichiers créés. Valeurs reprises de dev à vérifier : admin_member, github_repo, region.
 2. cidr_block (stack foundation) : ${CIDR:-NON FOURNI, il est resté celui de dev : donnez-en un autre}.
 3. Créer le bucket d'état « ${PROJECT}-tfstate-eu » (il n'est pas géré par Terraform).
 4. Amorcer l'identité de la CI, depuis votre poste :
      cd infra/access
      terraform init -reconfigure -backend-config=backends/$ENV.hcl
      terraform plan -var-file=$ENV.tfvars -out=tfplan   (relire, puis terraform apply tfplan)
 5. Créer l'environnement GitHub « $ENV » : variables WIF_PROVIDER et DEPLOYER_SA (sorties de l'étape 4),
    et au moins un relecteur obligatoire.
 6. Ajouter « $ENV » aux matrices des workflows .github/workflows/terraform-pr.yml et terraform-deploy.yml.
 7. serverless : renseigner cors_allowed_origins (adresse du front) et discord_public_key (clé publique de
    l'application Discord de cet environnement), sinon la fonction discord-proxy ne démarre pas.
 8. Le jeton du bot Discord et l'enregistrement des commandes restent manuels (scripts/register_discord_commands.sh).
EOF
