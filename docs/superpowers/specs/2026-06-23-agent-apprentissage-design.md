# Agent Apprentissage Hermès — design

**Date** : 2026-06-23. **Projet** : MediView (horos-viewer), `self-host`, mono-tenant.
**Statut** : design validé (brainstorming). Sous-projet du socle [[agents Hermès]].

## Problème

Les corrections du médecin (brouillon IA → texte signé) portent un savoir, mais rien ne le
capitalise. L'agent Apprentissage transforme les corrections **récurrentes** en **fiches RAG**
qui amélioreront les prochains CR — **sans stocker de PHI** et **sans écrire sans validation
humaine**.

## Objectifs

1. **Détecter les patterns récurrents** : regrouper PAR MODALITÉ les brouillons corrigés de
   façon majeure (snapshot `report_ai_snapshots` vs `reports` signé, via
   `sectionsChangedSignificantly`), ne retenir qu'au-delà d'un **seuil** (défaut 3).
2. **Abstraire en règle générale** via un **modèle LOCAL** (Ollama, PHI-safe) : une consigne
   anonyme réutilisable, **zéro nom/donnée patient**.
3. **Proposer** la fiche dans `agent_suggestions` (statut `open`, `kind="rag_fiche"`).
4. **À l'approbation du gérant** → insérer la fiche en base RAG (source `radio-ref-appris`)
   via le pipeline existant (`embedText` + `insertChunks`) → injectée dans les prochains CR.

## Non-objectifs

- Écriture **automatique** en base RAG (validation humaine OBLIGATOIRE).
- Apprendre d'**une seule** correction (seuil requis).
- Stocker du **PHI** dans la proposition ou la fiche (abstraction locale + contrôle humain).
- Modifier le **prompt/code** ou ré-entraîner un modèle (on n'ajoute que des fiches RAG).
- Multi-tenant.

## Architecture

Réutilise tout l'existant. Pas de nouvelle table : on ÉTEND `agent_suggestions` (migration 0016) pour porter la fiche proposée. L'agent tourne en **batch** (bouton « Analyser
l'apprentissage » du dashboard + réutilisable par un cron futur). Abstraction = modèle local.
Écriture RAG = pipeline knowledge existant. Agent ajouté au registre (fiche métier) avec
tool-gate.

## Composants

### 1. Schéma — extension `agent_suggestions` (migration 0016)

Ajouter (nullable, rétro-compatible) :

- `kind` enum(`improvement`,`rag_fiche`) NOT NULL DEFAULT `improvement` (les suggestions
  socle restent `improvement`).
- `modality` varchar(16) — modalité concernée.
- `proposedHeading` varchar(512) — titre de la fiche proposée.
- `proposedContent` text — contenu (règle générale anonyme).
- `sampleCount` int — nb de corrections ayant motivé la proposition (preuve de récurrence).

### 2. Registre — nouvel agent `apprentissage` (server/agents/registry.ts)

```ts
{
  key: "apprentissage",
  name: "Hermès Apprentissage",
  role: "Apprend des corrections du médecin et propose des fiches de référence.",
  objectives: ["Capitaliser les corrections récurrentes", "Améliorer les futurs CR"],
  tasks: ["Comparer brouillon↔signé", "Repérer les patterns par modalité", "Proposer une fiche RAG"],
  tools: ["proposeRagFiche"],
  access: ["report.read", "knowledge.read"],
  guardrails: [
    "N'écrit JAMAIS en base RAG sans validation humaine",
    "Aucune donnée patient dans la fiche (règle générale uniquement)",
    "N'apprend que d'un pattern récurrent (seuil)",
  ],
  kpis: [
    { key: "fichesProposed", label: "Fiches proposées", target: 1, unit: "", goal: "max" },
    { key: "fichesApproved", label: "Fiches approuvées", target: 1, unit: "", goal: "max" },
  ],
}
```

### 3. Détection des patterns — `server/agents/learning.ts`

- `collectCorrections()` : reports signés ayant un snapshot, où `sectionsChangedSignificantly`
  est vrai. Pour chacun : modalité (via study), + le COUPLE (brouillon, signé) des sections
  résultats/conclusion. **Ne renvoie ni nom patient ni studyId dans le texte agrégé** —
  studyId gardé seulement pour le comptage interne.
- `groupByModality(corrections)` : Map modalité → liste de couples. Ne garde que les modalités
  avec `count >= SEUIL` (défaut 3, configurable via `targetsJson`/ENV `LEARNING_MIN_SAMPLES`).
- Idempotence : ne re-propose pas une fiche `open` déjà existante pour la même modalité
  (`kind="rag_fiche"` + `modality`).

### 4. Abstraction (modèle local PHI-safe) — `server/agents/learning.ts`

- `abstractRule(modality, samples)` : appelle Ollama local (`ENV.ollamaTextModel`,
  `keep_alive:-1`) avec un prompt qui demande : « À partir de ces corrections fréquentes sur
  des CR de modalité X, formule UNE règle radiologique GÉNÉRALE et ANONYME (aucun nom, date,
  ni détail patient) que l'IA devrait suivre. Format : titre + 2-4 phrases. » → renvoie
  `{ heading, content }`.
- **Filet anti-PHI** : passer la sortie par une fonction de scrub (réutiliser la logique de
  `~/mediview-deid` côté serveur n'existe pas → implémenter `stripPhiLike(text)` : retire
  séquences de MAJUSCULES type nom, dates jj.mm.aaaa, nombres ≥6 chiffres). Si un résidu est
  détecté, marquer la proposition `needs_review` (mais elle reste `open`, jamais auto-insérée).

### 5. Orchestration — `runLearningAgent()` (server/agents/learning.ts)

batch : collect → group(seuil) → pour chaque modalité retenue : abstractRule → stripPhiLike →
insérer une `agent_suggestions` (`kind="rag_fiche"`, `modality`, `proposedHeading`,
`proposedContent`, `sampleCount`, status `open`). Logue via `logAgentActivity("apprentissage", ...)`.
Respecte le tool-gate (`runAgentTool("apprentissage","proposeRagFiche", ...)`).

### 6. Application à l'approbation — `server/agents/learning.ts`

`applyRagFiche(suggestionId)` : sur une suggestion `rag_fiche` passée à `approved`, prend
`proposedHeading`+`proposedContent`, calcule l'embedding (`embedText`), insère via
`insertChunks` source `radio-ref-appris`. Idempotent (ne ré-insère pas si déjà appliquée :
on passe le statut à `approved` et on insère une seule fois — vérifier qu'aucun chunk
`radio-ref-appris` n'a déjà ce heading).

### 7. tRPC (étend le router `agentsRegistry`)

- `runLearning` (adminProcedure) → lance `runLearningAgent`, renvoie `{ proposed }`.
- `resolveSuggestion` (déjà existant) : si la suggestion est `kind="rag_fiche"` et action
  `approved` → appeler `applyRagFiche` (insertion RAG) EN PLUS de passer le statut.
- `list`/`suggestions` renvoient déjà les suggestions ; le dashboard affiche le titre + contenu
  proposé + `sampleCount` pour les `rag_fiche`.

### 8. UI (dashboard agents)

Les suggestions `kind="rag_fiche"` s'affichent avec : modalité, **titre + contenu proposé**
(éditable avant approbation = bonus optionnel ; au minimum lecture), `sampleCount`
(« vu N fois »), boutons Approuver (→ insère en RAG) / Ignorer.

## Garde-fous / sécurité

- **Validation humaine obligatoire** avant toute écriture RAG (statut open→approved déclenche
  l'insertion ; rien d'auto).
- **PHI** : abstraction locale + `stripPhiLike` + contrôle humain ; la fiche est une règle
  générale ; aucun studyId/nom dans `proposedContent`.
- **Seuil** anti-bruit (≥3 par modalité).
- Tool-gate : `apprentissage` limité à `proposeRagFiche`.
- Mono-tenant ; endpoints admin ; activité auditée.

## Tests

- `groupByModality` : seuil respecté (2 < 3 → exclu ; 3 → inclus). (pur)
- `stripPhiLike` : retire nom MAJUSCULE, date, nombre ≥6 chiffres ; garde le texte médical. (pur)
- Idempotence : pas de 2e suggestion `open` pour la même modalité ; `applyRagFiche` n'insère
  pas deux fois le même heading.
- Garde : `applyRagFiche` n'écrit que sur `approved` ; jamais sur `open`.

## Migration

Manuelle (convention repo) `0016_agent_learning.sql` (ALTER TABLE agent_suggestions ADD …).
**RAPPEL** : retirer `--> statement-breakpoint` avant `mysql`.
