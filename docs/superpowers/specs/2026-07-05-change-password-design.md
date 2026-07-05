# Changer mon mot de passe — design

Date : 2026-07-05 · Statut : validé (mode autonome gérant) · Portée : horos-viewer (MediView)

## Problème

L'app n'offre aucun moyen self-service de changer son mot de passe. Chaque oubli ou
rotation passe par une intervention manuelle (reset bcrypt en base via le chat/SSH),
ce qui fait transiter des identifiants par des canaux non prévus pour ça. Deux
rotations ont déjà eu lieu ainsi (2026-07-03 et 2026-07-04).

## Objectifs

- L'utilisateur connecté change son mot de passe seul, depuis l'interface.
- Toutes les autres sessions sont révoquées immédiatement (`sessionVersion`).
- La session de l'appareil courant survit (cookie ré-émis après le bump).
- Aucun identifiant ne transite hors de l'app.

## Hors périmètre (non-objectifs)

- « Mot de passe oublié » par email (pas de SMTP fiable branché à ce jour).
- Gestion des mots de passe d'autres comptes par un admin.
- Compte de service dédié pour `eva-capture` (incrément suivant — voir Impacts).

## Conception

### Serveur — `auth.changePassword` (tRPC, `protectedProcedure`)

Entrée zod : `{ currentPassword: string().min(1), newPassword: string().min(12).max(128) }`.

1. Charger l'utilisateur par `ctx.user.openId` (`getUserByOpenId`).
2. Vérifier `currentPassword` contre `passwordHash` (`verifyPassword`).
   Échec → `UNAUTHORIZED` message générique « Mot de passe actuel incorrect »
   (pas d'oracle sur l'existence du hash).
3. Refuser `newPassword === currentPassword` (`BAD_REQUEST`).
4. `hashPassword(newPassword)` (bcrypt 12 rounds, existant) →
   `updateUserPassword(openId, hash)` (nouveau helper `db.ts`).
5. `bumpSessionVersion(openId)` — révoque tous les JWT émis avant.
6. Ré-émettre le cookie de session courant : `sdk.createSessionToken(openId)`
   (snapshotte la NOUVELLE `sessionVersion`) + `res.cookie` mêmes options que login.

### Client — dialog dans l'en-tête worklist (`Home.tsx`)

- Bouton icône `KeyRound` (title « Changer le mot de passe ») à côté du logout.
- Dialog 3 champs (actuel, nouveau, confirmation), `type=password`,
  `autocomplete` correct (`current-password` / `new-password`).
- Validation client : longueur ≥ 12, confirmation identique — logique pure
  extraite dans `client/src/lib/passwordChange.ts` (testable).
- Succès : toast « Mot de passe changé. Les autres sessions ont été déconnectées. »
- Erreur serveur affichée dans le dialog (générique).

### Tests

- `server/auth.changePassword.test.ts` : mauvais mdp actuel → UNAUTHORIZED ;
  nouveau = actuel → BAD_REQUEST ; succès → hash mis à jour + `bumpSessionVersion`
  appelé + cookie ré-émis ; zod rejette < 12 caractères.
- `client/src/lib/passwordChange.test.ts` : validation pure.

## Impacts connus

- Le service `eva-capture-mediview` (VPS 76) se connecte avec le compte du gérant :
  après un changement de mot de passe, son `MEDI_PASSWORD` doit être mis à jour,
  sinon le navigateur piloté ne se logue plus. Correctif durable = compte de
  service dédié (rôle limité) — chantier séparé.

## Approches écartées

- Page dédiée `/compte` : sur-structure pour une app mono-utilisateur (YAGNI).
- Reset admin/CLI : ne résout pas le problème (identifiants toujours hors app).
