# Mesure IA d'évolution entre examens — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quand le patient a une antériorité, « Générer (IA) » compare automatiquement l'examen courant à l'antérieur en un seul appel multimodal, tisse l'évolution dans le compte-rendu et affiche un verdict structuré (stable / progression / régression) en badge.

**Architecture:** Extension de `runAiPreanalysis` (pas de nouvelle route, pas de migration). Le serveur échantillonne les DEUX séries (8 coupes chacune), envoie un prompt comparatif unique avec des blocs étiquetés « EXAMEN ACTUEL » / « EXAMEN ANTÉRIEUR du <date> », puis un parseur pur extrait le verdict d'évolution. Anti-IDOR : l'antériorité doit appartenir au même patient (garde pure testable). Fail-soft à chaque étage : sans antériorité ou en cas d'échec, le compte-rendu se génère comme aujourd'hui.

**Tech Stack:** TypeScript, tRPC v11 (`reports.aiGenerate`), Vitest, backend IA hybride existant (Ollama local par défaut / Claude via ENV), React 19 (ReportPanel / Viewer).

**Spec :** `docs/superpowers/specs/2026-06-12-evolution-ia-design.md`

---

### Task 1 : Parseur pur `parseEvolution` + extension des types

**Files:**

- Modify: `server/report/aiPreanalysis.ts` (ajouter `parseEvolution`, étendre `PreanalysisResult` et `RunAiPreanalysisResult`)
- Test: `server/report/aiPreanalysis.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent** (ajouter à la fin du `describe` existant, avant la `}` finale)

```ts
it("parseEvolution : extrait le verdict et nettoie la ligne", async () => {
  const { parseEvolution } = await import("./aiPreanalysis");
  const out = parseEvolution(
    "Conclusion:\nLésion stable.\n\nÉvolution:\nstable"
  );
  expect(out.evolution).toBe("stable");
  expect(out.cleaned).not.toMatch(/Évolution/i);
});

it("parseEvolution : tolère casse/accents et les 3 verdicts", async () => {
  const { parseEvolution } = await import("./aiPreanalysis");
  expect(
    (await import("./aiPreanalysis")).parseEvolution("evolution: PROGRESSION")
      .evolution
  ).toBe("progression");
  expect(parseEvolution("Évolution : régression").evolution).toBe("regression");
  expect(parseEvolution("Evolution: Regression").evolution).toBe("regression");
});

it("parseEvolution : ligne absente -> null, texte inchangé", async () => {
  const { parseEvolution } = await import("./aiPreanalysis");
  const out = parseEvolution("Conclusion:\nExamen normal.");
  expect(out.evolution).toBeNull();
  expect(out.cleaned).toBe("Conclusion:\nExamen normal.");
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier l'échec**

Run: `npx vitest run server/report/aiPreanalysis.test.ts -t parseEvolution`
Expected: FAIL — `parseEvolution is not a function`

- [ ] **Step 3 : Implémenter `parseEvolution`** (à ajouter après `parseKeySlice`, vers la ligne 365 de `server/report/aiPreanalysis.ts`)

```ts
// Extrait le verdict d'évolution comparative (ligne « Évolution: stable |
// progression | régression »). Tolérant à la casse et aux accents. Renvoie le
// texte NETTOYÉ de cette ligne (elle ne doit pas polluer la Conclusion) ;
// verdict null si la ligne est absente.
export function parseEvolution(text: string): {
  evolution: "stable" | "progression" | "regression" | null;
  cleaned: string;
} {
  const m = text.match(
    /\n?\s*[EÉeé]volution\s*:?\s*(stable|progression|régression|regression)\b/i
  );
  if (!m) return { evolution: null, cleaned: text };
  const raw = m[1].toLowerCase();
  const evolution =
    raw === "stable"
      ? "stable"
      : raw === "progression"
        ? "progression"
        : "regression";
  return { evolution, cleaned: text.replace(m[0], "").trimEnd() };
}
```

- [ ] **Step 4 : Étendre les types** — dans `PreanalysisResult` (vers ligne 49), ajouter après `abnormal` :

```ts
  // Verdict d'évolution comparative (mode antériorité) ; null hors comparaison.
  evolution?: "stable" | "progression" | "regression" | null;
```

Dans `RunAiPreanalysisResult` (vers ligne 251), ajouter après `keyImage` :

```ts
  // Date (DICOM DA, brute) de l'antériorité réellement comparée, ou null.
  comparedPriorDate?: string | null;
```

- [ ] **Step 5 : Lancer les tests pour vérifier le succès**

Run: `npx vitest run server/report/aiPreanalysis.test.ts -t parseEvolution`
Expected: PASS (3 tests)

- [ ] **Step 6 : Commit**

```bash
git add server/report/aiPreanalysis.ts server/report/aiPreanalysis.test.ts
git commit -m "feat(evolution-ia): parseEvolution + types evolution/comparedPriorDate"
```

---

### Task 2 : Prompt comparatif dans `generatePreanalysis`

**Files:**

- Modify: `server/report/aiPreanalysis.ts` (`SYSTEM_PROMPT` voisin, `generatePreanalysis`, `generateViaOllama`, `generateViaClaude`)
- Test: `server/report/aiPreanalysis.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue** (ajouter au `describe`)

```ts
it("mode comparatif : envoie les 2 jeux d'images + blocs étiquetés + parse Évolution", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      message: {
        content:
          "Technique:\nCT.\n\nRésultats:\nComparaison à l'examen du 20240101 : lésion inchangée.\n\nConclusion:\nStabilité.\n\nAnomalie:\noui\n\nCoupe-clé:\n5\n\nÉvolution:\nstable",
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  const { generatePreanalysis } = await import("./aiPreanalysis");
  const out = await generatePreanalysis(
    [{ pngBase64: "CUR0", sliceIndex: 1 }],
    {
      modality: "CT",
      prior: {
        images: [{ pngBase64: "OLD0", sliceIndex: 2 }],
        date: "20240101",
      },
    }
  );
  const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
  const userMsg = body.messages.find((m: any) => m.role === "user");
  expect(userMsg.images).toContain("CUR0");
  expect(userMsg.images).toContain("OLD0");
  expect(userMsg.content).toMatch(/EXAMEN ACTUEL/);
  expect(userMsg.content).toMatch(/EXAMEN ANTÉRIEUR du 20240101/);
  expect(body.messages[0].content).toMatch(/Évolution/);
  expect(out.evolution).toBe("stable");
  // la ligne méta ne contamine pas la conclusion
  expect(out.conclusion).toBe("Stabilité.");
});
```

- [ ] **Step 2 : Lancer le test pour vérifier l'échec**

Run: `npx vitest run server/report/aiPreanalysis.test.ts -t comparatif`
Expected: FAIL — `prior` n'est pas pris en compte (pas de bloc étiqueté, `evolution` undefined)

- [ ] **Step 3 : Ajouter l'addendum comparatif** (après la définition de `SYSTEM_PROMPT`, vers ligne 91)

```ts
const COMPARATIVE_ADDENDUM = [
  "",
  "COMPARAISON D'ANTÉRIORITÉ :",
  "On te fournit DEUX examens du MÊME patient : l'EXAMEN ACTUEL et un EXAMEN ANTÉRIEUR (daté). Chaque coupe fournie est étiquetée par l'examen auquel elle appartient.",
  "- Compare les deux examens et décris l'ÉVOLUTION (apparition, disparition, stabilité, augmentation ou diminution d'une anomalie). Reste prudent et purement visuel : n'invente AUCUNE mesure chiffrée.",
  "- Dans la section Résultats, ajoute un paragraphe commençant par « Comparaison à l'examen du <date> : … » résumant l'évolution.",
  "- APRÈS la ligne Coupe-clé, ajoute une DERNIÈRE ligne supplémentaire, exactement à ce format :",
  "Évolution:",
  "<stable | progression | régression — l'anomalie est-elle globalement stable, en progression (aggravation/augmentation) ou en régression (amélioration/diminution) ?>",
].join("\n");
```

- [ ] **Step 4 : Réécrire `generatePreanalysis`** (remplacer le corps, lignes ~93-139) pour gérer le mode comparatif et produire un tableau `labels` parallèle aux images :

```ts
export async function generatePreanalysis(
  keyImages: PreanalysisKeyImage[],
  opts: {
    indication?: string;
    modality?: string;
    studyDescription?: string;
    antecedents?: string;
    totalSlices?: number;
    prior?: {
      images: PreanalysisKeyImage[];
      date?: string;
      totalSlices?: number;
    };
  }
): Promise<PreanalysisResult> {
  const useClaude = ENV.aiBackend === "claude" && ENV.anthropicApiKey;
  const comparing = !!opts.prior && opts.prior.images.length > 0;
  // Claude encaisse plus d'images ; Ollama local est plafonné (RAM/latence).
  // En mode comparatif, le budget est partagé entre les deux examens.
  const maxImages = useClaude ? 16 : 6;
  const perStudy = comparing
    ? Math.max(1, Math.floor(maxImages / 2))
    : maxImages;

  const chosen = keyImages.slice(0, perStudy);
  const curImages = chosen.map(k => downscalePngBase64(k.pngBase64, 768));
  const curSlices = chosen.map(k => k.sliceIndex);

  const priorChosen = comparing ? opts.prior!.images.slice(0, perStudy) : [];
  const priorImages = priorChosen.map(k =>
    downscalePngBase64(k.pngBase64, 768)
  );
  const priorSlices = priorChosen.map(k => k.sliceIndex);
  const priorDate = opts.prior?.date;

  const images = [...curImages, ...priorImages];
  const numCtx = Math.min(16384, 4096 + 4500 * Math.max(1, images.length));

  // Étiquette de CHAQUE image (parallèle à `images`), utilisée par le backend
  // Claude (bloc texte avant chaque image) pour distinguer actuel / antérieur.
  const labels = [
    ...curSlices.map(n =>
      comparing ? `EXAMEN ACTUEL — Coupe n° ${n} :` : `Coupe n° ${n} :`
    ),
    ...priorSlices.map(
      n =>
        `EXAMEN ANTÉRIEUR${priorDate ? ` du ${priorDate}` : ""} — Coupe n° ${n} :`
    ),
  ];

  // Contexte de l'étude injecté pour ancrer le modèle.
  const ctxLines: string[] = [];
  if (opts.modality) ctxLines.push(`Modalité : ${opts.modality}`);
  if (opts.studyDescription) ctxLines.push(`Examen : ${opts.studyDescription}`);
  if (opts.indication)
    ctxLines.push(`Indication clinique : ${opts.indication}`);
  if (opts.antecedents)
    ctxLines.push(`Antécédents médicaux du patient : ${opts.antecedents}`);
  if (comparing) {
    const curTotal = opts.totalSlices ?? curImages.length;
    const priorTotal = opts.prior?.totalSlices ?? priorImages.length;
    ctxLines.push(
      `EXAMEN ACTUEL : ${curImages.length} coupe(s) (sur ${curTotal}), coupes n° ${curSlices.join(", ")}.`
    );
    ctxLines.push(
      `EXAMEN ANTÉRIEUR${priorDate ? ` du ${priorDate}` : ""} : ${priorImages.length} coupe(s) (sur ${priorTotal}), coupes n° ${priorSlices.join(", ")}.`
    );
    ctxLines.push(
      `Compare les deux examens, rédige Technique / Résultats (avec un paragraphe « Comparaison à l'examen du ${priorDate ?? "précédent"} : … ») / Conclusion, puis Anomalie (oui/non), Coupe-clé, et enfin Évolution (stable/progression/régression).`
    );
  } else {
    const total = opts.totalSlices ?? images.length;
    ctxLines.push(
      `Échantillon de ${images.length} coupe(s) réparties sur les ${total} coupes du volume. Dans l'ordre, ces images correspondent aux coupes n° : ${curSlices.join(", ")}.`
    );
    ctxLines.push(
      "Analyse l'ensemble de ces coupes selon la méthode, rédige Technique / Résultats / Conclusion, puis indique Anomalie (oui/non) et le numéro de la Coupe-clé."
    );
  }
  const userText = ctxLines.join("\n");
  const system = comparing
    ? `${SYSTEM_PROMPT}\n${COMPARATIVE_ADDENDUM}`
    : SYSTEM_PROMPT;

  if (useClaude) {
    return generateViaClaude(images, userText, labels, system);
  }
  return generateViaOllama(images, userText, numCtx, system);
}
```

- [ ] **Step 5 : Mettre à jour `generateViaOllama`** (signature + usage de `system` + `evolution`)

Signature (ligne ~141) :

```ts
async function generateViaOllama(
  images: string[],
  userText: string,
  numCtx: number,
  system: string
): Promise<PreanalysisResult> {
```

Remplacer `content: SYSTEM_PROMPT` (ligne ~161) par `content: system`. Remplacer le `return` (lignes ~179-183) par :

```ts
return {
  ...parseSections(content),
  ...parseKeySlice(content),
  evolution: parseEvolution(content).evolution,
  model: ENV.ollamaVisionModel,
};
```

- [ ] **Step 6 : Mettre à jour `generateViaClaude`** (signature `labels` au lieu de `sliceNumbers` + `system` + `evolution`)

Signature (ligne ~186) :

```ts
async function generateViaClaude(
  images: string[],
  userText: string,
  labels: string[],
  system: string
): Promise<PreanalysisResult> {
```

Remplacer la construction du label d'image (lignes ~196-200) par :

```ts
images.forEach((b64, i) => {
  content.push({
    type: "text",
    text: labels[i] ?? `Coupe n° ${i + 1} :`,
  });
  content.push({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: b64 },
  });
});
```

Remplacer `system: SYSTEM_PROMPT,` (ligne ~211) par `system,`. Remplacer le `return` (lignes ~218-222) par :

```ts
return {
  ...parseSections(text),
  ...parseKeySlice(text),
  evolution: parseEvolution(text).evolution,
  model: ENV.anthropicModel,
};
```

- [ ] **Step 7 : Lancer toute la suite du fichier (non-régression du mode simple)**

Run: `npx vitest run server/report/aiPreanalysis.test.ts`
Expected: PASS (tous les tests existants + le nouveau comparatif)

- [ ] **Step 8 : Commit**

```bash
git add server/report/aiPreanalysis.ts server/report/aiPreanalysis.test.ts
git commit -m "feat(evolution-ia): prompt comparatif a 2 examens dans generatePreanalysis"
```

---

### Task 3 : Gardes pures `assertSamePatientStudies` + `pickPriorSeriesId`

**Files:**

- Modify: `server/report/aiPreanalysis.ts`
- Test: `server/report/aiPreanalysis.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

```ts
it("assertSamePatientStudies : rejette des patients différents", async () => {
  const { assertSamePatientStudies } = await import("./aiPreanalysis");
  expect(() =>
    assertSamePatientStudies({ patientId: "A" }, { patientId: "B" })
  ).toThrow();
  expect(() =>
    assertSamePatientStudies({ patientId: "A" }, { patientId: "" })
  ).toThrow();
  expect(() =>
    assertSamePatientStudies({ patientId: "A" }, { patientId: " A " })
  ).not.toThrow();
});

it("pickPriorSeriesId : même modalité prioritaire, repli 1re, vide -> null", async () => {
  const { pickPriorSeriesId } = await import("./aiPreanalysis");
  expect(
    pickPriorSeriesId(
      [
        { id: 1, modality: "MR" },
        { id: 2, modality: "CT" },
      ],
      "ct"
    )
  ).toBe(2);
  expect(pickPriorSeriesId([{ id: 9, modality: "MR" }], "CT")).toBe(9);
  expect(pickPriorSeriesId([], "CT")).toBeNull();
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier l'échec**

Run: `npx vitest run server/report/aiPreanalysis.test.ts -t "assertSamePatientStudies|pickPriorSeriesId"`
Expected: FAIL — fonctions non définies

- [ ] **Step 3 : Implémenter les deux gardes pures** (à ajouter après `parseEvolution`)

```ts
// Garde anti-IDOR : une antériorité ne peut être comparée que si elle appartient
// au MÊME patient que l'étude courante (sinon fuite PHI inter-patients). Compare
// les PatientID (identifiant technique) après trim ; un id vide ne rapproche
// personne. Lève FORBIDDEN sinon.
export function assertSamePatientStudies(
  current: { patientId?: string | null },
  prior: { patientId?: string | null }
): void {
  const a = (current.patientId ?? "").trim();
  const b = (prior.patientId ?? "").trim();
  if (a === "" || b === "" || a !== b) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "L'antériorité doit appartenir au même patient.",
    });
  }
}

// Série de l'antériorité à comparer : 1re série de MÊME modalité que la
// courante si elle existe, sinon la 1re série, sinon null. Fonction pure.
export function pickPriorSeriesId(
  series:
    | readonly { id: number; modality?: string | null }[]
    | null
    | undefined,
  currentModality?: string | null
): number | null {
  if (!series || series.length === 0) return null;
  const wanted = (currentModality ?? "").trim().toUpperCase();
  if (wanted) {
    const m = series.find(
      s => (s.modality ?? "").trim().toUpperCase() === wanted
    );
    if (m) return m.id;
  }
  return series[0].id;
}
```

- [ ] **Step 4 : Lancer les tests pour vérifier le succès**

Run: `npx vitest run server/report/aiPreanalysis.test.ts -t "assertSamePatientStudies|pickPriorSeriesId"`
Expected: PASS

- [ ] **Step 5 : Commit**

```bash
git add server/report/aiPreanalysis.ts server/report/aiPreanalysis.test.ts
git commit -m "feat(evolution-ia): gardes pures same-patient + pick prior series"
```

---

### Task 4 : Câbler `runAiPreanalysis` (échantillonnage des 2 séries + comparaison)

**Files:**

- Modify: `server/report/aiPreanalysis.ts` (`RunAiPreanalysisInput`, `runAiPreanalysis`)

Cette tâche est de l'intégration serveur (DB + sampling) ; pas de test unitaire dédié (couvert par les gardes pures de Task 3 + le prompt comparatif de Task 2, puis vérif build/typecheck). La logique est fail-soft : toute erreur de l'antériorité retombe sur le comportement actuel.

- [ ] **Step 1 : Étendre `RunAiPreanalysisInput`** (vers ligne 239) — ajouter après `sampleCount?` :

```ts
  // Antériorité à comparer (mesure d'évolution) ; absente → pas de comparaison.
  priorStudyId?: number;
  priorSeriesId?: number;
```

- [ ] **Step 2 : Ajouter le bloc de comparaison dans `runAiPreanalysis`** — juste AVANT l'appel à `_internal.generatePreanalysis` (vers ligne 320), insérer :

```ts
// --- Antériorité (mesure d'évolution) : fail-soft de bout en bout. ---------
let prior:
  | {
      images: PreanalysisKeyImage[];
      date?: string;
      totalSlices?: number;
    }
  | undefined;
let comparedPriorDate: string | null = null;
if (input.priorStudyId) {
  try {
    const priorStudy = await getStudyById(input.priorStudyId);
    if (priorStudy) {
      // Anti-IDOR : l'antériorité DOIT être du même patient (lève FORBIDDEN).
      assertSamePatientStudies(study as any, priorStudy as any);
      const priorSeriesList = await listSeriesByStudy(input.priorStudyId);
      const priorSeriesId =
        input.priorSeriesId &&
        priorSeriesList.some((s: any) => s.id === input.priorSeriesId)
          ? input.priorSeriesId
          : pickPriorSeriesId(
              priorSeriesList as any,
              (study as any).modality ?? null
            );
      if (priorSeriesId) {
        const { sampleSeriesPngs } = await import("./aiSampling");
        const sampledPrior = await sampleSeriesPngs(priorSeriesId, {
          windowCenter: wc,
          windowWidth: ww,
          count: 8,
        });
        if (sampledPrior.images.length > 0) {
          prior = {
            images: sampledPrior.images.map(s => ({
              pngBase64: s.pngBase64,
              sliceIndex: s.sliceNumber,
            })),
            date: (priorStudy as any).studyDate ?? undefined,
            totalSlices: sampledPrior.totalSlices,
          };
          comparedPriorDate = (priorStudy as any).studyDate ?? null;
        }
      }
    }
  } catch (e) {
    // FORBIDDEN (patient différent) doit remonter ; le reste est fail-soft.
    if (e instanceof TRPCError && e.code === "FORBIDDEN") throw e;
    console.warn("[aiPreanalysis] comparaison antériorité échouée:", e);
  }
}
```

- [ ] **Step 3 : Réduire l'échantillon courant à 8 coupes quand on compare** — dans le bloc d'échantillonnage existant (vers ligne 303), remplacer `count: input.sampleCount ?? 16,` par :

```ts
        count: input.sampleCount ?? (input.priorStudyId ? 8 : 16),
```

- [ ] **Step 4 : Passer `prior` à la génération** — dans l'appel `_internal.generatePreanalysis` (vers ligne 320), ajouter `prior,` aux options :

```ts
const result = await _internal.generatePreanalysis(images, {
  indication: input.indication,
  antecedents: input.antecedents,
  modality: (study as any).modality ?? undefined,
  studyDescription: (study as any).studyDescription ?? undefined,
  totalSlices,
  prior,
});
```

- [ ] **Step 5 : Renvoyer `comparedPriorDate`** — remplacer le `return` final (ligne ~351) par :

```ts
return { ...result, keyImage, comparedPriorDate };
```

- [ ] **Step 6 : Vérifier le typecheck**

Run: `npx tsc --noEmit`
Expected: aucune erreur

- [ ] **Step 7 : Commit**

```bash
git add server/report/aiPreanalysis.ts
git commit -m "feat(evolution-ia): runAiPreanalysis echantillonne+compare l'anteriorite"
```

---

### Task 5 : Câbler le routeur `reports.aiGenerate`

**Files:**

- Modify: `server/routers.ts:1619-1662` (`reports.aiGenerate`)

- [ ] **Step 1 : Ajouter les entrées zod** — dans l'`z.object` de `aiGenerate` (vers ligne 1626), ajouter après `keyImages` :

```ts
          priorStudyId: z.number().int().optional(),
          priorSeriesId: z.number().int().optional(),
```

- [ ] **Step 2 : Choisir l'antériorité par défaut + passer à `runAiPreanalysis`** — remplacer le corps du `.mutation` (lignes ~1631-1662) par :

```ts
      .mutation(async ({ input, ctx }) => {
        // Antériorité explicite (mode comparatif du viewer) sinon la plus
        // récente du même patient (helper DB existant). Fail-soft : aucune
        // antériorité → génération simple inchangée.
        let priorStudyId = input.priorStudyId;
        if (!priorStudyId) {
          const { listPriorStudiesForStudy } = await import("./db");
          const priors = await listPriorStudiesForStudy(input.studyId);
          priorStudyId = priors[0]?.id;
        }
        // runAiPreanalysis renvoie déjà des sections structurées
        // (technique/resultats/conclusion) — pas de re-parsing de texte brut.
        const result = await runAiPreanalysis(
          {
            studyId: input.studyId,
            seriesId: input.seriesId,
            indication: input.indication,
            antecedents: input.antecedents,
            keyImages: input.keyImages,
            priorStudyId,
            priorSeriesId: input.priorSeriesId,
          },
          { user: { id: ctx.user.id }, req: { ip: ctx.req?.ip } }
        );
        const sections = validateReportSections({
          indication: input.indication ?? "",
          technique: result.technique,
          resultats: result.resultats,
          conclusion: result.conclusion,
        });
        await recordAccess({
          userId: ctx.user.id,
          action: "report.generate",
          studyId: input.studyId,
          detail: result.comparedPriorDate
            ? `${result.model} compared:${priorStudyId}`
            : result.model,
          ipAddress: ctx.req?.ip ?? null,
        });
        return {
          sections,
          aiModel: result.model,
          keyImage: result.keyImage ?? null,
          evolution: result.evolution ?? null,
          comparedPriorDate: result.comparedPriorDate ?? null,
        };
      }),
```

- [ ] **Step 3 : Confirmer le pattern d'import dynamique** — `listPriorStudiesForStudy` n'est PAS dans l'import en tête ; il s'importe dynamiquement (déjà fait au Step 2, comme à la ligne ~415 de `server/routers.ts`).

Run: `grep -n "listPriorStudiesForStudy" server/routers.ts`
Expected: au moins l'import dynamique du Step 2 (`const { listPriorStudiesForStudy } = await import("./db");`).

- [ ] **Step 4 : Vérifier le typecheck**

Run: `npx tsc --noEmit`
Expected: aucune erreur

- [ ] **Step 5 : Commit**

```bash
git add server/routers.ts
git commit -m "feat(evolution-ia): reports.aiGenerate passe l'anteriorite + renvoie evolution"
```

---

### Task 6 : Badge d'évolution dans `ReportPanel`

**Files:**

- Modify: `client/src/components/ReportPanel.tsx`

- [ ] **Step 1 : Ajouter les props comparatives** — dans `ReportPanelProps` (ligne ~18), ajouter avant `onClose` :

```ts
  comparePriorStudyId?: number | null;
  comparePriorSeriesId?: number | null;
```

Et dans la déstructuration des props (ligne ~44), ajouter `comparePriorStudyId,` et `comparePriorSeriesId,` avant `onClose,`.

- [ ] **Step 2 : Ajouter l'état du verdict** — après `const [analyzedSeriesId, ...]` (ligne ~105), ajouter :

```ts
const [evolution, setEvolution] = useState<
  "stable" | "progression" | "regression" | null
>(null);
const [comparedPriorDate, setComparedPriorDate] = useState<string | null>(null);
```

- [ ] **Step 3 : Passer l'antériorité à `aiGenerate` et stocker le verdict** — dans le `onClick` du bouton « Générer (IA) » (lignes ~286-312), remplacer l'appel `aiGenerate.mutateAsync({...})` par (ajout des 2 champs prior), puis après le `setSections(...)` enregistrer le verdict :

```ts
const r = await aiGenerate.mutateAsync({
  studyId,
  seriesId: analyzedSeriesId ?? seriesId,
  indication: sections.indication || undefined,
  antecedents: antecedents || undefined,
  keyImages: keyImages.map(k => ({
    pngBase64: k.pngBase64,
    sliceIndex: k.sliceIndex,
  })),
  priorStudyId: comparePriorStudyId ?? undefined,
  priorSeriesId: comparePriorSeriesId ?? undefined,
});
// Ne pré-remplit QUE les champs vides.
setSections(s => ({
  indication: s.indication || r.sections.indication,
  technique: s.technique || r.sections.technique,
  resultats: s.resultats || r.sections.resultats,
  conclusion: s.conclusion || r.sections.conclusion,
}));
setEvolution(r.evolution ?? null);
setComparedPriorDate(r.comparedPriorDate ?? null);
```

(le bloc `if (r.keyImage && ...)` existant reste inchangé juste en dessous.)

- [ ] **Step 4 : Afficher le badge** — juste APRÈS la `</div>` qui ferme le groupe de boutons « Générer (IA) / Enregistrer / Signer » (le `<div className="flex gap-2 flex-wrap">` ouvert ligne ~281), insérer :

```tsx
{
  !isSigned && evolution && (
    <div
      className={
        "mt-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium " +
        (evolution === "stable"
          ? "bg-green-500/15 text-green-400"
          : evolution === "progression"
            ? "bg-red-500/15 text-red-400"
            : "bg-blue-500/15 text-blue-400")
      }
    >
      {evolution === "stable"
        ? "🟢 Stable"
        : evolution === "progression"
          ? "🔴 Progression"
          : "🔵 Régression"}
      {comparedPriorDate ? ` · vs examen du ${comparedPriorDate}` : ""}
    </div>
  );
}
```

- [ ] **Step 5 : Vérifier le typecheck**

Run: `npx tsc --noEmit`
Expected: aucune erreur

- [ ] **Step 6 : Commit**

```bash
git add client/src/components/ReportPanel.tsx
git commit -m "feat(evolution-ia): badge d'evolution + passe l'anteriorite a aiGenerate"
```

---

### Task 7 : Transmettre l'antériorité depuis `Viewer`

**Files:**

- Modify: `client/src/pages/Viewer.tsx:3160-3173` (montage de `ReportPanel`)

- [ ] **Step 1 : Passer les props comparatives** — dans le `<ReportPanel ... />` (vers ligne 3161), ajouter avant `onClose=` :

```tsx
comparePriorStudyId = { comparePriorStudyId };
comparePriorSeriesId = { comparePriorSeriesId };
```

(Ces deux états existent déjà dans `Viewer.tsx` : `comparePriorStudyId` ligne ~520, `comparePriorSeriesId` ligne ~523.)

- [ ] **Step 2 : Vérifier le typecheck + le build**

Run: `npx tsc --noEmit && npm run build`
Expected: aucune erreur, build OK

- [ ] **Step 3 : Lancer toute la suite de tests**

Run: `npx vitest run`
Expected: tous les tests passent

- [ ] **Step 4 : Commit**

```bash
git add client/src/pages/Viewer.tsx
git commit -m "feat(evolution-ia): Viewer transmet l'anteriorite au ReportPanel"
```

---

### Task 8 : PR + déploiement `self-host` (aucune migration DB)

**Files:** aucun fichier de code (intégration / déploiement)

- [ ] **Step 1 : Pousser la branche SEULE** (le hook agent-guard bloque `push && gh` combiné)

```bash
git push origin HEAD:refs/heads/feat/evolution-ia
```

- [ ] **Step 2 : Créer la PR** (appel séparé)

```bash
gh pr create --base self-host --head feat/evolution-ia \
  --title "Mesure IA d'évolution entre examens" \
  --body "Comparaison automatique courant↔antériorité (même patient) dans « Générer (IA) » : échantillonnage des 2 séries, prompt comparatif unique, verdict d'évolution (stable/progression/régression) tissé dans le CR + badge. Aucune migration DB. Backend hybride (Ollama local par défaut, PHI-safe)."
```

- [ ] **Step 3 : Merger la PR** (appel séparé, après passage de la CI)

```bash
gh pr merge --merge --delete-branch=false
```

- [ ] **Step 4 : Récupérer le SHA complet de l'image GHCR construite par la CI**

Run: `gh run list --branch self-host --limit 3` puis identifier le SHA du commit de merge ; l'image est `ghcr.io/mbbssarl1201-max/horos-viewer:<fullSHA>`.

- [ ] **Step 5 : Déployer sur le VPS** (SSH `root@76.13.55.44`)

```bash
ssh root@76.13.55.44 "cd /docker/horos && sed -i 's|horos-viewer:[a-f0-9]*|horos-viewer:<fullSHA>|' docker-compose.yml && docker compose pull app && docker compose up -d app"
```

- [ ] **Step 6 : Vérifier la santé (ping post-déploiement)**

```bash
ssh root@76.13.55.44 "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:<port>/healthz; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:<port>/api/audit/export.csv"
```

Expected: `200` (healthz) puis `401` (garde d'auth). Confirmer aussi `docker compose ps` → app `healthy` sur le bon SHA.

---

## Notes de déploiement

- **Aucune migration DB** : le verdict d'évolution n'est PAS persisté (le texte du CR + l'affichage suffisent — cf. spec). Le service `migrate` du compose ne fera donc rien de neuf.
- **PHI-safe** : backend Ollama local par défaut ; le coût/latence reste comparable (8+8 images vs 16 aujourd'hui).
- **Données de test** : il faut deux examens du MÊME patient (même PatientID) avec de vraies coupes pour observer un verdict ; les seules antériorités mutuelles en prod sont des fichiers démo dégradés (« Unknown Patient ») → comportement fail-soft attendu (verdict null) sur ceux-ci.
