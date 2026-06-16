import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { representativeImageId } from "@/lib/seriesThumbnail";
import { renderThumbnail } from "@/lib/seriesThumbnailRenderer";

interface SeriesThumbnailProps {
  seriesId: number;
  /** W/L à appliquer (défauts du viewer ou W/L DICOM de la série). */
  windowWidth: number;
  windowCenter: number;
}

/**
 * Vignette réelle d'une série : charge les instances, rend hors écran la coupe
 * représentative (coupe du milieu) en PNG, et l'affiche. Tant que la vignette
 * n'est pas prête — ou si le rendu échoue (série non chargeable, p. ex.
 * compressée) — on garde le placeholder noir existant.
 *
 * Les instances ne sont demandées que lorsque la vignette est visible (le
 * composant n'est monté que pour les séries rendues dans le panneau), et le
 * rendu est mis en cache par imageId → pas de re-rendu au re-render du panneau.
 */
export default function SeriesThumbnail({
  seriesId,
  windowWidth,
  windowCenter,
}: SeriesThumbnailProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  const { data: instances } = trpc.instances.listBySeries.useQuery(
    { seriesId },
    { enabled: !!seriesId, staleTime: Infinity }
  );

  useEffect(() => {
    if (!instances) return;
    const imageId = representativeImageId(instances as any);
    if (!imageId) return;

    let cancelled = false;
    // Asynchrone : ne bloque pas le montage du panneau.
    renderThumbnail(imageId, windowWidth, windowCenter)
      .then(url => {
        if (!cancelled && url) setDataUrl(url);
      })
      .catch(() => {
        // On garde le placeholder noir.
      });

    return () => {
      cancelled = true;
    };
    // W/L volontairement hors deps : la vignette utilise le W/L initial et le
    // cache par imageId évite tout re-rendu ; on ne régénère pas à chaque
    // changement de fenêtrage dans le viewer principal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances]);

  return (
    <div className="aspect-square bg-black rounded mb-1.5 flex items-center justify-center overflow-hidden">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="Aperçu de la série"
          className="w-full h-full object-contain"
        />
      ) : (
        <Layers className="w-6 h-6 text-muted-foreground/30" />
      )}
    </div>
  );
}
