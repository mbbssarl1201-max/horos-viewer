# Audit complet — Horos Viewer

**Projet :** `horos-viewer`
**Branche auditée :** `security-hardening`
**Date :** 2026-06-03
**Nature :** visualiseur DICOM médical full-stack manipulant des données de santé (PHI)
**Stack :** React 19 · tRPC 11 · Drizzle ORM / MySQL · Express · Cornerstone3D · Orthanc PACS · S3 (Forge) · OAuth Manus + JWT de session

> Un travail de durcissement préalable est documenté dans [`SECURITY.md`](SECURITY.md).
> Cet audit **confirme** ces correctifs et **ajoute** plusieurs problèmes non listés, dont un bug de confidentialité actif.

---

## 🔴 Critique / Élevé

### 1. L'anonymisation de l'identité patient ne fonctionne pas (fuite PHI)
**Fichier :** `server/routers.ts:215-249`

L'endpoint `studies.anonymize` mappe `patientName`, `patientId`, `birthDate` puis exécute :

```ts
await db.update(studies).set(updateData)...
```

Or **ces colonnes n'existent pas sur la table `studies`** : elles sont sur la table `patients`
(cf. `drizzle/schema.ts` ; `getStudyById` les récupère via `leftJoin(patients)`).

**Conséquence :**
- soit Drizzle lève une erreur et l'anonymisation échoue entièrement ;
- soit ces champs sont silencieusement ignorés → **nom, ID et date de naissance du patient restent intacts** alors que l'UI confirme « anonymisé ».

Seuls `referringPhysician`, `institution`, `accessionNumber` (réellement sur `studies`) sont effacés.
**L'information la plus sensible n'est jamais masquée.**

**Correctif :** mettre à jour la table `patients` pour ces trois champs.

---

### 2. Anonymiseur DICOM binaire non fiable
**Fichier :** `server/routers.ts:32-106`

`anonymizeDicomBuffer` suppose un **Explicit VR** (lit 2 octets ASCII en `offset+4` comme VR).
Pour un transfer syntax **Implicit VR Little Endian** (très courant), ces octets font partie de la
longueur → mauvais parsing, décalage, PII non effacée. De plus :

- ne traite pas les **séquences imbriquées (SQ)** ni les tags privés ;
- n'efface **pas le PHI brûlé dans les pixels** (échographie / capture secondaire).

« Best-effort » documenté, mais à ne **pas** considérer comme une garantie d'anonymisation.

**Correctif :** utiliser une vraie librairie (`dcmjs`) ou déléguer l'anonymisation à Orthanc.

---

### 3. Aucune journalisation d'accès (audit trail) — exigence HIPAA
**Portée :** globale

Aucun log d'accès aux PHI (qui a vu / exporté / supprimé quelle étude). Tout rôle clinique voit
**toutes** les études (pas de cloisonnement par patient / établissement). L'absence de piste d'audit
est un manquement de conformité majeur pour une application de santé.

**Correctif :** table `access_log` (userId, action, studyId, timestamp, IP) écrite sur chaque accès PHI.

---

## 🟠 Moyen

### 4. Injection de chemin / SSRF dans le proxy Orthanc
**Fichier :** `server/orthanc.ts:167-205` (`cFind`), `server/orthanc.ts:210` (`cMove`)

`params.aet` (validé seulement par `z.string()`) est interpolé **sans encodage** :

```ts
orthancFetch(`/modalities/${params.aet}/query`, ...)
```

Un `aet` contenant `/`, `..` ou une query permet d'atteindre des endpoints Orthanc arbitraires.
`cFind` est ouvert à **tout rôle clinique**. Idem `query: z.record(z.string(), z.string())` transmis tel quel.

**Correctif :** `z.string().regex(/^[A-Za-z0-9_-]+$/)` sur l'AET + `encodeURIComponent`.

---

### 5. CSRF + cookie `sameSite:"none"`
**Fichier :** `server/_core/cookies.ts:42-47`

`sameSite:"none"` sans token CSRF. Les mutations tRPC (JSON → preflight CORS) sont partiellement
protégées, **mais les routes d'export en GET** (`server/_core/index.ts:40` et `:98`) sont déclenchables
cross-site et **téléchargent du PHI**. `secure` dépend de `x-forwarded-proto` : derrière un proxy mal
configuré, le cookie de session peut partir en clair ou être rejeté.

**Correctif :** token CSRF, `sameSite:"lax"` si possible, forcer `secure` en production.

---

### 6. Session JWT d'1 an, sans révocation
**Fichier :** `server/_core/sdk.ts:194` · `server/routers.ts:138`

Le `logout` ne fait qu'un `clearCookie` côté client. Un JWT volé reste valide **un an** : pas de liste
de révocation, pas de rotation, pas de version de session en base.

**Correctif :** durée courte + refresh token + invalidation serveur (champ `sessionVersion`).

---

### 7. Aucune limite de débit + uploads 50 Mo
**Fichier :** `server/_core/index.ts:35`

`express.json({ limit: "50mb" })` + import DICOM base64 via tRPC, sans rate limiting → DoS mémoire et abus.

**Correctif :** `express-rate-limit` + limite de taille / fréquence d'upload.

---

### 8. `pacsServers` accessible au rôle `user` par défaut
**Fichier :** `server/routers.ts:580-625`

`list/create/delete` en `protectedProcedure` (tout compte connecté), alors que tout le domaine est en
`medicalProcedure`. Incohérent avec le modèle PHI.

**Correctif :** aligner sur `medicalProcedure` / `adminProcedure`.

---

## 🟡 Faible / Qualité

- **Race condition `findOrCreatePatient`** (`server/db.ts:193`) : `patients.patientId` n'est pas unique
  (seulement indexé) → imports concurrents = doublons patients. Ajouter `.unique()` + `onDuplicateKeyUpdate`.
- **Notifications mal ciblées** : `updateStatus`/`updatePriority` notifient `ctx.user.id` (l'auteur) au lieu
  des destinataires (`server/routers.ts:175` et `:203`).
- **Pas de clés étrangères / cascade** : suppression manuelle dans `studies.delete` ; les `albums` ne sont
  jamais nettoyés.
- **Fuite de messages d'erreur** vers le client (`err.message`) dans Orthanc / export.
- **Injection HTML possible dans les emails** (`server/email.ts`) si `patientName` contient du HTML — à échapper.
- **`findAvailablePort`** (`server/_core/index.ts:22`) : démarrage sur un port différent silencieusement →
  désync OAuth redirect / cookies.
- **`import` dynamiques répétés** dans presque chaque handler tRPC : à hisser en haut de fichier.
- **Couverture de tests faible** : 3 fichiers ; ni l'anonymiseur ni le RBAC critique ne sont testés.
- **MPR / 3D** : placeholders UI, pas de vraie reconstruction.

---

## ✅ Points positifs confirmés

- JWT refuse de signer / vérifier avec un secret `< 16` car. (`server/_core/sdk.ts:157`).
- Proxy `/manus-storage/*` correctement gated (auth + rôle clinique) (`server/_core/storageProxy.ts:7`).
- Modèle de rôles cohérent et bien découpé (`medical` / `admin|radiologist` / `strictAdmin`) (`server/routers.ts:110-131`).
- `markNotificationRead` scopé par `userId` (anti-IDOR) (`server/db.ts:349`).
- Requêtes via Drizzle paramétrées → **pas d'injection SQL**.
- `.env` gitignored, `.env.example` clair, secrets hors code.

---

## Synthèse priorisée

| #  | Sévérité | Problème                                      | Fichier              |
|----|----------|-----------------------------------------------|----------------------|
| 1  | 🔴       | Anonymisation patient cassée (PHI conservé)   | `routers.ts:215`     |
| 2  | 🔴       | Anonymiseur DICOM non fiable (implicit VR)    | `routers.ts:32`      |
| 3  | 🔴       | Aucun audit trail (HIPAA)                     | global               |
| 4  | 🟠       | Injection chemin / SSRF Orthanc (`aet`)       | `orthanc.ts:167`     |
| 5  | 🟠       | CSRF + export GET de PHI                       | `cookies.ts` / `index.ts` |
| 6  | 🟠       | Session 1 an non révocable                    | `sdk.ts:194`         |
| 7  | 🟠       | Pas de rate limiting, upload 50 Mo            | `index.ts:35`        |
| 8  | 🟠       | `pacsServers` ouvert au rôle `user`           | `routers.ts:580`     |

---

## Séquencement recommandé

1. **#1** immédiatement — fuite de confidentialité active et trompeuse.
2. **#4** et **#8** — correctifs rapides à faible risque.
3. **#2 / #3** — anonymisation robuste + audit log, **avant tout usage clinique réel**.
4. **#5 / #6 / #7** — durcissement réseau / session / DoS.

---

*Audit généré le 2026-06-03. Couvre l'intégralité du code serveur (auth, RBAC, routers tRPC, accès DB,
proxy storage, intégration PACS, upload S3, schéma).*
