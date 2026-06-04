# AGENTS.md — Horos Viewer

Visualiseur DICOM / mini-PACS full-stack inspiré de Horos / OsiriX. Permet à des
utilisateurs cliniques d'importer, parcourir, visualiser et annoter des études
DICOM, de les exporter (ZIP / PDF) et d'interroger un PACS Orthanc. Les types
sont partagés de bout en bout via le routeur tRPC et le schéma Drizzle.

## Stack

- **Frontend :** React 19, Vite 7, Tailwind 4, Radix UI, Cornerstone3D (rendu
  DICOM), wouter (routing), TanStack Query + client tRPC.
- **Backend :** Express 4, tRPC 11, Drizzle ORM (MySQL), `jose` (JWT de
  session), stockage S3 présigné (Forge), nodemailer, proxy Orthanc DICOMweb.
- **Shared :** types/constantes partagés client ↔ serveur.
- **Outils :** TypeScript (strict), Vitest, Prettier, esbuild, drizzle-kit.

## Structure du repo

```
client/         App React — code dans client/src
  src/_core/    Plumbing framework (à ne pas modifier sans raison)
  src/pages/    Pages
  src/components/, hooks/, contexts/, lib/, const.ts
server/         API Express + tRPC, services
  routers.ts    Routeur tRPC principal (procédures + RBAC)
  rbac.ts       Définition des rôles / procédures protégées
  db.ts         Accès base de données (Drizzle)
  orthanc.ts    Intégration PACS Orthanc (C-FIND / C-MOVE)
  email.ts, storage.ts, export.*
  _core/        Plumbing framework (auth, cookies, oauth, sdk, storageProxy…)
shared/         Types/constantes partagés (types.ts, const.ts, _core/errors.ts)
drizzle/        Schéma DB + migrations SQL (drizzle/migrations, drizzle/meta)
```

Alias d'import : `@/*` → `client/src/*`, `@shared/*` → `shared/*`.

## Commandes

Le projet utilise **pnpm**. Scripts réellement définis dans `package.json` :

| Commande        | Rôle                                                  |
| --------------- | ----------------------------------------------------- |
| `pnpm dev`      | Serveur de dev (Vite + API) via `tsx watch`           |
| `pnpm build`    | Build prod (Vite client + esbuild bundle serveur)     |
| `pnpm start`    | Lance le build de production (`dist/index.js`)        |
| `pnpm check`    | Type-check TypeScript (`tsc --noEmit`)                |
| `pnpm test`     | Tests Vitest (`vitest run`)                           |
| `pnpm format`   | Formatage Prettier (`prettier --write .`)             |
| `pnpm db:push`  | Migrations Drizzle (`drizzle-kit generate && migrate`)|

Mise en route : `pnpm install`, copier `.env.example` → `.env` (renseigner les
valeurs, `JWT_SECRET` obligatoire et ≥ 16 caractères), puis `pnpm db:push` et
`pnpm dev`.

## Conventions

- **Formatage (Prettier, `.prettierrc`) :** point-virgules, `printWidth` 80,
  `tabWidth` 2 espaces, double quotes (JS et JSX), `trailingComma: es5`,
  `arrowParens: avoid`, `endOfLine: lf`. Lancer `pnpm format` avant de committer.
- **TypeScript :** mode `strict`, `noEmit`, `moduleResolution: bundler`,
  `module: ESNext`. Préférer le type-check via `pnpm check`.
- **Patterns observés :** API exposée via procédures tRPC dans `server/routers.ts`,
  gardées par les procédures RBAC (`medicalProcedure`, `adminProcedure`,
  `strictAdminProcedure` — cf. `server/rbac.ts`). Accès DB centralisé dans
  `server/db.ts` (Drizzle, requêtes paramétrées). Les types côté client
  proviennent du routeur tRPC. Les dossiers `_core/` (client et serveur) sont du
  plumbing framework — éviter de les modifier sans nécessité.

## Tests

- Framework : **Vitest** (`vitest.config.ts`, environnement `node`).
- Les tests vivent à côté du code serveur : `server/**/*.test.ts`
  (ex. `routers.test.ts`, `export.test.ts`, `auth.logout.test.ts`).
- Lancer : `pnpm test`.
- Note : la couverture est faible ; ni l'anonymiseur ni le RBAC critique ne sont
  couverts (cf. AUDIT.md).

## À savoir / pièges

- **Pas un dispositif médical certifié.** Projet de développement, ne doit pas
  servir au diagnostic primaire. Manipule du PHI / DICOM (données de santé).
- **Features en preview / non implémentées :** MPR (overlay crosshair visuel
  uniquement, pas de vraie reconstruction), rendu volumique 3D (indisponible),
  statistiques HU (best-effort). Étiquetées non-diagnostiques dans l'UI.
- **Anonymisation best-effort et non fiable** (`anonymizeDicomBuffer`) :
  parsing Explicit VR seulement, séquences imbriquées et PHI brûlé dans les
  pixels non traités. Ne pas considérer comme une garantie (voir SECURITY.md /
  AUDIT.md).
- **Modèle d'accès (RBAC) :** rôles `user` (défaut — **aucun accès aux données
  patient**), `technician`, `radiologist`, `admin`. Un nouveau compte doit être
  promu à un rôle clinique avant de lire le moindre PHI. Actions destructives
  (suppression, Orthanc C-MOVE) réservées à `admin`. Table complète dans
  SECURITY.md.
- **Limites connues (AUDIT.md) :** pas d'audit trail d'accès PHI, pas de rate
  limiting (upload 50 Mo), session JWT longue durée non révocable, cookie
  `sameSite: "none"` sans token CSRF, pas de clés étrangères dans le schéma.
  Voir AUDIT.md et SECURITY.md avant tout usage clinique réel.
```
