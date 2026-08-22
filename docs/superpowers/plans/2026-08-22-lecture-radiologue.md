# Lecture « niveau radiologue » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dépistage cloud Gemini Flash de 100 % des coupes, double lecture croisée Opus 5 × Gemini 2.5 Pro avec réconciliation dans le CR, service TotalSegmentator CPU rétabli sur VPS72, et réimport des 56 études incomplètes.

**Architecture:** On ne change PAS la structure du pipeline exhaustif (phase 1 dépistage → phase 2 rapport, job de fond) : on remplace le modèle du dépistage (qwen local → Gemini Flash Vertex UE, repli local conservé) et la « 2e opinion » (qwen 3b oui/non → vraie relecture Gemini 2.5 Pro + réconciliation Opus 5). Le service de segmentation est un micro-service FastAPI isolé qui honore le contrat déjà consommé par `ctSegmentation.ts`. Le réimport réutilise la passerelle PACS existante du Mac cabinet.

**Tech Stack:** TypeScript/Node (tRPC, Vitest), Vertex AI REST (`generateContent`), API Anthropic (client existant), Python FastAPI + TotalSegmentator (Docker CPU), passerelle pynetdicom existante.

**Spec:** `docs/superpowers/specs/2026-08-22-lecture-radiologue-design.md`

## Global Constraints

- Tout chemin cloud (Claude ET Gemini) est gardé par `ENV.cloudAiPhiConsent`.
- Chaque étage est fail-soft : échec Gemini dépistage → repli qwen local ; échec double lecture → CR sans la section (mention honnête) ; échec segmentation → CR sans mesures. Jamais d'exception qui casse le job.
- Le CR nomme les modèles réellement utilisés (`result.model`, `secondOpinion.model`).
- Ne PAS toucher : mode rapide local (pré-analyse), `selectExhaustiveSeries`/anti-scanogramme, adaptateurs `externalAI.ts`.
- Nouvelle config env : `GEMINI_SCREEN_MODEL` (défaut `gemini-2.5-flash`), `GEMINI_SECOND_READ_MODEL` (défaut `gemini-2.5-pro`), `SEG_SERVICE_URL`, `SEG_TOKEN` (existants), côté service `SEG_FORCE_FAST`.
- Style code : commentaires français, fonctions PURES testées séparément (convention du repo).
- Commits fréquents sur `feat/lecture-radiologue` ; suffixe `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Client vision Gemini Vertex (`geminiVision.ts`)

**Files:**

- Create: `server/report/geminiVision.ts`
- Create: `server/report/geminiVision.test.ts`
- Modify: `server/_core/env.ts` (ajout `geminiScreenModel`, `geminiSecondReadModel`)

**Interfaces:**

- Consomme : `ENV.geminiVertexProject/Location/Token`, `ENV.cloudAiPhiConsent` (existants).
- Produit :
  - `geminiVisionConfigured(): boolean` — project ET token ET consentement PHI présents (⚠️ SANS la condition `chatBackend === "vertex"` de `vertexConfigured()` : le dépistage ne dépend pas du backend du chat).
  - `extractGeminiText(json: unknown): string | null` — PURE : extrait `candidates[0].content.parts[].text` concaténé, null si absent.
  - `geminiVision(opts: { model: string; system: string; userText: string; pngBase64: string[]; maxTokens?: number; timeoutMs?: number }): Promise<string | null>` — appel REST `https://${loc}-aiplatform.googleapis.com/v1/projects/${proj}/locations/${loc}/publishers/google/models/${model}:generateContent`, header `Authorization: Bearer ${ENV.geminiVertexToken}` (même patron que `hermesChat.ts:153-158`), corps `{ systemInstruction: {parts:[{text: system}]}, contents: [{role:"user", parts:[{text: userText}, ...images.map(d => ({inlineData:{mimeType:"image/png", data:d}}))]}], generationConfig: {maxOutputTokens, temperature: 0} }`. Renvoie null sur toute erreur (réseau, HTTP non-2xx, parse) — jamais de throw.

- [ ] **Step 1 : tests qui échouent** (`geminiVision.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { extractGeminiText } from "./geminiVision";

describe("extractGeminiText", () => {
  it("extrait le texte d'une réponse generateContent", () => {
    const json = {
      candidates: [
        { content: { parts: [{ text: "142, " }, { text: "210" }] } },
      ],
    };
    expect(extractGeminiText(json)).toBe("142, 210");
  });
  it("null si structure absente/vide", () => {
    expect(extractGeminiText({})).toBeNull();
    expect(extractGeminiText({ candidates: [] })).toBeNull();
    expect(extractGeminiText(null)).toBeNull();
    expect(
      extractGeminiText({ candidates: [{ content: { parts: [] } }] })
    ).toBeNull();
  });
});
```

- [ ] **Step 2 : vérifier l'échec** — `npx vitest run server/report/geminiVision.test.ts` → FAIL (module inexistant).
- [ ] **Step 3 : implémentation minimale** — `geminiVision.ts` avec les trois exports ci-dessus ; `geminiVision()` utilise `AbortSignal.timeout(opts.timeoutMs ?? 120_000)` et try/catch → null. Dans `env.ts`, à côté des `geminiVertex*` (l.159-162) :

```ts
  geminiScreenModel: process.env.GEMINI_SCREEN_MODEL ?? "gemini-2.5-flash",
  geminiSecondReadModel:
    process.env.GEMINI_SECOND_READ_MODEL ?? "gemini-2.5-pro",
```

- [ ] **Step 4 : vérifier le vert** — même commande → PASS.
- [ ] **Step 5 : commit** — `git add -A && git commit -m "feat(cr): client vision Gemini Vertex UE (dépistage/double lecture)"`

### Task 2: Dépistage cloud avec repli local

**Files:**

- Modify: `server/report/exhaustivePreanalysis.ts` (fonction `screenBatch` l.132-173, constantes `SCREEN_DIM`/`BATCH` l.232-233)
- Test: `server/report/exhaustivePreanalysis.test.ts` (compléter)

**Interfaces:**

- Consomme : `geminiVisionConfigured`, `geminiVision`, `extractGeminiText` (Task 1) ; `SCREEN_SYS` existant.
- Produit :
  - `parseScreenReply(txt: string, allowed: readonly number[]): number[]` — PURE, exportée : extraction des numéros (regex `\d+` actuelle), filtrés par `allowed`, dédupliqués ; `"RAS"` → `[]`.
  - `screenBatch` devient : si `geminiVisionConfigured()` → `geminiVision({model: ENV.geminiScreenModel, system: SCREEN_SYS, userText, pngBase64: batch.map(b=>b.pngBase64), maxTokens: 100})` ; si résultat null (erreur/non configuré) → chemin Ollama actuel inchangé (repli). Les deux chemins passent par `parseScreenReply`.
  - Constantes : `SCREEN_DIM = 512` et `BATCH = 16` quand `geminiVisionConfigured()`, sinon valeurs locales actuelles (384/12).

- [ ] **Step 1 : tests qui échouent** (ajouter au fichier de test existant)

```ts
import { parseScreenReply } from "./exhaustivePreanalysis";

describe("parseScreenReply", () => {
  it("extrait et filtre les numéros autorisés", () => {
    expect(
      parseScreenReply("Coupes 142, 143 et 999 suspectes", [141, 142, 143])
    ).toEqual([142, 143]);
  });
  it("RAS → aucun", () => {
    expect(parseScreenReply("RAS", [1, 2, 3])).toEqual([]);
  });
  it("dédoublonne", () => {
    expect(parseScreenReply("7, 7, 7", [7])).toEqual([7]);
  });
});
```

- [ ] **Step 2 : vérifier l'échec** — `npx vitest run server/report/exhaustivePreanalysis.test.ts` → FAIL (`parseScreenReply` non exportée).
- [ ] **Step 3 : implémentation** — extraire la logique de parsing existante (l.164-167) dans `parseScreenReply` exportée ; refactorer `screenBatch` (Gemini d'abord, repli Ollama) ; dimension/lot conditionnels. Ne pas changer la signature de `screenBatch`.
- [ ] **Step 4 : suite complète du fichier** — `npx vitest run server/report/exhaustivePreanalysis.test.ts` → PASS (non-régression `selectExhaustiveSeries` incluse).
- [ ] **Step 5 : commit** — `feat(cr): dépistage exhaustif par Gemini Flash (Vertex UE), repli qwen local`

### Task 3: Relecture indépendante Gemini 2.5 Pro

**Files:**

- Create: `server/report/doubleLecture.ts`
- Create: `server/report/doubleLecture.test.ts`

**Interfaces:**

- Consomme : `geminiVision`, `geminiVisionConfigured` (Task 1) ; `PreanalysisKeyImage` (aiPreanalysis.ts:129) ; `downscalePngBase64` (aiPreanalysis).
- Produit :
  - `interface SecondRead { resultats: string; conclusion: string; abnormal: boolean | null; model: string }`
  - `parseSecondRead(txt: string, model: string): SecondRead | null` — PURE : découpe une réponse balisée `RESULTATS:\n…\nCONCLUSION:\n…\nANORMAL: oui|non` (insensible casse/accents) ; null si les 3 sections manquent.
  - `buildSecondReadPrompt(opts: { indication?: string; modality?: string; measurements?: string; totalSlices?: number }): { system: string; user: string }` — PURE. System = « Tu es un DEUXIÈME radiologue senior, lecture INDÉPENDANTE… Réponds STRICTEMENT au format RESULTATS:/CONCLUSION:/ANORMAL: ». Il ne reçoit JAMAIS la lecture du premier lecteur.
  - `secondReadGemini(keyImages: PreanalysisKeyImage[], opts: Parameters<typeof buildSecondReadPrompt>[0]): Promise<SecondRead | null>` — ≤20 images, redimensionnées 1024 px, modèle `ENV.geminiSecondReadModel` ; null si non configuré ou échec (fail-soft).

- [ ] **Step 1 : tests qui échouent**

```ts
import { parseSecondRead, buildSecondReadPrompt } from "./doubleLecture";

describe("parseSecondRead", () => {
  it("découpe les 3 sections", () => {
    const r = parseSecondRead(
      "RESULTATS:\nFracture non déplacée du radius distal.\nCONCLUSION:\nFracture radius distal.\nANORMAL: oui",
      "gemini-2.5-pro"
    );
    expect(r).toEqual({
      resultats: "Fracture non déplacée du radius distal.",
      conclusion: "Fracture radius distal.",
      abnormal: true,
      model: "gemini-2.5-pro",
    });
  });
  it("ANORMAL: non → abnormal=false ; absent → null (sections présentes)", () => {
    expect(
      parseSecondRead("RESULTATS:\nx\nCONCLUSION:\ny\nANORMAL: non", "m")!
        .abnormal
    ).toBe(false);
  });
  it("réponse informe → null", () => {
    expect(parseSecondRead("Je ne peux pas.", "m")).toBeNull();
  });
});

describe("buildSecondReadPrompt", () => {
  it("injecte indication et mesures, jamais la 1re lecture", () => {
    const p = buildSecondReadPrompt({
      indication: "hernie ?",
      measurements: "foie: 1500 mL",
    });
    expect(p.user).toContain("hernie ?");
    expect(p.user).toContain("1500 mL");
    expect(p.system).toContain("INDÉPENDANTE");
  });
});
```

- [ ] **Step 2 : vérifier l'échec** → FAIL (module inexistant).
- [ ] **Step 3 : implémentation minimale** de `doubleLecture.ts`.
- [ ] **Step 4 : vérifier le vert.**
- [ ] **Step 5 : commit** — `feat(cr): relecture indépendante Gemini 2.5 Pro (double lecture)`

### Task 4: Réconciliation Opus 5 + branchement dans le flux exhaustif

**Files:**

- Modify: `server/report/doubleLecture.ts` (ajout réconciliation)
- Modify: `server/report/doubleLecture.test.ts`
- Modify: `server/report/exhaustivePreanalysis.ts` (bloc `secondOpinion` l.384-395 ; interface `ExhaustiveResult` l.95-103)

**Interfaces:**

- Consomme : `SecondRead` (Task 3) ; `PreanalysisResult` (aiPreanalysis.ts:281) ; le client Anthropic existant — repérer dans `aiPreanalysis.ts` la fonction texte-seul utilisée par `verifyConclusion` et la réutiliser (même patron d'appel, même gestion du refus).
- Produit :
  - `buildReconcilePrompt(primary: { resultats: string; conclusion: string; model: string }, second: SecondRead): { system: string; user: string }` — PURE. Demande : points d'accord (1 ligne), désaccords en liste « À VÉRIFIER PAR LE MÉDECIN », verdict final `ACCORD: oui|non`.
  - `parseReconcile(txt: string): { section: string; agree: boolean | null } | null` — PURE : section = texte intégral nettoyé ; `agree` lu sur la ligne `ACCORD:`.
  - `reconcileReads(primary, second): Promise<{ section: string; agree: boolean | null } | null>` — appel Opus (modèle `ENV.anthropicModel`), fail-soft null.
  - `ExhaustiveResult.secondOpinion` étendu : `{ abnormal: boolean | null; model: string; agree: boolean; resultats?: string; conclusion?: string; reconciliation?: string } | null` (champs optionnels → rétro-compatible client).
  - Dans `runExhaustive` : remplacer le bloc `secondOpinionAbnormal` par : `const sr = await secondReadGemini(keyImgs, {indication, modality, measurements, totalSlices: screenedTotal})` ; si `sr` → `const rec = await reconcileReads({resultats: result.resultats, conclusion: result.conclusion, model: result.model}, sr)` ; `secondOpinion = { abnormal: sr.abnormal, model: sr.model, agree: rec?.agree ?? (sr.abnormal !== null && sr.abnormal === (result.abnormal ?? null)), resultats: sr.resultats, conclusion: sr.conclusion, reconciliation: rec?.section }` ; si `rec?.section` → l'annexer à `result.resultats` sous le titre `\n\nDouble lecture (${result.model} × ${sr.model}) :\n` ; si `sr` null → repli sur l'actuel `secondOpinionAbnormal` local (comportement d'aujourd'hui conservé).

- [ ] **Step 1 : tests qui échouent** (parse/build purs)

```ts
import { buildReconcilePrompt, parseReconcile } from "./doubleLecture";

describe("réconciliation", () => {
  it("le prompt contient les deux lectures et exige ACCORD:", () => {
    const p = buildReconcilePrompt(
      { resultats: "r1", conclusion: "c1", model: "claude-opus-5" },
      {
        resultats: "r2",
        conclusion: "c2",
        abnormal: true,
        model: "gemini-2.5-pro",
      }
    );
    expect(p.user).toContain("r1");
    expect(p.user).toContain("r2");
    expect(p.system).toContain("ACCORD:");
  });
  it("parseReconcile lit le verdict", () => {
    const r = parseReconcile("Accord global.\nACCORD: oui");
    expect(r!.agree).toBe(true);
    const d = parseReconcile("Désaccord sur L4-L5.\nACCORD: non");
    expect(d!.agree).toBe(false);
  });
  it("verdict absent → agree null, section conservée", () => {
    expect(parseReconcile("Analyse.")!.agree).toBeNull();
  });
});
```

- [ ] **Step 2 : vérifier l'échec.**
- [ ] **Step 3 : implémentation** (réconciliation + branchement `runExhaustive` + extension du type).
- [ ] **Step 4 : suites `doubleLecture` + `exhaustivePreanalysis` vertes** ; puis `npx vitest run` complet → 0 régression.
- [ ] **Step 5 : commit** — `feat(cr): double lecture croisée avec réconciliation Opus 5 dans le CR exhaustif`

### Task 5: Affichage de la double lecture (ReportPanel)

**Files:**

- Modify: `client/src/components/ReportPanel.tsx` (état `secondOpinion` l.352, rendu l.980-1010)

**Interfaces:**

- Consomme : `secondOpinion` étendu (Task 4) — champs optionnels, l'ancien format reste valide.

- [ ] **Step 1 : étendre le type de l'état** `secondOpinion` (l.352) avec `resultats?/conclusion?/reconciliation?: string`.
- [ ] **Step 2 : rendu** — dans le bloc existant (l.980-1010) : quand `reconciliation` présent, afficher sous le badge accord/désaccord un `<details>` « Double lecture (`{secondOpinion.model}`) » contenant `reconciliation` (pré-formaté, `whitespace-pre-wrap`) ; garder l'affichage actuel sinon. Pas de nouveau composant.
- [ ] **Step 3 : vérifier** — `npx tsc --noEmit` (ou le script typecheck du repo) → 0 erreur ; `npx vitest run` → vert.
- [ ] **Step 4 : commit** — `feat(ui): section double lecture dans le panneau CR`

### Task 6: Micro-service TotalSegmentator CPU

**Files:**

- Create: `seg-service/app.py`
- Create: `seg-service/test_app.py`
- Create: `seg-service/Dockerfile`
- Create: `seg-service/requirements.txt` (`fastapi`, `uvicorn`, `python-multipart`, `TotalSegmentator`)

**Interfaces:**

- Contrat imposé par `ctSegmentation.ts:71-83` (NE PAS le changer) : `POST /segment?fast=0|1&overlay=N&task=total`, header `X-Seg-Token`, multipart champ `file` = zip de `.dcm` ; réponse JSON `{ durationS: number, count: number, structures: [{name, volumeMl}], overlays?: [{sliceIndex, pngBase64}] }` ; le client timeout à 900 s.
- Produit (interne service) : `parse_statistics(stats: dict) -> list[dict]` — PURE : transforme le `statistics.json` de TotalSegmentator (`{structure: {"volume": mm3|ml, ...}}`) en `[{"name": str, "volumeMl": float arrondi 1 déc.}]` trié par volume décroissant, structures à volume 0 exclues.

- [ ] **Step 1 : test qui échoue** (`test_app.py`, pytest)

```python
from app import parse_statistics

def test_parse_statistics_tri_et_arrondi():
    stats = {
        "liver": {"volume": 1500.234},
        "kidney_left": {"volume": 140.05},
        "rib_left_1": {"volume": 0.0},
    }
    out = parse_statistics(stats)
    assert out[0] == {"name": "liver", "volumeMl": 1500.2}
    assert out[1] == {"name": "kidney_left", "volumeMl": 140.1}
    assert all(s["name"] != "rib_left_1" for s in out)
```

- [ ] **Step 2 : vérifier l'échec** — `cd seg-service && python -m pytest test_app.py` → FAIL.
- [ ] **Step 3 : implémentation `app.py`** — FastAPI ; vérif `X-Seg-Token == os.environ["SEG_TOKEN"]` (403 sinon) ; dézippe dans un tmpdir ; `SEG_FORCE_FAST=1` (défaut sur CPU) force `--fast` même si `fast=0` demandé ; exécute `TotalSegmentator -i <dir> -o <out> --ml --statistics [--fast]` via `subprocess.run(timeout=840)` ; lit `<out>/statistics.json` → `parse_statistics` ; `overlays` non implémenté en CPU (renvoyer `[]` — le client le traite comme optionnel) ; verrou global `threading.Semaphore(1)` (1 job à la fois, 503 « occupé » sinon) ; réponse avec `durationS` mesuré et `count = len(structures)`.
- [ ] **Step 4 : test vert** + lancement local sanité : `uvicorn app:app` puis `curl -s -o /dev/null -w '%{http_code}' -X POST 'localhost:8000/segment' -H 'X-Seg-Token: mauvais'` → `403`.
- [ ] **Step 5 : Dockerfile** — `python:3.11-slim`, pip install torch CPU (`--index-url https://download.pytorch.org/whl/cpu`) + requirements, `EXPOSE 8000`, CMD uvicorn. Build local : `docker build -t seg-service:dev seg-service/` → succès.
- [ ] **Step 6 : commit** — `feat(seg): micro-service TotalSegmentator CPU (contrat ctSegmentation)`

### Task 7: Déploiement du service seg sur VPS72 + config env

**Files:**

- Aucun fichier repo (ops VPS72) ; procédure via ssh relais `ssh root@76.13.55.44 "ssh root@72.62.26.49 …"`.

- [ ] **Step 1 : espace disque** — `df -h /` sur VPS72 ; il faut ≥ 10 Go libres (image ~4 Go + poids modèles ~2 Go). Sinon STOP et signaler (cf. incident disque).
- [ ] **Step 2 : transfert & build** — `rsync` du dossier `seg-service/` vers VPS72 `/opt/medical/seg-service/`, `docker build -t seg-service:latest`, ajout au compose médical : service `seg-service`, réseau interne du stack mediview UNIQUEMENT (aucun port publié, pas de label Traefik), env `SEG_TOKEN=<généré openssl rand -hex 24>`, `SEG_FORCE_FAST=1`, volume cache modèles `~/.totalsegmentator`.
- [ ] **Step 3 : config mediview** — dans `/opt/medical/mediview/.env` : `SEG_SERVICE_URL=http://seg-service:8000`, `SEG_TOKEN=<le même>` ; backup `.env.bak-seg-<date>` ; `docker compose up -d --force-recreate mediview seg-service`.
- [ ] **Step 4 : vérification réelle** — depuis le conteneur mediview : `curl -s -X POST "$SEG_SERVICE_URL/segment" -H "X-Seg-Token: $SEG_TOKEN"` → 4xx propre (pas de connexion refusée) ; puis segmentation d'une vraie série CT via le routeur `ai.segmentCt` et présence des volumes ; healthz mediview 200 (ping après déploiement — règle absolue).
- [ ] **Step 5 : trace** — noter image/tag + rollback dans le journal de déploiement habituel.

### Task 8: Réimport des 56 études incomplètes (ops passerelle)

**Files:**

- Create (HORS git, Mac cabinet) : `~/mediview-rapatrieur/rapatrier_liste.py`
- Consomme : `commun.cget_et_pousser_multi(uid, commun.pousser_dicom_import)` (existant, multi-nœuds .180/.210/.211 — cf. `completer.py`).

- [ ] **Step 1 : extraire les UIDs** — sur VPS72 (MySQL du conteneur mediview) :

```sql
SELECT s.studyInstanceUid FROM studies s
WHERE NOT EXISTS (
  SELECT 1 FROM series se WHERE se.studyId = s.id
    AND se.modality NOT IN ('SR','PR','KO','DOC','OT')
    AND LOWER(COALESCE(se.seriesDescription,'')) NOT REGEXP
      'scano|topogram|localizer|scout|surview|dose|summary|secondary capture|key image'
);
```

Vérifier l'effectif (~56) ; ajuster les noms de colonnes réels (`drizzle/schema.ts` : `studies.studyInstanceUid`, `series.studyId`) si besoin. Sauver dans `~/mediview-rapatrieur/state/uids-incomplets.txt` (1 UID/ligne — UIDs seuls, zéro PHI).

- [ ] **Step 2 : script** — `rapatrier_liste.py` = généralisation de `completer.py` : lit le fichier d'UIDs, boucle `cget_et_pousser_multi`, log par UID (statut hexa + nb images + nœud source), continue sur échec, résumé final.
- [ ] **Step 3 : exécution** — hors heures de charge, Mac branché : `caffeinate -i venv/bin/python rapatrier_liste.py | tee state/rapatriement-$(date +%Y%m%d).log`. Surveiller le disque VPS72 pendant le run (seuil 10 Go).
- [ ] **Step 4 : vérification** — re-jouer la requête SQL du Step 1 : l'effectif doit tomber (idéalement 0 ; certains examens peuvent être absents des 3 nœuds → les lister nommément dans le compte rendu au gérant). Ouvrir 2 études réimportées dans le viewer : « Analyser (IA) » ne renvoie plus le refus « import incomplet ».

### Task 9: Intégration finale, déploiement app, mémoire

- [ ] **Step 1 : suite complète** — `npx vitest run` → 0 échec ; typecheck client/serveur.
- [ ] **Step 2 : env prod** — vérifier dans `/opt/medical/mediview/.env` : `GEMINI_VERTEX_PROJECT`/`GEMINI_VERTEX_TOKEN` présents et valides (sonde : un `generateContent` texte minimal → 200 ; si absents, reprendre les valeurs de la config Vertex UE de medicentral) ; poser `GEMINI_SCREEN_MODEL=gemini-2.5-flash`, `GEMINI_SECOND_READ_MODEL=gemini-2.5-pro`. Backup `.env` avant.
- [ ] **Step 3 : déploiement** — procédure MediView habituelle : build Mac→VPS72, tag `horos-viewer:depot` + tag rollback daté, `docker compose up -d`, ping santé 200, hard-refresh SPA (piège chunks périmés).
- [ ] **Step 4 : test réel de bout en bout** — lancer « Analyser (IA) » sur un CT réel : vérifier dans le CR (a) modèle de dépistage Gemini utilisé (logs), (b) section « Double lecture (…) », (c) mesures de volumes présentes. Montrer la sortie au gérant.
- [ ] **Step 5 : mémoire & finition** — mettre à jour les fiches (`eva-cerveau-et-radio-ia-certifiee`, `mediview-cr-modele-lecteur`) : état déployé, coûts observés, tag rollback. Puis skill `superpowers:finishing-a-development-branch` (merge/PR selon la convention prod-sur-branche).
