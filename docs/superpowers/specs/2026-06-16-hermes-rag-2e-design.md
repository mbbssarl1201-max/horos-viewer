# Agent Hermès radiologue — 2e : coffre Obsidian dédié comme source de la mémoire RAG — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-16 · **Repo** : `horos-viewer` (MediView)
> **Épopée 2** (agent Hermès), incrément **2e**. Source de la base RAG (2b/2c/2d la _consomment_).
> Cf. [[mediview-vr-avance]]. Conformité : [[respecter-lois-suisses]] [[nlpd-recommendations-non-negotiable]]
> [[keep-projects-separate]] (MediView uniquement — rien de MediAdmin).

## Problème

La mémoire RAG (table `knowledge_chunks`, 2b) n'est alimentée que par **upload manuel** de fichiers
`.md` via la page admin. Le gérant veut que la mémoire soit **adossée à un coffre Obsidian dédié** : un
espace de connaissances radiologiques qu'il édite dans Obsidian, et que MediView **synchronise** dans la
base — sans upload manuel, sans cloud, sans PHI.

## Objectifs (succès, 2e)

1. **Coffre dédié = dossier de `.md` sur le VPS**, monté en **lecture seule** dans le conteneur MediView
   (`KNOWLEDGE_VAULT_DIR`). Le gérant l'ouvre comme un coffre Obsidian de son côté. **Connaissances
   radiologiques uniquement — aucune donnée patient.**
2. **Synchronisation à la demande** : un bouton admin lit le coffre, découpe + embedde (pipeline local
   de 2b) et met la base à jour : par fichier, **remplace** ses chunks ; **supprime** les chunks dont le
   fichier a disparu. Idempotent (re-sync = état du coffre).
3. **Statut** : afficher le chemin du coffre, s'il est configuré/accessible, et le résultat de la
   dernière synchro (fichiers / chunks / supprimés).
4. **PHI-safe & cloisonné** : lecture de fichiers **locaux**, embeddings **locaux** ; coffre dédié
   distinct de tout coffre patient/MBBS ; périmètre MediView.
5. L'**upload manuel** de 2b **reste** disponible en repli.

## Non-objectifs (hors scope 2e)

- ❌ Synchro temps réel / file-watcher — **synchro à la demande** (bouton).
- ❌ Obsidian Local REST API / plugin custom — on lit un **dossier monté** (plus simple, pas de service).
- ❌ Écriture vers le coffre depuis MediView — **lecture seule**.
- ❌ Détection automatique de PHI dans le coffre — la garantie repose sur la **discipline du coffre
  dédié** (et l'UI le rappelle). Non-PHI par conception.
- ❌ Autres formats que `.md`. ❌ PHI vers cloud.

## Architecture

```
Coffre dédié (VPS)  /vault  (volume monté RO)  ──lecture──▶  server/knowledge/vaultSync.ts
  *.md connaissances radio                                     listVaultMarkdown(dir)   [pur sur fs simulé]
  (édité côté gérant dans Obsidian)                            syncVault(dir) :
                                                                 pour chaque .md :
                                                                   read → chunkMarkdown(rel, contenu)   (2b)
                                                                   → embedText (local)                  (2b/2c)
                                                                   → clearKnowledge(source) + insertChunks
                                                                 supprime les sources absentes du coffre
                                                                 → { files, chunks, removed, errors }
                                                                        ▲
   tRPC knowledge.syncVault (adminProcedure) ───────────────────────────┘
   tRPC knowledge.vaultStatus (adminProcedure) → { dir, configured, exists, fileCount }
                                                                        ▲
   Page /admin/knowledge : bouton « Synchroniser le coffre Obsidian » + chemin + résultat ; upload 2b conservé
```

### Composants

- **`server/_core/env.ts`** — ajouter `knowledgeVaultDir: process.env.KNOWLEDGE_VAULT_DIR ?? ""`.
- **`server/knowledge/vaultSync.ts`** (nouveau) :
  - `listVaultMarkdown(dir): string[]` — parcourt récursivement `dir`, renvoie les chemins **relatifs**
    des `.md`, en **ignorant** `.obsidian/`, `.trash/`, et les dossiers cachés. Dossier inexistant →
    `[]`. La logique de filtrage (`isIgnoredPath(rel)`) est **pure et testée**.
  - `syncVault(dir): Promise<{ files: number; chunks: number; removed: number; errors: string[] }>` —
    si `dir` vide/inexistant → renvoie un état vide + erreur explicite. Sinon : liste les `.md` ;
    pour chacun (best-effort) : lit, `chunkMarkdown(rel, contenu)`, `embedText` par chunk,
    `clearKnowledge(rel)` puis `insertChunks` ; à la fin, **supprime** via `clearKnowledge(source)`
    chaque `source` présente en base mais absente de la liste courante (helper
    `listKnowledgeSources()` à ajouter dans `store.ts`). `source` = chemin relatif dans le coffre.
  - Lecture fichier via `fs/promises` ; bornes : ignore un fichier > 2 Mo (cohérent avec la limite zod
    d'upload de 2b) en l'inscrivant dans `errors`.
- **`server/knowledge/store.ts`** — ajouter `listKnowledgeSources(): Promise<string[]>` (DISTINCT
  `source`), utilisé par `syncVault` pour la suppression des sources disparues.
- **`server/routers.ts`** — dans le routeur `knowledge` :
  - `vaultStatus: adminProcedure.query` → `{ dir: ENV.knowledgeVaultDir, configured, exists, fileCount }`
    (n'embedde rien ; juste un `listVaultMarkdown` + test d'existence).
  - `syncVault: adminProcedure.mutation` → `syncVault(ENV.knowledgeVaultDir)` + `recordAccess`.
- **Client `KnowledgePage.tsx`** (la page admin 2b) — ajouter une section « Coffre Obsidian » : chemin
  (`vaultStatus.dir` ou « non configuré »), nombre de fichiers, bouton **« Synchroniser le coffre
  Obsidian »** (affiche `files/chunks/removed/errors`), puis `stats.refetch()`. L'upload manuel reste.

## Gestion d'erreurs

- `KNOWLEDGE_VAULT_DIR` non défini → `vaultStatus.configured=false` ; bouton désactivé + message
  « coffre non configuré ». `syncVault` renvoie une erreur claire (pas d'exception non gérée).
- Dossier monté absent/illisible → `exists=false` ; sync renvoie `errors: ["coffre introuvable: <dir>"]`.
- Fichier illisible / embedding échoué → consigné dans `errors`, n'arrête pas les autres (best-effort).
- Embeddings Ollama indisponible → erreur claire par fichier (réutilise le message de `embedText`).

## Tests

- **Pur (vitest)** : `isIgnoredPath` — ignore `.obsidian/…`, `.trash/…`, dossiers cachés ; garde
  `notes/a.md`, `protocoles/irm.md`. (`listVaultMarkdown`/`syncVault` touchent le fs → testés via un
  répertoire temporaire OU via mock fs ; au minimum la fonction pure `isIgnoredPath`.)
- **Intégration (fs temporaire + Ollama mické)** : `syncVault` sur un dossier de 2 `.md` insère N
  chunks ; un 3ᵉ fichier supprimé du dossier puis re-sync → ses chunks sont retirés (`removed>0`).
- **UI** : vérif visuelle (chemin, bouton, résultat de synchro, compteur de base mis à jour).

## Intégration & déploiement

- **Aucune migration, aucun nouveau modèle.** Réutilise `knowledge_chunks` + nomic-embed-text.
- **Déploiement (infra VPS, manuel)** :
  1. Créer le dossier dédié sur le VPS, ex. `/docker/horos/knowledge-vault`, avec une **note-graine**
     `.md` (connaissances radio non-PHI).
  2. Monter ce dossier **en lecture seule** dans le service `app` du `docker-compose` :
     `- /docker/horos/knowledge-vault:/vault:ro` et `environment: KNOWLEDGE_VAULT_DIR=/vault`.
  3. `docker compose up -d app`.
- Vérif post-déploiement : `/admin/knowledge` → section « Coffre Obsidian » montre le chemin + N
  fichiers ; clic « Synchroniser » → `chunks>0` ; le chat Hermès (2c) cite ensuite ces connaissances.
- Branche commune `feat/hermes-rag-2de` (avec 2d). Gate CI → build GHCR.

## nLPD / conformité

- Le coffre est un **dossier dédié connaissances radiologiques**, jamais un coffre patient/MBBS ; lecture
  **seule**, embeddings + stockage **locaux**, périmètre **MediView** (cloisonné). L'UI rappelle
  « aucune donnée patient ». Aucun envoi vers un cloud. Cf. [[keep-projects-separate]].
