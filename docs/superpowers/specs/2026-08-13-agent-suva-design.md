# Agent SUVA — traitement automatique des demandes d'imagerie assureur

Date : 2026-08-13 · Statut : implémenté (feat/agent-suva) — déploiement en attente

## Problème

Les demandes d'imagerie de la SUVA arrivent par email ou par courrier papier.
Elles contiennent l'identité du patient (nom, prénom, date de naissance,
téléphone) et la liste des examens demandés (modalité, dates). Le traitement
est aujourd'hui manuel : retrouver le patient dans MediView, exporter les
études et le compte-rendu, répondre à la SUVA.

## Objectif

Le gérant transfère le mail SUVA (ou le scan/photo de la feuille papier) vers
une boîte dédiée. Un agent intégré à MediView :

1. extrait l'identité patient et les examens demandés (texte + pièces jointes) ;
2. identifie le patient par concordance multi-critère ;
3. retrouve les études correspondantes ;
4. prépare la réponse : CR PDF en pièce jointe + lien sécurisé vers le ZIP DICOM ;
5. envoie automatiquement si le match est parfait, sinon demande une
   validation 1 clic ;
6. journalise chaque étape dans l'audit trail existant.

## Hors périmètre (non-goals)

- Autres assureurs que la SUVA (le design reste généralisable : table et
  module nommés `insurer`, pas `suva` ; seule la config d'auto-envoi est
  spécifique SUVA).
- Lecture du courrier papier non scanné.
- Écriture dans le PACS (lecture seule).
- Relance ou réponse automatique à la SUVA quand des examens sont
  introuvables : ces cas passent toujours par la validation du gérant.
- Traitement de mails non transférés par le cabinet (jamais d'envoi auto).

## Architecture (approche retenue : tout dans MediView)

Nouveau module `server/insurer/` dans horos-viewer. Aucun nouveau service ;
le PHI reste dans le périmètre MediView déjà audité (17,5/20).

### 1. Ingestion

- Boîte dédiée sur le Mailu du VPS72 (ex. `suva@mediview.ch` — le domaine
  exact est déterminé à l'implémentation selon les domaines servis par Mailu).
- `server/insurer/mailPoller.ts` : poller IMAP (`imapflow`), intervalle
  2 min. **No-op si `INSURER_IMAP_HOST/USER/PASS` absents** (pattern
  `gpuControl`). Démarré depuis l'init serveur.
- Chaque message : ligne `insurer_requests` (idempotence par `Message-ID`),
  corps + pièces jointes stockés dans MinIO sous `insurer/<requestId>/…`
  (chiffrement au repos SSE-S3 existant). Le mail est marqué lu/archivé.

### 2. Extraction (`server/insurer/extractRequest.ts`)

- Sortie JSON structurée : `{ patient: {nom, prenom, ddn, tel},
exams: [{modalite, dateDemandee, description}], refSinistre,
adresseReponse, confiance }`.
- Texte du mail → LLM CH (Infomaniak texte, repli Ollama local) —
  jamais de fournisseur US.
- Pièces jointes image (feuille SUVA photographiée/scannée en JPEG/PNG) →
  vision Infomaniak gemma. PDF : texte extrait côté serveur (`pdf-parse`) et
  concaténé au corps ; un PDF image pur (scan sans couche texte) est stocké
  mais non lu automatiquement ⇒ la demande passe en validation (jamais
  d'envoi auto sur ce cas).
- Score de confiance par champ ; tout champ sous le seuil ⇒ « à valider ».

### 3. Identification (`server/insurer/matchPatient.ts`, `matchStudies.ts`)

- Normalisation (accents, casse, espaces) puis concordance multi-critère —
  **jamais la DDN seule** : match parfait = nom + prénom + DDN concordent
  avec exactement UN patient ; le téléphone sert de critère de renfort,
  jamais de critère unique.
- Études du patient filtrées par modalité + date. Tolérance ±7 jours,
  marquée `dateApprochee` si non exacte (⇒ validation).
- Match parfait global = patient unique ET chaque examen demandé apparié à
  au moins une étude, dates exactes.

### 4. Colisage & envoi (`server/insurer/packageAndSend.ts`)

- Par étude : CR PDF (export `pdf-report` existant) + ZIP DICOM streamé
  depuis MinIO (`archiver`), stocké `insurer/<requestId>/bundle-<studyId>.zip`.
- Nouvelle table `insurer_bundle_tokens` : jeton 256 bits aléatoire **haché**
  en base, expiration 14 jours, compteur + journal des téléchargements,
  révocable depuis l'UI. Route publique de téléchargement avec rate-limit
  (même traitement que `/r/:token`).
- Mail de réponse : CR(s) PDF en pièces jointes (si < 15 Mo au total, sinon
  inclus dans le ZIP), lien de téléchargement, récapitulatif des examens.
- Garde d'egress : `isAllowedPhiRecipientStrict` (fail-closed) ; `suva.ch`
  ajouté à `REPORT_EMAIL_ALLOWED_DOMAINS` en prod.

### 5. Envoi automatique — conditions cumulatives

L'envoi SANS validation exige TOUTES ces conditions :

1. le mail entrant provient d'une adresse de l'allow-list expéditeurs du
   cabinet (`INSURER_TRUSTED_SENDERS`) — un mail d'un inconnu ne déclenche
   JAMAIS d'envoi auto (anti-abus / anti-injection de prompt) ;
2. match patient parfait (un seul patient, nom+prénom+DDN exacts) ;
3. toutes les études demandées trouvées, dates exactes ;
4. adresse de réponse en `@suva.ch`.

Sinon : statut `a_valider`, notification email au gérant, traitement via la
page « Demandes assureurs ».

Le contenu des mails entrants est traité comme NON FIABLE : les instructions
qu'il pourrait contenir ne sont jamais exécutées ; l'extraction est du
parsing pur vers un schéma fermé.

### 6. UI de validation

- Routeur tRPC `insurer.*` : `list`, `detail`, `approve` (envoie),
  `reject`, `revokeToken`, `resend`. Accès : rôles admin/médecin
  (`medicalProcedure` existant).
- Page `/demandes-assureurs` : liste avec statuts, détail montrant ce qui a
  été lu (extraction), le patient identifié, les études trouvées/manquantes,
  aperçu du mail sortant, bouton « Valider et envoyer ».
- Notification email au gérant à chaque nouvelle demande `a_valider` et
  récapitulatif après chaque envoi auto.

### 7. Cycle de vie (`insurer_requests.statut`)

`recue → extraite → identifiee → prete → envoyee | a_valider → envoyee | rejetee`
(+ `erreur` avec motif ; toute transition journalisée dans l'audit trail).

## Données

- `insurer_requests` : id, messageId (unique), expediteur, sujet, recuLe,
  statut, extraction (json), patientId?, studyIds (json), adresseReponse,
  motifValidation?, envoyeLe?, envoyePar? (user ou 'auto'), erreur?.
- `insurer_bundle_tokens` : id, requestId, tokenHash, expireLe,
  telechargements (json : ts + IP), revoqueLe?.

## Sécurité / nLPD

- Extraction et vision : fournisseurs CH/local uniquement (Infomaniak,
  Ollama VPS72). Aucun PHI vers les US.
- Envoi à la SUVA = communication justifiée (LAA) ; l'auto-envoi est
  verrouillé par les 4 conditions ci-dessus.
- Stockage MinIO chiffré au repos ; jetons hachés en base ; liens à
  expiration courte, révocables, téléchargements journalisés.
- Rate-limit sur la route publique de téléchargement ; pas d'énumération
  possible (jeton 256 bits, réponse générique 410).

## Tests

- Unitaires (vitest) : parsing/extraction sur fixtures (mail texte, feuille
  scannée — fixtures anonymisées), matching (homonymes, DDN divergente,
  accents), conditions d'auto-envoi (chaque condition manquante ⇒
  `a_valider`), gardes egress, cycle de vie des jetons (expiration,
  révocation).
- Intégration : redeem du lien (200 puis 410 après expiration/révocation).
- E2E manuel avant mise en prod : un vrai mail SUVA transféré en staging.
- Rappel CI : `vitest run` COMPLET avant push (piège connu du repo).

## Déploiement

- Migrations Drizzle (2 tables) — application MANUELLE via `mysql-medical`
  (procédure connue, `__drizzle_migrations` non fiable).
- Env prod : `INSURER_IMAP_HOST/PORT/USER/PASS`, `INSURER_TRUSTED_SENDERS`,
  `INSURER_AUTO_SEND_DOMAINS=suva.ch`, ajout `suva.ch` à
  `REPORT_EMAIL_ALLOWED_DOMAINS`.
- Création de la boîte Mailu + test IMAP avant activation du poller.
- Procédure : build Mac → tgz → VPS76 → VPS72, `Dockerfile.prebuilt`,
  `--force-recreate`, pings post-deploy habituels.
