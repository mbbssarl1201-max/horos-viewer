# Agent Hermès radiologue — 2b : socle RAG (mémoire vectorielle) — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-16 · **Repo** : `horos-viewer` (MediView)
> **Prochaine étape** : plan d'implémentation (`superpowers:writing-plans`).
> **Épopée 2** (agent Hermès), **incrément 2b**. Précède : 2a chat persona ✅ déployé. Suit :
> 2c brancher le RAG sur le chat (réponses sourcées) + recherche de connaissances, 2d aide à la
> rédaction du CR. Cf. [[mediview-vr-avance]].

## Problème

L'assistant Hermès (2a) ne dispose **d'aucune base de connaissances** : il raisonne uniquement sur
l'étude courante. Il manque la « mémoire vectorielle » — un corpus de connaissances radiologiques
(non-PHI) interrogeable par similarité sémantique, pour fonder des réponses sourcées (en 2c).

## Objectifs (succès, 2b)

1. **Page admin d'ingestion** : l'admin **téléverse des fichiers `.md`** (coffre Obsidian) ;
   chaque fichier est **découpé en chunks**, **embeddé localement** (Ollama `nomic-embed-text`),
   et **stocké** (MySQL, table `knowledge_chunks`).
2. **Recherche par similarité** : une fonction serveur renvoie les **top-k** chunks les plus proches
   d'une requête (embedding de la requête + **cosinus** calculé côté serveur).
3. **Gestion** : compter les chunks, **vider** la base (par source ou globalement).
4. **PHI-safe** : embeddings **locaux** (Ollama), base = **connaissances non-PHI** (jamais de
   dossiers patients). Aucune donnée vers le cloud.
5. **Accès admin only** (`adminProcedure`).

## Non-objectifs (hors scope 2b)

- ❌ **Brancher le RAG sur le chat Hermès** (réponses sourcées) = **incrément 2c**.
- ❌ **Recherche de connaissances** exposée à l'utilisateur final = 2c.
- ❌ **Extraction PDF / autres formats** — `.md` uniquement en 2b (markdown texte).
- ❌ **pgvector / base externe** — MySQL + cosinus en JS (base personnelle, petite/moyenne).
- ❌ Stocker du **PHI** dans la base de connaissances (par conception).
- ❌ Diagnostic certifié.

## Architecture (Approche A — MySQL + cosinus JS, embeddings Ollama local, upload admin)

```
KnowledgePage.tsx (admin) ── upload .md ──▶ trpc knowledge.ingest({ files:[{name,content}] })
                                              │ adminProcedure
                                              ▼
        server/knowledge/chunk.ts   chunkMarkdown(content)            [PUR, testable]
        server/knowledge/embeddings.ts  embedText(text) → number[]    (Ollama /api/embeddings)
                                         cosineSimilarity(a,b)         [PUR, testable]
        server/knowledge/store.ts   insertChunks(...) / searchSimilar(queryEmb, k) / stats / clear
                                              │
                            DB MySQL : table knowledge_chunks (drizzle, migration 0008)
                              (id, source, heading, content, embedding(JSON longtext), createdAt)

trpc knowledge.search({ query, k }) → embedText(query) → searchSimilar → top-k  (test/2c)
```

- **Stockage** : table `knowledge_chunks` — `embedding` sérialisé en **JSON (longtext)**. La
  recherche charge les embeddings candidats et calcule le **cosinus en JS** (tri top-k). Suffisant
  pour une base perso (≈ jusqu'à quelques milliers de chunks ; au-delà → 2b-bis pgvector).
- **Embeddings** : `embedText` appelle `${ENV.ollamaUrl}/api/embeddings` (modèle
  `ENV.ollamaEmbedModel`, défaut `nomic-embed-text`) — **local, PHI-safe**. Prérequis déploiement :
  `ollama pull nomic-embed-text` sur `ollama-hermes`.
- **Découpage** : `chunkMarkdown` découpe par titres/paragraphes en chunks bornés (~800–1200
  caractères, léger chevauchement), en conservant `source` (nom de fichier) + `heading`.
- **Routeur** `knowledge` (**adminProcedure**) : `ingest`, `search`, `stats`, `clear`.
- **Client** : `KnowledgePage.tsx` (route admin, lien de nav admin-only) — sélection de `.md`,
  bouton « Ingérer », compteur de chunks/sources, bouton « Vider ».

## Gestion d'erreurs

- Ingestion **best-effort par fichier** : un fichier illisible n'arrête pas les autres (rapport
  par fichier : ok/erreur). Embedding qui échoue → chunk ignoré + compté en erreur.
- Bornes : taille de fichier et nombre de fichiers par requête (zod) ; longueur de requête de
  recherche bornée. Rate-limit léger sur l'ingestion.
- Ollama embeddings indisponible / modèle absent → erreur claire (« modèle d'embeddings
  indisponible — `ollama pull nomic-embed-text` »).

## Tests

- **Pur (vitest)** : `chunkMarkdown` (découpe par titres, bornes de taille, conserve source/heading,
  fichier vide → []) ; `cosineSimilarity` (vecteurs identiques → 1, orthogonaux → 0, dimensions
  différentes → garde-fou).
- **Store/ingestion** : ingestion d'un `.md` → N chunks insérés avec embeddings (Ollama mocké) ;
  `searchSimilar` renvoie le chunk le plus proche en tête.
- **UI** : vérif visuelle (upload, compteur, vider).

## Intégration & déploiement

- **Migration DB** : `drizzle/0008_*.sql` (table `knowledge_chunks`), générée via
  `drizzle-kit generate` après ajout à `drizzle/schema.ts` ; appliquée par le service `migrate`
  au déploiement (vérifier `migrate exit=0`).
- **Modèle d'embeddings** : `ollama pull nomic-embed-text` sur `ollama-hermes` (étape de déploiement).
- Var d'env **optionnelle** `OLLAMA_EMBED_MODEL` (défaut `nomic-embed-text`), documentée dans
  `.env.example`.
- Déploiement `self-host` (PR), **gate CI** (tsc+tests+audit), build GHCR, compose VPS, healthz 200 +
  garde 401. Vérif : page admin → ingérer un petit `.md` → compteur > 0.
