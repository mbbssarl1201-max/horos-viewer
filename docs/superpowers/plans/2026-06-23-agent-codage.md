# Agent Codage Hermès (CIM-10 + TARDOC) — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Étendre suggestCodes aux actes TARDOC + formaliser le codage comme agent (fiche métier, tool-gate, journal). Suggestion à valider, local PHI-safe.

**Tech:** TS, tRPC, React, Vitest. Pas de migration.

---

### Task 1: Étendre suggestCodes (TARDOC) + agent au registre

**Files:** `server/report/suggestCodes.ts`, `server/report/suggestCodes.test.ts` (create), `server/agents/registry.ts`, `server/agents/registry.test.ts` (maj compte)

- [ ] **Step 1: test** — créer `server/report/suggestCodes.test.ts` (mock fetch) :

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../_core/env", () => ({
  ENV: { ollamaUrl: "http://x", ollamaTextModel: "m" },
}));
import { suggestCodes } from "./suggestCodes";

describe("suggestCodes CIM-10 + TARDOC", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("renvoie codes ET tardoc", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              codes: [{ code: "R93.1", label: "anomalie" }],
              tardoc: [{ code: "39.0010", label: "CT abdomen" }],
            }),
          },
        }),
      }))
    );
    const r = await suggestCodes("res", "concl");
    expect(r.codes[0].code).toBe("R93.1");
    expect(r.tardoc[0].code).toBe("39.0010");
  });
  it("tableaux vides si réponse vide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ message: { content: "{}" } }),
      }))
    );
    const r = await suggestCodes("a", "b");
    expect(r.codes).toEqual([]);
    expect(r.tardoc).toEqual([]);
  });
});
```

Run `npx vitest run server/report/suggestCodes.test.ts` → FAIL (tardoc absent).

- [ ] **Step 2: étendre `suggestCodes.ts`** — changer le retour en `{ codes, tardoc }` :
  - prompt système : demander AUSSI `tardoc` : `'...{"codes":[{"code":"R93.1","label":"..."}],"tardoc":[{"code":"39.0010","label":"..."}]}'` + phrase « Propose aussi 1 à 5 actes TARDOC (tarif suisse) correspondant à l'examen. SUGGESTIONS à valider, ne facture rien. »
  - parsing : ajouter, en miroir de `codes`, un `tardoc: CodeSuggestion[]` (même filter/slice(5)/slice longueurs). Retourner `{ codes, tardoc }`. Le `return { codes: [] }` du garde `!ENV.ollamaUrl` devient `{ codes: [], tardoc: [] }`.
- [ ] **Step 3:** run test → PASS (2). `npx tsc --noEmit` → clean.
- [ ] **Step 4: agent au registre** — dans `server/agents/registry.ts`, ajouter au tableau `AGENTS` :

```ts
  {
    key: "codage",
    name: "Hermès Codage",
    role: "Propose les codes CIM-10 et actes TARDOC à partir du compte rendu.",
    objectives: ["Aider au codage diagnostique et tarifaire"],
    tasks: ["Suggérer des codes CIM-10", "Suggérer des actes TARDOC"],
    tools: ["suggestBillingCodes"],
    access: ["report.read"],
    guardrails: ["Suggestion à valider par le médecin", "Ne facture ni ne transmet rien"],
    kpis: [{ key: "codageRuns", label: "Codages proposés", target: 1, unit: "", goal: "max" }],
  },
```

- [ ] **Step 5: maj test registre** — dans `server/agents/registry.test.ts`, ajouter `"codage"` au tableau attendu (trié) : `["apprentissage","codage","copilote","qualite","redacteur"]`.
- [ ] **Step 6:** `npx vitest run server/agents/registry.test.ts server/report/suggestCodes.test.ts` → PASS. `npx tsc --noEmit` → clean.
- [ ] **Step 7: commit**

```bash
git add server/report/suggestCodes.ts server/report/suggestCodes.test.ts server/agents/registry.ts server/agents/registry.test.ts
git commit -m "feat(codage): suggestCodes + TARDOC + agent au registre"
```

---

### Task 2: Router via tool-gate + journal

**Files:** `server/routers.ts`

- [ ] **Step 1:** trouver la mutation `reports.suggestCodes` (vers ligne 2346). Elle fait `return suggestCodes(input.resultats, input.conclusion);`. La remplacer par un passage par le tool-gate + log :

```ts
const { suggestCodes } = await import("./report/suggestCodes");
const { runAgentTool } = await import("./agents/tools");
const { logAgentActivity } = await import("./agents/state");
const res = await runAgentTool(
  "codage",
  "suggestBillingCodes",
  () => suggestCodes(input.resultats, input.conclusion),
  null
);
await logAgentActivity("codage", "suggestBillingCodes", "ok", {
  detail: `cim=${res.codes.length} tardoc=${res.tardoc.length}`,
});
return res;
```

(garder l'`.input(...)` existant inchangé.)

- [ ] **Step 2:** `npx tsc --noEmit` → clean. Commit :

```bash
git add server/routers.ts
git commit -m "feat(codage): router suggestCodes via tool-gate + journal"
```

---

### Task 3: UI TARDOC + intégration + déploiement

**Files:** `client/src/components/ReportPanel.tsx`

- [ ] **Step 1: explorer** le rendu actuel des codes : `grep -n "suggestCodes\|\.codes\|CIM\|code" client/src/components/ReportPanel.tsx`. Repérer où `result.codes` (ou équivalent) est affiché.
- [ ] **Step 2:** sous la liste des codes CIM-10 existante, ajouter une liste « Actes TARDOC (à valider) » rendue depuis `data.tardoc` (même style que les codes CIM-10 ; mapper `{code,label}`). Si `tardoc` vide, ne rien afficher.
- [ ] **Step 3:** `npx tsc --noEmit` clean ; `npm run build` succès. Commit :

```bash
git add -A
git commit -m "feat(codage): UI actes TARDOC dans le compte rendu"
```

- [ ] **Step 4: intégration** : `npx tsc --noEmit && npx vitest run` → clean + verts.
- [ ] **Step 5: déploiement** : PR `docs/agent-codage` → `self-host`, merge, CI verte, déployer (pull image SHA + sed compose + up -d --force-recreate app), health 200. (Aucune migration.)
- [ ] **Step 6: vérif** : `agentsRegistry.list` montre 5 agents (dont codage) ; `reports.suggestCodes` renvoie `{codes, tardoc}`.

---

## Self-review

- Couverture spec : extension TARDOC (T1), agent registre (T1), tool-gate+journal (T2), UI (T3), pas de migration. ✅
- Non-objectifs : suggestion only, local, ne facture pas, mono-tenant. ✅
- Cohérence : `{ codes, tardoc }`, tool `suggestBillingCodes` (déclaré registre), agent `codage`. Le test registre passe de 4 à 5 agents (maj en T1 Step 5). ✅
