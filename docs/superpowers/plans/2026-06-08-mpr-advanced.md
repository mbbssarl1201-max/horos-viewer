# MPR avancé (depuis Orthanc) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner à Horos un vrai MPR avancé (3 plans synchronisés + oblique + slab MIP/MinIP/moyenne) alimenté par Orthanc via un proxy DICOMweb authentifié.

**Architecture:** Un proxy HTTP serveur (`/api/dicomweb/*`) relaie en streaming les réponses WADO-RS d'Orthanc derrière l'auth de l'app (JWT + rôle médical + audit). Le client construit des `imageIds` `wadors:` pointant sur ce proxy, charge un volume Cornerstone3D en streaming, et l'affiche dans un `VolumeViewer` étendu (ToolGroup crosshair/W-L, oblique, slab).

**Tech Stack:** Express + tRPC + Drizzle (serveur) ; React 19 + Cornerstone3D v4 (`@cornerstonejs/core`, `@cornerstonejs/tools`, `@cornerstonejs/dicom-image-loader`) ; Vitest.

**Spec :** `docs/superpowers/specs/2026-06-08-mpr-advanced-design.md`

**Branche :** `feat/mpr-advanced` (déjà créée).

**Commande de test :** `npx vitest run <chemin>` (le repo expose `npm test` = `vitest run`).

---

## Structure de fichiers

| Fichier                                  | Rôle                                                         | Action   |
| ---------------------------------------- | ------------------------------------------------------------ | -------- |
| `server/dicomwebProxy.ts`                | Validation UID + handler proxy WADO-RS authentifié + montage | Créer    |
| `server/dicomwebProxy.test.ts`           | Tests serveur (auth/RBAC/UID/stream/audit)                   | Créer    |
| `server/_core/index.ts`                  | Monter la route `/api/dicomweb`                              | Modifier |
| `client/src/lib/wadorsImageIds.ts`       | Dérivation pure des `imageIds` wadors depuis la metadata     | Créer    |
| `client/src/lib/wadorsImageIds.test.ts`  | Tests de la dérivation                                       | Créer    |
| `client/src/lib/slabBlend.ts`            | Map mode slab → `BlendModes` (helper pur)                    | Créer    |
| `client/src/lib/slabBlend.test.ts`       | Tests du mapping                                             | Créer    |
| `client/src/hooks/useOrthancVolume.ts`   | Hook : metadata tRPC → imageIds + enregistrement metadata    | Créer    |
| `client/src/components/VolumeViewer.tsx` | ToolGroup, oblique, slab, source Orthanc                     | Modifier |
| `client/src/pages/Viewer.tsx`            | Contrôles toolbar en mode MPR                                | Modifier |

---

## Task 1 : Validation des UID DICOM (serveur, anti-SSRF)

**Files:**

- Create: `server/dicomwebProxy.ts`
- Test: `server/dicomwebProxy.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// server/dicomwebProxy.test.ts
import { describe, it, expect } from "vitest";
import { isValidDicomUid } from "./dicomwebProxy";

describe("isValidDicomUid", () => {
  it("accepte un UID DICOM valide", () => {
    expect(isValidDicomUid("1.3.6.1.4.1.14519.5.2.1.7009.2403.3342")).toBe(
      true
    );
  });
  it("rejette les caractères de path traversal", () => {
    expect(isValidDicomUid("../../etc/passwd")).toBe(false);
    expect(isValidDicomUid("1.2.3/4")).toBe(false);
    expect(isValidDicomUid("1.2.3 4")).toBe(false);
  });
  it("rejette le vide et les UID trop longs (>64)", () => {
    expect(isValidDicomUid("")).toBe(false);
    expect(isValidDicomUid("1".repeat(65))).toBe(false);
  });
});
```

- [ ] **Step 2 : Lancer le test, vérifier l'échec**

Run: `npx vitest run server/dicomwebProxy.test.ts`
Expected: FAIL — `isValidDicomUid is not a function` (module/fonction absents).

- [ ] **Step 3 : Implémentation minimale**

```typescript
// server/dicomwebProxy.ts
/**
 * Un UID DICOM est une suite de chiffres séparés par des points, max 64 caractères
 * (PS 3.5). On l'exige strictement avant de l'interpoler dans une URL Orthanc :
 * défense en profondeur contre le path traversal / SSRF.
 */
export function isValidDicomUid(uid: string): boolean {
  return (
    typeof uid === "string" &&
    /^[0-9]+(\.[0-9]+)*$/.test(uid) &&
    uid.length <= 64 &&
    uid.length > 0
  );
}
```

- [ ] **Step 4 : Lancer le test, vérifier le succès**

Run: `npx vitest run server/dicomwebProxy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5 : Commit**

```bash
git add server/dicomwebProxy.ts server/dicomwebProxy.test.ts
git commit -m "feat(dicomweb): validation stricte des UID DICOM (anti-SSRF)"
```

---

## Task 2 : Handler proxy WADO-RS authentifié + montage

> **⚠️ CORRECTIF SÉCURITÉ (appliqué post-implémentation) :** la version initiale reconstruisait l'URL Orthanc à partir du chemin brut `rest` après une validation partielle (`parseDicomwebPath`), permettant à des chemins sans segment `studies/` (ex. `tools/execute-script`, `../system`) d'échapper à la validation et d'atteindre l'API admin Orthanc (SSRF/path traversal). La version corrigée remplace `parseDicomwebPath` par `buildOrthancPath` : grammaire regex stricte + rejet préalable des caractères dangereux (`..`, `\`, `%2f`, `%2e`, `%5c`, `?`, `#`) + reconstruction URL segment par segment (jamais interpolation de `rest`). Voir commit `fix(dicomweb): durcir le proxy contre path traversal/SSRF`.

**Files:**

- Modify: `server/dicomwebProxy.ts`
- Modify: `server/_core/index.ts` (montage de la route)
- Test: `server/dicomwebProxy.test.ts`

Contexte réutilisé (déjà présents dans le repo) :

- `sdk.authenticateRequest(req)` → renvoie l'utilisateur, **throw** si pas de session (cf. `server/_core/storageProxy.ts:12`).
- `hasMedicalAccess(user)` → booléen (cf. `server/rbac.ts:14`).
- `orthancFetch(path, options)` → `Response` web fetch vers Orthanc avec l'auth Basic (cf. `server/orthanc.ts:41`).
- `recordAccess({ userId, action, studyId?, detail?, ipAddress? })` (cf. `server/db.ts:489`) ; `action` = varchar(64), `studyId` est l'**id numérique interne** (on n'a ici que l'UID DICOM → on met `studyId: null` et l'UID dans `detail`).

- [ ] **Step 1 : Écrire les tests qui échouent**

```typescript
// server/dicomwebProxy.test.ts  (ajouter sous les tests existants)
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_core/sdk", () => ({
  sdk: { authenticateRequest: vi.fn() },
}));
vi.mock("./rbac", () => ({
  hasMedicalAccess: vi.fn(),
}));
vi.mock("./orthanc", () => ({
  orthancFetch: vi.fn(),
}));
vi.mock("./db", () => ({
  recordAccess: vi.fn(),
}));

import { handleDicomwebRequest } from "./dicomwebProxy";
import { sdk } from "./_core/sdk";
import { hasMedicalAccess } from "./rbac";
import { orthancFetch } from "./orthanc";
import { recordAccess } from "./db";

function mockRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
    end(b?: unknown) {
      this.body = b;
      return this;
    },
  };
}

describe("handleDicomwebRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 sans session", async () => {
    (sdk.authenticateRequest as any).mockRejectedValue(new Error("no session"));
    const res = mockRes();
    await handleDicomwebRequest(
      { params: { 0: "studies/1.2/series/3.4/metadata" }, headers: {} } as any,
      res as any
    );
    expect(res.statusCode).toBe(401);
    expect(orthancFetch).not.toHaveBeenCalled();
  });

  it("403 sans rôle médical", async () => {
    (sdk.authenticateRequest as any).mockResolvedValue({ id: 7, role: "user" });
    (hasMedicalAccess as any).mockReturnValue(false);
    const res = mockRes();
    await handleDicomwebRequest(
      { params: { 0: "studies/1.2/series/3.4/metadata" }, headers: {} } as any,
      res as any
    );
    expect(res.statusCode).toBe(403);
    expect(orthancFetch).not.toHaveBeenCalled();
  });

  it("400 si un UID du chemin est invalide", async () => {
    (sdk.authenticateRequest as any).mockResolvedValue({
      id: 7,
      role: "radiologist",
    });
    (hasMedicalAccess as any).mockReturnValue(true);
    const res = mockRes();
    await handleDicomwebRequest(
      {
        params: { 0: "studies/..%2F/series/3.4/metadata" },
        headers: {},
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect(orthancFetch).not.toHaveBeenCalled();
  });

  it("relaie la metadata et journalise l'accès une fois", async () => {
    (sdk.authenticateRequest as any).mockResolvedValue({
      id: 7,
      role: "radiologist",
    });
    (hasMedicalAccess as any).mockReturnValue(true);
    (orthancFetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/dicom+json"]]),
      arrayBuffer: async () => new TextEncoder().encode("[]").buffer,
    });
    const res = mockRes();
    await handleDicomwebRequest(
      {
        params: { 0: "studies/1.2.3/series/4.5.6/metadata" },
        headers: { accept: "application/dicom+json" },
      } as any,
      res as any
    );
    expect(orthancFetch).toHaveBeenCalledWith(
      "/dicom-web/studies/1.2.3/series/4.5.6/metadata",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/dicom+json" }),
      })
    );
    expect(res.headers["Content-Type"]).toBe("application/dicom+json");
    expect(recordAccess).toHaveBeenCalledTimes(1);
    expect((recordAccess as any).mock.calls[0][0]).toMatchObject({
      userId: 7,
      action: "mpr_volume_view",
      detail: "study=1.2.3",
    });
  });
});
```

- [ ] **Step 2 : Lancer les tests, vérifier l'échec**

Run: `npx vitest run server/dicomwebProxy.test.ts`
Expected: FAIL — `handleDicomwebRequest is not a function`.

- [ ] **Step 3 : Implémenter le handler**

```typescript
// server/dicomwebProxy.ts  (ajouter)
import type { Express, Request, Response } from "express";
import { Readable } from "node:stream";
import { sdk } from "./_core/sdk";
import { hasMedicalAccess } from "./rbac";
import { orthancFetch } from "./orthanc";
import { recordAccess } from "./db";

/**
 * Découpe le chemin DICOMweb capturé (`studies/{uid}/series/{uid}/instances/{uid}[/frames/{n}]`
 * ou `.../metadata`) et valide chaque UID. Renvoie null si un segment UID est invalide.
 */
export function parseDicomwebPath(
  rest: string
): { study?: string; series?: string; isMetadata: boolean } | null {
  const clean = decodeURIComponent(rest).replace(/^\/+/, "");
  const isMetadata = clean.endsWith("/metadata");
  const parts = clean.split("/");
  let study: string | undefined;
  let series: string | undefined;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "studies") study = parts[i + 1];
    if (parts[i] === "series") series = parts[i + 1];
    if (parts[i] === "instances" && !isValidDicomUid(parts[i + 1])) return null;
  }
  if (study !== undefined && !isValidDicomUid(study)) return null;
  if (series !== undefined && !isValidDicomUid(series)) return null;
  return { study, series, isMetadata };
}

export async function handleDicomwebRequest(
  req: Request,
  res: Response
): Promise<void> {
  // PHI : exiger une session + un rôle clinique avant de relayer le moindre octet.
  let user;
  try {
    user = await sdk.authenticateRequest(req as any);
  } catch {
    res.status(401).send("Unauthorized");
    return;
  }
  if (!hasMedicalAccess(user)) {
    res.status(403).send("Forbidden");
    return;
  }

  const rest = (req.params as Record<string, string>)[0] ?? "";
  const parsed = parseDicomwebPath(rest);
  if (!parsed) {
    res.status(400).send("Invalid DICOM UID");
    return;
  }

  // Audit : une seule entrée par chargement de volume, sur la requête metadata
  // (qui identifie l'étude). On n'a que l'UID DICOM ici → studyId null, UID en detail.
  if (parsed.isMetadata && parsed.study) {
    await recordAccess({
      userId: (user as any).id,
      action: "mpr_volume_view",
      studyId: null,
      detail: `study=${parsed.study}`,
      ipAddress:
        (req.headers["x-forwarded-for"] as string) ?? (req as any).ip ?? null,
    });
  }

  try {
    const orthancPath = `/dicom-web/${decodeURIComponent(rest).replace(/^\/+/, "")}`;
    const accept =
      (req.headers["accept"] as string) || "application/dicom+json";
    const upstream = await orthancFetch(orthancPath, {
      method: "GET",
      headers: { Accept: accept },
    });

    const contentType =
      upstream.headers.get("content-type") || "application/octet-stream";
    res.status(upstream.status);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");

    if (!upstream.ok || !upstream.body) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
      return;
    }
    // Streaming passthrough (frames volumineuses). Node 20 : web ReadableStream → Node stream.
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (err) {
    console.error("[DicomwebProxy] failed:", err);
    if (!res.headersSent) res.status(502).send("DICOMweb proxy error");
  }
}

export function registerDicomwebProxy(app: Express) {
  app.get("/api/dicomweb/*", handleDicomwebRequest);
}
```

> Note : dans le test « metadata », `upstream.ok = true` et `upstream.body` absent → on passe par la branche `arrayBuffer()` (`res.send`). Le streaming réel n'est exercé qu'à l'exécution.

- [ ] **Step 4 : Monter la route dans `_core/index.ts`**

Repérer l'enregistrement du storage proxy (`registerStorageProxy(app)`) et ajouter juste après :

```typescript
// server/_core/index.ts
import { registerDicomwebProxy } from "../dicomwebProxy";
// ... après registerStorageProxy(app);
registerDicomwebProxy(app);
```

- [ ] **Step 5 : Lancer les tests, vérifier le succès**

Run: `npx vitest run server/dicomwebProxy.test.ts`
Expected: PASS (tous les tests, dont les 3 de Task 1).

- [ ] **Step 6 : Typecheck**

Run: `npm run check`
Expected: aucune erreur TS sur `server/dicomwebProxy.ts` / `_core/index.ts`.

- [ ] **Step 7 : Commit**

```bash
git add server/dicomwebProxy.ts server/dicomwebProxy.test.ts server/_core/index.ts
git commit -m "feat(dicomweb): proxy WADO-RS authentifié (RBAC + audit + streaming)"
```

---

## Task 3 : Dérivation des imageIds wadors (client, pur)

**Files:**

- Create: `client/src/lib/wadorsImageIds.ts`
- Test: `client/src/lib/wadorsImageIds.test.ts`

Contexte : la metadata WADO-RS est un tableau d'objets DICOM JSON ; chaque instance porte
le SOPInstanceUID (tag `00080018`) et le nombre de frames (`00280008`, défaut 1). L'imageId
wadors attendu par Cornerstone est :
`wadors:{root}/studies/{study}/series/{series}/instances/{sop}/frames/{frame}`.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// client/src/lib/wadorsImageIds.test.ts
import { describe, it, expect } from "vitest";
import { deriveWadorsImageIds } from "./wadorsImageIds";

const meta = [
  { "00080018": { Value: ["1.2.3.1"] }, "00280008": { Value: ["1"] } },
  { "00080018": { Value: ["1.2.3.2"] } }, // pas de NumberOfFrames → 1 frame
];

describe("deriveWadorsImageIds", () => {
  it("construit un imageId wadors par frame", () => {
    const ids = deriveWadorsImageIds(meta, {
      root: "/api/dicomweb",
      studyUid: "1.2",
      seriesUid: "3.4",
    });
    expect(ids).toEqual([
      "wadors:/api/dicomweb/studies/1.2/series/3.4/instances/1.2.3.1/frames/1",
      "wadors:/api/dicomweb/studies/1.2/series/3.4/instances/1.2.3.2/frames/1",
    ]);
  });

  it("gère le multiframe", () => {
    const mf = [
      { "00080018": { Value: ["1.2.3.9"] }, "00280008": { Value: ["3"] } },
    ];
    const ids = deriveWadorsImageIds(mf, {
      root: "/api/dicomweb",
      studyUid: "1.2",
      seriesUid: "3.4",
    });
    expect(ids).toHaveLength(3);
    expect(ids[2]).toContain("/instances/1.2.3.9/frames/3");
  });

  it("ignore les instances sans SOPInstanceUID", () => {
    const bad = [{ "00280008": { Value: ["1"] } }];
    expect(
      deriveWadorsImageIds(bad, {
        root: "/api/dicomweb",
        studyUid: "1.2",
        seriesUid: "3.4",
      })
    ).toEqual([]);
  });
});
```

- [ ] **Step 2 : Lancer le test, vérifier l'échec**

Run: `npx vitest run client/src/lib/wadorsImageIds.test.ts`
Expected: FAIL — `deriveWadorsImageIds is not a function`.

- [ ] **Step 3 : Implémentation**

```typescript
// client/src/lib/wadorsImageIds.ts
export interface InstanceMetadata {
  [tag: string]: { Value?: unknown[] } | undefined;
}

export interface WadorsContext {
  root: string; // ex. "/api/dicomweb"
  studyUid: string;
  seriesUid: string;
}

const SOP_INSTANCE_UID = "00080018";
const NUMBER_OF_FRAMES = "00280008";

/** Construit la liste des imageIds wadors (un par frame) depuis la metadata WADO-RS. */
export function deriveWadorsImageIds(
  metadata: InstanceMetadata[],
  { root, studyUid, seriesUid }: WadorsContext
): string[] {
  const ids: string[] = [];
  for (const inst of metadata) {
    const sop = inst?.[SOP_INSTANCE_UID]?.Value?.[0] as string | undefined;
    if (!sop) continue;
    const frames = Number(inst?.[NUMBER_OF_FRAMES]?.Value?.[0] ?? 1) || 1;
    for (let f = 1; f <= frames; f++) {
      ids.push(
        `wadors:${root}/studies/${studyUid}/series/${seriesUid}/instances/${sop}/frames/${f}`
      );
    }
  }
  return ids;
}
```

- [ ] **Step 4 : Lancer le test, vérifier le succès**

Run: `npx vitest run client/src/lib/wadorsImageIds.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5 : Commit**

```bash
git add client/src/lib/wadorsImageIds.ts client/src/lib/wadorsImageIds.test.ts
git commit -m "feat(mpr): dérivation des imageIds wadors depuis la metadata"
```

---

## Task 4 : Mapping mode slab → BlendMode (client, pur)

**Files:**

- Create: `client/src/lib/slabBlend.ts`
- Test: `client/src/lib/slabBlend.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// client/src/lib/slabBlend.test.ts
import { describe, it, expect } from "vitest";
import { SLAB_MODES, slabModeToBlend } from "./slabBlend";

describe("slabModeToBlend", () => {
  it("mappe chaque mode vers une constante BlendModes", () => {
    expect(slabModeToBlend("mip")).toBe("MAXIMUM_INTENSITY_BLEND");
    expect(slabModeToBlend("minip")).toBe("MINIMUM_INTENSITY_BLEND");
    expect(slabModeToBlend("average")).toBe("AVERAGE_INTENSITY_BLEND");
  });
  it("expose les modes pour l'UI", () => {
    expect(SLAB_MODES.map(m => m.id)).toEqual(["mip", "minip", "average"]);
  });
});
```

- [ ] **Step 2 : Lancer le test, vérifier l'échec**

Run: `npx vitest run client/src/lib/slabBlend.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3 : Implémentation**

```typescript
// client/src/lib/slabBlend.ts
export type SlabMode = "mip" | "minip" | "average";

/** Clés de Enums.BlendModes (Cornerstone3D). On garde la chaîne pour tester sans importer le moteur. */
const BLEND_KEY: Record<SlabMode, string> = {
  mip: "MAXIMUM_INTENSITY_BLEND",
  minip: "MINIMUM_INTENSITY_BLEND",
  average: "AVERAGE_INTENSITY_BLEND",
};

export const SLAB_MODES: { id: SlabMode; label: string }[] = [
  { id: "mip", label: "MIP" },
  { id: "minip", label: "MinIP" },
  { id: "average", label: "Moyenne" },
];

export function slabModeToBlend(mode: SlabMode): string {
  return BLEND_KEY[mode];
}
```

- [ ] **Step 4 : Lancer le test, vérifier le succès**

Run: `npx vitest run client/src/lib/slabBlend.test.ts`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add client/src/lib/slabBlend.ts client/src/lib/slabBlend.test.ts
git commit -m "feat(mpr): mapping mode slab -> BlendMode"
```

---

## Task 5 : Hook `useOrthancVolume` (metadata tRPC → imageIds + enregistrement metadata)

**Files:**

- Create: `client/src/hooks/useOrthancVolume.ts`

> Ce hook fait des effets de bord (fetch metadata, enregistrement dans le metaDataManager du
> loader), peu unitaire-testable ; la dérivation pure est déjà couverte en Task 3. Vérification
> manuelle via Task 8.

- [ ] **Step 1 : Implémenter le hook**

```typescript
// client/src/hooks/useOrthancVolume.ts
import { useEffect, useState } from "react";
import { deriveWadorsImageIds } from "@/lib/wadorsImageIds";

const PROXY_ROOT = "/api/dicomweb";

interface Result {
  imageIds: string[];
  volumeId: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Récupère la metadata WADO-RS d'une série via le proxy authentifié, l'enregistre dans
 * le metaDataManager du loader wadors, et renvoie les imageIds + un volumeId stable.
 */
export function useOrthancVolume(
  studyUid?: string,
  seriesUid?: string
): Result {
  const [state, setState] = useState<Result>({
    imageIds: [],
    volumeId: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!studyUid || !seriesUid) return;
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: null }));

    (async () => {
      try {
        const url = `${PROXY_ROOT}/studies/${studyUid}/series/${seriesUid}/metadata`;
        const resp = await fetch(url, {
          headers: { Accept: "application/dicom+json" },
          credentials: "same-origin",
        });
        if (!resp.ok) throw new Error(`Metadata HTTP ${resp.status}`);
        const metadata = await resp.json();

        const imageIds = deriveWadorsImageIds(metadata, {
          root: PROXY_ROOT,
          studyUid,
          seriesUid,
        });
        if (imageIds.length < 2)
          throw new Error("Série non volumétrique (moins de 2 coupes)");

        // Enregistrer la metadata par imageId pour que le loader wadors connaisse
        // géométrie/pixel spacing sans re-télécharger.
        const loader: any = await import("@cornerstonejs/dicom-image-loader");
        const mgr =
          loader.wadors?.metaDataManager ??
          loader.default?.wadors?.metaDataManager;
        metadata.forEach((inst: any, i: number) => {
          if (imageIds[i] && mgr?.add) mgr.add(imageIds[i], inst);
        });

        if (!cancelled) {
          setState({
            imageIds,
            volumeId: `cornerstoneStreamingImageVolume:ORTHANC_${seriesUid}`,
            loading: false,
            error: null,
          });
        }
      } catch (err: any) {
        if (!cancelled)
          setState({
            imageIds: [],
            volumeId: null,
            loading: false,
            error: err?.message ?? "Échec metadata",
          });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [studyUid, seriesUid]);

  return state;
}
```

- [ ] **Step 2 : Typecheck**

Run: `npm run check`
Expected: pas d'erreur TS sur le hook (l'import dynamique est typé `any`, volontairement).

- [ ] **Step 3 : Commit**

```bash
git add client/src/hooks/useOrthancVolume.ts
git commit -m "feat(mpr): hook useOrthancVolume (metadata -> imageIds wadors)"
```

---

## Task 6 : Étendre `VolumeViewer` — ToolGroup, oblique, slab, source Orthanc

**Files:**

- Modify: `client/src/components/VolumeViewer.tsx`

Objectifs de cette tâche (rendu — vérification manuelle en Task 8) :

1. Accepter une source Orthanc (imageIds wadors) en plus de la source locale existante.
2. 4ᵉ quadrant = viewport **oblique**.
3. ToolGroup : `CrosshairsTool`, `WindowLevelTool`, `StackScrollTool`, `PanTool`, `ZoomTool`.
4. Synchronizer VOI (W/L) sur les 4 viewports.
5. Slab : `setSlabThickness` + `setBlendMode` pilotés par des props.

- [ ] **Step 1 : Mettre à jour l'interface du composant**

```typescript
// client/src/components/VolumeViewer.tsx (interface)
import { slabModeToBlend, type SlabMode } from "@/lib/slabBlend";

interface VolumeViewerProps {
  /** Source locale (MinIO, schéma wadouri:) — conservée pour compat. */
  imageUrls?: string[];
  /** Source Orthanc (imageIds wadors déjà préfixés). Prioritaire si fournie. */
  orthancImageIds?: string[];
  /** volumeId stable fourni par useOrthancVolume (sinon valeur locale par défaut). */
  volumeId?: string;
  mode: "mpr" | "3d";
  /** Épaisseur de coupe en mm (0 = coupe fine). */
  slabThicknessMm?: number;
  /** Mode de projection slab. */
  slabMode?: SlabMode;
}
```

- [ ] **Step 2 : Construire les imageIds selon la source**

Remplacer le bloc actuel `const imageIds = imageUrls.map((u) => 'wadouri:' + u);` par :

```typescript
const imageIds =
  orthancImageIds && orthancImageIds.length
    ? orthancImageIds
    : (imageUrls ?? []).map(u => `wadouri:${u}`);
if (imageIds.length < 2) {
  throw new Error("Need at least 2 slices to build a volume");
}
const volId = volumeId ?? `cornerstoneStreamingImageVolume:HOROS_VOL`;
```

Puis utiliser `volId` partout où `volumeId` était codé en dur (création + `setVolumesForViewports` + purge cache).

- [ ] **Step 3 : Initialiser tools + 4ᵉ viewport oblique (mode MPR)**

Dans la branche `if (mode === "mpr") { … }`, après `engine.setViewports(inputs)`, ajouter un 4ᵉ input oblique et le ToolGroup :

```typescript
import {
  init as toolsInit,
  ToolGroupManager,
  CrosshairsTool,
  WindowLevelTool,
  StackScrollTool,
  PanTool,
  ZoomTool,
  Enums as csToolsEnums,
  addTool,
  synchronizers,
} from "@cornerstonejs/tools";

// ... dans setup(), avant de créer le ToolGroup :
await toolsInit();
[CrosshairsTool, WindowLevelTool, StackScrollTool, PanTool, ZoomTool].forEach(
  t => {
    try {
      addTool(t);
    } catch {} // addTool throw si déjà enregistré → ignorer
  }
);

// 4ᵉ quadrant oblique (orientation ACQUISITION = plan oblique pilotable au crosshair)
inputs.push({
  viewportId: "MPR_OBLIQUE",
  element: obliqueRef.current!,
  type: Enums.ViewportType.ORTHOGRAPHIC,
  defaultOptions: { orientation: Enums.OrientationAxis.ACQUISITION },
});
engine.setViewports(inputs);
const allIds = ["MPR_AXIAL", "MPR_SAGITTAL", "MPR_CORONAL", "MPR_OBLIQUE"];
await setVolumesForViewports(engine, [{ volumeId: volId }], allIds);

const TOOLGROUP_ID = "HOROS_MPR_TG";
ToolGroupManager.destroyToolGroup?.(TOOLGROUP_ID); // repartir propre
const tg = ToolGroupManager.createToolGroup(TOOLGROUP_ID)!;
[CrosshairsTool, WindowLevelTool, StackScrollTool, PanTool, ZoomTool].forEach(
  t => tg.addTool(t.toolName)
);
allIds.forEach(id => tg.addViewport(id, VOLUME_ENGINE_ID));

const { MouseBindings } = csToolsEnums;
tg.setToolActive(CrosshairsTool.toolName, {
  bindings: [{ mouseButton: MouseBindings.Primary }],
});
tg.setToolActive(WindowLevelTool.toolName, {
  bindings: [{ mouseButton: MouseBindings.Secondary }],
});
tg.setToolActive(ZoomTool.toolName, {
  bindings: [{ mouseButton: MouseBindings.Auxiliary }],
});
tg.setToolActive(StackScrollTool.toolName, {
  bindings: [{ mouseButton: MouseBindings.Wheel }],
});

// Synchronizer VOI (W/L cohérent sur les 4 vues)
const voiSync = synchronizers.createVOISynchronizer("HOROS_VOI_SYNC", {
  syncInvertState: false,
});
allIds.forEach(id =>
  voiSync.add({ renderingEngineId: VOLUME_ENGINE_ID, viewportId: id })
);
```

Remplacer `mprIds` par `allIds` dans `applyMprWindow()` et `engine.renderViewports(...)`.

- [ ] **Step 4 : Appliquer slab thickness + blend mode (mode MPR)**

Après `applyMprWindow()`, ajouter :

```typescript
const applySlab = () => {
  if (!slabThicknessMm || slabThicknessMm <= 0) return;
  const blendKey = slabModeToBlend(slabMode ?? "mip");
  const blend =
    (csToolsEnums as any).BlendModes?.[blendKey] ??
    (Enums as any).BlendModes?.[blendKey];
  for (const id of allIds) {
    try {
      const vp = engine.getViewport(id) as any;
      vp.setSlabThickness(slabThicknessMm);
      if (blend !== undefined) vp.setBlendMode(blend);
    } catch {}
  }
  engine.renderViewports(allIds);
};
applySlab();
volume.load(() => {
  applyMprWindow();
  applySlab();
});
```

> `BlendModes` provient de `@cornerstonejs/core` `Enums` (cf. doc). Le fallback couvre les deux emplacements selon le build.

- [ ] **Step 5 : Ajouter la ref + le 4ᵉ quadrant dans le JSX MPR**

```tsx
const obliqueRef = useRef<HTMLDivElement>(null);
// ... dans le rendu MPR, remplacer le 4ᵉ <div className="bg-black" /> par :
<div ref={obliqueRef} className="relative bg-black" data-label="Oblique" />;
```

- [ ] **Step 6 : Renforcer le cleanup (anti-fuite GPU)**

Dans le `return () => { … }` du `useEffect`, avant `engine.destroy()` :

```typescript
try {
  const cornerstone = (window as any).cornerstone ?? null;
} catch {}
// purge du volume du cache pour libérer la mémoire GPU entre changements de série
import("@cornerstonejs/core")
  .then((cs: any) => {
    try {
      cs.cache?.removeVolumeLoadObject?.(volId);
    } catch {}
    try {
      cs.ToolGroupManager?.destroyToolGroup?.("HOROS_MPR_TG");
    } catch {}
  })
  .catch(() => {});
```

(`volId` doit être capturé dans la closure de l'effet.)

- [ ] **Step 7 : Typecheck + lint**

Run: `npm run check`
Expected: pas d'erreur TS. (Les `as any` sur les enums dynamiques sont volontaires.)

- [ ] **Step 8 : Commit**

```bash
git add client/src/components/VolumeViewer.tsx
git commit -m "feat(mpr): ToolGroup crosshair/W-L, viewport oblique, slab, source Orthanc"
```

---

## Task 7 : Contrôles toolbar en mode MPR + branchement de la source Orthanc

**Files:**

- Modify: `client/src/pages/Viewer.tsx`

- [ ] **Step 1 : Récupérer le volume Orthanc + états slab**

Dans `Viewer.tsx`, près des autres `useState` :

```typescript
import { useOrthancVolume } from "@/hooks/useOrthancVolume";
import { SLAB_MODES, type SlabMode } from "@/lib/slabBlend";

// studyUid / seriesUid : à dériver de l'étude affichée (UID DICOM de la série courante).
const {
  imageIds: orthancImageIds,
  volumeId: orthancVolumeId,
  error: orthancError,
} = useOrthancVolume(currentStudyUid, currentSeriesUid);
const [slabThicknessMm, setSlabThicknessMm] = useState(0);
const [slabMode, setSlabMode] = useState<SlabMode>("mip");
```

> `currentStudyUid` / `currentSeriesUid` : utiliser les UID DICOM de la série affichée (déjà
> disponibles dans l'objet étude/série chargé ; sinon les remonter depuis la requête étude).

- [ ] **Step 2 : Passer la source + le slab au VolumeViewer**

Remplacer le `<VolumeViewer mode={viewMode} … />` (vers `Viewer.tsx:462`) par :

```tsx
<VolumeViewer
  mode={viewMode === "3d" ? "3d" : "mpr"}
  imageUrls={imageUrls}
  orthancImageIds={orthancImageIds}
  volumeId={orthancVolumeId ?? undefined}
  slabThicknessMm={slabThicknessMm}
  slabMode={slabMode}
/>
```

- [ ] **Step 3 : Ajouter les contrôles slab dans le toolbar (mode MPR seulement)**

À côté des boutons 2D/MPR/3D :

```tsx
{
  viewMode === "mpr" && (
    <div className="flex items-center gap-2 px-2">
      <label className="text-[10px] text-muted-foreground">Slab</label>
      <input
        type="range"
        min={0}
        max={50}
        step={1}
        value={slabThicknessMm}
        onChange={e => setSlabThicknessMm(Number(e.target.value))}
        title="Épaisseur de coupe (mm)"
      />
      <span className="text-[10px] w-8">{slabThicknessMm}mm</span>
      <select
        className="bg-transparent text-[10px] border border-border rounded"
        value={slabMode}
        onChange={e => setSlabMode(e.target.value as SlabMode)}
      >
        {SLAB_MODES.map(m => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );
}
{
  orthancError && viewMode === "mpr" && (
    <span className="text-[10px] text-destructive px-2">{orthancError}</span>
  );
}
```

- [ ] **Step 4 : Typecheck**

Run: `npm run check`
Expected: pas d'erreur TS.

- [ ] **Step 5 : Commit**

```bash
git add client/src/pages/Viewer.tsx
git commit -m "feat(mpr): contrôles slab dans le toolbar + source Orthanc branchée"
```

---

## Task 8 : Vérification manuelle (build + app réelle)

**Files:** aucun (vérification).

- [ ] **Step 1 : Suite de tests complète**

Run: `npm test`
Expected: tous les tests verts (dont les nouveaux serveur + client).

- [ ] **Step 2 : Build de production**

Run: `npm run build`
Expected: build vite + esbuild sans erreur ; `dist/` régénéré.

- [ ] **Step 3 : Lancer l'app et tester le MPR**

Run: `npm run dev` (nécessite Orthanc + MySQL + MinIO configurés via `.env`).
Vérifier, connecté avec un compte **rôle médical** :

- Ouvrir une étude **CT issue d'Orthanc**, cliquer **MPR**.
- Les 3 plans (axial/coronal/sagittal) + le 4ᵉ (oblique) se construisent ; le volume se remplit en streaming.
- Le **crosshair** déplace la position dans les 3 plans simultanément ; sa **rotation** modifie le plan oblique.
- Le **clic droit** ajuste le **window/level** et il reste **synchronisé** sur les 4 vues.
- Le **slider Slab** > 0 + bascule **MIP/MinIP/Moyenne** changent le rendu.

- [ ] **Step 4 : Vérifier sécurité / audit**

- Sans session : `curl -i https://<host>/api/dicomweb/studies/1.2/series/3.4/metadata` → **401**.
- Avec un compte rôle `user` (non médical) → **403**.
- Après un chargement MPR, une ligne `mpr_volume_view` apparaît dans `access_logs`
  (`SELECT action, detail, createdAt FROM access_logs ORDER BY id DESC LIMIT 5;`).
- UID forgé (`.../studies/..%2f/series/3.4/metadata`) → **400**.

- [ ] **Step 5 : Commit final éventuel** (correctifs issus de la vérif)

```bash
git add -A && git commit -m "fix(mpr): correctifs issus de la vérification manuelle"
```

---

## Notes d'exécution

- **PHI** : ne jamais committer de fichier DICOM/patient. Les tests utilisent des UID/metadata factices.
- **Branche** : tout sur `feat/mpr-advanced`. Ne pas push sur `main` (hook bloquant). PR ensuite.
- **Cornerstone3D** : si une API diffère du build v4.22.13 installé, vérifier via Context7
  (`/websites/cornerstonejs`) — notamment l'emplacement exact de `Enums.BlendModes` et la
  signature de `createVOISynchronizer`.
- **Hors périmètre** rappelé : pas de 3D VR poli, pas de MPR sur études locales MinIO, pas de
  mesures cross-plans, pas de CPR.
