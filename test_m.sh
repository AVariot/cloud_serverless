#!/usr/bin/env bash
#
# Démonstration : vérifie la sécurité de la gateway et le chemin d'un dessin,
# de la gateway jusqu'à la file Pub/Sub et aux logs.
#
# Usage : ./test_m.sh   (depuis n'importe où, avec gcloud et terraform connectés)
# Les couleurs sont désactivées hors terminal ou si NO_COLOR est défini.

set -u

REGION=europe-west1
CID="demo-$(date +%s)"
FAIL=0

# --- Couleurs ---------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN=$'\033[1;32m'
  RED=$'\033[1;31m'
  BLUE=$'\033[1;34m'
  DIM=$'\033[2m'
  RESET=$'\033[0m'
else
  GREEN="" RED="" BLUE="" DIM="" RESET=""
fi

title() { printf '%s== %s ==%s\n' "$BLUE" "$1" "$RESET"; }
ok()    { printf '  %sOK%s  %s\n' "$GREEN" "$RESET" "$1"; }
ko()    { printf '  %sKO%s  %s\n' "$RED" "$RESET" "$1"; FAIL=1; }

# Les commandes terraform output doivent tourner dans la stack serverless
cd "$(dirname "$0")/infra/serverless" || exit 1

printf '%sTest starting%s\n\n' "$BLUE" "$RESET"

# --- Setup ------------------------------------------------------------------
title "Setup"
GW=$(terraform output -raw gateway_url)
KEY=$(terraform output -raw api_key) # jamais affichée
PROXY=$(gcloud functions describe proxy --gen2 --region="$REGION" --format='value(serviceConfig.uri)')
printf 'gateway : %s%s%s\n' "$DIM" "$GW" "$RESET"
printf 'proxy   : %s%s%s\n' "$DIM" "$PROXY" "$RESET"
echo

# check "libellé" code_attendu <arguments curl...>
check() {
  local label="$1" expected="$2"
  shift 2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$code" = "$expected" ]; then
    ok "$(printf '%-44s %s' "$label" "$code")"
  else
    ko "$(printf '%-44s %s (attendu %s)' "$label" "$code" "$expected")"
  fi
}

# --- Sécurité ---------------------------------------------------------------
title "Sécurité"
check "proxy en direct, sans identité"        403 -X POST "$PROXY"
check "gateway sans clé"                      401 -X POST "$GW/draw" -d '{}'
check "gateway, mauvaise clé"                 400 -X POST "$GW/draw" -H 'x-api-key: fausse' -d '{}'
check "gateway, GET interdit"                 405 "$GW/draw" -H "x-api-key: $KEY"
check "gateway, requête invalide (x=99999)"   400 -X POST "$GW/draw" -H "x-api-key: $KEY" \
  -d '{"x":99999,"y":0,"color":"#ff0000","user_id":"u1"}'
echo

# --- Un dessin de bout en bout ----------------------------------------------
title "Dessin de bout en bout (correlation_id : $CID)"
OUT=$(curl -s -w '\n%{http_code}' -X POST "$GW/draw" \
  -H "x-api-key: $KEY" -H "X-Correlation-Id: $CID" \
  -d '{"x":42,"y":7,"color":"#ff8800","user_id":"demo"}')
CODE=${OUT##*$'\n'}
BODY=${OUT%$'\n'*}
if [ "$CODE" = "202" ]; then
  ok "réponse 202 : $BODY"
else
  ko "réponse $CODE : $BODY"
fi
echo

# --- Dans la file -----------------------------------------------------------
title "Dans la file Pub/Sub"
MSG=""
# Un pull peut revenir vide même si le message existe : on réessaie quelques fois
for _ in 1 2 3 4 5; do
  sleep 3
  MSG=$(gcloud pubsub subscriptions pull pixel-events-worker --limit=10 --auto-ack \
    --format='value(message.attributes.correlation_id,message.data.decode("base64"))' 2>/dev/null | grep "$CID")
  [ -n "$MSG" ] && break
done
if [ -n "$MSG" ]; then
  ok "message trouvé : $MSG"
else
  ko "message introuvable dans pixel-events-worker"
fi
echo

# --- Dans les logs ----------------------------------------------------------
title "Dans Cloud Logging"
LOG=""
for _ in 1 2 3 4 5 6; do
  LOG=$(gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"proxy\" AND jsonPayload.correlation_id=\"$CID\"" \
    --limit=1 --format='value(severity,jsonPayload.message)')
  [ -n "$LOG" ] && break
  sleep 5
done
if [ -n "$LOG" ]; then
  ok "log trouvé : $LOG"
else
  ko "aucun log pour $CID (les logs peuvent prendre jusqu'à 30 s)"
fi
echo

if [ "$FAIL" = "0" ]; then
  printf '%sTous les tests sont passés.%s\n' "$GREEN" "$RESET"
else
  printf '%sCertains tests ont échoué.%s\n' "$RED" "$RESET"
fi
exit "$FAIL"
