# Agent Hermès radiologue — 2d : rédaction assistée du compte-rendu (par section) — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-16 · **Repo** : `horos-viewer` (MediView)
> **Épopée 2** (agent Hermès), incrément **2d**. Précède : 2a chat ✅, 2b socle RAG ✅, 2c RAG+streaming ✅.
> Cf. [[mediview-vr-avance]]. Conformité : [[respecter-lois-suisses]] [[nlpd-recommendations-non-negotiable]].

## Problème

Le compte-rendu radiologique (`ReportPanel`, 4 sections : indication / technique / résultats /
conclusion) dispose déjà d'une **génération IA one-shot** (`reports.aiGenerate` via `runAiPreanalysis`,
depuis les images/antériorité, **sans** la base de connaissances). Il manque une **assistance à la
rédaction itérative, par section** : le médecin a un texte (ou des notes) dans une section et veut
qu'Hermès le **reformule / structure / corrige**, ou **propose une conclusion** à partir des résultats —
en s'appuyant sur la base de connaissances (RAG 2b/2c), avec **validation humaine obligatoire**.

## Objectifs (succès, 2d)

1. **4 actions par section** : **Reformuler/clarifier**, **Structurer** (notes → prose), **Corriger la
   terminologie** (sur le texte de la section) ; **Proposer une conclusion** (lit les _Résultats_,
   écrit une _Conclusion_).
2. **Streaming dans le champ** : la proposition s'écrit **en direct** (token par token) directement dans
   la textarea de la section, **en remplaçant** le contenu — réutilise la route SSE locale de 2c.
3. **Annulation** : avant le streaming, l'ancien texte est mémorisé → bouton **« ↩ Restaurer »** après
   coup (sécurité : ne jamais perdre une saisie manuelle sans recours).
4. **RAG** : toutes les actions s'appuient sur la base de connaissances (toujours-RAG, choix gérant),
   MAIS sous une **RÈGLE anti-invention** stricte dans le prompt (cf. ci-dessous).
5. **Validation humaine** : rien n'est enregistré ni signé automatiquement ; désactivé si le CR est
   **signé** (immuable). Accès = **éditeur de CR** (`admin`|`radiologist`).
6. **PHI-safe** : modèle + embeddings **locaux** ; le CR ne quitte jamais le VPS. Garde H4 (Claude
   cloud) inchangée et **non-streaming** (409 → repli).

## RÈGLE anti-invention (garde clinique)

Le médecin **signe** le CR (responsabilité). Le system prompt impose : « N'introduis **aucun** fait,
mesure, antécédent ni résultat **absent** du texte fourni ou du contexte de l'examen. La base de
connaissances sert au **style, à la terminologie et au cadrage**, jamais à ajouter du contenu clinique.
Tu n'es pas un dispositif de diagnostic. Renvoie **uniquement** le texte réécrit de la section, sans
préambule ni commentaire. »

## Non-objectifs (hors scope 2d)

- ❌ Refonte de « Générer (IA) » one-shot (`reports.aiGenerate`) — conservé tel quel.
- ❌ Enregistrement / signature automatiques.
- ❌ Modification d'un CR **signé** (→ addendum existant).
- ❌ Streaming du chemin cloud (Claude/H4).
- ❌ Affichage des sources dans le champ (l'output est le texte de la section ; le RAG informe mais
  n'affiche pas de bloc « Sources » ici — contrairement au chat 2c).
- ❌ PHI vers cloud ; diagnostic certifié.

## Architecture

```
ReportPanel (par section) ──[action]──▶ POST /api/hermes/report-assist/stream  (Express SSE, comme 2c)
   ancien texte mémorisé                 auth éditeur CR (admin|radiologist) → 401/403
   champ rempli en direct                CSRF Sec-Fetch-Site + abort si déconnexion
   bouton « ↩ Restaurer »                       │
                                                ▼
            server/report/reportAssist.ts
              ASSIST_ACTIONS = { reformuler, structurer, conclure, terminologie }  (prompts dédiés)
              buildAssistMessages(action, currentText, studyContext, knowledgeBlock)   [PUR, testé]
                 → system (persona + RÈGLE anti-invention) + DONNÉES (texte/contexte/connaissances)
              prepareReportAssist(input, ctx) :
                 rate-limit (ai.hermes.assist) · anti-IDOR getStudyById · buildHermesContext (étude+CR)
                 · RAG : embedText(texte cible) → searchSimilar(8) → selectRelevant → buildKnowledgeBlock
                 → { messages, model, useClaude, study }
                                                │
                                streamOllamaChat(messages, onToken, signal)   (réutilisé de 2c)
```

### Composants

- **`server/report/reportAssist.ts`** (nouveau) :
  - `type AssistAction = "reformuler" | "structurer" | "conclure" | "terminologie"`.
  - `ASSIST_INSTRUCTIONS: Record<AssistAction, string>` — l'instruction spécifique de chaque action.
  - `buildAssistMessages(action, currentText, studyContext, knowledgeBlock)` **PUR** → `{role,content}[]` :
    system `REPORT_ASSIST_SYSTEM_PROMPT` (persona + RÈGLE anti-invention + « renvoie uniquement le
    texte ») ; user DONNÉES (contexte examen) ; user (knowledgeBlock si non vide) ; user (instruction
    de l'action + le `currentText`). Pour `conclure`, `currentText` = les _Résultats_.
  - `prepareReportAssist(input, ctx)` — `input: { studyId, action, currentText }`. rate-limit
    `countRecentAccess('ai.hermes.assist', 60) < 60` ; `getStudyById` (404) ; `buildHermesContext`
    (étude + CR existant) ; RAG fail-open (embed `currentText`, ou un libellé d'action si vide) ;
    renvoie `{ messages, model, useClaude, study }`.
- **`server/_core/index.ts`** — route **`POST /api/hermes/report-assist/stream`**, calquée sur
  `/api/hermes/chat/stream` (2c) : CSRF → auth `sdk.authenticateRequest` (401) → **rôle éditeur de CR**
  (`user.role === "admin" || user.role === "radiologist"`, sinon 403) → validation `{studyId, action,
currentText}` (action ∈ liste, 400 sinon) → `prepareReportAssist` → si `useClaude` 409 → SSE
  (`data:{t}` par token, `data:{done:true,model}` en fin, `recordAccess('ai.hermes.assist')`) ; abort
  sur `req.on('close')`.
- **Client `ReportPanel.tsx`** : sous chaque textarea de section, une barre d'actions Hermès. Au clic :
  mémorise `previous = sections[field]`, ouvre le flux `fetch` (lecture `ReadableStream`, mêmes utils
  que 2c), **écrit les tokens dans `sections[field]`** au fil de l'eau ; à la fin, affiche **« ↩
  Restaurer »** (remet `previous`). Boutons désactivés si `isSigned` ou pendant un autre flux. Repli :
  si le flux échoue, message d'erreur discret, champ restauré.
  - indication / technique / résultats : `[Reformuler] [Structurer] [Terminologie]`.
  - conclusion : `[Reformuler] [Structurer] [Terminologie] [Proposer depuis les résultats]` (cette
    dernière envoie `action:"conclure"` avec `currentText` = `sections.resultats`).

## Gestion d'erreurs

- **RAG fail-open** (comme 2c) : base vide / Ollama embeddings KO → assistance sans connaissances, pas
  d'erreur bloquante.
- **Streaming** : erreur avant le 1ᵉʳ octet → code HTTP (401/403/404/409/429/500), client restaure le
  champ + message. Erreur en cours → `data:{error}` + fin ; client restaure + message.
- **CR signé** : actions désactivées côté client ; côté serveur l'assist ne persiste rien, donc aucun
  risque d'altérer un CR signé (l'écriture passe toujours par `upsertDraft`, qui refuse déjà un signé).
- **Auth** : non authentifié 401 ; rôle non éditeur 403.

## Tests

- **Pur (vitest)** : `buildAssistMessages` — chaque action produit l'instruction attendue ; la RÈGLE
  anti-invention est présente dans le system ; `conclure` inclut bien le texte des résultats ; sans
  `knowledgeBlock`, pas de message connaissances.
- **Intégration (Ollama mické)** : `prepareReportAssist` injecte un bloc connaissances quand un chunk
  dépasse le seuil ; fail-open si `embedText` jette ; 404 si étude absente ; 429 si rate-limit.
- **UI** : vérif visuelle (tokens en direct dans le champ, bouton Restaurer, désactivation si signé).

## Intégration & déploiement

- **Aucune migration, aucun nouveau modèle.** Réutilise `knowledge_chunks` + qwen2.5:3b +
  nomic-embed-text. Branche commune `feat/hermes-rag-2de` (avec 2e). Gate CI → build GHCR → compose VPS →
  healthz 200 + garde 401. Vérif : ouvrir un CR (brouillon) → cliquer « Reformuler » → le champ se
  remplit en direct ; « Restaurer » revient à l'ancien ; sur un CR signé, les actions sont grisées.
