# Agent Hermès radiologue — 2a : assistant conversationnel (persona expert, sans RAG) — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-16 · **Repo** : `horos-viewer` (MediView)
> **Prochaine étape** : plan d'implémentation (`superpowers:writing-plans`).
> **Épopée 2** (agent Hermès radiologue), **incrément 2a**. Suite : 2b socle RAG (mémoire
> vectorielle, embeddings locaux), 2c réponses sourcées + recherche de connaissances, 2d aide à
> la rédaction du CR. Tous séparés. Cf. [[mediview-vr-avance]] (épopée 1a livrée).

## Problème

MediView génère une **pré-analyse IA** (brouillon de compte-rendu : technique / résultats /
conclusion, via `runAiPreanalysis`, Ollama local par défaut). Mais le médecin ne peut pas
**dialoguer** avec elle : poser une question de suivi, demander un diagnostic différentiel, une
reformulation, une explication d'un signe. Il n'existe **aucun assistant conversationnel**.

## Objectifs (succès, 2a)

1. Un **panneau de chat « Hermès radiologue »** dans le viewer (mode 2D/MPR/3D), ouvrable depuis la
   barre d'outils, où le médecin discute en français avec un assistant **persona « radiologue
   expérimenté »**.
2. L'assistant répond en s'appuyant sur le **contexte de l'étude courante** : modalité, description,
   indication, antécédents, et les **sections du compte-rendu déjà générées** (s'il existe).
3. **Conversation multi-tours** (l'historique est renvoyé à chaque appel — pas de persistance).
4. **PHI-safe** : LLM **Ollama local** par défaut ; Claude (cloud) uniquement sous la **garde H4**
   existante (`MEDIVIEW_CLOUD_AI_PHI_CONSENT`). Aucun PHI ne sort sans consentement documenté.
5. **Anti-IDOR** : endpoint `medicalProcedure`, contexte chargé serveur via `studyId` (pas de
   données fournies par le client). **Rate-limité**.
6. **Aide non-diagnostique** : positionnement et garde-fous explicites (prompt + disclaimer UI).

## Non-objectifs (hors scope 2a)

- ❌ **RAG / base de connaissances vectorielle** (= incréments 2b/2c).
- ❌ **Écriture automatique dans le compte-rendu** (le médecin copie/valide lui-même) (= 2d).
- ❌ **Chat multimodal** (renvoi des images au modèle) — la pré-analyse a déjà transformé les images
  en texte ; 2a raisonne sur ce texte. (Amélioration ultérieure.)
- ❌ **Persistance** de la conversation (éphémère, état composant ; aucune table, aucune migration).
- ❌ Diagnostic certifié / dispositif médical (CE/MDR) — reste une **aide**.

## Architecture (Approche A — endpoint chat stateless + contexte étude, LLM local)

```
HermesChatPanel.tsx (viewer)  ── messages[] (éphémère) ──▶ trpc ai.askHermes({ studyId, messages })
                                                              │ medicalProcedure + rate-limit + anti-IDOR
                                                              ▼
                                   server/report/hermesChat.ts
                                     ├─ HERMES_SYSTEM_PROMPT (persona + garde-fous)   [const]
                                     ├─ buildHermesContext(study, report) → string    [PUR, testable]
                                     ├─ assembleMessages(system, context, history)     [PUR, testable]
                                     └─ chatViaOllama(messages) / chatViaClaude(...)    [LLM local/H4]
                                                              │
                                   getStudyById(studyId) + getReportByStudy(studyId)   (serveur)
```

- **Serveur** : nouveau module `server/report/hermesChat.ts`. Procédure `ai.askHermes` (nouveau
  sous-routeur `ai` OU dans `reports`) : `medicalProcedure`, input
  `{ studyId: number, messages: {role:"user"|"assistant", content:string}[] (borné) }`.
  Charge `getStudyById` (NOT_FOUND sinon) + `getReportByStudy` ; construit le contexte ; assemble
  `[system, {role:"user", content: contexte}, ...history]` ; appelle Ollama
  `${ENV.ollamaUrl}/api/chat` (modèle texte `ENV.ollamaTextModel`, défaut `qwen2.5:3b` — présent
  sur `ollama-hermes`) ou Claude si `aiBackend==="claude" && cloudAiPhiConsent` ; renvoie
  `{ reply: string, model: string }`. `recordAccess({action:"ai.hermes.chat", studyId})`.
- **Client** : `HermesChatPanel.tsx` — liste de messages (user/assistant), zone de saisie, bouton
  « Envoyer », état local `messages` (éphémère), disclaimer « Aide non-diagnostique — à valider par
  le médecin ». Monté en overlay du viewer, ouvrable via un bouton de la barre d'outils. Appelle
  `trpc.ai.askHermes.useMutation()`.

## Persona & garde-fous (prompt système)

`HERMES_SYSTEM_PROMPT` : « Tu es Hermès, un assistant pour un radiologue expérimenté, francophone.
Tu aides à raisonner sur un examen d'imagerie : différentiels, signes, protocoles, reformulation.
Tu n'es PAS un dispositif de diagnostic : exprime l'incertitude, propose des hypothèses à
**confirmer par le médecin**, ne pose jamais de diagnostic définitif. Ne raisonne QUE sur le
contexte fourni (n'invente ni mesure, ni antécédent, ni résultat non fournis). N'identifie pas le
patient. Réponds de façon concise et structurée. »

## Gestion d'erreurs

- **Rate-limit** : `countRecentAccess(user, "ai.hermes.chat", 60) >= 60` → `TOO_MANY_REQUESTS`.
- **Timeout** LLM (AbortController, ex. 120 s) → message d'erreur clair côté client, pas de crash.
- Messages d'entrée **bornés** (zod : longueur de `content`, nombre de tours) — anti-abus/coût.
- Étude introuvable → `NOT_FOUND`. LLM indisponible → `INTERNAL_SERVER_ERROR` + toast côté client.

## Tests

- **Pur (vitest)** : `buildHermesContext(study, report)` (inclut modalité/indication/antécédents +
  sections du CR ; « non renseigné » si absent ; ne fuite rien d'autre) ; `assembleMessages`
  (ordre system → contexte → historique ; troncature des tours si trop longs).
- **Procédure** : anti-IDOR (étude introuvable → NOT_FOUND), rate-limit, et que le LLM reçoit bien
  le system + contexte (LLM mocké, comme `aiPreanalysis.test.ts`).
- **UI** : vérif visuelle (ouvrir le panneau, poser une question, recevoir une réponse).

## Intégration & déploiement

- **Aucune migration DB. Aucun nouveau service.** Réutilise Ollama local existant + les helpers DB.
- Nouvelle var d'env **optionnelle** `OLLAMA_TEXT_MODEL` (défaut `qwen2.5:3b`) documentée dans
  `.env.example`.
- Déploiement branche `self-host` (PR), **gate CI** (tsc+tests+audit), build GHCR, compose VPS,
  healthz 200 + garde 401. Vérif visuelle du chat (test gérant).
