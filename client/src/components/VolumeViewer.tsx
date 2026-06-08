import { useEffect, useRef, useState } from "react";
import { slabModeToBlend, type SlabMode } from "@/lib/slabBlend";

/**
 * VolumeViewer — real volumetric rendering with Cornerstone3D.
 *
 * mode="mpr": builds a 3D volume from the stack and shows 3 orthogonal
 *             reconstructions (axial / sagittal / coronal) + 1 oblique quad.
 *             Supports ToolGroup (CrosshairsTool, WindowLevelTool, etc.),
 *             VOI synchronizer, and slab thickness/blend-mode.
 * mode="3d" : volume rendering (VR) in a single viewport with a CT preset.
 *
 * Source priority:
 *   1. orthancImageIds (wadors: scheme, from Orthanc via proxy) if provided
 *   2. imageUrls (wadouri: scheme, from MinIO) otherwise
 *
 * Uses its own rendering engine so it never collides with the 2D stack viewer.
 * Cornerstone core must already be initialized (the 2D viewer's initCornerstone
 * registers the streaming volume loader via cornerstone.init()).
 */
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

const VOLUME_ENGINE_ID = "horosVolumeEngine";

export default function VolumeViewer({
  imageUrls,
  orthancImageIds,
  volumeId,
  mode,
  slabThicknessMm,
  slabMode,
}: VolumeViewerProps) {
  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const obliqueRef = useRef<HTMLDivElement>(null);
  const vr3dRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      setLoading(true);
      setError(null);
      try {
        const cornerstone = await import("@cornerstonejs/core");
        const { RenderingEngine, Enums, volumeLoader, setVolumesForViewports } =
          cornerstone as any;

        // Make sure core is initialized (idempotent).
        if (!cornerstone.getRenderingEngine?.(VOLUME_ENGINE_ID)) {
          await cornerstone.init?.();
        }

        // Source priority: orthancImageIds (wadors) > imageUrls (wadouri)
        const imageIds =
          orthancImageIds && orthancImageIds.length
            ? orthancImageIds
            : (imageUrls ?? []).map(u => `wadouri:${u}`);

        if (imageIds.length < 2) {
          throw new Error("Need at least 2 slices to build a volume");
        }

        const volId = volumeId ?? `cornerstoneStreamingImageVolume:HOROS_VOL`;

        // Drop any cached volume from a previous mount so we rebuild cleanly.
        try {
          cornerstone.cache?.removeVolumeLoadObject?.(volId);
        } catch {}
        const volume = await volumeLoader.createAndCacheVolume(volId, {
          imageIds,
        });

        // Fresh engine each time.
        if (engineRef.current) {
          try {
            engineRef.current.destroy();
          } catch {}
        }
        const engine = new RenderingEngine(VOLUME_ENGINE_ID);
        engineRef.current = engine;

        if (cancelled) return;

        if (mode === "mpr") {
          // ── Init @cornerstonejs/tools ────────────────────────────────────
          const csTools = await import("@cornerstonejs/tools");
          const {
            init: toolsInit,
            ToolGroupManager,
            CrosshairsTool,
            WindowLevelTool,
            StackScrollTool,
            PanTool,
            ZoomTool,
            Enums: csToolsEnums,
            addTool,
            synchronizers,
          } = csTools as any;

          await toolsInit();
          for (const t of [
            CrosshairsTool,
            WindowLevelTool,
            StackScrollTool,
            PanTool,
            ZoomTool,
          ]) {
            try {
              addTool(t);
            } catch {} // addTool throws if already registered — ignore
          }

          // ── 4 viewports : axial / sagittal / coronal / oblique ───────────
          const inputs = [
            {
              viewportId: "MPR_AXIAL",
              element: axialRef.current!,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.AXIAL },
            },
            {
              viewportId: "MPR_SAGITTAL",
              element: sagittalRef.current!,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.SAGITTAL },
            },
            {
              viewportId: "MPR_CORONAL",
              element: coronalRef.current!,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.CORONAL },
            },
            {
              viewportId: "MPR_OBLIQUE",
              element: obliqueRef.current!,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: {
                orientation: Enums.OrientationAxis.ACQUISITION,
              },
            },
          ];
          engine.setViewports(inputs);

          const allIds = [
            "MPR_AXIAL",
            "MPR_SAGITTAL",
            "MPR_CORONAL",
            "MPR_OBLIQUE",
          ];
          await setVolumesForViewports(engine, [{ volumeId: volId }], allIds);

          // ── ToolGroup ─────────────────────────────────────────────────────
          const TOOLGROUP_ID = "HOROS_MPR_TG";
          ToolGroupManager.destroyToolGroup?.(TOOLGROUP_ID);
          const tg = ToolGroupManager.createToolGroup(TOOLGROUP_ID)!;
          for (const t of [
            CrosshairsTool,
            WindowLevelTool,
            StackScrollTool,
            PanTool,
            ZoomTool,
          ]) {
            tg.addTool(t.toolName);
          }
          allIds.forEach((id: string) => tg.addViewport(id, VOLUME_ENGINE_ID));

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

          // ── VOI Synchronizer (W/L cohérent sur les 4 vues) ───────────────
          const voiSync = synchronizers.createVOISynchronizer(
            "HOROS_VOI_SYNC",
            { syncInvertState: false, syncColormap: false }
          );
          allIds.forEach((id: string) =>
            voiSync.add({ renderingEngineId: VOLUME_ENGINE_ID, viewportId: id })
          );

          // ── W/L par défaut (CT soft-tissue) ──────────────────────────────
          const applyMprWindow = () => {
            for (const id of allIds) {
              try {
                engine
                  .getViewport(id)
                  .setProperties({ voiRange: { lower: -160, upper: 240 } });
              } catch {}
            }
            engine.renderViewports(allIds);
          };

          // ── Slab thickness + blend mode ───────────────────────────────────
          const applySlab = () => {
            if (!slabThicknessMm || slabThicknessMm <= 0) return;
            const blendKey = slabModeToBlend(slabMode ?? "mip");
            // BlendModes est dans Enums du core (pas dans csToolsEnums)
            const blend = (Enums as any).BlendModes?.[blendKey];
            for (const id of allIds) {
              try {
                const vp = engine.getViewport(id) as any;
                vp.setSlabThickness(slabThicknessMm);
                if (blend !== undefined) vp.setBlendMode(blend);
              } catch {}
            }
            engine.renderViewports(allIds);
          };

          engine.resize(true, false);
          applyMprWindow();
          applySlab();
          volume.load(() => {
            applyMprWindow();
            applySlab();
          });
        } else {
          engine.setViewports([
            {
              viewportId: "VR_3D",
              element: vr3dRef.current!,
              type: Enums.ViewportType.VOLUME_3D,
              defaultOptions: {
                background: [0, 0, 0] as [number, number, number],
              },
            },
          ]);
          await setVolumesForViewports(
            engine,
            [{ volumeId: volId }],
            ["VR_3D"]
          );
          const vp = engine.getViewport("VR_3D") as any;
          const applyPreset = () => {
            try {
              vp.setProperties({ preset: "CT-Bone" });
            } catch {}
            vp.render();
          };
          engine.resize(true, false);
          applyPreset();
          volume.load(() => applyPreset());
        }

        if (!cancelled) setLoading(false);
      } catch (err: any) {
        console.error("[VolumeViewer] setup failed:", err);
        if (!cancelled) {
          setError(err?.message || "Volume rendering failed");
          setLoading(false);
        }
      }
    };

    setup();
    return () => {
      cancelled = true;
      // Purge du volume du cache pour libérer la mémoire GPU entre changements de série.
      const capturedVolId =
        volumeId ?? `cornerstoneStreamingImageVolume:HOROS_VOL`;
      import("@cornerstonejs/core")
        .then((cs: any) => {
          try {
            cs.cache?.removeVolumeLoadObject?.(capturedVolId);
          } catch {}
        })
        .catch(() => {});
      import("@cornerstonejs/tools")
        .then((csTools: any) => {
          try {
            csTools.ToolGroupManager?.destroyToolGroup?.("HOROS_MPR_TG");
          } catch {}
          try {
            csTools.SynchronizerManager?.destroySynchronizer?.(
              "HOROS_VOI_SYNC"
            );
          } catch {}
        })
        .catch(() => {});
      try {
        engineRef.current?.destroy();
      } catch {}
      engineRef.current = null;
    };
  }, [imageUrls, orthancImageIds, volumeId, mode, slabThicknessMm, slabMode]);

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <p className="text-xs text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 bg-black">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <p className="text-xs text-muted-foreground">
            Building {mode === "mpr" ? "MPR" : "3D"} volume…
          </p>
        </div>
      )}
      {mode === "mpr" ? (
        <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-border">
          <div
            ref={axialRef}
            className="relative bg-black"
            data-label="Axial"
          />
          <div
            ref={sagittalRef}
            className="relative bg-black"
            data-label="Sagittal"
          />
          <div
            ref={coronalRef}
            className="relative bg-black"
            data-label="Coronal"
          />
          <div
            ref={obliqueRef}
            className="relative bg-black"
            data-label="Oblique"
          />
        </div>
      ) : (
        <div ref={vr3dRef} className="absolute inset-0 bg-black" />
      )}
    </div>
  );
}
