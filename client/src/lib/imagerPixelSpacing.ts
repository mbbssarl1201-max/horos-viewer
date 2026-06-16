/**
 * Repli ImagerPixelSpacing pour la calibration des mesures.
 *
 * Le loader DICOM de Cornerstone (`@cornerstonejs/dicom-image-loader`) calibre
 * les distances/surfaces à partir du tag PixelSpacing (0028,0030). Les scanners
 * (CT/IRM) le portent toujours → mesures en mm garanties. Mais certaines radios
 * standard (CR/DX) ne portent QUE l'ImagerPixelSpacing (0018,1164), que le loader
 * ignore : il pose alors rowPixelSpacing = columnPixelSpacing = 1 (px) et marque
 * `usingDefaultValues = true`. Conséquence : les outils de mesure tombent en
 * pixels au lieu des millimètres.
 *
 * Cette fonction PURE prend le module `imagePlaneModule` déjà calculé par le
 * loader et l'ImagerPixelSpacing lu sur le dataset, et renvoie un module corrigé
 * UNIQUEMENT lorsque c'est pertinent (spacing réel absent + ImagerPixelSpacing
 * valide). Sinon elle renvoie `undefined` pour laisser le provider par défaut
 * faire foi (aucun changement de comportement sur les CT/IRM).
 *
 * Convention : comme PixelSpacing, ImagerPixelSpacing est [espacement entre
 * lignes (rowPixelSpacing), espacement entre colonnes (columnPixelSpacing)] en mm.
 *
 * Note clinique : sur une radio de projection, l'ImagerPixelSpacing est mesuré au
 * niveau du DÉTECTEUR (non corrigé du grandissement). Les mesures sont donc en mm
 * « détecteur », ce que font tous les PACS pour ce type d'examen.
 */

export interface ImagePlaneModuleLike {
  rowPixelSpacing?: number | null;
  columnPixelSpacing?: number | null;
  pixelSpacing?: number[] | null;
  usingDefaultValues?: boolean;
  [key: string]: unknown;
}

export function patchImagerPixelSpacing(
  imagePlaneModule: ImagePlaneModuleLike | null | undefined,
  imagerPixelSpacing: number[] | null | undefined
): ImagePlaneModuleLike | undefined {
  // Pas de module → rien à patcher.
  if (!imagePlaneModule) return undefined;

  // Le loader a trouvé un vrai PixelSpacing (usingDefaultValues=false) → on ne
  // touche à rien, le provider par défaut est correct.
  if (imagePlaneModule.usingDefaultValues !== true) return undefined;

  // ImagerPixelSpacing absent ou incomplet → on laisse le comportement par
  // défaut (mesures en px), pas de repli possible.
  if (!Array.isArray(imagerPixelSpacing) || imagerPixelSpacing.length < 2) {
    return undefined;
  }

  const [row, col] = imagerPixelSpacing;
  // Valeurs aberrantes (0, négatives, NaN) → on n'introduit pas de fausse
  // calibration.
  if (!(row > 0) || !(col > 0)) return undefined;

  return {
    ...imagePlaneModule,
    pixelSpacing: [row, col],
    rowPixelSpacing: row,
    columnPixelSpacing: col,
    usingDefaultValues: false,
  };
}
