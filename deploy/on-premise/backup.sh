#!/usr/bin/env bash
# Sauvegarde MediView on-premise : base MySQL + objets MinIO (DICOM/captures).
# À planifier (cron) sur l'hôte. Les sauvegardes contiennent des données
# patients → les garder dans le périmètre de confiance (disque chiffré du
# cabinet / NAS interne), jamais dans le cloud en clair.
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/${STAMP}"
mkdir -p "${DEST}"

# shellcheck disable=SC1091
set -a; source .env; set +a

echo "→ Dump MySQL…"
docker compose exec -T db \
  sh -c "exec mysqldump -uroot -p\"\$MYSQL_ROOT_PASSWORD\" --single-transaction --routines --triggers \"$MYSQL_DATABASE\"" \
  > "${DEST}/mysql-${MYSQL_DATABASE}.sql"

echo "→ Copie des objets MinIO…"
docker compose exec -T minio sh -c '
  mc alias set h http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 || true
' || true
# Miroir du bucket vers une archive locale via un conteneur mc jetable.
docker run --rm --network "$(basename "$(pwd)")_internal" \
  -v "$(pwd)/${DEST}:/backup" \
  -e S3_ACCESS_KEY -e S3_SECRET_KEY -e S3_BUCKET \
  --entrypoint /bin/sh minio/mc:latest -c '
    mc alias set h http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" &&
    mc mirror --overwrite "h/$S3_BUCKET" "/backup/minio-$S3_BUCKET"
  '

echo "✅ Sauvegarde dans ${DEST}"
echo "   (Pense à la copier sur un support chiffré hors-machine.)"
