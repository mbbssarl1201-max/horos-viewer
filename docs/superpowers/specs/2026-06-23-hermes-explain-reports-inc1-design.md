# Hermès explique les CR — Incrément 1 (texte) : design

**Date** : 2026-06-23. **Projet** : MediView (horos-viewer), branche `self-host`.
**Statut** : design validé (brainstorming).

## Problème

Le médecin veut **interroger l'assistant Hermès** (déjà dans MediView) sur le compte rendu
d'un patient **désigné par son nom** — qu'il retrouve le bon dossier, en donne le CR et
**explique son raisonnement** — sans ouvrir l'étude à la main. (La voix = incrément 2.)

## Objectifs (incrément 1, texte)

1. **Recherche par nom** : « le dossier de Untel » → l'assistant trouve le(s) patient(s).
2. **Chargement du CR** du patient résolu dans le contexte de la conversation.
3. **Réponses** : « donne-moi le CR de X », « pourquoi cette conclusion », « qu'as-tu vu ».

## Modèle (choix du gérant : Gemini, voie conforme)

- **Gemini via Vertex AI UE** : région `europe-*` + DPA Google → conforme nLPD même sur
  PHI en clair. Connecteur HTTP Vertex, activé par ENV (projet + région + identifiants
  service-account).
- **Repli LOCAL (Ollama, PHI-safe) tant que Vertex n'est pas configuré** → l'assistant
  fonctionne dès maintenant, sans rien envoyer hors périmètre, et bascule sur Gemini
  automatiquement quand la clé est posée. Sélection : `CHAT_BACKEND` = `local` | `vertex`
  (défaut `local`). Claude reste possible (existant).

## Optimisations (demande explicite « optimiser »)

1. **Recherche par nom rapide ET chiffrée (blind index)** — le nom patient est chiffré à
   IV aléatoire (non recherchable). On ajoute `patients.nameSearch` = empreinte
   **déterministe** du nom **normalisé** (`encryptDeterministic(normalize(name))`, même
   technique que `patientId`). → recherche exacte/préfixe instantanée sans déchiffrer
   toute la base ; le nom reste chiffré. Migration `0014` + **backfill** des patients
   existants + remplissage à l'`upsertPatient`.
2. **Réponses rapides** — modèle local **gardé chaud** : `keep_alive: -1` (au lieu de
   `"30s"`) + `num_thread` adapté dans l'appel Ollama de `hermesChat.ts`. Fini le
   démarrage à froid à chaque question.
3. **Explications de qualité** — le contexte du chat est enrichi avec les **fiches RAG
   pertinentes** (critères appris : adénomyose JZ≥12, HTAP, conflit radiculaire…) +
   métadonnées du CR (modèle, anomalie). Quand on demande « pourquoi », l'assistant
   **cite les critères** au lieu d'inventer.

## Composants

1. **Migration `0014_patient_name_index.sql`** : `ALTER TABLE patients ADD nameSearch
varchar(255)` + index ; backfill (script qui lit chaque patient, déchiffre le nom,
   calcule `encryptDeterministic(normalize(name))`, écrit `nameSearch`).
2. **Schéma** : `patients.nameSearch`. `upsertPatient` calcule et stocke `nameSearch`.
3. **db.ts** : `searchPatientsByName(query)` → blind-index (exact puis préfixe), renvoie
   patients + dernière étude + résumé CR (nom déchiffré pour l'affichage). Mono-tenant.
4. **`server/report/hermesChat.ts`** :
   - `chatViaVertex(messages)` — backend Gemini Vertex UE (ENV `GEMINI_VERTEX_PROJECT`,
     `GEMINI_VERTEX_LOCATION` défaut `europe-west1`, `GEMINI_VERTEX_MODEL`,
     `GOOGLE_APPLICATION_CREDENTIALS`). Repli local si non configuré.
   - `keep_alive: -1` + `num_thread` sur l'appel Ollama.
   - `prepareHermesChat` enrichit le contexte avec les fiches RAG (réutilise
     `embedText` + `searchSimilar` + `buildKnowledgeBlock`).
5. **tRPC** : `hermes.findPatientReport({ query })` (medicalProcedure, lecture seule,
   audité) → résultats de recherche. Le chat existant (`runHermesChat`) prend le studyId résolu.
6. **UI** : barre « Demander à Hermès : le dossier de… » → liste de résultats → ouvre le
   `HermesChatPanel` sur le CR du patient choisi.

## Sécurité / garde-fous

- **Lecture seule** : aucune action (signature, envoi, modif) via le chat.
- **PHI** : local par défaut ; Gemini UNIQUEMENT via Vertex UE (DPA). Jamais l'API Gemini US.
- `nameSearch` ne stocke PAS le nom en clair (empreinte déterministe chiffrée).
- Anti-IDOR : mono-tenant ; endpoints `medicalProcedure` ; recherche auditée (`recordAccess`).

## Hors périmètre

- Voix (incrément 2). Génération/écriture de CR via le chat. Gemini US (interdit).
  Renommage en « Eva » (option d'affichage seulement, à la demande).

## Tests

- `normalize` + génération `nameSearch` (pur).
- `searchPatientsByName` (hit exact, préfixe, miss) — via le test d'intégration si DB requise.
- Sélection de backend chat (`local` quand Vertex non configuré).
- Garde lecture seule (le chat n'expose aucune mutation).

## Migration

Manuelle (convention repo). **RAPPEL** : retirer les marqueurs `--> statement-breakpoint`
avant d'appliquer via le client `mysql` (cf. incident 0013).
