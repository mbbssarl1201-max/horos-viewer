# Plan de coupe oblique (clipping 3D) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps en `- [ ]`.

**Goal:** Ajouter un plan de coupe oblique (azimut/élévation/position/invert) au clipping 3D, en réutilisant la passe de clipping existante.

**Architecture:** fonctions pures dans `clipPlanes.ts` (`obliqueClipPlane`, `buildObliqueClipPlane`) ; `VolumeViewer` reçoit une prop `obliqueClip` et l'ajoute dans sa passe de clipping ; `Viewer` ajoute l'état + l'UI (sliders) et la passe au viewer. 100% client, additif, aucune migration.

**Tech Stack:** React 19, VTK.js (via Cornerstone3D), TypeScript, Vitest.

**Branche :** `feat/oblique-clip-plane` (déjà créée depuis `self-host`).

---

### Task 1 : fonctions pures `obliqueClipPlane` + `buildObliqueClipPlane`

**Files:** Modify `client/src/lib/clipPlanes.ts` ; Modify `client/src/lib/clipPlanes.test.ts` (créer si absent)

- [ ] **Step 1 : tests (échec attendu)**

```typescript
// client/src/lib/clipPlanes.test.ts — AJOUTER
import { obliqueClipPlane, buildObliqueClipPlane } from "./clipPlanes";

describe("obliqueClipPlane", () => {
  const B = [0, 10, 0, 10, 0, 10]; // cube 10, centre (5,5,5)
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  it("az=0 el=0 → normale +X", () => {
    const p = obliqueClipPlane(B, 0, 0, 0.5, false);
    expect(
      near(p.normal[0], 1) && near(p.normal[1], 0) && near(p.normal[2], 0)
    ).toBe(true);
  });
  it("az=90 el=0 → normale +Y", () => {
    const p = obliqueClipPlane(B, 90, 0, 0.5, false);
    expect(
      near(p.normal[0], 0) && near(p.normal[1], 1) && near(p.normal[2], 0)
    ).toBe(true);
  });
  it("el=90 → normale +Z", () => {
    const p = obliqueClipPlane(B, 0, 90, 0.5, false);
    expect(near(p.normal[2], 1)).toBe(true);
  });
  it("invert → normale opposée", () => {
    const p = obliqueClipPlane(B, 0, 0, 0.5, true);
    expect(near(p.normal[0], -1)).toBe(true);
  });
  it("position 0.5 → origine au centre", () => {
    const p = obliqueClipPlane(B, 0, 0, 0.5, false);
    expect(
      near(p.origin[0], 5) && near(p.origin[1], 5) && near(p.origin[2], 5)
    ).toBe(true);
  });
});

describe("buildObliqueClipPlane", () => {
  it("désactivé → null", () => {
    expect(
      buildObliqueClipPlane([0, 10, 0, 10, 0, 10], {
        enabled: false,
        azimuthDeg: 0,
        elevationDeg: 0,
        position: 0.5,
        invert: false,
      })
    ).toBeNull();
  });
  it("bounds invalides → null", () => {
    expect(
      buildObliqueClipPlane([0, 1], {
        enabled: true,
        azimuthDeg: 0,
        elevationDeg: 0,
        position: 0.5,
        invert: false,
      })
    ).toBeNull();
  });
  it("activé + bounds OK → spec non nulle", () => {
    expect(
      buildObliqueClipPlane([0, 10, 0, 10, 0, 10], {
        enabled: true,
        azimuthDeg: 30,
        elevationDeg: 20,
        position: 0.5,
        invert: false,
      })
    ).not.toBeNull();
  });
});
```

- [ ] **Step 2 : lancer (échec)** — `pnpm exec vitest run client/src/lib/clipPlanes.test.ts`

- [ ] **Step 3 : implémenter (ajouter à `clipPlanes.ts`)**

```typescript
export interface ObliqueClipConfig {
  enabled: boolean;
  /** Azimut autour de Z, en degrés [0..360). */
  azimuthDeg: number;
  /** Élévation, en degrés [-90..90]. */
  elevationDeg: number;
  /** Position le long de la normale, normalisée [0..1]. */
  position: number;
  invert: boolean;
}

/**
 * Plan de coupe OBLIQUE : normale dérivée des angles sphériques (azimut/élévation),
 * origine = centre du volume décalé le long de la normale par `position01`. PUR.
 */
export function obliqueClipPlane(
  bounds: readonly number[],
  azimuthDeg: number,
  elevationDeg: number,
  position01: number,
  invert: boolean
): ClipPlaneSpec {
  const az = ((azimuthDeg % 360) * Math.PI) / 180;
  const el = (Math.min(90, Math.max(-90, elevationDeg)) * Math.PI) / 180;
  const s = invert ? -1 : 1;
  const normal: [number, number, number] = [
    s * Math.cos(el) * Math.cos(az),
    s * Math.cos(el) * Math.sin(az),
    s * Math.sin(el),
  ];
  const cx = (bounds[0] + bounds[1]) / 2;
  const cy = (bounds[2] + bounds[3]) / 2;
  const cz = (bounds[4] + bounds[5]) / 2;
  const dx = bounds[1] - bounds[0];
  const dy = bounds[3] - bounds[2];
  const dz = bounds[5] - bounds[4];
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const t = (clampClipPosition(position01) - 0.5) * diag;
  const origin: [number, number, number] = [
    cx + normal[0] * t,
    cy + normal[1] * t,
    cz + normal[2] * t,
  ];
  return { origin, normal };
}

/** Spec du plan oblique si activé et bounds valides, sinon null. PUR. */
export function buildObliqueClipPlane(
  bounds: readonly number[] | null | undefined,
  config: ObliqueClipConfig
): ClipPlaneSpec | null {
  if (!config.enabled || !bounds || bounds.length < 6) return null;
  return obliqueClipPlane(
    bounds,
    config.azimuthDeg,
    config.elevationDeg,
    config.position,
    config.invert
  );
}
```

- [ ] **Step 4 : lancer (succès)** — `pnpm exec vitest run client/src/lib/clipPlanes.test.ts`
- [ ] **Step 5 : commit** — `git add client/src/lib/clipPlanes.ts client/src/lib/clipPlanes.test.ts && git commit -m "feat(viewer): obliqueClipPlane + buildObliqueClipPlane (purs)"`

---

### Task 2 : `VolumeViewer` applique le plan oblique

**Files:** Modify `client/src/components/VolumeViewer.tsx`

- [ ] **Step 1 : prop + import**

Import : `import { buildClipPlanes, buildObliqueClipPlane, type ClipPlaneConfig, type ObliqueClipConfig } from "@/lib/clipPlanes";`.
Ajouter la prop `obliqueClip?: ObliqueClipConfig;` (à côté de `clipPlanes?`), et la destructurer.

- [ ] **Step 2 : inclure dans la signature de re-application**

Là où `clipSig` est calculé (≈ l.1069), ajouter l'oblique pour que le changement déclenche la re-passe :

```typescript
const clipSig =
  (clipPlanes ?? [])
    .map(c => `${c.axis}${c.enabled ? 1 : 0}${c.position}${c.invert ? 1 : 0}`)
    .join("|") +
  "|ob:" +
  (obliqueClip && obliqueClip.enabled
    ? `1${obliqueClip.azimuthDeg}_${obliqueClip.elevationDeg}_${obliqueClip.position}_${obliqueClip.invert ? 1 : 0}`
    : "0");
```

(adapter à la forme exacte du `clipSig` existant — l'objectif : la chaîne change quand l'oblique change.)

- [ ] **Step 3 : ajouter le plan oblique dans la passe de clipping**

Dans la passe (après la boucle qui ajoute les `interactivePlanes` par axe, avant le `render`), ajouter :

```typescript
const ob = buildObliqueClipPlane(
  b,
  obliqueClip ?? {
    enabled: false,
    azimuthDeg: 0,
    elevationDeg: 0,
    position: 0.5,
    invert: false,
  }
);
if (ob) {
  const pl = vtkPlane.newInstance();
  pl.setOrigin(ob.origin);
  pl.setNormal(ob.normal);
  mapper.addClippingPlane?.(pl);
}
```

(réutiliser la même réf `vtkPlane` et le même `mapper` que la boucle par axe ; rester DANS la passe unique `removeAllClippingPlanes` existante.)

- [ ] **Step 4 : ajouter `obliqueClip` aux deps de l'effet de clipping** (là où `clipSig` est en deps).

- [ ] **Step 5 : compilation** — `pnpm check` (PASS). Vérifier que le clipping par axe marche toujours.
- [ ] **Step 6 : commit** — `git add client/src/components/VolumeViewer.tsx && git commit -m "feat(viewer): VolumeViewer applique le plan de coupe oblique"`

---

### Task 3 : UI oblique dans `Viewer`

**Files:** Modify `client/src/pages/Viewer.tsx`

- [ ] **Step 1 : import + état**

Import : ajouter `type ObliqueClipConfig` à l'import depuis `@/lib/clipPlanes`. Après l'état `clipPlanes` (≈ l.375) :

```typescript
const [obliqueClip, setObliqueClip] = useState<ObliqueClipConfig>({
  enabled: false,
  azimuthDeg: 0,
  elevationDeg: 0,
  position: 0.5,
  invert: false,
});
const updateOblique = (patch: Partial<ObliqueClipConfig>) =>
  setObliqueClip(prev => ({ ...prev, ...patch }));
```

- [ ] **Step 2 : passer la prop au VolumeViewer 3D**

Là où `<VolumeViewer ... clipPlanes={clipPlanes} ... />` est monté (mode 3D), ajouter `obliqueClip={obliqueClip}`.

- [ ] **Step 3 : UI dans le bloc clipping** (après le `clipPlanes.map(...)`, ≈ l.2470, dans le même conteneur)

```tsx
{
  /* Plan de coupe oblique */
}
<div className="flex items-center gap-1 border-t border-border pt-1 mt-1 flex-wrap">
  <label className="flex items-center gap-1 text-[10px] w-16">
    <input
      type="checkbox"
      checked={obliqueClip.enabled}
      onChange={e => updateOblique({ enabled: e.target.checked })}
      className="accent-primary"
    />
    Oblique
  </label>
  <label className="text-[9px] flex items-center gap-0.5">
    Az
    <input
      type="range"
      min={0}
      max={360}
      step={1}
      value={obliqueClip.azimuthDeg}
      disabled={!obliqueClip.enabled}
      onChange={e => updateOblique({ azimuthDeg: Number(e.target.value) })}
      title="Azimut (°)"
    />
  </label>
  <label className="text-[9px] flex items-center gap-0.5">
    Él
    <input
      type="range"
      min={-90}
      max={90}
      step={1}
      value={obliqueClip.elevationDeg}
      disabled={!obliqueClip.enabled}
      onChange={e => updateOblique({ elevationDeg: Number(e.target.value) })}
      title="Élévation (°)"
    />
  </label>
  <input
    type="range"
    min={0}
    max={1}
    step={0.01}
    value={obliqueClip.position}
    disabled={!obliqueClip.enabled}
    onChange={e => updateOblique({ position: Number(e.target.value) })}
    title="Position du plan oblique"
  />
  <label className="flex items-center gap-0.5 text-[9px]">
    <input
      type="checkbox"
      checked={obliqueClip.invert}
      disabled={!obliqueClip.enabled}
      onChange={e => updateOblique({ invert: e.target.checked })}
      className="accent-primary"
    />
    Inv
  </label>
</div>;
```

- [ ] **Step 4 : compilation** — `pnpm check` (PASS).
- [ ] **Step 5 : commit** — `git add client/src/pages/Viewer.tsx && git commit -m "feat(viewer): ui plan de coupe oblique (azimut/élévation/position/invert)"`

---

### Task 4 : vérification + déploiement

- [ ] **Step 1** — `pnpm check && pnpm exec vitest run` → tout vert.
- [ ] **Step 2** — `git push -u origin feat/oblique-clip-plane` ; puis (séparé) `gh pr create --base self-host ...`.
- [ ] **Step 3** — `gh run watch <id> --exit-status` (gate verify+build) ; `gh pr merge <num> --merge --delete-branch`.
- [ ] **Step 4** — déployer le SHA de merge (`/docker/horos` : sed image → pull → `up -d migrate` (no-op) → `up -d app`).
- [ ] **Step 5** — ping : healthz 200, garde 401, bonne image.
- [ ] **Step 6** — mémoire : `mediview-vr-avance.md` + `mediview-horos-parity.md` (oblique déployé) + index `MEMORY.md`.

---

## Notes

- Additif : les 3 plans par axe restent inchangés, l'oblique entre dans la même passe `removeAllClippingPlanes`.
- 100% client, aucune migration, aucun PHI. v1 : contrôle par sliders (pas de gizmo souris).
