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
