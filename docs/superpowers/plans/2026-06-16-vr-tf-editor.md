# VR avancé — Incrément 4 : éditeur de fonction de transfert (opacité) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre au médecin de régler lui-même la **courbe d'opacité** du rendu 3D (« fenêtrage 3D ») via un éditeur canvas à points déplaçables, et de **sauvegarder/charger ses propres presets** (localStorage). La couleur reste celle du preset clinique choisi.

**Architecture:** Module pur `lib/transferFunction.ts` (modèle de points + normalisation + sérialisation localStorage), composant `TransferFunctionEditor.tsx` (canvas à points déplaçables + presets), branché dans `Viewer.tsx` (mode 3D) qui passe les points à `VolumeViewer` ; ce dernier surcharge la **scalar opacity** de l'acteur volume VTK après le preset. 100 % client.

**Tech Stack:** React 19, Canvas 2D, Cornerstone3D (`actor.getProperty().getScalarOpacity(0)` → vtkPiecewiseFunction `removeAllPoints`/`addPoint`), localStorage, Vitest.

**Spec :** `docs/superpowers/specs/2026-06-16-vr-avance-design.md` (incrément 4). **Hors scope (reporté)** : édition de la **couleur** (RGB transfer function) — incrément ultérieur ; ici uniquement l'opacité.

---

### Task 1 : Module pur `transferFunction.ts`

**Files:**

- Create: `client/src/lib/transferFunction.ts`
- Test: `client/src/lib/transferFunction.test.ts`

- [ ] **Step 1 : Test qui échoue**

```ts
import { describe, it, expect } from "vitest";
import {
  clampOpacity,
  normalizeOpacityPoints,
  defaultOpacityRamp,
  serializePresets,
  deserializePresets,
} from "./transferFunction";

describe("clampOpacity", () => {
  it("borne dans [0,1] et gère NaN", () => {
    expect(clampOpacity(1.4)).toBe(1);
    expect(clampOpacity(-0.1)).toBe(0);
    expect(clampOpacity(0.5)).toBe(0.5);
    expect(clampOpacity(NaN)).toBe(0);
  });
});

describe("normalizeOpacityPoints", () => {
  it("trie par valeur, borne l'opacité, retire les valeurs non finies", () => {
    const out = normalizeOpacityPoints([
      { value: 300, opacity: 1.5 },
      { value: 0, opacity: -1 },
      { value: NaN, opacity: 0.5 },
    ]);
    expect(out).toEqual([
      { value: 0, opacity: 0 },
      { value: 300, opacity: 1 },
    ]);
  });
});

describe("defaultOpacityRamp", () => {
  it("rampe 0→1 entre lo et hi", () => {
    expect(defaultOpacityRamp(-200, 800)).toEqual([
      { value: -200, opacity: 0 },
      { value: 800, opacity: 1 },
    ]);
  });
});

describe("serialize/deserialize presets", () => {
  it("round-trip, et JSON invalide → []", () => {
    const presets = [
      { name: "Mon os", points: [{ value: 200, opacity: 0.2 }] },
    ];
    const json = serializePresets(presets);
    expect(deserializePresets(json)).toEqual(presets);
    expect(deserializePresets(null)).toEqual([]);
    expect(deserializePresets("{pas du json")).toEqual([]);
    expect(deserializePresets('{"x":1}')).toEqual([]);
  });
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx vitest run client/src/lib/transferFunction.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter `client/src/lib/transferFunction.ts`**

```ts
/**
 * Logique PURE de la fonction de transfert d'opacité (« fenêtrage 3D ») : modèle
 * de points {value: HU, opacity: 0..1}, normalisation, et (dé)sérialisation des
 * presets perso pour localStorage. Sans DOM ni VTK → testable.
 */

export interface OpacityPoint {
  /** Valeur scalaire (HU pour un CT). */
  value: number;
  /** Opacité [0..1]. */
  opacity: number;
}

export interface TfPreset {
  name: string;
  points: OpacityPoint[];
}

/** Borne l'opacité dans [0,1] ; entrée non finie → 0. */
export function clampOpacity(o: number): number {
  if (!Number.isFinite(o)) return 0;
  return Math.min(1, Math.max(0, o));
}

/** Trie par `value` croissante, borne l'opacité, retire les `value` non finies. */
export function normalizeOpacityPoints(
  points: readonly OpacityPoint[]
): OpacityPoint[] {
  return points
    .filter(p => Number.isFinite(p.value))
    .map(p => ({ value: p.value, opacity: clampOpacity(p.opacity) }))
    .sort((a, b) => a.value - b.value);
}

/** Rampe d'opacité linéaire 0→1 entre `loHU` et `hiHU` (2 points). */
export function defaultOpacityRamp(loHU: number, hiHU: number): OpacityPoint[] {
  return [
    { value: loHU, opacity: 0 },
    { value: hiHU, opacity: 1 },
  ];
}

export function serializePresets(presets: readonly TfPreset[]): string {
  return JSON.stringify(presets);
}

/** Parse des presets depuis localStorage ; toute entrée invalide → []. */
export function deserializePresets(json: string | null): TfPreset[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (p: any) => p && typeof p.name === "string" && Array.isArray(p.points)
      )
      .map((p: any) => ({
        name: p.name,
        points: normalizeOpacityPoints(p.points),
      }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4 : Vérifier le succès**

Run: `npx vitest run client/src/lib/transferFunction.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5 : Commit**

```bash
git add client/src/lib/transferFunction.ts client/src/lib/transferFunction.test.ts
git commit -m "feat(vr): module pur transferFunction (points opacite + presets)"
```

---

### Task 2 : Surcharger la scalar opacity dans `VolumeViewer`

**Files:**

- Modify: `client/src/components/VolumeViewer.tsx` (import, prop `opacityPoints`, effet d'override)

Intégration (la normalisation est testée en Task 1 ; ici tsc + visuel). On applique les points à l'opacité de l'acteur APRÈS le preset, best-effort.

- [ ] **Step 1 : Import** (près des autres imports `@/lib/...`) :

```ts
import {
  normalizeOpacityPoints,
  type OpacityPoint,
} from "@/lib/transferFunction";
```

- [ ] **Step 2 : Prop `opacityPoints`** — dans `VolumeViewerProps`, après `surfaceIso?: number;` :

```ts
  /** Mode "3d" : surcharge la courbe d'opacité (fenêtrage 3D). Vide = preset. */
  opacityPoints?: OpacityPoint[];
```

Et dans la déstructuration des props (près de `surfaceIso = 300,`) :

```ts
  opacityPoints,
```

- [ ] **Step 3 : Effet d'override** — ajoute, près des autres effets 3D (après l'effet de clipping) :

```ts
// Surcharge de la courbe d'opacité (éditeur de fonction de transfert) : après
// l'application du preset, on réécrit la scalar opacity de l'acteur volume à
// partir des points fournis. Vide → on laisse le preset. Best-effort.
const opacitySig = (opacityPoints ?? [])
  .map(p => `${p.value}:${p.opacity}`)
  .join("|");
useEffect(() => {
  if (mode !== "3d") return;
  const pts = normalizeOpacityPoints(opacityPoints ?? []);
  if (pts.length < 2) return;
  let raf = 0;
  const apply = () => {
    try {
      const vp = engineRef.current?.getViewport?.("VR_3D") as any;
      const actors = vp?.getActors?.();
      const actor =
        actors?.[0]?.actor ?? actors?.[0]?.volumeActor ?? actors?.[0];
      const property = actor?.getProperty?.();
      const ofun = property?.getScalarOpacity?.(0);
      if (!ofun?.addPoint) return;
      ofun.removeAllPoints?.();
      for (const p of pts) ofun.addPoint(p.value, p.opacity);
      vp.render?.();
    } catch {
      /* acteur pas prêt / API indispo — ignoré, ré-appliqué au prochain changement */
    }
  };
  // Laisse le preset s'appliquer d'abord (il peut être asynchrone), puis surcharge.
  raf = requestAnimationFrame(() => {
    raf = requestAnimationFrame(apply);
  });
  return () => {
    if (raf) cancelAnimationFrame(raf);
  };
}, [mode, preset3d, opacitySig]);
```

- [ ] **Step 4 : Typecheck**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 5 : Commit**

```bash
git add client/src/components/VolumeViewer.tsx
git commit -m "feat(vr): VolumeViewer surcharge la scalar opacity depuis opacityPoints"
```

---

### Task 3 : Composant `TransferFunctionEditor` + intégration `Viewer`

**Files:**

- Create: `client/src/components/TransferFunctionEditor.tsx`
- Modify: `client/src/pages/Viewer.tsx` (import, état `opacityPoints`, montage de l'éditeur dans le bloc 3D, passage du prop à `VolumeViewer`)

- [ ] **Step 1 : Créer `client/src/components/TransferFunctionEditor.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import {
  type OpacityPoint,
  type TfPreset,
  normalizeOpacityPoints,
  defaultOpacityRamp,
  serializePresets,
  deserializePresets,
} from "@/lib/transferFunction";

const LO = -1000;
const HI = 3000;
const W = 240;
const H = 96;
const HIT = 10; // rayon de capture d'un point (px)
const LS_KEY = "mediview.tfPresets";

function toX(value: number) {
  return ((value - LO) / (HI - LO)) * W;
}
function toY(opacity: number) {
  return H - opacity * H;
}
function fromX(x: number) {
  return LO + (Math.max(0, Math.min(W, x)) / W) * (HI - LO);
}
function fromY(y: number) {
  return Math.max(0, Math.min(1, 1 - y / H));
}

interface Props {
  points: OpacityPoint[];
  onChange: (points: OpacityPoint[]) => void;
}

/**
 * Éditeur canvas de la courbe d'opacité (« fenêtrage 3D ») : clic sur le fond =
 * ajout d'un point ; glisser = déplacer ; Maj+clic sur un point = supprimer.
 * Presets perso en localStorage. La couleur reste gérée par le preset clinique.
 */
export default function TransferFunctionEditor({ points, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<number | null>(null);
  const [presets, setPresets] = useState<TfPreset[]>([]);

  useEffect(() => {
    setPresets(deserializePresets(localStorage.getItem(LS_KEY)));
  }, []);

  // Dessin
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, W, H);
    const pts = normalizeOpacityPoints(points);
    // courbe
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = toX(p.value);
      const y = toY(p.opacity);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // points
    ctx.fillStyle = "#f1f5f9";
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(toX(p.value), toY(p.opacity), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [points]);

  const localPos = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitIndex = (x: number, y: number): number => {
    const pts = normalizeOpacityPoints(points);
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(toX(pts[i].value) - x, toY(pts[i].opacity) - y) <= HIT)
        return i;
    }
    return -1;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const { x, y } = localPos(e);
    const idx = hitIndex(x, y);
    const sorted = normalizeOpacityPoints(points);
    if (idx >= 0) {
      if (e.shiftKey) {
        // suppression (garder au moins 2 points)
        if (sorted.length > 2) {
          const next = sorted.filter((_, i) => i !== idx);
          onChange(next);
        }
        return;
      }
      dragRef.current = idx;
      return;
    }
    // ajout d'un point
    const next = normalizeOpacityPoints([
      ...sorted,
      { value: fromX(x), opacity: fromY(y) },
    ]);
    onChange(next);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (dragRef.current === null) return;
    const { x, y } = localPos(e);
    const sorted = normalizeOpacityPoints(points);
    const moved = sorted.map((p, i) =>
      i === dragRef.current ? { value: fromX(x), opacity: fromY(y) } : p
    );
    onChange(normalizeOpacityPoints(moved));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const savePreset = () => {
    const name = window.prompt("Nom du preset d'opacité ?")?.trim();
    if (!name) return;
    const next = [
      ...presets.filter(p => p.name !== name),
      { name, points: normalizeOpacityPoints(points) },
    ];
    setPresets(next);
    try {
      localStorage.setItem(LS_KEY, serializePresets(next));
    } catch {}
  };

  const loadPreset = (name: string) => {
    const p = presets.find(x => x.name === name);
    if (p) onChange(normalizeOpacityPoints(p.points));
  };

  return (
    <div className="flex flex-col gap-1">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="border border-border rounded cursor-crosshair"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        title="Clic = ajouter un point ; glisser = déplacer ; Maj+clic = supprimer"
      />
      <div className="flex items-center gap-1 text-[10px]">
        <button type="button" className="toolbar-btn" onClick={savePreset}>
          Enregistrer preset
        </button>
        <select
          className="bg-muted/40 border border-border rounded px-1 py-0.5"
          value=""
          onChange={e => e.target.value && loadPreset(e.target.value)}
        >
          <option value="">Mes presets…</option>
          {presets.map(p => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => onChange(defaultOpacityRamp(LO + 200, HI - 1800))}
          title="Réinitialiser la courbe (rampe par défaut)"
        >
          Réinit.
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2 : Intégrer dans `Viewer.tsx`** — import (haut du fichier) :

```ts
import TransferFunctionEditor from "@/components/TransferFunctionEditor";
import { type OpacityPoint } from "@/lib/transferFunction";
```

État (après `const [clipPlanes, setClipPlanes] = …`) :

```ts
const [opacityPoints, setOpacityPoints] = useState<OpacityPoint[]>([]);
```

Dans le bloc `{viewMode === "3d" && ( … )}` (après les contrôles de clipping), monter l'éditeur :

```tsx
<div className="border-l border-border pl-2 ml-1">
  <div className="text-[10px] mb-0.5">Opacité (fenêtrage 3D)</div>
  <TransferFunctionEditor points={opacityPoints} onChange={setOpacityPoints} />
</div>
```

Passer le prop à `<VolumeViewer … />` (près de `clipPlanes={clipPlanes}`) :

```tsx
opacityPoints = { opacityPoints };
```

- [ ] **Step 3 : Vérifs** — `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx tsc --noEmit && npm run build` → aucune erreur, build OK.

- [ ] **Step 4 : Non-régression** — `npx vitest run` → tous PASS (dont `transferFunction.test.ts`).

- [ ] **Step 5 : Commit**

```bash
git add client/src/components/TransferFunctionEditor.tsx client/src/pages/Viewer.tsx
git commit -m "feat(vr): editeur de courbe d'opacite (TF) + presets perso en mode 3D"
```

---

### Task 4 : PR + déploiement (clôture épopée 1a)

**Files:** aucun.

- [ ] **Step 1 : Pousser la branche SEULE**

```bash
git push origin HEAD:refs/heads/feat/vr-tf-editor
```

- [ ] **Step 2 : Créer la PR** (appel séparé)

```bash
gh pr create --base self-host --head feat/vr-tf-editor \
  --title "VR avancé 4/4 — éditeur de courbe d'opacité (fonction de transfert)" \
  --body "Dernier incrément de l'épopée VR avancé. Éditeur canvas de la courbe d'opacité (« fenêtrage 3D ») : clic = ajouter un point, glisser = déplacer, Maj+clic = supprimer ; application live à la scalar opacity du volume ; presets perso (localStorage) + réinit. Couleur = preset clinique (édition couleur reportée). Module pur testé (transferFunction). 100 % client, aucun serveur/PHI/migration. Clôt l'épopée 1a (turntable ✅, MIP/dalle déjà existant, clipping ✅, TF ✅)."
```

- [ ] **Step 3 : CI verte (gate verify → build) puis merge**

```bash
gh run watch "$(gh run list --branch self-host --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh pr merge <num> --merge --delete-branch=false
```

- [ ] **Step 4 : Déployer** (image GHCR `:<fullSHA>` du merge → `/docker/horos/docker-compose.yml`, `docker compose pull app && up -d app`), vérifier healthz 200 + garde 401 + image SHA, et **VÉRIF VISUELLE (importante — éditeur non itéré visuellement)** : mode 3D → l'éditeur s'affiche → ajouter/déplacer un point change l'opacité du rendu en direct → enregistrer/charger un preset fonctionne.

---

## Notes

- **Aucune migration DB, aucun changement serveur.** Tout est client.
- Plage HU de l'éditeur figée à [-1000, 3000] (CT) en v1 — suffisant pour le fenêtrage ; une plage adaptative au volume serait une amélioration ultérieure.
- **Édition de la couleur reportée** (la couleur vient du preset clinique). Incrément ultérieur si besoin.
- ⚠️ L'éditeur canvas n'a pas pu être itéré visuellement pendant le dev → **vérification visuelle au déploiement requise** (gérant).
