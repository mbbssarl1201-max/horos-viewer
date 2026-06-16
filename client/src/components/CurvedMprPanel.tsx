import { useCallback, useEffect, useRef, useState } from "react";
import { buildCprImage, cprImageToRgba, type Vec3 } from "@/lib/curvedMpr";

/**
 * CurvedMprPanel — Curved MPR (CPR) BASIQUE, version « bêta ».
 *
 * Panneau AUTONOME et FAIL-SAFE : il NE touche PAS aux viewports MPR existants.
 * Il lit le volume scalaire déjà en cache (HOROS_VOL, chargé par VolumeViewer),
 * affiche une coupe axiale de référence sur laquelle l'utilisateur clique pour
 * poser une polyligne (centerline), puis échantillonne le volume le long de
 * cette courbe (logique pure `buildCprImage`) pour produire l'image « déroulée »
 * (stretched CPR) rendue sur un canvas.
 *
 * Tout est encadré try/catch : un échec affiche un message, jamais une exception
 * qui casserait le visualiseur. Si le volume n'est pas (encore) chargé, le
 * panneau l'indique.
 *
 * LIMITATIONS (bêta) :
 *   • Coupe de référence = une coupe axiale (plan z), centerline dans ce plan.
 *   • Suppose un volume axis-aligned (cohérent avec objExport / export OBJ).
 *   • Stretched CPR 2D (pas de déroulé volumique 3D).
 */

const VOL_ID = "cornerstoneStreamingImageVolume:HOROS_VOL";

interface VolumeData {
  scalars: ArrayLike<number>;
  dims: Vec3;
  origin: Vec3;
  spacing: Vec3;
}

/** WW/WC os par défaut pour la coupe de référence et le CPR (lisible sur CT). */
const REF_WC = 40;
const REF_WW = 400;

export default function CurvedMprPanel({ onClose }: { onClose: () => void }) {
  const [vol, setVol] = useState<VolumeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Coupe axiale de référence (index z), centrée par défaut.
  const [zSlice, setZSlice] = useState(0);
  // Points de la centerline en INDEX (ix, iy) sur la coupe affichée (z = zSlice).
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  const refCanvasRef = useRef<HTMLCanvasElement>(null);
  const cprCanvasRef = useRef<HTMLCanvasElement>(null);

  // Charge le volume scalaire depuis le cache Cornerstone (best-effort).
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
          if (!cancelled)
            setError("Données du volume indisponibles (réessayez).");
          return;
        }
        const dims = volume.dimensions as Vec3;
        const data: VolumeData = {
          scalars,
          dims,
          origin: volume.origin as Vec3,
          spacing: volume.spacing as Vec3,
        };
        if (!cancelled) {
          setVol(data);
          setZSlice(Math.floor(dims[2] / 2));
        }
      } catch (e: any) {
        if (!cancelled)
          setError(e?.message || "Échec du chargement du volume.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Dessine la coupe axiale de référence (z = zSlice) en niveaux de gris.
  useEffect(() => {
    const canvas = refCanvasRef.current;
    if (!canvas || !vol) return;
    try {
      const [nx, ny] = vol.dims;
      canvas.width = nx;
      canvas.height = ny;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const img = ctx.createImageData(nx, ny);
      const low = REF_WC - REF_WW / 2;
      const zOff = zSlice * nx * ny;
      for (let i = 0; i < nx * ny; i++) {
        let g = ((vol.scalars[zOff + i] - low) / REF_WW) * 255;
        if (g < 0) g = 0;
        else if (g > 255) g = 255;
        const o = i * 4;
        img.data[o] = g;
        img.data[o + 1] = g;
        img.data[o + 2] = g;
        img.data[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    } catch {
      /* rendu de référence non critique */
    }
  }, [vol, zSlice]);

  // Clic sur la coupe de référence → ajoute un point (en index voxel).
  const handleRefClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = refCanvasRef.current;
      if (!canvas || !vol) return;
      const rect = canvas.getBoundingClientRect();
      // Position en pixels canvas (= index voxel ix, iy car canvas = nx×ny).
      const x = ((e.clientX - rect.left) / rect.width) * vol.dims[0];
      const y = ((e.clientY - rect.top) / rect.height) * vol.dims[1];
      setPoints(prev => [...prev, { x, y }]);
    },
    [vol]
  );

  // Construit et affiche le CPR à partir des points posés.
  const renderCpr = useCallback(() => {
    const canvas = cprCanvasRef.current;
    if (!canvas || !vol) return;
    if (points.length < 2) {
      setError("Posez au moins 2 points sur la coupe de référence.");
      return;
    }
    setError(null);
    try {
      // Index (ix, iy, zSlice) → monde (mm), via origin + index*spacing.
      const worldPts: Vec3[] = points.map(p => [
        vol.origin[0] + p.x * vol.spacing[0],
        vol.origin[1] + p.y * vol.spacing[1],
        vol.origin[2] + zSlice * vol.spacing[2],
      ]);
      const cpr = buildCprImage(
        vol.scalars,
        vol.dims,
        vol.origin,
        vol.spacing,
        worldPts,
        {
          stepMm: Math.min(...vol.spacing) || 1,
          halfWidthMm: 20,
          planeNormal: [0, 0, 1],
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
      const rgba = cprImageToRgba(cpr, REF_WC, REF_WW);
      const imageData = ctx.createImageData(cpr.width, cpr.height);
      imageData.data.set(rgba);
      ctx.putImageData(imageData, 0, 0);
    } catch (e: any) {
      setError(e?.message || "Échec du calcul CPR.");
    }
  }, [vol, points, zSlice]);

  return (
    <div className="absolute inset-0 z-40 bg-background/95 flex flex-col p-3 gap-2 overflow-auto">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Curved MPR (bêta) — reformation curviligne
        </h3>
        <button
          className="text-xs px-2 py-1 rounded bg-secondary hover:bg-secondary/80"
          onClick={onClose}
        >
          Fermer
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Cliquez pour poser une polyligne (centerline) sur la coupe de référence,
        puis « Générer ». L'image déroulée (stretched CPR) échantillonne le
        volume le long de la courbe. Version bêta : coupe axiale, volume
        axis-aligned.
      </p>

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div className="flex items-center gap-2 text-[11px]">
        <label className="text-muted-foreground">Coupe Z</label>
        <input
          type="range"
          min={0}
          max={Math.max(0, (vol?.dims[2] ?? 1) - 1)}
          value={zSlice}
          onChange={e => setZSlice(Number(e.target.value))}
          disabled={!vol}
        />
        <span className="w-10">
          {zSlice + 1}/{vol?.dims[2] ?? 0}
        </span>
        <button
          className="px-2 py-1 rounded bg-secondary hover:bg-secondary/80 disabled:opacity-40"
          onClick={() => setPoints([])}
          disabled={points.length === 0}
        >
          Effacer points
        </button>
        <button
          className="px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          onClick={renderCpr}
          disabled={!vol || points.length < 2}
        >
          Générer
        </button>
        <span className="text-muted-foreground">{points.length} point(s)</span>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <div className="text-[10px] text-muted-foreground mb-1">
            Coupe de référence (cliquez pour poser la courbe)
          </div>
          <canvas
            ref={refCanvasRef}
            onClick={handleRefClick}
            className="border border-border cursor-crosshair bg-black"
            style={{ width: 320, height: 320, imageRendering: "pixelated" }}
          />
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground mb-1">
            CPR déroulé (stretched)
          </div>
          <canvas
            ref={cprCanvasRef}
            className="border border-border bg-black"
            style={{ maxWidth: 600, imageRendering: "pixelated" }}
          />
        </div>
      </div>
    </div>
  );
}
