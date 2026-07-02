# VR avancé — Incrément 3 : plans de coupe interactifs (clipping) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter au mode 3D des **plans de coupe déplaçables par axe** (sagittal X / coronal Y / axial Z), en réutilisant la plomberie `vtkPlane`/`addClippingPlane` existante (aujourd'hui figée sur le scissor), pour « entrer » dans le volume.

**Architecture:** Module pur `lib/clipPlanes.ts` (origine/normale d'un plan par axe à partir des bounds + position [0..1] + inversion), branché dans l'effet de clipping existant de `VolumeViewer` (qui gère déjà `removeAllClippingPlanes` + scissor). Contrôles par axe (activer + position + inverser) dans `Viewer.tsx`. 100 % client, aucun serveur/PHI.

**Tech Stack:** React 19, Cornerstone3D (viewport `VR_3D`, `actor.getMapper().addClippingPlane`), VTK `@kitware/vtk.js/Common/DataModel/Plane`, Vitest.

**Spec :** `docs/superpowers/specs/2026-06-16-vr-avance-design.md` (incrément 3). **Hors scope de cet incrément** : plan **oblique** (reporté — la spec l'autorise) ; on livre les 3 axes orthogonaux.

---

### Task 1 : Module pur `clipPlanes.ts`

**Files:**

- Create: `client/src/lib/clipPlanes.ts`
- Test: `client/src/lib/clipPlanes.test.ts`

- [ ] **Step 1 : Test qui échoue**

```ts
import { describe, it, expect } from "vitest";
import {
  clampClipPosition,
  axisClipPlane,
  buildClipPlanes,
} from "./clipPlanes";

const B = [0, 10, 0, 20, 0, 30]; // xmin,xmax,ymin,ymax,zmin,zmax

describe("clampClipPosition", () => {
  it("borne dans [0,1] et gère NaN", () => {
    expect(clampClipPosition(1.5)).toBe(1);
    expect(clampClipPosition(-0.2)).toBe(0);
    expect(clampClipPosition(0.3)).toBeCloseTo(0.3, 6);
    expect(clampClipPosition(NaN)).toBe(0.5);
  });
});

describe("axisClipPlane", () => {
  it("X au milieu → origine x=5, normale +X ; inversion → -X", () => {
    const p = axisClipPlane(B, "x", 0.5, false);
    expect(p.origin).toEqual([5, 10, 15]);
    expect(p.normal).toEqual([1, 0, 0]);
    expect(axisClipPlane(B, "x", 0.5, true).normal).toEqual([-1, 0, 0]);
  });
  it("Z aux extrêmes → z=0 puis z=30", () => {
    expect(axisClipPlane(B, "z", 0, false).origin[2]).toBeCloseTo(0, 6);
    expect(axisClipPlane(B, "z", 1, false).origin[2]).toBeCloseTo(30, 6);
    expect(axisClipPlane(B, "z", 1, false).normal).toEqual([0, 0, 1]);
  });
  it("Y → normale sur l'axe Y", () => {
    expect(axisClipPlane(B, "y", 0.5, false).normal).toEqual([0, 1, 0]);
    expect(axisClipPlane(B, "y", 0.25, false).origin[1]).toBeCloseTo(5, 6);
  });
});

describe("buildClipPlanes", () => {
  it("ne garde que les plans activés ; bounds invalides → []", () => {
    const cfgs = [
      { axis: "x" as const, enabled: true, position: 0.5, invert: false },
      { axis: "y" as const, enabled: false, position: 0.5, invert: false },
      { axis: "z" as const, enabled: true, position: 0.2, invert: true },
    ];
    expect(buildClipPlanes(B, cfgs)).toHaveLength(2);
    expect(buildClipPlanes([1, 2, 3], cfgs)).toEqual([]);
    expect(buildClipPlanes(B, [])).toEqual([]);
  });
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx vitest run client/src/lib/clipPlanes.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter `client/src/lib/clipPlanes.ts`**

```ts
/**
 * Logique PURE des plans de coupe (clipping) du rendu 3D : à partir des bounds
 * du volume [xmin,xmax,ymin,ymax,zmin,zmax] et d'une position normalisée [0..1]
 * sur un axe, calcule l'origine + la normale d'un plan vtk. Sans DOM/VTK, testable.
 */

export type ClipAxis = "x" | "y" | "z";

export interface ClipPlaneConfig {
  axis: ClipAxis;
  enabled: boolean;
  /** Position le long de l'axe, normalisée [0..1]. */
  position: number;
  /** Inverse le demi-espace conservé. */
  invert: boolean;
}

export interface ClipPlaneSpec {
  origin: [number, number, number];
  normal: [number, number, number];
}

/** Borne une position de coupe dans [0,1] ; entrée invalide → 0.5 (milieu). */
export function clampClipPosition(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1, Math.max(0, p));
}

/**
 * Origine + normale d'un plan de coupe sur `axis`, à la position normalisée
 * `position01` de l'étendue du volume. La normale pointe vers le demi-espace
 * CONSERVÉ (vtk garde `normale·(x − origine) ≥ 0`) ; `invert` la retourne.
 */
export function axisClipPlane(
  bounds: readonly number[],
  axis: ClipAxis,
  position01: number,
  invert: boolean
): ClipPlaneSpec {
  const pos = clampClipPosition(position01);
  const idx = axis === "x" ? 0 : axis === "y" ? 2 : 4;
  const lo = bounds[idx];
  const hi = bounds[idx + 1];
  const w = lo + (hi - lo) * pos;
  const cx = (bounds[0] + bounds[1]) / 2;
  const cy = (bounds[2] + bounds[3]) / 2;
  const cz = (bounds[4] + bounds[5]) / 2;
  const origin: [number, number, number] =
    axis === "x" ? [w, cy, cz] : axis === "y" ? [cx, w, cz] : [cx, cy, w];
  const s = invert ? -1 : 1;
  const normal: [number, number, number] =
    axis === "x" ? [s, 0, 0] : axis === "y" ? [0, s, 0] : [0, 0, s];
  return { origin, normal };
}

/**
 * Construit les specs des plans ACTIVÉS. `bounds` invalide (< 6 valeurs) → [].
 */
export function buildClipPlanes(
  bounds: readonly number[] | null | undefined,
  configs: readonly ClipPlaneConfig[]
): ClipPlaneSpec[] {
  if (!bounds || bounds.length < 6) return [];
  return configs
    .filter(c => c.enabled)
    .map(c => axisClipPlane(bounds, c.axis, c.position, c.invert));
}
```

- [ ] **Step 4 : Vérifier le succès**

Run: `npx vitest run client/src/lib/clipPlanes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5 : Commit**

```bash
git add client/src/lib/clipPlanes.ts client/src/lib/clipPlanes.test.ts
git commit -m "feat(vr): module pur clipPlanes (origine/normale par axe)"
```

---

### Task 2 : Appliquer les plans interactifs dans `VolumeViewer`

**Files:**

- Modify: `client/src/components/VolumeViewer.tsx` (import, prop `clipPlanes`, extension de l'effet de clipping existant)

Intégration (la géométrie est testée en Task 1 ; ici tsc + visuel). On **étend l'effet de clipping existant** (celui du scissor, vers lignes 919-973) — il fait déjà `removeAllClippingPlanes()` + ajoute les plans-boîte du scissor ; on y ajoute les plans interactifs, dans la MÊME passe (sinon deux effets se battraient sur `removeAllClippingPlanes`).

- [ ] **Step 1 : Import** (en tête, près des autres imports `@/lib/...`) :

```ts
import { buildClipPlanes, type ClipPlaneConfig } from "@/lib/clipPlanes";
```

- [ ] **Step 2 : Prop `clipPlanes`** — dans l'interface `VolumeViewerProps`, après `cropFraction?: number;` :

```ts
  /** Mode "3d" : plans de coupe interactifs par axe (sagittal/coronal/axial). */
  clipPlanes?: ClipPlaneConfig[];
```

Et dans la déstructuration des props, après `cropFraction = 0,` :

```ts
  clipPlanes,
```

- [ ] **Step 3 : Étendre l'effet de clipping** — repère l'effet du scissor (commentaire « Scissor editing… », `useEffect(() => { if (mode !== "3d") return; … }, [cropFraction, mode, preset3d, surface3d]);`, vers lignes 919-973). Remplace son CORPS et ses deps comme suit (conserve la logique scissor, ajoute les plans interactifs ; récupère `b`/`vtkPlane` une seule fois) :

```ts
useEffect(() => {
  if (mode !== "3d") return;
  let cancelled = false;
  (async () => {
    try {
      const vp = engineRef.current?.getViewport?.("VR_3D") as any;
      const actors = vp?.getActors?.();
      if (!actors || !actors.length) return;
      const actor = actors[0]?.actor ?? actors[0]?.volumeActor ?? actors[0];
      const mapper = actor?.getMapper?.();
      if (!mapper) return;
      mapper.removeAllClippingPlanes?.();

      const b = actor.getBounds?.();
      const interactivePlanes = buildClipPlanes(b, clipPlanes ?? []);
      const needScissor = cropFraction > 0.01 && b && b.length >= 6;

      if (needScissor || interactivePlanes.length) {
        const vtkPlane = (
          await import("@kitware/vtk.js/Common/DataModel/Plane")
        ).default;
        if (cancelled) return;

        // Scissor (recadrage boîte centrale) — comportement existant inchangé.
        if (needScissor) {
          const cx = (b[0] + b[1]) / 2;
          const cy = (b[2] + b[3]) / 2;
          const cz = (b[4] + b[5]) / 2;
          const f = Math.min(0.9, cropFraction);
          const hx = ((b[1] - b[0]) / 2) * (1 - f);
          const hy = ((b[3] - b[2]) / 2) * (1 - f);
          const hz = ((b[5] - b[4]) / 2) * (1 - f);
          const box = [
            { o: [cx - hx, cy, cz], n: [1, 0, 0] },
            { o: [cx + hx, cy, cz], n: [-1, 0, 0] },
            { o: [cx, cy - hy, cz], n: [0, 1, 0] },
            { o: [cx, cy + hy, cz], n: [0, -1, 0] },
            { o: [cx, cy, cz - hz], n: [0, 0, 1] },
            { o: [cx, cy, cz + hz], n: [0, 0, -1] },
          ];
          for (const p of box) {
            const pl = vtkPlane.newInstance();
            pl.setOrigin(p.o as any);
            pl.setNormal(p.n as any);
            mapper.addClippingPlane?.(pl);
          }
        }

        // Plans de coupe interactifs par axe (nouveau).
        for (const c of interactivePlanes) {
          const pl = vtkPlane.newInstance();
          pl.setOrigin(c.origin as any);
          pl.setNormal(c.normal as any);
          mapper.addClippingPlane?.(pl);
        }
      }
      vp.render?.();
    } catch {
      /* clipping indisponible — rendu inchangé */
    }
  })();
  return () => {
    cancelled = true;
  };
}, [cropFraction, mode, preset3d, surface3d, clipSig]);
```

- [ ] **Step 4 : Ajouter la signature `clipSig`** — juste AVANT cet effet (dans le corps du composant), pour que l'effet se relance quand la config change sans dépendre de l'identité du tableau :

```ts
const clipSig = (clipPlanes ?? [])
  .map(c => `${c.axis}:${c.enabled ? 1 : 0}:${c.position}:${c.invert ? 1 : 0}`)
  .join("|");
```

- [ ] **Step 5 : Typecheck**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 6 : Commit**

```bash
git add client/src/components/VolumeViewer.tsx
git commit -m "feat(vr): plans de coupe interactifs appliques dans VolumeViewer"
```

---

### Task 3 : Contrôles de clipping dans `Viewer.tsx`

**Files:**

- Modify: `client/src/pages/Viewer.tsx` (import type, état `clipPlanes`, contrôles dans le bloc 3D, passage du prop)

- [ ] **Step 1 : Import du type** (près de l'import `SlabMode` depuis `@/lib/slabBlend`) :

```ts
import type { ClipPlaneConfig, ClipAxis } from "@/lib/clipPlanes";
```

- [ ] **Step 2 : État** — près des autres états 3D (après `const [turntableNonce, setTurntableNonce] = useState(0);`) :

```ts
const [clipPlanes, setClipPlanes] = useState<ClipPlaneConfig[]>([
  { axis: "x", enabled: false, position: 0.5, invert: false },
  { axis: "y", enabled: false, position: 0.5, invert: false },
  { axis: "z", enabled: false, position: 0.5, invert: false },
]);
const updateClip = (axis: ClipAxis, patch: Partial<ClipPlaneConfig>) =>
  setClipPlanes(prev =>
    prev.map(c => (c.axis === axis ? { ...c, ...patch } : c))
  );
const CLIP_LABELS: Record<ClipAxis, string> = {
  x: "Sagittal",
  y: "Coronal",
  z: "Axial",
};
```

- [ ] **Step 3 : Contrôles dans le bloc 3D** — dans `{viewMode === "3d" && ( … )}` (après le bouton « Exporter rotation »), insérer :

```tsx
<div className="flex flex-col gap-1 border-l border-border pl-2 ml-1">
  {clipPlanes.map(c => (
    <div key={c.axis} className="flex items-center gap-1">
      <label className="flex items-center gap-1 text-[10px] w-16">
        <input
          type="checkbox"
          checked={c.enabled}
          onChange={e => updateClip(c.axis, { enabled: e.target.checked })}
        />
        {CLIP_LABELS[c.axis]}
      </label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={c.position}
        disabled={!c.enabled}
        onChange={e => updateClip(c.axis, { position: Number(e.target.value) })}
        title="Position du plan de coupe"
      />
      <label className="flex items-center gap-0.5 text-[9px]">
        <input
          type="checkbox"
          checked={c.invert}
          disabled={!c.enabled}
          onChange={e => updateClip(c.axis, { invert: e.target.checked })}
        />
        inv.
      </label>
    </div>
  ))}
</div>
```

(Adapter classes/conteneur au style local des contrôles 3D voisins si besoin.)

- [ ] **Step 4 : Passer le prop** — dans `<VolumeViewer … />` (près de `turntableNonce={turntableNonce}`) :

```tsx
clipPlanes = { clipPlanes };
```

- [ ] **Step 5 : Vérifs** : `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx tsc --noEmit && npm run build` → aucune erreur, build OK.

- [ ] **Step 6 : Non-régression** : `npx vitest run` → tous PASS (dont `clipPlanes.test.ts`).

- [ ] **Step 7 : Commit**

```bash
git add client/src/pages/Viewer.tsx
git commit -m "feat(vr): controles de plans de coupe interactifs en mode 3D"
```

---

### Task 4 : PR + déploiement

**Files:** aucun.

- [ ] **Step 1 : Pousser la branche SEULE**

```bash
git push origin HEAD:refs/heads/feat/vr-clipping
```

- [ ] **Step 2 : Créer la PR** (appel séparé)

```bash
gh pr create --base self-host --head feat/vr-clipping \
  --title "VR avancé 3/4 — plans de coupe interactifs (clipping)" \
  --body "Incrément 3 de l'épopée VR avancé. Plans de coupe déplaçables par axe (sagittal/coronal/axial) en mode 3D : case activer + slider position + inversion, par axe. Réutilise la plomberie vtkPlane/addClippingPlane existante (étend l'effet de clipping du scissor, sans le casser). Module pur testé (clipPlanes). Oblique reporté. 100 % client, aucun serveur/PHI/migration. (Incrément 2 MIP/MinIP+dalle déjà présent en MPR → sauté.)"
```

- [ ] **Step 3 : CI verte (gate verify → build) puis merge**

```bash
gh run watch "$(gh run list --branch self-host --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh pr merge <num> --merge --delete-branch=false
```

- [ ] **Step 4 : Déployer** (image GHCR `:<fullSHA>` du merge → `/docker/horos/docker-compose.yml`, `docker compose pull app && up -d app`), vérifier healthz 200 + garde 401 + image SHA, et **vérif visuelle** : mode 3D → activer un axe → le volume se coupe ; slider déplace le plan ; « inv. » inverse le côté conservé.

---

## Notes

- **Aucune migration DB, aucun changement serveur.** Tout est client.
- L'incrément réutilise la plomberie de clipping existante : risque faible, le scissor reste fonctionnel (mêmes plans-boîte, dans la même passe).
- **Oblique** reporté (hors scope) — la spec l'autorise ; à faire dans un incrément ultérieur si besoin.
