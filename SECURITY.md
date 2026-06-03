# Security Hardening

This document records the critical security fixes applied to the Horos Viewer
backend. The application handles patient health information (PHI/DICOM) and these
changes close access-control gaps that previously exposed patient data.

## Access model

Roles: `user` (default, **no PHI access**), `technician`, `radiologist`, `admin`.

A freshly registered account gets the `user` role and **cannot read any patient
data**. It must be promoted to a clinical role (`technician`, `radiologist`,
`admin`) before it can list studies, view images or export data. See
[`server/rbac.ts`](server/rbac.ts).

| Action                                   | Required role                         |
| ---------------------------------------- | ------------------------------------- |
| Read studies/series/instances/exports    | clinical (`medicalProcedure`)         |
| View DICOM file via `/manus-storage/*`   | clinical (auth + role check)          |
| Save / list annotations                  | clinical                              |
| Orthanc query / C-FIND / status          | clinical                              |
| Update status / priority / anonymize     | `admin` or `radiologist`              |
| Delete study, Orthanc C-MOVE, test email | `admin` only (`strictAdminProcedure`) |

## Fixes applied

1. **JWT secret hardening** — `server/_core/sdk.ts`
   Sessions are no longer signed or verified with an empty/short key. A missing
   or `< 16` char `JWT_SECRET` now throws instead of producing trivially
   forgeable HS256 tokens. **`JWT_SECRET` is now mandatory.**

2. **Authenticated storage proxy** — `server/_core/storageProxy.ts`
   `GET /manus-storage/*` (which serves raw DICOM) now requires a valid session
   **and** a clinical role. Previously it was fully unauthenticated, allowing
   anyone to download patient files by guessing keys.

3. **PHI access control (IDOR)** — `server/routers.ts`
   All study/series/instance/export/annotation reads and the DICOM import are
   gated behind `medicalProcedure`. The default `user` role can no longer read
   any patient data.

4. **Least privilege for destructive actions** — `server/routers.ts`
   - `studies.delete` and `orthanc.cMove` (study exfiltration) are restricted to
     `admin` only.
   - `studies.delete` now also removes child annotations, notifications and
     album links instead of leaving them orphaned.

5. **Notification IDOR** — `server/db.ts`
   `markNotificationRead` is scoped by `userId`; a user can only mark their own
   notifications as read.

6. **Authenticated export routes** — `server/_core/index.ts`
   `/api/export/dicom-zip/:studyId` and `/api/export/pdf-report/:studyId` now
   require a clinical role (previously any authenticated account).

7. **Restored missing migration** — `drizzle/0000_workable_ultragirl.sql`
   The `users` table migration referenced by the journal was missing, breaking
   `pnpm db:push` on a fresh database. It has been restored.

## Known remaining items (not in this pass)

These were identified in the audit but are intentionally out of scope for this
security pass and should be addressed before any production/clinical use:

- DICOM binary anonymizer (`anonymizeDicomBuffer`) is best-effort and unreliable
  for implicit-VR / nested sequences.
- Cookie `sameSite: "none"` and absence of CSRF tokens.
- No foreign keys / indexes in the schema.
- MPR / 3D viewer modes are UI placeholders, not real reconstructions.
