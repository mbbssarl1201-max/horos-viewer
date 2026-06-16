/**
 * Fenêtre osseuse (CT) : c'est dans cette fenêtre que les traits de fracture
 * sont visibles. Utilisée par le bouton « Analyser les fractures ».
 */
export const BONE_WINDOW = { windowCenter: 500, windowWidth: 2000 };

export interface SeriesLike {
  id: number;
  seriesDescription?: string | null;
}

/**
 * Repère la série à reconstruction OSSEUSE parmi les séries d'une étude, d'après
 * sa description. On se fie aux mots explicites (OS / osseux / bone / knochen /
 * sharp) — fiable et conservateur. On évite volontairement de deviner d'après le
 * numéro de noyau (ex. « B30 » est un noyau MOU, « B60 » osseux), source de faux
 * positifs. Renvoie undefined si aucune série osseuse n'est identifiable.
 */
export function findBoneSeries<T extends SeriesLike>(
  list?: T[]
): T | undefined {
  return list?.find(s =>
    /\bos\b|osseu|bone|bony|knochen|sharp/i.test(s.seriesDescription || "")
  );
}
