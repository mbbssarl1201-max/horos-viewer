# Pré-analyse IA des images clés — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un bouton « Pré-analyse IA » au panneau Compte rendu qui fait analyser les images clés par un VLM local (Ollama VPS) pour pré-remplir _Résultats_/_Conclusion_, le médecin validant et signant avant l'envoi PDF+MP4 existant.

**Architecture:** Le serveur appelle l'API vision d'Ollama (`ollama-hermes`, même réseau Docker) avec les PNG des images clés et un prompt FR structuré ; renvoie un brouillon `{resultats, conclusion}`. Tout est local (PHI-safe), audité, rate-limité, fail-soft. Une mention « assisté par IA » est ajoutée au PDF quand le brouillon a servi.

**Tech Stack:** TypeScript, tRPC v11, fetch (Ollama /api/chat), Vitest, React, jsPDF (existant), Ollama `qwen2.5-vl:3b`.

**Spec:** `docs/superpowers/specs/2026-06-10-ai-preanalysis-design.md`

---

## File Structure

- **Modify** `server/_core/env.ts` — ajouter `ollamaUrl`, `ollamaVisionModel`.
- **Create** `server/report/aiPreanalysis.ts` — `generatePreanalysis()` (client Ollama vision + parsing) et `runAiPreanalysis()` (orchestration : rate-limit, étude, audit).
- **Create** `server/report/aiPreanalysis.test.ts` — tests parsing + fail-soft (mock fetch).
- **Create** `server/aiPreanalysis.mutation.test.ts` — tests orchestration (rate-limit, 404, audit).
- **Modify** `server/routers.ts` — mutation `email.aiPreanalysis` + champ `aiAssisted` dans `email.sendStudyReport`.
- **Modify** `server/report/sendStudyReport.ts` — `aiAssisted` dans l'input, passé à `buildReportPdf`.
- **Modify** `server/report/reportPdf.ts` — `aiAssisted?: boolean` dans `ReportPdfInput` + mention PDF.
- **Modify** `server/report/reportPdf.test.ts` — test de la mention IA.
- **Modify** `client/src/components/ReportPanel.tsx` — bouton « Pré-analyse IA », pré-remplissage, badge/disclaimer, flag `aiAssisted` à l'envoi.
- **Ops** (Task 6) : pull modèle Ollama + env `OLLAMA_*` dans le compose VPS + redéploiement + vérif live.

---

## Task 1: Config env Ollama

**Files:** Modify `server/_core/env.ts`

- [ ] **Step 1: Ajouter les variables**

Dans l'objet `ENV` de `server/_core/env.ts`, après le bloc Orthanc (`orthancUrl`/`orthancUser`/`orthancPassword`), ajouter :

```ts
  // IA locale (Ollama auto-hébergé) — pré-analyse vision des images clés.
  ollamaUrl: process.env.OLLAMA_URL ?? "http://ollama-hermes:11434",
  ollamaVisionModel: process.env.OLLAMA_VISION_MODEL ?? "qwen2.5-vl:3b",
```

- [ ] **Step 2: Vérifier la compilation**

Run: `pnpm check`
Expected: 0 erreur.

- [ ] **Step 3: Commit**

```bash
git add server/_core/env.ts
git commit -m "feat(ai): config env Ollama (OLLAMA_URL, OLLAMA_VISION_MODEL)"
```

---

## Task 2: Client VLM `generatePreanalysis`

**Files:** Create `server/report/aiPreanalysis.ts`, Test `server/report/aiPreanalysis.test.ts`

- [ ] **Step 1: Écrire le test (échoue)**

`server/report/aiPreanalysis.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("generatePreanalysis", () => {
  beforeEach(() => {
    process.env.OLLAMA_URL = "http://ollama-test:11434";
    process.env.OLLAMA_VISION_MODEL = "qwen2.5-vl:3b";
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parse Résultats/Conclusion depuis la réponse Ollama", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: {
            content:
              "Résultats:\nPas de fracture visible.\n\nConclusion:\nExamen normal.",
          },
        }),
      }))
    );
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "AAAA", sliceIndex: 0 }],
      {}
    );
    expect(out.resultats).toMatch(/Pas de fracture/);
    expect(out.conclusion).toMatch(/Examen normal/);
    expect(out.model).toBe("qwen2.5-vl:3b");
  });

  it("repli : réponse hors-format -> tout dans resultats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: { content: "Texte libre sans sections." },
        }),
      }))
    );
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "AAAA", sliceIndex: 0 }],
      {}
    );
    expect(out.resultats).toBe("Texte libre sans sections.");
    expect(out.conclusion).toBe("");
  });

  it("Ollama en erreur -> throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }))
    );
    const { generatePreanalysis } = await import("./aiPreanalysis");
    await expect(
      generatePreanalysis([{ pngBase64: "AAAA", sliceIndex: 0 }], {})
    ).rejects.toThrow();
  });

  it("envoie les images en base64 dans le message user", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nx\nConclusion:\ny" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    await generatePreanalysis([{ pngBase64: "IMG1", sliceIndex: 3 }], {
      indication: "douleur",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.images).toContain("IMG1");
    expect(body.model).toBe("qwen2.5-vl:3b");
    expect(body.stream).toBe(false);
  });
});
```

- [ ] **Step 2: Lancer le test (échoue)**

Run: `pnpm vitest run server/report/aiPreanalysis.test.ts`
Expected: FAIL — module `./aiPreanalysis` inexistant.

- [ ] **Step 3: Implémenter le client**

`server/report/aiPreanalysis.ts` :

```ts
import { ENV } from "../_core/env";

export interface PreanalysisKeyImage {
  pngBase64: string;
  sliceIndex: number;
}

export interface PreanalysisResult {
  resultats: string;
  conclusion: string;
  model: string;
}

const SYSTEM_PROMPT = [
  "Tu es un assistant de pré-analyse d'imagerie médicale destiné à un MÉDECIN (pas au patient).",
  "Tu observes une ou plusieurs coupes et tu proposes un BROUILLON en français, à valider par le médecin.",
  "Règles STRICTES :",
  "- N'invente AUCUNE mesure, valeur chiffrée, ni diagnostic catégorique.",
  '- Exprime explicitement l\'incertitude ("aspect évocateur de", "à corréler", "sous réserve").',
  "- Ne tente pas d'identifier le patient.",
  "- Réponds UNIQUEMENT avec deux sections, exactement dans ce format :",
  "Résultats:",
  "<description des observations>",
  "",
  "Conclusion:",
  "<synthèse prudente>",
].join("\n");

/**
 * Envoie les images clés (PNG base64) au VLM local Ollama et renvoie un brouillon
 * { resultats, conclusion }. Throw uniquement si Ollama est injoignable / répond
 * en erreur (capté par l'appelant en fail-soft). Une réponse hors-format n'est PAS
 * une erreur : tout le texte va dans `resultats`.
 */
export async function generatePreanalysis(
  keyImages: PreanalysisKeyImage[],
  opts: { indication?: string }
): Promise<PreanalysisResult> {
  const model = ENV.ollamaVisionModel;
  const userText = opts.indication
    ? `Indication clinique : ${opts.indication}\nDécris tes observations puis conclus.`
    : "Décris tes observations puis conclus.";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let content = "";
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: "30s",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: userText,
            images: keyImages.map(k => k.pngBase64),
          },
        ],
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Ollama HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    content = data?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }

  return { ...parseSections(content), model };
}

/** Sépare la sortie en Résultats/Conclusion ; repli = tout dans resultats. */
export function parseSections(text: string): {
  resultats: string;
  conclusion: string;
} {
  const m = text.match(
    /Résultats\s*:?\s*([\s\S]*?)\n\s*Conclusion\s*:?\s*([\s\S]*)$/i
  );
  if (m) {
    return { resultats: m[1].trim(), conclusion: m[2].trim() };
  }
  return { resultats: text.trim(), conclusion: "" };
}
```

- [ ] **Step 4: Lancer les tests (passent)**

Run: `pnpm vitest run server/report/aiPreanalysis.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/report/aiPreanalysis.ts server/report/aiPreanalysis.test.ts
git commit -m "feat(ai): client Ollama vision generatePreanalysis (+ parsing Résultats/Conclusion)"
```

---

## Task 3: Orchestration + mutation `email.aiPreanalysis`

**Files:** Modify `server/report/aiPreanalysis.ts` (ajout `runAiPreanalysis`), Modify `server/routers.ts`, Test `server/aiPreanalysis.mutation.test.ts`

- [ ] **Step 1: Écrire le test (échoue)**

`server/aiPreanalysis.mutation.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  getStudyById: vi.fn(),
  countRecentAccess: vi.fn(),
  recordAccess: vi.fn(),
  generatePreanalysis: vi.fn(),
};
vi.mock("../db", () => ({
  getStudyById: (...a: any) => mocks.getStudyById(...a),
  countRecentAccess: (...a: any) => mocks.countRecentAccess(...a),
  recordAccess: (...a: any) => mocks.recordAccess(...a),
}));

import { runAiPreanalysis } from "./report/aiPreanalysis";
// generatePreanalysis est dans le même module : on le mocke via vi.spyOn dynamique.
import * as ai from "./report/aiPreanalysis";

const onePxPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const baseInput = {
  studyId: 1,
  keyImages: [{ pngBase64: onePxPng, sliceIndex: 0 }],
  indication: "douleur",
};
const ctx = { user: { id: 7 }, req: { ip: "1.2.3.4" } } as any;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.countRecentAccess.mockResolvedValue(0);
  mocks.getStudyById.mockResolvedValue({ id: 1, patientName: "P" });
  vi.spyOn(ai, "generatePreanalysis").mockResolvedValue({
    resultats: "R",
    conclusion: "C",
    model: "qwen2.5-vl:3b",
  });
});

describe("runAiPreanalysis", () => {
  it("refuse au-delà du rate-limit", async () => {
    mocks.countRecentAccess.mockResolvedValue(30);
    await expect(runAiPreanalysis(baseInput, ctx)).rejects.toThrow(
      /limite|too many/i
    );
  });
  it("404 si étude absente", async () => {
    mocks.getStudyById.mockResolvedValue(undefined);
    await expect(runAiPreanalysis(baseInput, ctx)).rejects.toThrow(
      /introuvable|not found/i
    );
  });
  it("rejette un PNG invalide", async () => {
    await expect(
      runAiPreanalysis(
        { ...baseInput, keyImages: [{ pngBase64: "bm90cG5n", sliceIndex: 0 }] },
        ctx
      )
    ).rejects.toThrow(/png/i);
  });
  it("succès : renvoie le brouillon + audit", async () => {
    const out = await runAiPreanalysis(baseInput, ctx);
    expect(out).toEqual({
      resultats: "R",
      conclusion: "C",
      model: "qwen2.5-vl:3b",
    });
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ action: "study.ai.preanalysis", studyId: 1 })
    );
  });
});
```

> Note : `vi.spyOn(ai, "generatePreanalysis")` ne fonctionne que si `runAiPreanalysis` appelle `generatePreanalysis` via la référence du module (appel `generatePreanalysis(...)` dans le même fichier — l'espion sur l'export peut ne pas intercepter un appel interne direct). Pour rendre l'espion fiable, dans `aiPreanalysis.ts`, faire appeler `runAiPreanalysis` **via l'objet exporté** : déclarer `export const _internal = { generatePreanalysis }` et appeler `_internal.generatePreanalysis(...)` ; le test fait alors `vi.spyOn(ai._internal, "generatePreanalysis")`. Adapter le test et l'implémentation en cohérence.

- [ ] **Step 2: Lancer le test (échoue)**

Run: `pnpm vitest run server/aiPreanalysis.mutation.test.ts`
Expected: FAIL — `runAiPreanalysis` non exporté.

- [ ] **Step 3: Ajouter l'orchestration dans `server/report/aiPreanalysis.ts`**

Ajouter en haut les imports et en bas la fonction (et l'indirection `_internal` pour la testabilité) :

```ts
import { TRPCError } from "@trpc/server";
import { getStudyById, countRecentAccess, recordAccess } from "../db";

export const _internal = { generatePreanalysis };

function assertPng(b64: string) {
  const png = Buffer.from(b64, "base64");
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(sig)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Image clé : PNG attendu",
    });
  }
}

export interface RunAiPreanalysisInput {
  studyId: number;
  keyImages: PreanalysisKeyImage[];
  indication?: string;
}

export async function runAiPreanalysis(
  input: RunAiPreanalysisInput,
  ctx: { user: { id: number }; req?: { ip?: string } }
): Promise<PreanalysisResult> {
  const recent = await countRecentAccess(
    ctx.user.id,
    "study.ai.preanalysis",
    60
  );
  if (recent >= 30) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Limite de pré-analyses atteinte, réessayez plus tard.",
    });
  }
  const study = await getStudyById(input.studyId);
  if (!study)
    throw new TRPCError({ code: "NOT_FOUND", message: "Étude introuvable" });

  input.keyImages.forEach(k => assertPng(k.pngBase64));

  const result = await _internal.generatePreanalysis(input.keyImages, {
    indication: input.indication,
  });

  await recordAccess({
    userId: ctx.user.id,
    action: "study.ai.preanalysis",
    studyId: study.id,
    detail: result.model,
    ipAddress: ctx.req?.ip ?? null,
  });
  return result;
}
```

> Dans `generatePreanalysis`, garder l'appel tel quel. Le test mocke `_internal.generatePreanalysis`.

- [ ] **Step 4: Brancher la mutation tRPC dans `server/routers.ts`**

Dans le routeur `email: router({ ... })`, après `sendStudyReport`, ajouter :

```ts
    aiPreanalysis: medicalProcedure
      .input(z.object({
        studyId: z.number(),
        keyImages: z.array(z.object({
          pngBase64: z.string().min(1).max(10_000_000),
          sliceIndex: z.number().int().min(0),
        })).min(1).max(20),
        indication: z.string().max(5000).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { runAiPreanalysis } = await import("./report/aiPreanalysis");
        return runAiPreanalysis(input, ctx as any);
      }),
```

- [ ] **Step 5: Lancer les tests (passent)**

Run: `pnpm vitest run server/aiPreanalysis.mutation.test.ts && pnpm check`
Expected: 4 PASS, tsc 0 erreur.

- [ ] **Step 6: Commit**

```bash
git add server/report/aiPreanalysis.ts server/aiPreanalysis.mutation.test.ts server/routers.ts
git commit -m "feat(ai): mutation email.aiPreanalysis (RBAC, rate-limit, audit, PNG validé)"
```

---

## Task 4: Mention « assisté par IA » dans le PDF

**Files:** Modify `server/report/reportPdf.ts` + `server/report/reportPdf.test.ts`, Modify `server/report/sendStudyReport.ts`, Modify `server/routers.ts` (zod `aiAssisted`)

- [ ] **Step 1: Écrire le test (échoue)**

Dans `server/report/reportPdf.test.ts`, ajouter :

```ts
import { PDFDocument } from "pdf-lib"; // si déjà dispo ; sinon, voir Step 3 (assertion sur taille)
```

> Si `pdf-lib` n'est pas une dépendance, NE PAS l'ajouter. À la place, tester la présence de la mention en générant le PDF et en cherchant la sous-chaîne dans le flux texte. jsPDF encode le texte de façon compressée ; donc tester par **différence de taille** : un PDF `aiAssisted:true` est plus long que `false`. Test :

```ts
it("ajoute la mention IA quand aiAssisted=true", () => {
  const base = {
    study: { id: 1 } as any,
    report: { indication: "", technique: "", resultats: "", conclusion: "" },
    signature: "T",
    keyImages: [],
  };
  const withoutAi = buildReportPdf({ ...base, aiAssisted: false });
  const withAi = buildReportPdf({ ...base, aiAssisted: true });
  expect(withAi.length).toBeGreaterThan(withoutAi.length);
  expect(withAi.subarray(0, 4).toString()).toBe("%PDF");
});
```

- [ ] **Step 2: Lancer le test (échoue)**

Run: `pnpm vitest run server/report/reportPdf.test.ts -t "mention IA"`
Expected: FAIL — `aiAssisted` non géré (PDF identique).

- [ ] **Step 3: Implémenter dans `reportPdf.ts`**

Dans `ReportPdfInput` (interface), ajouter :

```ts
  aiAssisted?: boolean;
```

Dans `buildReportPdf`, juste après l'écriture du nom du médecin (la ligne `doc.text(\`Dr ${input.signature}\`, MARGIN, y);`), ajouter :

```ts
if (input.aiAssisted) {
  y += 6;
  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text(
    "Pré-analyse assistée par IA, validée par le médecin signataire.",
    MARGIN,
    y
  );
}
```

- [ ] **Step 4: Propager `aiAssisted` dans `sendStudyReport.ts`**

Dans `SendStudyReportInput` (interface), ajouter `aiAssisted?: boolean;`. Dans l'appel `buildReportPdf({ ... })`, ajouter `aiAssisted: input.aiAssisted,`.

- [ ] **Step 5: Ajouter `aiAssisted` au zod de `email.sendStudyReport`**

Dans `server/routers.ts`, dans l'`input(z.object({...}))` de `sendStudyReport`, ajouter avant `message` :

```ts
        aiAssisted: z.boolean().optional(),
```

- [ ] **Step 6: Lancer tests + tsc**

Run: `pnpm vitest run server/report/reportPdf.test.ts && pnpm check`
Expected: tests PASS (dont la mention IA), tsc 0 erreur.

- [ ] **Step 7: Commit**

```bash
git add server/report/reportPdf.ts server/report/reportPdf.test.ts server/report/sendStudyReport.ts server/routers.ts
git commit -m "feat(ai): mention 'assisté par IA' dans le PDF quand le brouillon a servi"
```

---

## Task 5: Bouton « Pré-analyse IA » dans `ReportPanel`

**Files:** Modify `client/src/components/ReportPanel.tsx`

- [ ] **Step 1: Ajouter l'appel IA, le pré-remplissage, le badge et le flag**

Dans `client/src/components/ReportPanel.tsx` :

1. Après `const send = trpc.email.sendStudyReport.useMutation();`, ajouter :

```tsx
const preanalyze = trpc.email.aiPreanalysis.useMutation();
const [aiAssisted, setAiAssisted] = useState(false);

const runPreanalysis = async () => {
  const res = await preanalyze.mutateAsync({
    studyId,
    keyImages: keyImages.map(k => ({
      pngBase64: k.pngBase64,
      sliceIndex: k.sliceIndex,
    })),
    indication: indication || undefined,
  });
  setResultats(res.resultats);
  setConclusion(res.conclusion);
  setAiAssisted(true);
};
```

2. Dans l'appel `send.mutateAsync({ ... })`, ajouter le champ `aiAssisted,`.

3. Juste au-dessus du `<textarea ... placeholder="Résultats" ...>`, insérer le bouton + badge :

```tsx
<div className="flex items-center justify-between gap-2">
  <span className="text-xs font-medium">Résultats / Conclusion</span>
  <button
    type="button"
    onClick={runPreanalysis}
    disabled={preanalyze.isPending || keyImages.length === 0}
    className="text-[11px] rounded bg-primary/15 text-primary px-2 py-1 disabled:opacity-50"
    title="Pré-remplir via l'IA locale à partir des images clés"
  >
    {preanalyze.isPending ? "Analyse en cours…" : "Pré-analyse IA"}
  </button>
</div>;
{
  aiAssisted && (
    <p className="text-[10px] text-amber-500">
      Brouillon généré par IA — à valider et corriger avant signature.
    </p>
  );
}
{
  preanalyze.isError && (
    <p className="text-[10px] text-destructive">
      IA indisponible, rédigez manuellement.
    </p>
  );
}
```

> Place le bloc ci-dessus de sorte qu'il précède immédiatement les textarea Résultats puis Conclusion (qui restent éditables). `keyImages.length === 0` désactive le bouton (il faut au moins une image clé).

- [ ] **Step 2: Vérifier compilation + build**

Run: `pnpm check && pnpm build`
Expected: tsc 0 erreur, build OK. (`trpc.email.aiPreanalysis` doit être typé — Task 3 faite.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ReportPanel.tsx
git commit -m "feat(ai): bouton Pré-analyse IA dans le panneau Compte rendu (+ badge à valider)"
```

---

## Task 6: Déploiement, modèle, vérification live

**Files:** aucun (ops)

- [ ] **Step 1: Suite complète locale**

Run: `pnpm check && pnpm test && pnpm build`
Expected: tsc 0 erreur, suite verte, build OK.

- [ ] **Step 2: PR + merge → CI build image**

```bash
git push -u origin feat/ai-preanalysis
gh pr create --repo mbbssarl1201-max/horos-viewer --base self-host --head feat/ai-preanalysis --title "feat(ai): pré-analyse IA des images clés (VLM local)" --fill
gh pr merge feat/ai-preanalysis --repo mbbssarl1201-max/horos-viewer --merge
gh run watch "$(gh run list --repo mbbssarl1201-max/horos-viewer --workflow=deploy-image.yml --limit 1 --json databaseId -q '.[0].databaseId')" --repo mbbssarl1201-max/horos-viewer --exit-status
```

- [ ] **Step 3: Pull du VLM sur le VPS + vérif RAM**

Sur `root@76.13.55.44` :

```bash
docker exec ollama-hermes ollama pull qwen2.5-vl:3b
# vérifier que le modèle charge (un appel test), surveiller la RAM
free -h
```

Si OOM / pas assez de RAM (~4 Go libres) : décharger temporairement le 27B (`docker exec ollama-hermes ollama stop qwen3.6:27b` si supporté) ou signaler au gérant qu'il faut libérer/ajouter de la RAM. **Ne pas continuer en silence si le modèle ne charge pas — le signaler.**

- [ ] **Step 4: Vérifier la joignabilité app → Ollama + env**

Confirmer que `horos-app-1` atteint `ollama-hermes` (même réseau `obsidian-mbbs_mbbs-net`) :

```bash
docker exec horos-app-1 sh -c "wget -qO- http://ollama-hermes:11434/api/tags 2>/dev/null | head -c 200 || echo UNREACHABLE"
```

Si injoignable, ajouter le réseau d'`ollama-hermes` au service `app` dans `/docker/horos/docker-compose.yml`. Ajouter au bloc `environment:` du service `app` :

```yaml
OLLAMA_URL: http://ollama-hermes:11434
OLLAMA_VISION_MODEL: qwen2.5-vl:3b
```

(les valeurs par défaut du code suffisent si l'hôte est joignable, mais on les rend explicites). Puis bump du SHA d'image vers le nouveau `origin/self-host`, `docker compose pull app migrate && docker compose up -d`.

- [ ] **Step 5: Vérification live (Playwright headless)**

Login `https://horos.mbbssarl.ch`, `/viewer/1`, « Ajouter l'image » sur 1-2 coupes, ouvrir « Compte rendu », cliquer « Pré-analyse IA », attendre (~15-60 s), confirmer que _Résultats_/_Conclusion_ se remplissent (texte FR) et que le badge « à valider » apparaît. Éditer, signer, envoyer → confirmer la réception du PDF (avec la mention IA) + MP4.

- [ ] **Step 6: Mémoire**

Mettre à jour la fiche Horos : sous-système A (pré-analyse IA) livré + déployé, modèle utilisé, contrainte RAM.

---

## Self-review (auteur)

- **Couverture spec** : VLM local sur images clés → Task 2 ✓ ; mutation RBAC/rate-limit/audit → Task 3 ✓ ; pré-remplissage + badge + fail-soft → Task 5 ✓ ; mention PDF IA → Task 4 ✓ ; env Ollama → Task 1 ✓ ; pull modèle + RAM + joignabilité + vérif live → Task 6 ✓ ; tests → Tasks 2,3,4 ✓ ; PHI local (pas de cloud) → appel `ollama-hermes` interne, aucune sortie externe ✓.
- **Placeholders** : le seul point « à adapter » est l'indirection `_internal.generatePreanalysis` pour la testabilité (Task 3) — explicitée avec le code exact. Le test de mention PDF utilise la comparaison de taille (pas de dép pdf-lib ajoutée). Reste du code complet.
- **Cohérence des types** : `generatePreanalysis(keyImages, {indication}) → {resultats, conclusion, model}`, `runAiPreanalysis(input, ctx) → PreanalysisResult`, `aiAssisted?: boolean` ajouté de façon cohérente dans `ReportPdfInput`, `SendStudyReportInput`, le zod de `sendStudyReport`, et passé par `ReportPanel`. Mutation `email.aiPreanalysis` (même routeur que `email.sendStudyReport`, comme dans le client `trpc.email.*`).
- **Hors-périmètre** respecté : pas de cloud, pas d'analyse des 297 coupes, pas de diagnostic autonome, pas de streaming.
