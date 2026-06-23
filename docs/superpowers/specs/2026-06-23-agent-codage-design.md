# Agent Codage Hermès (CIM-10 + TARDOC) — design

**Date** : 2026-06-23. **Projet** : MediView (horos-viewer), `self-host`, mono-tenant.
**Statut** : design validé (brainstorming). Sous-projet du socle [[agents Hermès]].

## Problème

`suggestCodes.ts` propose déjà des codes **CIM-10** (diagnostics) dans le ReportPanel, mais
(1) il n'est pas formalisé comme **agent** (pas de fiche métier, journal, KPI, tool-gate), et
(2) il ne propose PAS les **actes TARDOC** (tarif suisse) nécessaires à la facturation.

## Objectifs

1. **Étendre `suggestCodes`** : en plus des codes CIM-10, proposer 1 à 5 **actes TARDOC**
   pertinents au CR (`{ tardoc: [{ code, label }] }`), via le LLM **local** (PHI-safe).
   Rétro-compatible : `codes` (CIM-10) conservé.
2. **Formaliser l'agent `codage`** au registre (fiche métier : rôle/tâches/outils/accès/
   garde-fous/KPIs), passage par le **tool-gate** (`suggestBillingCodes`), **journal** d'activité.
3. **UI** : afficher les actes TARDOC à côté des CIM-10 dans le ReportPanel.

## Non-objectifs

- ❌ **Facturer** / transmettre (la facturation réelle reste dans MediAdmin) — ici **suggestion** seulement.
- ❌ Base TARDOC officielle exhaustive / validation tarifaire (LLM = aide, à valider par l'humain).
- ❌ Écriture autonome dans le CR ou ailleurs.
- ❌ Cloud / PHI hors périmètre (modèle local uniquement).
- ❌ Multi-tenant.

## Architecture

Extension de l'existant. `suggestCodes` renvoie désormais `{ codes, tardoc }`. Le router
`reports.suggestCodes` (déjà `medicalProcedure`) passe par `runAgentTool("codage",
"suggestBillingCodes", ...)` (tool-gate) et logue via `logAgentActivity("codage", ...)`.
Nouvel agent au registre. UI ReportPanel étendue.

## Composants

1. **`server/report/suggestCodes.ts`** : le prompt demande AUSSI les actes TARDOC ; le retour
   devient `{ codes: CodeSuggestion[]; tardoc: CodeSuggestion[] }` (parsing défensif, cap 5,
   slice longueurs). `CodeSuggestion` inchangé `{code,label}`.
2. **Registre** (`server/agents/registry.ts`) : agent `codage` — tools `["suggestBillingCodes"]`,
   access `["report.read"]`, garde-fous « suggestion à valider », « ne facture pas », KPI
   `codageRuns`.
3. **Router** (`server/routers.ts`) : `reports.suggestCodes` enveloppe l'appel dans
   `runAgentTool("codage","suggestBillingCodes", () => suggestCodes(...))` + `logAgentActivity`.
4. **UI** (`client/src/components/ReportPanel.tsx`) : sous les codes CIM-10, une liste
   « Actes TARDOC (à valider) » rendue depuis `tardoc`.

## Garde-fous / sécurité

- **Suggestion uniquement** : aucun acte/diagnostic n'est facturé ni écrit automatiquement.
- **Local PHI-safe** (ollama-hermes), pas de cloud.
- Tool-gate : `codage` limité à `suggestBillingCodes`.
- Mono-tenant ; `medicalProcedure` ; activité auditée.

## Tests

- `suggestCodes` : parsing renvoie `codes` ET `tardoc` (mock fetch JSON) ; tableaux vides si
  réponse vide ; cap à 5 ; champs tronqués. (le parsing est testable en mockant fetch)
- Registre : agent `codage` présent, tools ⊆ TOOLS, KPI non vide (couvert par le test de
  cohérence du registre existant — mettre à jour le compte d'agents : 5).
- Tool-gate : `suggestBillingCodes` autorisé pour `codage`, refusé pour un autre.

## Migration

Aucune (pas de nouveau champ DB).
