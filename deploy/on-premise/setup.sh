#!/usr/bin/env bash
# MediView on-premise — génération des secrets et de la config.
# Crée .env (secrets forts aléatoires) + orthanc/orthanc.json à partir des
# modèles. Idempotent : refuse d'écraser un .env existant (pour ne pas perdre
# des secrets déjà en service).
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  echo "⚠️  .env existe déjà — abandon (on ne régénère pas les secrets)."
  echo "    Pour repartir de zéro : sauvegarde puis supprime .env, et relance."
  exit 1
fi

command -v openssl >/dev/null || { echo "openssl requis"; exit 1; }
command -v envsubst >/dev/null || { echo "envsubst requis (paquet gettext-base)"; exit 1; }

gen() { openssl rand -base64 "${1:-24}" | tr -d '/+=' | cut -c1-"${2:-32}"; }

echo "→ Génération des secrets…"
MYSQL_PASSWORD="$(gen 24 32)"
MYSQL_ROOT_PASSWORD="$(gen 24 32)"
JWT_SECRET="$(gen 48 48)"
S3_ACCESS_KEY="$(gen 16 20)"
S3_SECRET_KEY="$(gen 32 40)"
ORTHANC_PASSWORD="$(gen 24 32)"

# Valeurs paramétrables (modifiables avant de lancer setup.sh via variables d'env)
MEDIVIEW_IMAGE_TAG="${MEDIVIEW_IMAGE_TAG:-self-host}"
MEDIVIEW_HOSTNAME="${MEDIVIEW_HOSTNAME:-mediview.cabinet.local}"
OLLAMA_VISION_MODEL="${OLLAMA_VISION_MODEL:-qwen2.5vl:7b}"
DCM4CHEE_AET="${DCM4CHEE_AET:-DCM4CHEE}"
DCM4CHEE_HOST="${DCM4CHEE_HOST:-192.168.1.180}"
DCM4CHEE_PORT="${DCM4CHEE_PORT:-11112}"
ORTHANC_USER="${ORTHANC_USER:-mediview}"

cat > .env <<EOF
# Généré par setup.sh — NE PAS VERSIONNER.
MEDIVIEW_IMAGE_TAG=${MEDIVIEW_IMAGE_TAG}
MEDIVIEW_HOSTNAME=${MEDIVIEW_HOSTNAME}

MYSQL_DATABASE=mediview
MYSQL_USER=mediview
MYSQL_PASSWORD=${MYSQL_PASSWORD}
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}
DATABASE_URL=mysql://mediview:${MYSQL_PASSWORD}@db:3306/mediview

JWT_SECRET=${JWT_SECRET}

S3_REGION=us-east-1
S3_BUCKET=mediview
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}

ORTHANC_USER=${ORTHANC_USER}
ORTHANC_PASSWORD=${ORTHANC_PASSWORD}
DCM4CHEE_AET=${DCM4CHEE_AET}
DCM4CHEE_HOST=${DCM4CHEE_HOST}
DCM4CHEE_PORT=${DCM4CHEE_PORT}

OLLAMA_VISION_MODEL=${OLLAMA_VISION_MODEL}

SMTP_HOST=
SMTP_PORT=587
SMTP_FROM=mediview@cabinet.local
EOF
chmod 600 .env
echo "  ✓ .env créé (chmod 600)"

echo "→ Rendu de orthanc/orthanc.json…"
export ORTHANC_USER ORTHANC_PASSWORD DCM4CHEE_AET DCM4CHEE_HOST DCM4CHEE_PORT
envsubst '${ORTHANC_USER} ${ORTHANC_PASSWORD} ${DCM4CHEE_AET} ${DCM4CHEE_HOST} ${DCM4CHEE_PORT}' \
  < orthanc/orthanc.json.tmpl > orthanc/orthanc.json
chmod 600 orthanc/orthanc.json
echo "  ✓ orthanc/orthanc.json généré"

echo
echo "✅ Config prête. Étapes suivantes :"
echo "   1) docker login ghcr.io        # token GHCR en lecture (cf. README)"
echo "   2) docker compose pull"
echo "   3) docker compose up -d"
echo "   4) docker compose exec ollama ollama pull ${OLLAMA_VISION_MODEL}"
echo "   5) Ouvre https://${MEDIVIEW_HOSTNAME} et crée le 1er compte (= admin)."
