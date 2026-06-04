import { useEffect, useRef, useState } from "react";

/**
 * VolumeViewer — real volumetric rendering with Cornerstone3D.
 *
 * mode="mpr": builds a 3D volume from the stack and shows 3 orthogonal
 *             reconstructions (axial / sagittal / coronal).
 * mode="3d" : volume rendering (VR) in a single viewport with a CT preset.
 *
 * Uses its own rendering engine so it never collides with the 2D stack viewer.
 * Cornerstone core must already be initialized (the 2D viewer's initCornerstone
 * registers the streaming volume loader via cornerstone.init()).
 */
interface VolumeViewerProps {
  imageUrls: string[];
  mode: "mpr" | "3d";
}

const VOLUME_ENGINE_ID = "horosVolumeEngine";

export default function VolumeViewer({ imageUrls, mode }: VolumeViewerProps) {
  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
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

        const imageIds = imageUrls.map((u) => `wadouri:${u}`);
        if (imageIds.length < 2) {
          throw new Error("Need at least 2 slices to build a volume");
        }

        const volumeId = `cornerstoneStreamingImageVolume:HOROS_VOL`;
        // Drop any cached volume from a previous mount so we rebuild cleanly.
        try {
          cornerstone.cache?.removeVolumeLoadObject?.(volumeId);
        } catch {}
        const volume = await volumeLoader.createAndCacheVolume(volumeId, {
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
          ];
          engine.setViewports(inputs);
          const mprIds = ["MPR_AXIAL", "MPR_SAGITTAL", "MPR_CORONAL"];
          await setVolumesForViewports(engine, [{ volumeId }], mprIds);
          // Apply a CT soft-tissue window (WW 400 / WC 40). The streaming
          // volume resets the VOI to a wide default when it finishes loading,
          // so apply it now AND again from the load-completion callback,
          // otherwise the reconstructions end up flat mid-grey.
          const applyMprWindow = () => {
            for (const id of mprIds) {
              try {
                engine
                  .getViewport(id)
                  .setProperties({ voiRange: { lower: -160, upper: 240 } });
              } catch {}
            }
            engine.renderViewports(mprIds);
          };
          engine.resize(true, false);
          applyMprWindow();
          volume.load(() => applyMprWindow());
        } else {
          engine.setViewports([
            {
              viewportId: "VR_3D",
              element: vr3dRef.current!,
              type: Enums.ViewportType.VOLUME_3D,
              defaultOptions: { background: [0, 0, 0] as [number, number, number] },
            },
          ]);
          await setVolumesForViewports(engine, [{ volumeId }], ["VR_3D"]);
          const vp = engine.getViewport("VR_3D") as any;
          // A bone preset gives a recognizable VR; fall back silently if the
          // preset name isn't available in this build. Apply now and again once
          // the volume has fully streamed in.
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
      try {
        engineRef.current?.destroy();
      } catch {}
      engineRef.current = null;
    };
  }, [imageUrls, mode]);

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
          <div ref={axialRef} className="relative bg-black" data-label="Axial" />
          <div ref={sagittalRef} className="relative bg-black" data-label="Sagittal" />
          <div ref={coronalRef} className="relative bg-black" data-label="Coronal" />
          <div className="bg-black" />
        </div>
      ) : (
        <div ref={vr3dRef} className="absolute inset-0 bg-black" />
      )}
    </div>
  );
}
