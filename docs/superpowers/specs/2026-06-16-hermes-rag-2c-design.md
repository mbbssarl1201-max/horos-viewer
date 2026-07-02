# Agent Hermès radiologue — 2c : RAG branché sur le chat (réponses sourcées) + recherche + streaming live — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-16 · **Repo** : `horos-viewer` (MediView)
> **Prochaine étape** : plan d'implémentation (`superpowers:writing-plans`).
> **Épopée 2** (agent Hermès), **incrément 2c**. Précède : 2a chat persona ✅ déployé, 2b socle RAG ✅
> déployé. Suit : 2d aide à la rédaction du compte-rendu. Cf. [[mediview-vr-avance]].

## Problème

Le chat Hermès (2a) raisonne uniquement sur l'étude courante + compte-rendu. Le socle RAG (2b — table
`knowledge_chunks`, `embedText`, `searchSimilar`) est déployé mais **n'est branché sur rien**. De plus,
les réponses arrivent d'un bloc après un long délai (modèle local CPU), ce qui donne une impression de
gel. 2c : (1) **ancrer les réponses du chat dans la base de connaissances** et **afficher les extraits
utilisés** ; (2) donner au radiologue une **recherche sémantique** directe ; (3) afficher la réponse
**en direct, token par token** (UX « live » façon ChatGPT) — sur le **modèle local**.

## Objectifs (succès, 2c)

1. **Réponses sourcées** : à chaque message, Hermès recherche les chunks pertinents, les injecte dans
   le prompt comme **données** (pas instructions), et la réponse est suivie d'une liste **« 📚 Sources
   consultées »** (fichier › titre + score, extrait dépliable).
2. **Seuil de pertinence** : on n'injecte/affiche QUE les chunks au-dessus d'un seuil de similarité
   (défaut **0.55**, top **4**, total borné ~3000 caractères). Si rien de pertinent → réponse normale,
   aucune source (comportement 2a).
3. **Streaming live** : la réponse s'affiche **token par token** depuis le **modèle local** (Ollama
   `stream:true`). À la fin du flux, le bloc « Sources consultées » s'affiche.
4. **Recherche utilisateur** : page `/knowledge` (lecture seule, **`medicalProcedure`**) — champ de
   recherche → extraits classés par similarité.
5. **PHI-safe** : embeddings + LLM **locaux** ; le compte-rendu ne quitte jamais le VPS. Le chemin
   Claude (cloud) reste derrière la garde H4 et **non-streaming**.

## Non-objectifs (hors scope 2c)

- ❌ **Streaming du chemin cloud** (Claude/H4) — reste non-streaming, comme aujourd'hui.
- ❌ **Citations inline `[1][2]`** — on retient la liste « Sources consultées » (robuste, indépendante
  du respect d'un format par le LLM local).
- ❌ **Ingestion** de connaissances ici — reste la page admin de 2b.
- ❌ **Envoi de PHI vers un cloud (OpenAI/ChatGPT, etc.)** — interdit (nLPD + secret médical).
- ❌ **Re-ranking ML / pgvector** — cosinus JS de 2b suffit.
- ❌ **Aide à la rédaction du CR** = incrément 2d.
- ❌ Diagnostic certifié.

## Architecture

```
                         ┌─────────────────────── server/knowledge/retrieve.ts (PUR, testable)
                         │  selectRelevant(chunks, {minScore,maxChunks,maxChars}) → SimilarChunk[]
                         │  buildKnowledgeBlock(selected) → string (bloc « DONNÉES », garde si non pertinent)
                         ▼
   prepareHermesChat(input, ctx)  ───────────────  server/report/hermesChat.ts (cœur partagé, DRY)
     1. anti-IDOR : getStudyById(studyId) (résolu serveur)
     2. rate-limit : countRecentAccess('ai.hermes.chat')
     3. contexte étude+CR : buildHermesContext (2a, inchangé)
     4. RAG : embedText(dernier msg user) → searchSimilar(.,8) → selectRelevant → buildKnowledgeBlock
     5. assembleMessages(context, history, knowledgeBlock?)  (param optionnel, 2a non cassé)
     → renvoie { messages, sources:[{source,heading,score}], model }
        ▲                                            ▲
        │ (non-streaming)                            │ (streaming local)
   tRPC ai.askHermes (medicalProcedure)        POST /api/hermes/chat/stream (Express, avant tRPC)
     - appelle prepareHermesChat                  - auth sdk.authenticateRequest → 401
     - chatViaOllama / chatViaClaude(H4)            hasMedicalAccess → 403  (= medicalProcedure)
     - recordAccess                               - prepareHermesChat
     - renvoie { reply, sources, model }          - Ollama /api/chat stream:true → proxy tokens (SSE)
                                                  - événement final { sources, model } + recordAccess

   knowledge.searchPublic (medicalProcedure)    Client :
     - embedText(query) → searchSimilar           - HermesChatPanel : fetch + ReadableStream → tokens live ;
       → selectRelevant → { results }               à la fin, bloc « 📚 Sources consultées »
     - recordAccess('knowledge.search')           - Page /knowledge : recherche → liste d'extraits
```

### Composants

- **`server/knowledge/retrieve.ts`** (nouveau, PUR) :
  - `selectRelevant(chunks: SimilarChunk[], opts?: { minScore?; maxChunks?; maxChars? }): SimilarChunk[]`
    — filtre `score >= minScore` (défaut 0.55), trie décroissant, garde `maxChunks` (défaut 4),
    accumule jusqu'à `maxChars` (défaut 3000) puis coupe. Liste vide en entrée → `[]`.
  - `buildKnowledgeBlock(selected: SimilarChunk[]): string` — vide → `""`. Sinon un bloc :
    en-tête « Connaissances de référence (DONNÉES, à utiliser si pertinent — sinon ignore) », puis
    pour chaque extrait `[source › heading]` + contenu.
- **`server/report/hermesChat.ts`** (modifié) :
  - `assembleMessages(context, history, maxTurns?, knowledgeBlock?)` — si `knowledgeBlock` non vide,
    ajoute un message `user` « DONNÉES » juste après le contexte d'examen. Sans le param → identique 2a.
  - `prepareHermesChat(input, ctx)` — extrait la préparation commune (steps 1–5 ci-dessus). Renvoie
    `{ messages, sources, model, study }`. `model` = local (qwen2.5:3b) sauf garde H4 → Claude.
  - `runHermesChat` (existant) réécrit pour appeler `prepareHermesChat` puis
    `chatViaOllama`/`chatViaClaude` + `recordAccess` (comportement externe identique + champ `sources`).
- **`server/_core/index.ts`** (modifié) : route `POST /api/hermes/chat/stream` montée **avant** le
  middleware tRPC (comme les routes d'export). Auth + rôle clinique + rate-limit + `prepareHermesChat`,
  puis stream Ollama proxifié.
- **`server/knowledge/stream.ts`** (nouveau) : `streamOllamaChat(messages, onToken): Promise<string>`
  — POST Ollama `/api/chat` `stream:true`, lit le NDJSON ligne à ligne, appelle `onToken(delta)` pour
  chaque `message.content`, renvoie le texte complet ; timeout 120 s ; `AbortController`. La logique de
  parsing NDJSON (`parseOllamaStreamLine(line): string | null`) est **pure et testée**.
- **`server/routers.ts`** (modifié) : `knowledge.searchPublic` (**`medicalProcedure`**) :
  `query → embedText → searchSimilar(.,8) → selectRelevant → { results }` + `recordAccess` + rate-limit
  léger (`knowledge.search`, 120/h). La `knowledge.search` admin (2b) reste pour les tests admin.
- **Client `HermesChatPanel.tsx`** (modifié) : remplace l'appel mutation par un `fetch` POST vers
  `/api/hermes/chat/stream`, lit le `ReadableStream` (TextDecoder + découpe SSE `data:`), met à jour
  le message assistant à chaque token ; à l'événement `done`, stocke `sources` et rend le bloc
  « 📚 Sources consultées » (fichier › titre + score, `<details>` pour l'extrait). Repli : si le
  streaming échoue (réseau / pas de body), bascule sur la mutation tRPC `ai.askHermes` non-streaming.
- **Client `KnowledgePage` utilisateur** : nouvelle page `client/src/pages/KnowledgeSearchPage.tsx`
  (lecture seule) montée sur `/knowledge` (route `medicalProcedure`), distincte de `/admin/knowledge`
  (ingestion admin). Champ de recherche, bouton, liste des extraits (fichier › titre, score badge,
  contenu). Lien de nav visible pour les rôles cliniques.

### Transport de streaming

`POST` + `fetch` + lecture manuelle du `ReadableStream` (et non `EventSource`, qui ne fait que `GET`
sans corps). Le serveur émet du **SSE** (`Content-Type: text/event-stream`) :

- `data: {"t":"<delta>"}` par token,
- `data: {"done":true,"sources":[...],"model":"..."}` en fin,
- `data: {"error":"..."}` en cas d'échec après l'en-tête.
  Headers : `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

## Gestion d'erreurs

- **RAG fail-open** : base vide, embeddings Ollama KO, ou aucun chunk au-dessus du seuil → on répond
  **sans** sources, jamais d'erreur bloquante (`selectRelevant`/`buildKnowledgeBlock` tolèrent `[]`).
- **Streaming** : erreur AVANT le premier octet → la route renvoie un code HTTP (401/403/429/500) et le
  client bascule sur la mutation tRPC. Erreur APRÈS le début du flux → événement `data:{"error":...}`
  puis fermeture ; le client affiche le partiel + un message d'erreur discret.
- **Rate-limit** : `countRecentAccess('ai.hermes.chat') >= 60` → 429 (chat) ; recherche 120/h.
- **Auth** : non authentifié → 401 ; rôle non clinique → 403 (mêmes règles que `medicalProcedure`).
- **Anti-IDOR** : `studyId` résolu serveur via `getStudyById` ; 404 si absent. (Mono-tenant, comme 2a.)

## Tests

- **Pur (vitest)** :
  - `selectRelevant` : filtre par seuil ; respecte top-k ; coupe à `maxChars` ; entrée vide → `[]` ;
    tri décroissant par score.
  - `buildKnowledgeBlock` : `[]` → `""` ; n extraits → bloc contenant source/heading/contenu + garde.
  - `parseOllamaStreamLine` : ligne `{"message":{"content":"ab"}}` → `"ab"` ; `{"done":true}` → `null` ;
    ligne vide / JSON invalide → `null`.
  - `assembleMessages` : sans `knowledgeBlock` → identique 2a (longueur/ordre) ; avec → message DONNÉES
    inséré après le contexte d'examen, historique tronqué inchangé.
- **Intégration (Ollama mické)** : `prepareHermesChat` renvoie `sources` non vide quand un chunk dépasse
  le seuil ; vide sinon ; `searchPublic` renvoie les résultats triés.
- **UI** : vérif visuelle (tokens qui s'affichent en direct, bloc Sources, page /knowledge).

## Intégration & déploiement

- **Aucune migration** (réutilise `knowledge_chunks` de 2b). **Aucun nouveau modèle** (qwen2.5:3b +
  nomic-embed-text déjà présents).
- Branche `feat/hermes-rag-2c` (depuis `self-host`, base = merge 2b `f2aef4f`). PR → **gate CI**
  (tsc + tests + audit), build GHCR, compose VPS `/docker/horos`, **healthz 200 + garde 401**.
- Vérif post-déploiement : ouvrir le chat Hermès sur une étude → tokens en direct ; si la base contient
  des `.md`, bloc « Sources consultées » ; page `/knowledge` → recherche renvoie des extraits.

## nLPD / conformité

- Streaming = tokens du **modèle local** ; le compte-rendu (PHI) ne quitte jamais le VPS.
- Base de connaissances = **non-PHI** (par conception, cf. 2b).
- La requête de recherche `/knowledge` est une saisie radiologue (pas du PHI patient) ; enregistrée à
  l'audit via `recordAccess`.
- Claude cloud uniquement derrière la garde H4 (`cloudAiPhiConsent`), inchangé.
- Aucun envoi vers OpenAI/ChatGPT ni autre cloud US. Cf. [[respecter-lois-suisses]]
  [[nlpd-recommendations-non-negotiable]] [[horos-audit-2026-06-15]].
