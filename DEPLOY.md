# Self-hosted deployment (MBBS VPS)

Horos Viewer runs fully self-hosted: **MySQL** + **MinIO** (S3-compatible object
storage) + the app, with **local email/password auth** (no Manus dependency).
The stack is defined in [`docker-compose.yml`](docker-compose.yml) and sits
behind the existing Traefik reverse proxy.

## Prerequisites on the VPS (76.13.55.44 / VM 1377524)
- Docker + Docker Compose (present).
- The active Traefik is `traefik-fblq` (`/docker/traefik-fblq`), running in
  **`network_mode: host`** with cert resolver **`letsencrypt`** and entrypoints
  `web` (:80) / `websecure` (:443), ACME **HTTP-01** challenge. The compose is
  already tuned for this — no shared external network is required.
- A **DNS A record** for the chosen domain (e.g. `horos.mbbsarl.ch`) →
  `76.13.55.44` (needed for the ACME HTTP-01 challenge to issue TLS).

> The `mbbs-traefik` container in the `obsidian-mbbs` project is in *Created*
> (not running) state — ignore it; `traefik-fblq` is the live proxy.

## 1. Configure
```sh
cp .env.example .env
# Edit .env and set strong values:
openssl rand -hex 32   # -> JWT_SECRET
# Set HOROS_DOMAIN, MYSQL_PASSWORD, MYSQL_ROOT_PASSWORD,
# S3_ACCESS_KEY, S3_SECRET_KEY, and align DATABASE_URL's password with
# MYSQL_PASSWORD.
```

## 2. Launch
```sh
docker compose up -d --build
```
Boot order is handled automatically:
1. `db` (MySQL) and `minio` start and become healthy.
2. `createbucket` creates the private `horos-dicom` bucket.
3. `migrate` applies all Drizzle migrations (`0000`…`0006`, incl. access_logs,
   sessionVersion, passwordHash) then exits.
4. `app` starts and is published by Traefik at `https://$HOROS_DOMAIN`.

## 3. First login
Open `https://$HOROS_DOMAIN/login` and **Register**. The **first account
created becomes admin**. Additional accounts default to the unprivileged
`user` role and must be promoted (e.g. to `radiologist`) to view PHI.

## Operations
- Logs: `docker compose logs -f app`
- Re-run migrations after an update: `docker compose run --rm migrate`
- MinIO console (optional, keep internal): expose `minio:9001` only if needed.
- Backups: snapshot the `db-data` and `minio-data` volumes.

## Security notes
- DICOM objects are streamed through the authenticated `/manus-storage/*`
  proxy; the MinIO bucket is **not** publicly exposed.
- Sessions are 7-day JWTs, revocable via logout (`sessionVersion`).
- Rate limiting, CSRF guard on exports, Orthanc AE-Title validation, and the
  PHI access-log audit trail are all active (see `SECURITY.md` / `AUDIT.md`).

## Known limitation
PHI **burned into pixel data** is not removed by the anonymizer (metadata only).
