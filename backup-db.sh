#!/usr/bin/env bash
# Sauvegarde nightly de la base MediView (PHI : identités chiffrées + CR + audit).
# Rotation : 14 dernières. Reste sur le VPS (France/UE — conforme nLPD).
set -euo pipefail
cd /docker/horos
RP=$(grep '^MYSQL_ROOT_PASSWORD' .env | cut -d= -f2)
MDB=$(grep '^MYSQL_DATABASE' .env | cut -d= -f2)
DIR=/root/horos-backups
mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/horos-db-$TS.sql.gz"
docker exec -e MYSQL_PWD="$RP" horos-db-1 mysqldump -uroot --single-transaction --quick --routines "$MDB" | gzip > "$OUT"
# garde-fou : refuser une sauvegarde anormalement petite (échec silencieux)
SZ=$(stat -c%s "$OUT")
[ "$SZ" -lt 10000 ] && { echo "$(date) ERREUR sauvegarde trop petite ($SZ o) — supprimée"; rm -f "$OUT"; exit 1; }
ls -1t "$DIR"/horos-db-*.sql.gz | tail -n +15 | xargs -r rm -f
echo "$(date) OK $OUT ($((SZ/1024)) Ko)"
