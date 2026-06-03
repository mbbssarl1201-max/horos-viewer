# Horos Viewer

A full-stack web DICOM viewer / mini-PACS inspired by Horos / OsiriX. It lets
clinical users import, browse, view and annotate DICOM studies, export them
(ZIP / PDF), and query an Orthanc PACS.

> ⚠️ **Not a certified medical device.** This is a development project. Several
> advanced features are previews only (see *Status* below) and it must not be
> used for primary diagnosis. See [`SECURITY.md`](SECURITY.md) for the access
> model and known limitations.

## Stack

- **Frontend:** React 19, Vite 7, Tailwind 4, Radix UI, Cornerstone3D (DICOM
  rendering), wouter, TanStack Query + tRPC client.
- **Backend:** Express 4, tRPC 11, Drizzle ORM (MySQL), `jose` (session JWTs),
  Forge presigned S3 storage, nodemailer, Orthanc DICOMweb proxy.
- **Shared:** end-to-end types from the tRPC router and Drizzle schema.

## Project layout

```
client/   React app (pages, components, hooks)   — client/src
server/   Express + tRPC API, services           — server/_core is framework plumbing
shared/   Types/constants shared client↔server
drizzle/  DB schema + SQL migrations
```

## Getting started

Requires **Node 20+** and **pnpm** (`corepack enable && corepack prepare pnpm@10.4.1 --activate`).

```bash
pnpm install
cp .env.example .env      # then fill in the values (JWT_SECRET is mandatory)
pnpm db:push              # create/upgrade the MySQL schema
pnpm dev                  # start the dev server (Vite + API)
```

Other scripts:

| Script        | Purpose                                  |
| ------------- | ---------------------------------------- |
| `pnpm check`  | TypeScript type-check (`tsc --noEmit`)   |
| `pnpm test`   | Vitest unit tests                        |
| `pnpm build`  | Production build (Vite client + esbuild) |
| `pnpm start`  | Run the production build                 |
| `pnpm format` | Prettier                                 |

## Access model (RBAC)

Roles: `user` (default — **no patient-data access**), `technician`,
`radiologist`, `admin`. A new account must be promoted to a clinical role before
it can read any PHI. Destructive actions (delete, Orthanc C-MOVE) are
admin-only. Full table in [`SECURITY.md`](SECURITY.md).

## Status — implemented vs preview

**Working:** DICOM import (drag & drop / folder), 2D viewer (stack, window/level,
zoom/pan, length/angle/ROI annotations), windowing presets, ZIP & PDF export,
study/series/instance browsing, notifications, on-demand anonymisation
(best-effort), Orthanc query (when an Orthanc server is configured).

**Preview / not implemented:** MPR (visual crosshair overlay only — not a real
reconstruction), 3D volume rendering (unavailable), HU statistics (best-effort).
These are clearly labelled in the UI as non-diagnostic.

## License

MIT.
