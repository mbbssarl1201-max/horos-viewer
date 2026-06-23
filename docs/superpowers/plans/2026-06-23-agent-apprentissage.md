# Agent Apprentissage Hermès — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** L'agent Apprentissage repère les corrections récurrentes (brouillon IA → signé) par modalité, en abstrait une règle générale anonyme (modèle local), la propose ; à l'approbation humaine, elle entre en base RAG (`radio-ref-appris`) et améliore les futurs CR.

**Architecture:** Réutilise snapshots/suggestions/pipeline RAG du socle. Étend `agent_suggestions` (mig 0016). Nouvel agent au registre + tool-gate. Batch via bouton. Abstraction = Ollama local. Écriture RAG = `embedText`+`insertChunks`, et SEULEMENT à l'approbation.

**Tech Stack:** TS, Drizzle/MySQL, tRPC, React, Vitest. Migrations manuelles (retirer `--> statement-breakpoint`).

---

### Task 1: Migration 0016 + extension `agent_suggestions`

**Files:** `drizzle/schema.ts`, `drizzle/0016_agent_learning.sql` (create)

- [ ] **Step 1:** dans `drizzle/schema.ts`, table `agentSuggestions`, ajouter ces champs (après `status`) :

```ts
  kind: mysqlEnum("kind", ["improvement", "rag_fiche"]).notNull().default("improvement"),
  modality: varchar("modality", { length: 16 }),
  proposedHeading: varchar("proposedHeading", { length: 512 }),
  proposedContent: text("proposedContent"),
  sampleCount: int("sampleCount"),
```

- [ ] **Step 2:** créer `drizzle/0016_agent_learning.sql` :

```sql
ALTER TABLE `agent_suggestions` ADD COLUMN `kind` enum('improvement','rag_fiche') NOT NULL DEFAULT 'improvement';
--> statement-breakpoint
ALTER TABLE `agent_suggestions` ADD COLUMN `modality` varchar(16);
--> statement-breakpoint
ALTER TABLE `agent_suggestions` ADD COLUMN `proposedHeading` varchar(512);
--> statement-breakpoint
ALTER TABLE `agent_suggestions` ADD COLUMN `proposedContent` text;
--> statement-breakpoint
ALTER TABLE `agent_suggestions` ADD COLUMN `sampleCount` int;
```

- [ ] **Step 3:** `npx tsc --noEmit` → clean.
- [ ] **Step 4: commit**

```bash
git add drizzle/schema.ts drizzle/0016_agent_learning.sql
git commit -m "feat(apprentissage): extension agent_suggestions (kind/modality/fiche, mig 0016)"
```

---

### Task 2: Agent au registre + scrub PHI (fonctions pures)

**Files:** `server/agents/registry.ts`, Create `server/agents/learning.ts` + `server/agents/learning.test.ts`

- [ ] **Step 1:** dans `server/agents/registry.ts`, ajouter au tableau `AGENTS` :

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
  },
```

- [ ] **Step 2: failing test** — créer `server/agents/learning.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupByModality, stripPhiLike } from "./learning";

describe("agent apprentissage", () => {
  it("groupByModality applique le seuil (≥3)", () => {
    const items = [
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "US", draft: "a", signed: "b" },
      { modality: "US", draft: "a", signed: "b" },
    ];
    const g = groupByModality(items, 3);
    expect(g.has("CT")).toBe(true);
    expect(g.has("US")).toBe(false); // 2 < 3
  });
  it("stripPhiLike retire nom MAJUSCULE, date, gros nombre ; garde le médical", () => {
    const t =
      "POCINCI ZEHRA née le 24.12.1997 id 1029384 : épaississement zone jonctionnelle 12 mm";
    const c = stripPhiLike(t);
    expect(c).not.toMatch(/POCINCI|ZEHRA/);
    expect(c).not.toMatch(/24\.12\.1997/);
    expect(c).not.toMatch(/1029384/);
    expect(c).toMatch(/zone jonctionnelle 12 mm/);
  });
});
```

Run `npx vitest run server/agents/learning.test.ts` → FAIL.

- [ ] **Step 3:** créer `server/agents/learning.ts` avec les fonctions pures (le reste en Task 3) :

```ts
export interface Correction {
  modality: string;
  draft: string;
  signed: string;
}

/** Regroupe par modalité, ne garde que celles atteignant le seuil. */
export function groupByModality(
  items: Correction[],
  minSamples: number
): Map<string, Correction[]> {
  const map = new Map<string, Correction[]>();
  for (const it of items) {
    const k = (it.modality || "?").toUpperCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  for (const [k, v] of map) if (v.length < minSamples) map.delete(k);
  return map;
}

/** Filet anti-PHI : retire noms en MAJUSCULES, dates, identifiants numériques longs. */
export function stripPhiLike(text: string): string {
  return (text ?? "")
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, "[date]")
    .replace(/\b\d{6,}\b/g, "[id]")
    .replace(/\b[A-ZÀ-Þ]{2,}(?:\s+[A-ZÀ-Þ]{2,}){1,5}\b/g, "[nom]")
    .trim();
}
```

Run test → PASS (2). `npx tsc --noEmit` → clean.

- [ ] **Step 4: commit**

```bash
git add server/agents/registry.ts server/agents/learning.ts server/agents/learning.test.ts
git commit -m "feat(apprentissage): agent au registre + groupByModality + stripPhiLike"
```

---

### Task 3: Collecte + abstraction + orchestration

**Files:** `server/agents/learning.ts` (append)

- [ ] **Step 1:** ajouter à `server/agents/learning.ts` :

```ts
import { ENV } from "../_core/env";

const MIN_SAMPLES = Number(process.env.LEARNING_MIN_SAMPLES ?? "3");

/** Reports signés avec snapshot + correction majeure → couples anonymisés par modalité. */
export async function collectCorrections(): Promise<Correction[]> {
  const { getDb, getStudyById } = await import("../db");
  const { reports, reportAiSnapshots } = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const { sectionsChangedSignificantly } = await import("./metrics");
  const db = await getDb();
  if (!db) return [];
  const signed = await db
    .select()
    .from(reports)
    .where(eq(reports.status, "signed"));
  const out: Correction[] = [];
  for (const r of signed) {
    const snap = await db
      .select()
      .from(reportAiSnapshots)
      .where(eq(reportAiSnapshots.studyId, r.studyId))
      .limit(1);
    if (!snap[0]) continue;
    const draft = JSON.parse(snap[0].sectionsJson);
    if (!sectionsChangedSignificantly(draft, r as any)) continue;
    const study = (await getStudyById(r.studyId)) as any;
    out.push({
      modality: study?.modality ?? "?",
      draft: stripPhiLike(
        `${draft.resultats ?? ""}\n${draft.conclusion ?? ""}`
      ),
      signed: stripPhiLike(`${r.resultats ?? ""}\n${r.conclusion ?? ""}`),
    });
  }
  return out;
}

/** Abstraction LOCALE (Ollama, PHI-safe) → règle générale anonyme. */
export async function abstractRule(
  modality: string,
  samples: Correction[]
): Promise<{ heading: string; content: string } | null> {
  const examples = samples
    .slice(0, 5)
    .map(
      (s, i) =>
        `Exemple ${i + 1}\n- Brouillon IA : ${s.draft}\n- Corrigé par le médecin : ${s.signed}`
    )
    .join("\n\n");
  const sys =
    'Tu es un radiologue senior. À partir de corrections FRÉQUENTES apportées par un médecin à des brouillons d\'IA, formule UNE règle radiologique GÉNÉRALE et ANONYME que l\'IA devrait suivre la prochaine fois. INTERDIT : tout nom, date, identifiant ou détail propre à un patient. Réponds STRICTEMENT en JSON {"heading":"...","content":"2 à 4 phrases"}.';
  const user = `Modalité : ${modality}.\n${examples}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: ENV.ollamaTextModel,
        stream: false,
        keep_alive: -1,
        format: "json",
        options: { num_thread: 4, temperature: 0.2 },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const parsed = JSON.parse(data?.message?.content ?? "{}");
    const heading = stripPhiLike(String(parsed.heading ?? "")).slice(0, 500);
    const content = stripPhiLike(String(parsed.content ?? "")).slice(0, 4000);
    if (!heading || !content) return null;
    return { heading: `${heading} (appris — ${modality})`, content };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Batch : collecte → groupe(seuil) → abstrait → propose (agent_suggestions, open). */
export async function runLearningAgent(): Promise<{ proposed: number }> {
  const { getDb } = await import("../db");
  const { agentSuggestions } = await import("../../drizzle/schema");
  const { and, eq } = await import("drizzle-orm");
  const { logAgentActivity } = await import("./state");
  const { runAgentTool } = await import("./tools");
  const db = await getDb();
  if (!db) return { proposed: 0 };
  const corrections = await collectCorrections();
  const groups = groupByModality(corrections, MIN_SAMPLES);
  let proposed = 0;
  for (const [modality, samples] of groups) {
    // idempotence : pas de fiche open déjà pour cette modalité
    const existing = await db
      .select()
      .from(agentSuggestions)
      .where(
        and(
          eq(agentSuggestions.agentKey, "apprentissage"),
          eq(agentSuggestions.kind, "rag_fiche"),
          eq(agentSuggestions.modality, modality),
          eq(agentSuggestions.status, "open")
        )
      )
      .limit(1);
    if (existing[0]) continue;
    const rule = await runAgentTool(
      "apprentissage",
      "proposeRagFiche",
      () => abstractRule(modality, samples),
      null
    );
    if (!rule) continue;
    await db.insert(agentSuggestions).values({
      agentKey: "apprentissage",
      kpiKey: "fichesProposed",
      kind: "rag_fiche",
      modality,
      proposedHeading: rule.heading,
      proposedContent: rule.content,
      sampleCount: samples.length,
      suggestion: `Fiche apprise (${modality}, vue ${samples.length}×) : ${rule.heading}`,
      status: "open",
    });
    proposed++;
    await logAgentActivity("apprentissage", "proposeRagFiche", "ok", {
      detail: `${modality} x${samples.length}`,
    });
  }
  return { proposed };
}

/** À l'approbation : insère la fiche en base RAG (source radio-ref-appris). Idempotent. */
export async function applyRagFiche(suggestionId: number): Promise<boolean> {
  const { getDb } = await import("../db");
  const { agentSuggestions, knowledgeChunks } = await import(
    "../../drizzle/schema"
  );
  const { eq, and } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select()
    .from(agentSuggestions)
    .where(eq(agentSuggestions.id, suggestionId))
    .limit(1);
  const s = rows[0];
  if (!s || s.kind !== "rag_fiche" || s.status !== "approved") return false;
  if (!s.proposedHeading || !s.proposedContent) return false;
  // idempotence : ne pas réinsérer le même heading
  const dup = await db
    .select()
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.source, "radio-ref-appris"),
        eq(knowledgeChunks.heading, s.proposedHeading)
      )
    )
    .limit(1);
  if (dup[0]) return true;
  const { embedText } = await import("../knowledge/embeddings");
  const { insertChunks } = await import("../knowledge/store");
  const embedding = await embedText(
    `${s.proposedHeading}\n${s.proposedContent}`
  );
  await insertChunks([
    {
      source: "radio-ref-appris",
      heading: s.proposedHeading,
      content: s.proposedContent,
      embedding,
    },
  ]);
  return true;
}
```

- [ ] **Step 2:** `npx tsc --noEmit` → clean. `npx vitest run server/agents/learning.test.ts` → PASS (les purs).
- [ ] **Step 3: commit**

```bash
git add server/agents/learning.ts
git commit -m "feat(apprentissage): collecte + abstraction locale + runLearningAgent + applyRagFiche"
```

---

### Task 4: tRPC — runLearning + branchement approbation

**Files:** `server/routers.ts` (router `agentsRegistry`)

- [ ] **Step 1:** ajouter dans `agentsRegistry` une mutation :

```ts
    runLearning: adminProcedure.mutation(async ({ ctx }) => {
      const { runLearningAgent } = await import("./agents/learning");
      const res = await runLearningAgent();
      await recordAccess({ userId: ctx.user.id, action: "agents.runLearning", studyId: null, detail: `proposed=${res.proposed}`, ipAddress: ctx.req?.ip ?? null });
      return res;
    }),
```

- [ ] **Step 2:** dans la mutation `resolveSuggestion` existante, APRÈS le `db.update(...).set({ status: input.action })`, ajouter (avant le `return`) :

```ts
if (input.action === "approved") {
  const { applyRagFiche } = await import("./agents/learning");
  await applyRagFiche(input.id); // no-op si la suggestion n'est pas une rag_fiche
}
```

- [ ] **Step 3:** `npx tsc --noEmit` → clean. Commit :

```bash
git add server/routers.ts
git commit -m "feat(apprentissage): tRPC runLearning + insertion RAG à l'approbation"
```

---

### Task 5: UI — fiches apprises dans le dashboard

**Files:** `client/src/components/AgentsDashboard.tsx`

- [ ] **Step 1:** ajouter un bouton « Apprendre des corrections » qui appelle `trpc.agentsRegistry.runLearning.useMutation()` (à côté de « Analyser »), avec refetch des suggestions. Pour les suggestions `kind === "rag_fiche"`, afficher en plus : `modality`, `proposedHeading` (gras), `proposedContent`, et « vu {sampleCount}× ». Les boutons Approuver/Ignorer existent déjà (resolveSuggestion). Adapter le rendu :

```tsx
const runLearning = trpc.agentsRegistry.runLearning.useMutation({
  onSuccess: () => suggestions.refetch(),
});
// bouton :
<button
  className="text-[11px] rounded bg-muted/50 px-2 py-1"
  onClick={() => runLearning.mutate()}
>
  Apprendre des corrections
</button>;
// dans le map des suggestions, si s.kind === "rag_fiche" :
{
  s.kind === "rag_fiche" && (
    <div className="text-[11px]">
      <div className="font-medium">
        {s.proposedHeading}{" "}
        <span className="text-muted-foreground">
          ({s.modality}, vu {s.sampleCount}×)
        </span>
      </div>
      <div className="text-muted-foreground">{s.proposedContent}</div>
    </div>
  );
}
```

(garder l'affichage `s.suggestion` pour les `improvement`.)

- [ ] **Step 2:** `npx tsc --noEmit` clean ; `npm run build` succès. Commit :

```bash
git add -A
git commit -m "feat(apprentissage): UI fiches apprises + bouton Apprendre"
```

---

### Task 6: Intégration + migration + déploiement

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run` → clean + tous verts.
- [ ] **Step 2: migration 0016 en prod (SANS marqueurs)** :

```bash
ssh root@76.13.55.44 'docker exec -i horos-db-1 sh -c "exec mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" horos"' <<'SQL'
ALTER TABLE `agent_suggestions` ADD COLUMN `kind` enum('improvement','rag_fiche') NOT NULL DEFAULT 'improvement';
ALTER TABLE `agent_suggestions` ADD COLUMN `modality` varchar(16);
ALTER TABLE `agent_suggestions` ADD COLUMN `proposedHeading` varchar(512);
ALTER TABLE `agent_suggestions` ADD COLUMN `proposedContent` text;
ALTER TABLE `agent_suggestions` ADD COLUMN `sampleCount` int;
SQL
```

Vérifier `SHOW COLUMNS FROM agent_suggestions LIKE "kind"`.

- [ ] **Step 3:** PR `docs/agent-apprentissage` → `self-host`, merge, CI verte, déployer, health 200.
- [ ] **Step 4: vérification** : `agentsRegistry.list` montre 4 agents (dont apprentissage) ; `runLearning` renvoie `{proposed}` (0 si pas encore de corrections récurrentes — normal) ; approuver une fiche `rag_fiche` insère bien un chunk `radio-ref-appris` (vérifier `SELECT COUNT(*) ... source='radio-ref-appris'`).

---

## Self-review

- Couverture spec : extension table (T1), agent registre + scrub (T2), collecte/abstraction/orchestration/apply (T3), tRPC + branchement approbation (T4), UI (T5), intégration/migration (T6). ✅
- Non-objectifs : pas d'écriture RAG sans approbation (applyRagFiche exige status=approved + appelé depuis resolveSuggestion approved), seuil ≥3, stripPhiLike + abstraction locale, pas de modif prompt/poids. ✅
- Cohérence noms : `Correction`, `groupByModality`, `stripPhiLike`, `collectCorrections`, `abstractRule`, `runLearningAgent`, `applyRagFiche` ; source RAG `radio-ref-appris` ; tool `proposeRagFiche` (déclaré dans la fiche registre). ✅
- Limite : KPIs `fichesProposed/fichesApproved` affichés mais `computeOneKpi` (metrics.ts) renvoie 0 pour eux tant qu'on n'ajoute pas leur branche — non bloquant, comptage visible via les suggestions. La fiche tool `proposeRagFiche` passe par `runAgentTool` (tool-gate) en T3.
