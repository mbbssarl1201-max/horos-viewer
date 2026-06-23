# Agent CR autonome — Incrément 1 : pipeline autonome (design)

**Date** : 2026-06-23
**Projet** : MediView (horos-viewer), branche prod `self-host`.
**Statut** : design validé par le gérant (brainstorming).

## Problème

La rédaction manuelle des comptes rendus est chronophage. On veut que MediView prépare
seul les CR à partir du flux : le médecin n'a plus qu'à relire / corriger / signer, et
l'envoi au médecin référent est automatique **après signature**. (L'apprentissage des
corrections = incrément 2, hors de ce spec.)

## Objectifs (incrément 1)

1. À l'arrivée d'une **nouvelle étude** (déjà dans la base via le flux), un worker
   génère **seul** un brouillon de CR (moteur existant `runAiPreanalysis`, mode dossier
   - RAG + prompt enrichi) et l'enregistre comme **report non signé `aiGenerated`**.
2. Les brouillons apparaissent dans une **« File à signer »**.
3. Le médecin ouvre, relit/corrige, **signe** → un **e-mail sécurisé** part automatiquement
   au **médecin référent** (réutilise `sendStudyReport`, audit/egress déjà gérés).

## Non-objectifs (hors périmètre)

- Boucle d'apprentissage (diff brouillon→signé → propositions de fiches) = **incrément 2**.
- Détecteurs certifiés CE (connecteur séparé déjà livré).
- Envoi **direct au patient**.
- Envoi **sans signature** d'un médecin (interdit).
- Modification automatique de la base de connaissances.
- Backfill massif de l'historique (on ne traite que les nouvelles études).

## Architecture

Worker de fond démarré au boot (même point que `recoverStaleAiJobs` dans
`server/_core/index.ts`), exécuté à intervalle régulier. Il sélectionne les études
éligibles, génère les brouillons en tâche de fond (réutilise la table `ai_jobs` pour le
suivi + un plafond/jour), enregistre un report non signé. La file et l'envoi réutilisent
les rails existants (reports, signature, `sendStudyReport`).

## Composants

### 1. Schéma (drizzle, migration manuelle — convention repo)

- **Réutilise** `reports` : un report avec `aiGenerated = true` et `signedAt IS NULL`
  = « brouillon agent en attente de signature ». (Pas de nouveau champ d'état requis.)
- **Nouvelle table `referring_contacts`** : résolution nom de référent → e-mail.
  - `id` PK, `cabinetId` (cloisonnement), `name` varchar(256) (clé de recherche,
    normalisée), `email` varchar(256), `createdAt`, `updatedAt`.
  - Index sur `(cabinetId, name)`.
- **Nouvelle table `agent_settings`** (ou réglage clé/valeur) : `enabled` boolean,
  `enabledAt` timestamp (ne traiter que les études postérieures), `dailyCap` int
  (plafond d'analyses/jour), `lastRunAt`. Une ligne par cabinet.

### 2. Worker — `server/report/autoReportAgent.ts`

- `findEligibleStudies(cabinetId, since, limit)` : études **sans report**, créées après
  `enabledAt`, hors séries non diagnostiques uniquement (réutilise la logique existante),
  limitées par le plafond restant du jour.
- `runAgentOnce()` : pour chaque cabinet `enabled`, prend N études éligibles (N =
  plafond/jour restant), pour chacune : crée un `ai_jobs` (suivi), appelle
  `runAiPreanalysis({ studyId, seriesId: <série diagnostique>, wholeStudy: true })`,
  puis **insère un report** (`aiGenerated: true`, sections remplies, non signé).
  **Idempotent** : skip si un report existe déjà OU si un job est en cours pour l'étude.
- Démarrage : `startAutoReportAgent()` appelé au boot ; `setInterval` (défaut 5 min,
  configurable ENV `AGENT_POLL_MS`). Fail-soft, jamais throw au boot.
- Plafond : ne génère pas plus de `dailyCap` brouillons / jour / cabinet (coût Opus).

### 3. tRPC (`server/routers.ts`)

- `agent.status` (medicalProcedure) : `{ enabled, enabledAt, dailyCap, pendingCount, generatedToday }`.
- `agent.configure` (adminProcedure) : `{ enabled, dailyCap }` → met à jour `agent_settings`
  (pose `enabledAt = now` à la 1ʳᵉ activation).
- `reports.pendingSignature` (medicalProcedure) : liste des reports `aiGenerated &&
signedAt IS NULL` du cabinet (anti-IDOR), avec infos étude (patient, modalité, date, référent).
- `referringContacts.resolve(name)` / `referringContacts.upsert(name, email)` : mapping référent.

### 4. Signature → envoi auto

- À la signature d'un report agent : résoudre l'e-mail via `referring_contacts`
  (clé = `study.referringPhysician` normalisé). Si trouvé → appeler `sendStudyReportImpl`
  automatiquement. Si absent → renvoyer un statut « e-mail référent requis » ;
  l'UI demande la saisie, qui est mémorisée (`referringContacts.upsert`) puis envoie.
- **Garde dure** : `sendStudyReport` n'est jamais déclenché par l'agent tant que
  `signedAt IS NULL`. Test dédié.

### 5. UI (`client/src/`)

- Page/volet **« File à signer »** : liste des `reports.pendingSignature` (patient,
  modalité, date, référent résolu ou « à renseigner »). Badge « Brouillon IA — à valider ».
- Clic → ouvre `ReportPanel` avec le brouillon chargé → relecture/édition → bouton
  **« Signer & envoyer »** : si e-mail référent manquant, champ de saisie ; puis signe +
  envoie ; sinon signe + envoie directement.
- Réglages agent (admin) : interrupteur ON/OFF + plafond/jour + compteur du jour.

## Flux de données

Nouvelle étude (flux) → worker `runAgentOnce` → `runAiPreanalysis` → insert report
brouillon (`aiGenerated`, non signé) → « File à signer » → médecin relit/édite/signe →
résolution e-mail référent → `sendStudyReport` → audit/egress.

## Gestion d'erreurs / garde-fous

- Agent **OFF par défaut** ; activé explicitement ; **ne traite que les études postérieures
  à `enabledAt`** (pas de backfill massif).
- Génération **fail-soft** : échec → job en erreur, l'étude reste éligible (re-tentée),
  visible dans le statut ; jamais de blocage.
- **Plafond/jour** respecté (coût Opus maîtrisé) ; log de ce qui est différé.
- **Jamais d'envoi sans signature** (garde + test).
- E-mail référent inconnu → **pas d'envoi**, saisie demandée.
- PHI : analyse via moteur actuel (exception Opus US déjà documentée) ; envoi via canal
  sécurisé existant (`sendStudyReport`, audit). Cloisonnement cabinet partout (anti-IDOR).

## Tests

- `findEligibleStudies` : exclut études déjà avec report, antérieures à `enabledAt`,
  respecte la limite.
- Idempotence : 2 passes ne créent pas 2 brouillons.
- Plafond/jour respecté.
- Résolution référent : hit/miss `referring_contacts`.
- **Garde « pas d'envoi sans signature »** (FORBIDDEN prouvé).
- `reports.pendingSignature` cloisonné (anti-IDOR cross-cabinet).

## Migration

Migration manuelle (convention repo, comme 0011/0012) : `0013_agent_cr.sql` créant
`referring_contacts` et `agent_settings`. À appliquer en prod avant déploiement du code.
