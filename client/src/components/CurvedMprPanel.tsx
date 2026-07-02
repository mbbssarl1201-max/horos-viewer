import { useCallback, useEffect, useRef, useState } from "react";
import { buildCprImage, cprImageToRgba, type Vec3 } from "@/lib/curvedMpr";

/**
 * CurvedMprPanel — Curved MPR (CPR), plans axial / sagittal / coronal.
 *
 * Le panneau est AUTONOME et FAIL-SAFE : il ne touche pas aux viewports MPR
 * existants. Il lit le volume scalaire depuis le cache Cornerstone (HOROS_VOL),
 * affiche une coupe de référence dans le plan choisi, et laisse l'utilisateur
 * poser une polyligne (centerline) en cliquant. L'image CPR étirée (stretched)
 * est calculée en pur JS et rendue sur un canvas.
 *
 * Planes supportés :
 *   axial    — coupe Z (nx × ny), planeNormal [0,0,1]
 *   sagittal — coupe X (ny × nz), planeNormal [1,0,0]
 *   coronal  — coupe Y (nx × nz), planeNormal [0,1,0]
 */

const VOL_ID = "cornerstoneStreamingImageVolume:HOROS_VOL";

type Plane = "axial" | "sagittal" | "coronal";

interface VolumeData {
  scalars: ArrayLike<number>;
  dims: Vec3;
  origin: Vec3;
  spacing: Vec3;
}

/** WW/WC par défaut — fenêtre os/tissu mou. */
const REF_WC = 40;
const REF_WW = 400;

/** Dimensions du canvas de référence selon le plan. */
function planeDims(
  dims: Vec3,
  plane: Plane
): { cw: number; ch: number; maxSlice: number } {
  const [nx, ny, nz] = dims;
  if (plane === "axial") return { cw: nx, ch: ny, maxSlice: nz - 1 };
  if (plane === "sagittal") return { cw: ny, ch: nz, maxSlice: nx - 1 };
  return { cw: nx, ch: nz, maxSlice: ny - 1 };
}

/** Normale de plan par axe. */
const PLANE_NORMAL: Record<Plane, Vec3> = {
  axial: [0, 0, 1],
  sagittal: [1, 0, 0],
  coronal: [0, 1, 0],
};

/** Renvoie la valeur HU d'un voxel (ix, iy, iz) depuis le tableau scalaire. */
function hu(
  scalars: ArrayLike<number>,
  dims: Vec3,
  ix: number,
  iy: number,
  iz: number
): number {
  const [nx, ny, nz] = dims;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz)
    return -1000;
  return scalars[
    Math.round(ix) + Math.round(iy) * nx + Math.round(iz) * nx * ny
  ] as number;
}

/** Dessine la coupe de référence sur le canvas. */
function drawSlice(
  canvas: HTMLCanvasElement,
  vol: VolumeData,
  plane: Plane,
  slice: number
) {
  const { cw, ch } = planeDims(vol.dims, plane);
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(cw, ch);
  const low = REF_WC - REF_WW / 2;
  const [nx, ny] = vol.dims;

  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let ix = 0,
        iy = 0,
        iz = 0;
      if (plane === "axial") {
        ix = cx;
        iy = cy;
        iz = slice;
      } else if (plane === "sagittal") {
        ix = slice;
        iy = cx;
        iz = cy;
      } else {
        ix = cx;
        iy = slice;
        iz = cy;
      }

      let g = ((hu(vol.scalars, vol.dims, ix, iy, iz) - low) / REF_WW) * 255;
      if (g < 0) g = 0;
      else if (g > 255) g = 255;
      const o = (cy * cw + cx) * 4;
      img.data[o] = g;
      img.data[o + 1] = g;
      img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Canvas click → point monde (mm) selon le plan. */
function clickToWorld(
  cx: number,
  cy: number,
  canvasW: number,
  canvasH: number,
  vol: VolumeData,
  plane: Plane,
  slice: number
): Vec3 {
  const [nx, ny] = vol.dims;
  const { cw, ch } = planeDims(vol.dims, plane);
  // Position fractionnelle sur le canvas → index voxel.
  const fx = (cx / canvasW) * cw;
  const fy = (cy / canvasH) * ch;

  let ix = 0,
    iy = 0,
    iz = 0;
  if (plane === "axial") {
    ix = fx;
    iy = fy;
    iz = slice;
  } else if (plane === "sagittal") {
    ix = slice;
    iy = fx;
    iz = fy;
  } else {
    ix = fx;
    iy = slice;
    iz = fy;
  }

  return [
    vol.origin[0] + ix * vol.spacing[0],
    vol.origin[1] + iy * vol.spacing[1],
    vol.origin[2] + iz * vol.spacing[2],
  ];
}

export default function CurvedMprPanel({ onClose }: { onClose: () => void }) {
  const [vol, setVol] = useState<VolumeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plane, setPlane] = useState<Plane>("axial");
  const [slice, setSlice] = useState(0);
  const [points, setPoints] = useState<Vec3[]>([]);
  const [wc, setWc] = useState(REF_WC);
  const [ww, setWw] = useState(REF_WW);
  const refCanvasRef = useRef<HTMLCanvasElement>(null);
  const cprCanvasRef = useRef<HTMLCanvasElement>(null);

  // Charge le volume depuis le cache Cornerstone.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cs: any = await import("@cornerstonejs/core");
        const volume = cs.cache?.getVolume?.(VOL_ID);
        if (!volume) {
          if (!cancelled)
            setError("Volume non chargé (ouvrez le MPR d'abord).");
          return;
        }
        const vm = volume.voxelManager;
        let scalars: ArrayLike<number> | undefined;
        for (const getter of [
          () => vm?.getCompleteScalarDataArray?.(),
          () => vm?.getScalarData?.(),
          () => volume.getScalarData?.(),
        ]) {
          try {
            const s = getter();
            if (s && (s as any).length > 0) {
              scalars = s;
              break;
            }
          } catch {
            /* méthode suivante */
          }
        }
        if (!scalars) {
          if (!cancelled) setError("Données du volume indisponibles.");
          return;
        }
        const dims = volume.dimensions as Vec3;
        if (!cancelled) {
          setVol({
            scalars,
            dims,
            origin: volume.origin as Vec3,
            spacing: volume.spacing as Vec3,
          });
          setSlice(Math.floor(dims[2] / 2));
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Échec chargement volume.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Centrage de la coupe lors du changement de plan.
  useEffect(() => {
    if (!vol) return;
    const { maxSlice } = planeDims(vol.dims, plane);
    setSlice(Math.floor(maxSlice / 2));
    setPoints([]);
  }, [plane, vol]);

  // Rendu de la coupe de référence.
  useEffect(() => {
    const canvas = refCanvasRef.current;
    if (!canvas || !vol) return;
    try {
      drawSlice(canvas, vol, plane, slice);
    } catch {
      /* non critique */
    }
  }, [vol, plane, slice]);

  // Superposition des points de la centerline sur le canvas de référence.
  useEffect(() => {
    const canvas = refCanvasRef.current;
    if (!canvas || !vol || points.length === 0) return;
    try {
      const { cw, ch } = planeDims(vol.dims, plane);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Redessine la coupe puis superpose les points (évite d'avoir besoin d'un canvas overlay).
      drawSlice(canvas, vol, plane, slice);
      ctx.strokeStyle = "#00e5ff";
      ctx.fillStyle = "#00e5ff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        let fx = 0,
          fy = 0;
        if (plane === "axial") {
          fx = (pt[0] - vol.origin[0]) / vol.spacing[0];
          fy = (pt[1] - vol.origin[1]) / vol.spacing[1];
        } else if (plane === "sagittal") {
          fx = (pt[1] - vol.origin[1]) / vol.spacing[1];
          fy = (pt[2] - vol.origin[2]) / vol.spacing[2];
        } else {
          fx = (pt[0] - vol.origin[0]) / vol.spacing[0];
          fy = (pt[2] - vol.origin[2]) / vol.spacing[2];
        }
        // Coordonnées canvas (canvas est dimensionné en voxels, affiché via CSS).
        const px = (fx / cw) * canvas.width;
        const py = (fy / ch) * canvas.height;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.moveTo(px, py);
      }
      ctx.stroke();
    } catch {
      /* overlay non critique */
    }
  }, [points, vol, plane, slice]);

  const handleRefClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = refCanvasRef.current;
      if (!canvas || !vol) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const wp = clickToWorld(
        cx,
        cy,
        rect.width,
        rect.height,
        vol,
        plane,
        slice
      );
      setPoints(prev => [...prev, wp]);
    },
    [vol, plane, slice]
  );

  const renderCpr = useCallback(() => {
    const canvas = cprCanvasRef.current;
    if (!canvas || !vol) return;
    if (points.length < 2) {
      setError("Posez au moins 2 points sur la coupe de référence.");
      return;
    }
    setError(null);
    try {
      const cpr = buildCprImage(
        vol.scalars,
        vol.dims,
        vol.origin,
        vol.spacing,
        points,
        {
          stepMm: Math.min(...vol.spacing) || 1,
          halfWidthMm: 25,
          planeNormal: PLANE_NORMAL[plane],
        }
      );
      if (cpr.width === 0 || cpr.height === 0) {
        setError("CPR vide (courbe trop courte).");
        return;
      }
      canvas.width = cpr.width;
      canvas.height = cpr.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rgba = cprImageToRgba(cpr, wc, ww);
      const imageData = ctx.createImageData(cpr.width, cpr.height);
      imageData.data.set(rgba);
      ctx.putImageData(imageData, 0, 0);
    } catch (e: any) {
      setError(e?.message || "Échec du calcul CPR.");
    }
  }, [vol, points, plane, wc, ww]);

  const maxSlice = vol ? planeDims(vol.dims, plane).maxSlice : 0;

  return (
    <div className="absolute inset-0 z-40 bg-background/95 flex flex-col p-3 gap-2 overflow-auto">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Curved MPR — reformation curviligne
        </h3>
        <button
          className="text-xs px-2 py-1 rounded bg-secondary hover:bg-secondary/80"
          onClick={onClose}
        >
          Fermer
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Choisissez un plan de référence, naviguez dans les coupes, puis cliquez
        pour poser la centerline. « Générer » produit le CPR étiré (stretched).
      </p>

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {/* Sélection du plan + navigation coupe */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">Plan</span>
        {(["axial", "sagittal", "coronal"] as Plane[]).map(p => (
          <button
            key={p}
            className={`px-2 py-0.5 rounded capitalize ${
              plane === p
                ? "bg-primary text-primary-foreground"
                : "bg-secondary hover:bg-secondary/80"
            }`}
            onClick={() => setPlane(p)}
          >
            {p}
          </button>
        ))}
        <span className="text-muted-foreground ml-2">Coupe</span>
        <input
          type="range"
          min={0}
          max={maxSlice}
          value={slice}
          onChange={e => {
            setSlice(Number(e.target.value));
            setPoints([]);
          }}
          disabled={!vol}
          className="w-24"
        />
        <span className="w-14 tabular-nums">
          {slice + 1}/{maxSlice + 1}
        </span>
      </div>

      {/* Fenêtrage CPR */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">WC</span>
        <input
          type="number"
          value={wc}
          onChange={e => setWc(Number(e.target.value))}
          className="w-16 text-center bg-secondary rounded px-1 py-0.5"
        />
        <span className="text-muted-foreground">WW</span>
        <input
          type="number"
          value={ww}
          onChange={e => setWw(Number(e.target.value))}
          className="w-16 text-center bg-secondary rounded px-1 py-0.5"
        />
        <button
          className="px-2 py-0.5 rounded bg-secondary hover:bg-secondary/80 disabled:opacity-40"
          onClick={() => setPoints([])}
          disabled={points.length === 0}
        >
          Effacer ({points.length} pt)
        </button>
        <button
          className="px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          onClick={renderCpr}
          disabled={!vol || points.length < 2}
        >
          Générer CPR
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div>
          <div className="text-[10px] text-muted-foreground mb-1">
            Coupe {plane} — cliquez pour tracer la courbe
          </div>
          <canvas
            ref={refCanvasRef}
            onClick={handleRefClick}
            className="border border-border cursor-crosshair bg-black block"
            style={{ width: 320, height: 320, imageRendering: "pixelated" }}
          />
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground mb-1">
            CPR étiré (stretched)
          </div>
          <canvas
            ref={cprCanvasRef}
            className="border border-border bg-black block"
            style={{ maxWidth: 600, imageRendering: "pixelated" }}
          />
        </div>
      </div>
    </div>
  );
}
