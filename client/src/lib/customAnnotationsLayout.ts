// Configuration des annotations d'écran aux 4 coins (préférence « Custom
// Annotations », à la manière de Horos/OsiriX).
//
// Le visualiseur superpose, sur chaque viewport, de courtes lignes de texte
// dans les quatre coins : taille de l'image, fenêtrage (WL/WW), zoom, position
// de coupe, identité patient, description de série, date d'acquisition, etc.
// L'utilisateur peut choisir QUELS champs apparaissent et DANS QUEL coin.
//
// Ce module est 100 % PUR : il ne fait que transformer un état (layout + valeurs
// courantes du viewport) en lignes de texte prêtes à afficher. Aucune dépendance
// React / DOM / Cornerstone : la couche de rendu se contente d'itérer sur les
// chaînes retournées. Tout est déterministe et testable hors navigateur.

/** Identifiants des champs d'annotation affichables. */
export type AnnotationField =
  | "imageSize" // dimensions du pixel-data (ex. « 512 x 512 »)
  | "wlww" // fenêtrage : centre (WL) / largeur (WW)
  | "zoom" // facteur de zoom (ex. « Zoom: 150% »)
  | "sliceInfo" // index de coupe (ex. « Im: 12/240 »)
  | "patientName" // nom du patient
  | "patientId" // identifiant patient
  | "seriesDesc" // description de série
  | "studyDesc" // description d'étude
  | "date" // date d'acquisition
  | "modality" // modalité (CT, MR, PT…)
  | "institution"; // établissement

/** Les quatre coins du viewport. */
export type AnnotationCorner =
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight";

/**
 * Disposition complète : pour chaque coin, la liste ORDONNÉE des champs à
 * afficher (de haut en bas pour les coins du haut, identique pour ceux du bas —
 * la couche de rendu ancre simplement le bloc au coin correspondant).
 */
export interface AnnotationLayout {
  topLeft: AnnotationField[];
  topRight: AnnotationField[];
  bottomLeft: AnnotationField[];
  bottomRight: AnnotationField[];
}

/**
 * Contexte courant du viewport : valeurs brutes servant à formater les champs.
 * Toutes les entrées sont optionnelles ; un champ dont la donnée manque produit
 * une chaîne vide et n'est PAS rendu (voir `renderCorner`).
 */
export interface AnnotationContext {
  /** Largeur du pixel-data en pixels. */
  columns?: number | null;
  /** Hauteur du pixel-data en pixels. */
  rows?: number | null;
  /** Centre de fenêtre (Window Level / WindowCenter, 0028,1050). */
  windowCenter?: number | null;
  /** Largeur de fenêtre (Window Width / WindowWidth, 0028,1051). */
  windowWidth?: number | null;
  /** Facteur de zoom : 1 = 100 %. */
  zoom?: number | null;
  /** Index 0-based de la coupe courante dans la série. */
  sliceIndex?: number | null;
  /** Nombre total de coupes de la série. */
  sliceCount?: number | null;
  /** Nom du patient (PatientName, 0010,0010). */
  patientName?: string | null;
  /** Identifiant patient (PatientID, 0010,0020). */
  patientId?: string | null;
  /** Description de série (SeriesDescription, 0008,103E). */
  seriesDescription?: string | null;
  /** Description d'étude (StudyDescription, 0008,1030). */
  studyDescription?: string | null;
  /** Date d'acquisition / d'étude (format DICOM DA `YYYYMMDD` ou libre). */
  date?: string | null;
  /** Modalité (Modality, 0008,0060). */
  modality?: string | null;
  /** Établissement (InstitutionName, 0008,0080). */
  institution?: string | null;
}

/**
 * Disposition par défaut, calquée sur l'usage radiologique courant :
 *   • haut-gauche  : identité patient (nom, id)
 *   • haut-droite  : étude / série (description, modalité, date)
 *   • bas-gauche   : fenêtrage et zoom
 *   • bas-droite   : taille image et coupe courante
 *
 * Figée (`Readonly`/`as const`) pour éviter toute mutation accidentelle d'une
 * valeur partagée ; les helpers en font des copies avant modification.
 */
export const DEFAULT_ANNOTATION_LAYOUT: Readonly<AnnotationLayout> = {
  topLeft: ["patientName", "patientId"],
  topRight: ["studyDesc", "seriesDesc", "modality", "date"],
  bottomLeft: ["wlww", "zoom"],
  bottomRight: ["imageSize", "sliceInfo"],
} as const;

/** Tous les champs connus, dans un ordre stable (utile pour une UI de réglage). */
export const ALL_ANNOTATION_FIELDS: readonly AnnotationField[] = [
  "imageSize",
  "wlww",
  "zoom",
  "sliceInfo",
  "patientName",
  "patientId",
  "seriesDesc",
  "studyDesc",
  "date",
  "modality",
  "institution",
] as const;

/** Tous les coins, dans un ordre stable. */
export const ALL_ANNOTATION_CORNERS: readonly AnnotationCorner[] = [
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
] as const;

/** Vrai si `v` est un nombre fini. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Nettoie une chaîne potentiellement absente : `trim`, et `null`/`undefined`
 * ou chaîne vide → `null`. Évite d'afficher des champs « fantômes ».
 */
function cleanString(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * Met en forme une date DICOM `YYYYMMDD` en `YYYY-MM-DD`. Toute autre forme est
 * renvoyée telle quelle (après trim) — on ne reformate que le cas canonique.
 */
function formatDicomDate(raw: string): string {
  const s = raw.trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Formate UN champ d'annotation à partir du contexte. Renvoie une chaîne vide
 * (`""`) si la donnée nécessaire est absente / invalide : la couche de rendu
 * (et `renderCorner`) filtre alors la ligne. Jamais d'exception, jamais de
 * `NaN`/`undefined` dans la sortie.
 */
export function formatAnnotationField(
  field: AnnotationField,
  ctx: AnnotationContext
): string {
  switch (field) {
    case "imageSize": {
      const cols = ctx.columns;
      const rows = ctx.rows;
      if (!isFiniteNumber(cols) || !isFiniteNumber(rows)) return "";
      if (cols <= 0 || rows <= 0) return "";
      return `${Math.round(cols)} x ${Math.round(rows)}`;
    }
    case "wlww": {
      const wl = ctx.windowCenter;
      const ww = ctx.windowWidth;
      if (!isFiniteNumber(wl) || !isFiniteNumber(ww)) return "";
      return `WL: ${Math.round(wl)} WW: ${Math.round(ww)}`;
    }
    case "zoom": {
      const z = ctx.zoom;
      if (!isFiniteNumber(z) || z <= 0) return "";
      return `Zoom: ${Math.round(z * 100)}%`;
    }
    case "sliceInfo": {
      const idx = ctx.sliceIndex;
      const total = ctx.sliceCount;
      if (!isFiniteNumber(idx) || !isFiniteNumber(total)) return "";
      if (total <= 0 || idx < 0 || idx >= total) return "";
      // Affichage 1-based pour le clinicien.
      return `Im: ${Math.round(idx) + 1}/${Math.round(total)}`;
    }
    case "patientName": {
      const v = cleanString(ctx.patientName);
      // DICOM PN : les composants sont séparés par « ^ » → on remet des espaces.
      return v ? v.replace(/\^+/g, " ").replace(/\s+/g, " ").trim() : "";
    }
    case "patientId": {
      const v = cleanString(ctx.patientId);
      return v ? `ID: ${v}` : "";
    }
    case "seriesDesc":
      return cleanString(ctx.seriesDescription) ?? "";
    case "studyDesc":
      return cleanString(ctx.studyDescription) ?? "";
    case "date": {
      const v = cleanString(ctx.date);
      return v ? formatDicomDate(v) : "";
    }
    case "modality":
      return cleanString(ctx.modality)?.toUpperCase() ?? "";
    case "institution":
      return cleanString(ctx.institution) ?? "";
    default: {
      // Exhaustivité : toute extension future du type AnnotationField doit
      // ajouter un cas ci-dessus. Le `never` fait échouer la compilation sinon.
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

/**
 * Rend les lignes d'un coin : pour chaque champ configuré, on formate puis on
 * RETIRE les chaînes vides (champs sans donnée). L'ordre des champs configurés
 * est préservé. Un coin absent du layout, ou inconnu, donne une liste vide.
 */
export function renderCorner(
  layout: AnnotationLayout,
  corner: AnnotationCorner,
  ctx: AnnotationContext
): string[] {
  const fields = layout?.[corner];
  if (!Array.isArray(fields)) return [];
  const lines: string[] = [];
  for (const field of fields) {
    const text = formatAnnotationField(field, ctx);
    if (text.length > 0) lines.push(text);
  }
  return lines;
}

/**
 * Rend les quatre coins en une fois (commodité pour la couche de rendu).
 * Renvoie un objet `{topLeft, topRight, bottomLeft, bottomRight}` de listes de
 * lignes déjà filtrées.
 */
export function renderAllCorners(
  layout: AnnotationLayout,
  ctx: AnnotationContext
): Record<AnnotationCorner, string[]> {
  return {
    topLeft: renderCorner(layout, "topLeft", ctx),
    topRight: renderCorner(layout, "topRight", ctx),
    bottomLeft: renderCorner(layout, "bottomLeft", ctx),
    bottomRight: renderCorner(layout, "bottomRight", ctx),
  };
}
