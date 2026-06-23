# Agents Hermès — Socle (registre + fiches métier + auto-amélioration) : design

**Date** : 2026-06-23. **Projet** : MediView (horos-viewer), `self-host`, mono-tenant.
**Statut** : design validé (brainstorming, version « 19/20 »).

## Problème

Les automatisations existent (Rédacteur de CR, Qualité/double-lecture, Copilote chat) mais
ne sont ni **formalisées**, ni **visibles**, ni **mesurées**, ni **améliorées**. On veut un
**registre d'agents Hermès** : chaque agent a une **fiche métier** (rôle, objectifs, tâches,
**outils autorisés**, **accès/portée**, garde-fous) et une **boucle d'auto-amélioration**
mesurable, le tout sous garde-fous PHI/responsabilité.

## Objectifs (socle)

1. **Registre en CODE** des fiches métier (`AgentSpec`).
2. **Tool-gate** : un agent ne peut appeler QUE les outils déclarés dans sa fiche (imposé à
   l'exécution, pas seulement documenté).
3. **État + réglages en base** par agent (activé, objectifs chiffrés, plafonds) + **dashboard**.
4. **Métriques (KPIs)** calculées par agent + **santé** (dernier run, erreurs, taux de succès).
5. **Boucle d'auto-amélioration** : écart objectif↔réel → **suggestion d'amélioration**
   concrète, **proposée puis validée par le gérant** (jamais appliquée seule au socle).
6. **Capture** : snapshot du brouillon IA à la génération (pour mesurer « signé sans
   correction » et alimenter l'apprentissage futur).
7. **Mémoire d'agent** : notes courtes d'amélioration réinjectées dans le contexte de l'agent.
8. **Rattacher les 3 agents existants** sans changer leur comportement.

## Non-objectifs (socle)

- Nouveaux agents métier (Apprentissage actif / Référent / Codage) = sous-projets suivants.
- Application **automatique** des améliorations (le socle propose, l'humain valide).
- Édition des **outils/accès via l'UI** (en code, versionné, sûr).
- Toute levée des garde-fous (jamais d'envoi/signature sans médecin).
- Multi-tenant (mono-tenant inchangé).

## Architecture (approche A)

Registre **en code** (`server/agents/`) + couche d'orchestration légère + tables d'état /
journal / notes / snapshots + endpoints tRPC + dashboard. Les agents existants émettent leur
activité et passent par le tool-gate.

## Composants

### 1. Registre & types — `server/agents/registry.ts`

```ts
export interface AgentSpec {
  key: string; // "redacteur" | "qualite" | "copilote"
  name: string;
  role: string; // description courte
  objectives: string[]; // buts
  tasks: string[]; // tâches concrètes
  tools: string[]; // clés d'outils AUTORISÉS (tool-gate)
  access: string[]; // portées : "report.read","study.read","email.send"...
  guardrails: string[]; // règles dures (texte)
  kpis: {
    key: string;
    label: string;
    target: number;
    unit: string;
    goal: "max" | "min";
  }[];
}
export const AGENTS: AgentSpec[]; // 3 fiches : redacteur, qualite, copilote
```

Fiches initiales :

- **redacteur** (= agent CR autonome) : tools `[generateDraft]`, access `[study.read, report.write_draft]`, garde-fous « jamais de signature/envoi », KPI `acceptanceRate` (target 70 %, max) + `draftsPerDay`.
- **qualite** (= double-lecture) : tools `[verifyDraft]`, access `[report.read]`, KPI `disagreementConfirmedRate`.
- **copilote** (= chat Hermès) : tools `[searchPatient, explainReport]`, access `[patient.search, report.read]`, KPI `conversations`, `avgLatencyMs`.

### 2. Tool-gate — `server/agents/tools.ts`

```ts
export type ToolFn = (args: any) => Promise<any>;
export const TOOLS: Record<string, { run: ToolFn; access: string[] }>;
export async function runAgentTool(
  agentKey: string,
  toolKey: string,
  args: any
): Promise<any>;
// throws si toolKey ∉ AGENTS[agentKey].tools (défense en profondeur)
```

Les agents existants sont (progressivement) routés via `runAgentTool`. Au socle, le tool-gate
existe + est utilisé par AU MOINS un agent (redacteur) pour prouver l'enforcement ; les autres
suivent. Test : appel d'un outil hors-fiche → throw.

### 3. Schéma (migration 0015 manuelle ; retirer les marqueurs drizzle)

- `agent_state` : `agentKey` PK, `enabled` bool, `targetsJson` text (overrides de KPI),
  `lastRunAt`, `lastError` varchar, `updatedAt`. (généralise `agent_settings`, qu'on garde
  pour le worker CR ; `agent_state` est le registre d'état multi-agents.)
- `agent_activity` : id, `agentKey`, `action`, `studyId` (null), `status`
  (`ok`|`error`|`skipped`), `detail` varchar, `createdAt`. (journal/santé)
- `agent_notes` : id, `agentKey`, `note` text, `createdAt`. (mémoire)
- `agent_suggestions` : id, `agentKey`, `kpiKey`, `gap` float, `suggestion` text,
  `status` (`open`|`approved`|`dismissed`), `createdAt`. (boucle d'amélioration)
- `report_ai_snapshots` : id, `studyId` unique, `sectionsJson` text, `model` varchar,
  `createdAt`. (capture du brouillon IA à la génération)

### 4. Métriques — `server/agents/metrics.ts`

`computeAgentKpis(agentKey)` lit la base (reports, ai_evaluations, report_ai_snapshots,
agent_activity) et renvoie les KPIs (valeur courante vs cible). Ex. `acceptanceRate` =
1 − (brouillons modifiés significativement / brouillons signés) via diff snapshot↔signé.

### 5. Boucle d'auto-amélioration — `server/agents/improve.ts`

`computeSuggestions(agentKey)` : pour chaque KPI sous la cible (selon `goal`), génère une
**suggestion textuelle** concrète (règles + génération locale Ollama), stockée `open` dans
`agent_suggestions`. Le gérant `approve`/`dismiss`. (Aucune action auto au socle.)

### 6. Helpers DB & orchestration — `server/agents/state.ts`

`getAgentState`, `setAgentState`, `logAgentActivity`, `addAgentNote`, `getAgentNotes`,
`recordReportSnapshot`. Le worker CR (`autoReportAgent`) appelle `logAgentActivity` +
`recordReportSnapshot` ; le chat et la double-lecture appellent `logAgentActivity`.

### 7. tRPC — `agents` router (server/routers.ts)

- `list` (medicalProcedure) → fiches (depuis le code) + état + KPIs + santé.
- `configure` (adminProcedure {agentKey, enabled?, targets?}).
- `activity` (medicalProcedure {agentKey?, limit}) → journal.
- `suggestions` (medicalProcedure) → suggestions ouvertes.
- `resolveSuggestion` (adminProcedure {id, action}).

### 8. UI — `client/src/components/AgentsDashboard.tsx`

Une carte par agent : fiche métier (rôle/objectifs/tâches/outils/accès/garde-fous, lecture
seule), **KPIs vs objectif** (jauge), **santé** (dernier run, erreurs, taux succès), bouton
ON/OFF + cible éditable, **suggestions d'amélioration** à valider. Monté dans la sidebar/réglages
admin de Home.

## Garde-fous / sécurité

- Outils/accès **en code** ; tool-gate **imposé** à l'exécution.
- Améliorations **proposées → validées** (jamais auto-appliquées).
- Garde-fous existants intacts (pas d'envoi/signature sans médecin ; agent CR OFF par défaut).
- PHI : tout local/dans le périmètre ; journal/notes sans contenu PHI sensible (clés/compteurs).
- Mono-tenant ; endpoints `medical`/`admin` appropriés ; activité auditée.

## Tests

- Tool-gate : outil hors-fiche → throw ; outil autorisé → ok.
- `computeAgentKpis` sur jeux synthétiques (acceptanceRate, etc. — fonctions pures testables).
- `computeSuggestions` : KPI sous cible → suggestion `open` ; au-dessus → aucune.
- Snapshot : enregistré à la génération ; diff snapshot↔signé.
- Registre : chaque AgentSpec a tools ⊆ TOOLS et kpis non vides (test de cohérence).

## Migration

Manuelle (convention repo) `0015_agents_socle.sql`. **RAPPEL** : retirer `--> statement-breakpoint`
avant `mysql` (cf. 0013).

## Sous-projets suivants (hors socle)

Agent Apprentissage (diff→fiches RAG), Agent Référent/Envoi, Agent Codage TARDOC/CIM-10 —
chacun = une fiche métier + ses outils + son accès + ses KPIs, branché sur ce socle.
