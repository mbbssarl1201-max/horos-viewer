#!/usr/bin/env bash
# Miroir incrémental du bucket DICOM → bucket de sauvegarde (même MinIO, CHIFFRÉ
# SSE-S3). Protège contre la suppression/corruption logique. Additif (les objets
# supprimés par erreur restent récupérables).
set -euo pipefail
cd /docker/horos
KEY=$(grep '^S3_ACCESS_KEY' .env|cut -d= -f2); SEC=$(grep '^S3_SECRET_KEY' .env|cut -d= -f2)
docker run --rm --entrypoint sh --network horos_internal minio/mc:latest -c "
  mc alias set h http://minio:9000 $KEY $SEC >/dev/null 2>&1
  mc mb -p h/horos-dicom-bak >/dev/null 2>&1 || true
  mc encrypt set sse-s3 h/horos-dicom-bak >/dev/null 2>&1 || true
  mc mirror --overwrite --quiet h/horos-dicom h/horos-dicom-bak
"
echo "$(date) DICOM mirror OK"
