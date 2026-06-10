import { z } from "zod";

/**
 * Schéma de validation du payload d'une annotation Cornerstone3D, en remplacement
 * d'un `z.any()` non borné (durcissement : empêche le stockage de JSON arbitraire
 * volumineux dans la table `annotations`).
 *
 * Volontairement PERMISSIF sur le contenu spécifique à chaque outil (les
 * structures `handles`/`points` varient selon Length/Angle/ROI/Freehand…), mais
 * il EXIGE la forme essentielle d'une annotation Cornerstone (objet avec
 * `metadata.toolName` et un objet `data`) et BORNE la taille sérialisée totale.
 */
const MAX_PAYLOAD_BYTES = 256_000;

export const annotationDataSchema = z
  .object({
    metadata: z
      .object({
        toolName: z.string().min(1).max(64),
      })
      .passthrough(),
    data: z.object({}).passthrough(),
  })
  .passthrough()
  .refine(
    payload => {
      try {
        return JSON.stringify(payload).length <= MAX_PAYLOAD_BYTES;
      } catch {
        // structures circulaires / non sérialisables : rejet
        return false;
      }
    },
    { message: "Payload d'annotation invalide ou trop volumineux" }
  );

export type AnnotationData = z.infer<typeof annotationDataSchema>;
