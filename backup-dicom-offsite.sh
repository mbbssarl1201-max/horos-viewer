#!/usr/bin/env bash
# Offsite DICOM → Infomaniak Object Storage (SUISSE), chiffré CLIENT (rclone crypt).
# Vrai 2e site (hors VPS) + conforme nLPD (CH + chiffré). Incrémental.
set -euo pipefail
docker run --rm --network horos_internal \
  -v /docker/horos/rclone.conf:/config/rclone/rclone.conf rclone/rclone \
  sync minio:horos-dicom infocrypt: --transfers 8 --checkers 16
echo "$(date) DICOM offsite Infomaniak OK"
