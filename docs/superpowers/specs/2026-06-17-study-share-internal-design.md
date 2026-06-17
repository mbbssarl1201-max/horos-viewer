# MediView — partage interne d'étude (remplace « Cloud Sharing ») — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-17 · **Repo** : `horos-viewer` (MediView)
> Conformité : [[respecter-lois-suisses]] [[nlpd-recommendations-non-negotiable]] [[keep-projects-separate]].
> Cf. [[mediview-horos-parity]] (bloc « Cloud/partage »).

## Problème

Le bouton « Cloud Sharing » de Horos est un **stub « coming soon »** dans MediView. Le gérant veut un
partage d'étude **conforme nLPD** (pas de cloud US, PHI dans le périmètre). Décisions du brainstorming :
**partage INTERNE** (vers un compte MediView authentifié) + **étude complète (images + CR)**.

**Réalité mono-tenant** : tous les comptes cliniques voient déjà toutes les études (worklist partagé,
« faux positif IDOR » assumé). Donc « partager » **n'octroie pas un accès** (il existe déjà) — c'est une
**transmission/prise en charge** : notifier un confrère qu'une étude lui est adressée, avec une note.

## Objectifs (succès)

1. Depuis une étude (worklist + viewer), action **« Partager »** → choisir un **destinataire** parmi les
   comptes **cliniques** (admin/radiologist/technician), + **note** facultative.
2. Le destinataire reçoit une **notification** « Étude transmise par <expéditeur> » (réutilise l'infra
   `notifications` + `NotificationsPanel`) ; un clic ouvre l'étude `/viewer/<studyId>`.
3. Le stub **« Cloud Sharing »** ouvre cette boîte (fin du « coming soon »).
4. **PHI-safe** : aucun accès nouveau, aucune sortie du périmètre, **audité** (`recordAccess`).

## Non-objectifs (hors scope)

- ❌ **Lien externe / OTP** (destinataire sans compte) → incrément séparé (registre DEP nLPD requis).
- ❌ Octroi/scoping d'accès par étude (le modèle reste mono-tenant — accès déjà global).
- ❌ Duplication de l'**email du CR au confrère** (`email.sendStudyReport`, existe déjà).
- ❌ Cloud US / stockage externe. ❌ Notification temps réel (la liste se rafraîchit comme aujourd'hui).

## Architecture

```
drizzle/schema.ts : notifications.type enum += "shared_study"  → migration 0009 (drizzle-kit generate)
server/db.ts      : createNotification type union += "shared_study" ; listClinicalUsers(excludeUserId)
server/studyShare.ts (PUR) : buildShareNotification(senderName, note) → { title, message }
server/routers.ts :
  users.listClinical  (medicalProcedure)  → [{ id, name, email, role }] (rôles cliniques, hors soi)
  studies.share       (medicalProcedure)  → { studyId, recipientUserId, note? }
        anti-IDOR getStudyById (404) · rate-limit (study.share) · createNotification(dest, shared_study,…)
        · recordAccess("study.share")
client :
  ShareStudyDialog.tsx : sélecteur destinataire + note → studies.share
  Home.tsx  : action « Partager » (menu étude) + le bouton « Cloud Sharing » ouvre la boîte
  Viewer.tsx (option) : bouton « Partager » l'étude courante
  NotificationsPanel.tsx : notif `shared_study` cliquable → navigate(/viewer/<studyId>)
```

### Composants

- **`drizzle/schema.ts`** : ajouter `"shared_study"` à l'enum `notifications.type`. Générer la migration
  `0009_*.sql` via `pnpm exec drizzle-kit generate` (1 `ALTER TABLE … MODIFY … ENUM(...)`).
- **`server/db.ts`** :
  - `createNotification` : étendre le type `type` avec `"shared_study"`.
  - `listClinicalUsers(excludeUserId: number): Promise<Array<{ id; name; email; role }>>` — `select`
    sur `users` où `role IN ('admin','radiologist','technician')` et `id <> excludeUserId`.
- **`server/studyShare.ts`** (nouveau, PUR) :
  - `buildShareNotification(senderName: string, note?: string): { title: string; message: string }`
    → `title: "Étude transmise par " + (senderName||"un confrère")` ; `message: (note||"").slice(0,1000)`.
- **`server/routers.ts`** :
  - `users.listClinical: medicalProcedure.query` → `listClinicalUsers(ctx.user.id)`.
  - `studies.share: medicalProcedure.mutation({ studyId:int, recipientUserId:int, note?:string≤1000 })` :
    rate-limit `countRecentAccess("study.share",60) < 60` ; `getStudyById` (404) ; vérifier que
    `recipientUserId` est un compte clinique existant (sinon 400) ; `buildShareNotification(ctx.user.name)` ;
    `createNotification({ userId: recipientUserId, type:"shared_study", title, message, studyId })` ;
    `recordAccess("study.share", studyId, detail:"to=<recipientId>")`.
- **`client/src/components/ShareStudyDialog.tsx`** (nouveau) : props `{ studyId, open, onClose }` ;
  `users.listClinical` (query) → `<select>` destinataire + `<textarea>` note → `studies.share` ;
  toast succès/échec.
- **`Home.tsx`** : entrée « Partager… » dans le menu d'une étude sélectionnée + le bouton **Cloud
  Sharing** (l. ~496) ouvre `ShareStudyDialog` (au lieu du toast). Désactivée si aucune étude sélectionnée.
- **`NotificationsPanel.tsx`** : rendre une notif avec `studyId` cliquable → `navigate("/viewer/"+studyId)`
  (+ `markRead`). Vérifier si déjà le cas ; sinon l'ajouter.

## Gestion d'erreurs

- Aucun destinataire choisi → bouton désactivé. Étude introuvable → 404. Destinataire non clinique /
  inexistant → 400. Rate-limit → 429. `getDb` null → no-op silencieux (comme `createNotification`).
- Auto-partage (destinataire = soi) exclu côté liste ; refusé côté serveur (400) par sécurité.

## Tests

- **Pur** : `buildShareNotification` (title avec nom expéditeur ; nom vide → « un confrère » ; note
  tronquée à 1000 ; note absente → message vide).
- **Intégration (mocks)** : `studies.share` → 404 si étude absente ; crée la notif pour le bon `userId`
  avec `type:"shared_study"` + `studyId` ; 400 si destinataire = soi ou non clinique ; `recordAccess`
  appelé. `listClinicalUsers` exclut l'appelant et les rôles non cliniques.

## Intégration & déploiement

- **Migration 0009** (enum) appliquée par le service `migrate` au déploiement (`up -d migrate`, exit 0).
- Branche `feat/study-share-internal`. Gate CI (tsc+tests+audit) → build GHCR → compose VPS →
  **healthz 200 + garde 401**. Vérif : « Partager » sur une étude → notif chez le destinataire →
  clic ouvre l'étude. `study.share` non authentifié → 401.

## nLPD / conformité

Partage **interne** entre comptes authentifiés du **même périmètre** (aucune sortie de PHI, aucun cloud
US) ; pas d'octroi d'accès nouveau (mono-tenant) ; chaque partage **audité** (`recordAccess`). Lien
externe/OTP **exclu** ici (exigerait registre DEP). Cf. [[respecter-lois-suisses]]
[[nlpd-recommendations-non-negotiable]].
