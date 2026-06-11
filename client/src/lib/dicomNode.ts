// Modèle et validation d'un nœud DICOM, tel qu'enregistré dans les préférences
// « Locations » du visualiseur (un PACS / une station distante avec qui dialoguer).
//
// Fonctions PURES et déterministes : aucune dépendance React / DOM / réseau.
// On ne valide ici que la FORME des champs (AET, host, port, rôle), pas la
// connectivité réelle — c'est testable hors navigateur.
//
// ── Rappel des contraintes DICOM ────────────────────────────────────────────
//   • AET (Application Entity Title) : 1 à 16 caractères, ASCII imprimable, pas
//     d'espace de tête/queue significatif (PS3.5 — VR « AE »). On refuse le vide
//     et tout caractère non-ASCII (>16 ou caractères de contrôle).
//   • host : nom d'hôte ou IP, non vide (on ne résout pas le DNS ici).
//   • port : entier TCP dans [1, 65535].
//   • role : ce que le nœud sait faire de notre point de vue —
//       - 'qr'    : Query/Retrieve (C-FIND/C-MOVE/C-GET) uniquement
//       - 'store' : C-STORE (destination d'envoi) uniquement
//       - 'both'  : les deux
//   • wado (optionnel) : URL de base WADO-URI / WADO-RS pour la récupération web.

/** Rôle d'un nœud DICOM vis-à-vis du visualiseur. */
export type DicomNodeRole = "qr" | "store" | "both";

/** Liste close des rôles valides (source de vérité pour la validation). */
export const DICOM_NODE_ROLES: readonly DicomNodeRole[] = [
  "qr",
  "store",
  "both",
];

/** Un nœud DICOM configuré dans les préférences « Locations ». */
export interface DicomNode {
  /** Application Entity Title (1..16 ASCII imprimables). */
  aet: string;
  /** Nom d'hôte ou adresse IP (non vide). */
  host: string;
  /** Port TCP, entier dans [1, 65535]. */
  port: number;
  /** Capacité du nœud : Query/Retrieve, destination de stockage, ou les deux. */
  role: DicomNodeRole;
  /** URL de base WADO optionnelle (récupération web). */
  wado?: string;
}

/** Résultat de validation : `ok` global + liste des messages d'erreur. */
export interface ValidationResult {
  /** Vrai si aucune erreur. */
  ok: boolean;
  /** Messages d'erreur en français (vide si `ok`). */
  errors: string[];
}

/** Bornes du port TCP. */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;
/** Longueur maximale d'un AET (VR « AE » DICOM). */
export const AET_MAX_LENGTH = 16;

/**
 * Vrai si toute la chaîne est en ASCII imprimable (0x20..0x7E inclus). On
 * accepte l'espace interne mais on rejette tabulations, retours chariot et tout
 * caractère hors ASCII (accents, emoji, NUL…).
 */
function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/**
 * Valide la FORME d'un nœud DICOM. Renvoie toujours un objet (jamais
 * d'exception) : `{ ok, errors }`. Chaque problème ajoute un message distinct,
 * de sorte que l'UI peut tous les afficher d'un coup.
 *
 * Règles :
 *   • aet   : chaîne non vide (après trim), ≤ 16 caractères, ASCII imprimable,
 *             sans espace de tête/queue.
 *   • host  : chaîne non vide (après trim).
 *   • port  : entier fini dans [1, 65535].
 *   • role  : l'une de 'qr' | 'store' | 'both'.
 *   • wado  : si présent et non vide, doit être une URL absolue parsable.
 *
 * Tolérant aux entrées dégénérées (`null`/`undefined`/mauvais types) : on les
 * traite comme « champ manquant » plutôt que de lever.
 */
export function validateNode(
  node: Partial<DicomNode> | null | undefined
): ValidationResult {
  const errors: string[] = [];

  // ── AET ─────────────────────────────────────────────────────────────────
  const aet = node?.aet;
  if (typeof aet !== "string" || aet.length === 0) {
    errors.push("AET requis");
  } else if (aet.trim().length === 0) {
    errors.push("AET requis");
  } else if (aet !== aet.trim()) {
    errors.push("AET ne doit pas comporter d'espace en tête ou en fin");
  } else if (aet.length > AET_MAX_LENGTH) {
    errors.push(`AET trop long (${aet.length} > ${AET_MAX_LENGTH} caractères)`);
  } else if (!isPrintableAscii(aet)) {
    errors.push("AET doit être en ASCII imprimable");
  }

  // ── host ────────────────────────────────────────────────────────────────
  const host = node?.host;
  if (typeof host !== "string" || host.trim().length === 0) {
    errors.push("Hôte requis");
  }

  // ── port ────────────────────────────────────────────────────────────────
  const port = node?.port;
  if (typeof port !== "number" || !Number.isInteger(port)) {
    errors.push("Port requis (entier)");
  } else if (port < PORT_MIN || port > PORT_MAX) {
    errors.push(`Port hors plage [${PORT_MIN}, ${PORT_MAX}]`);
  }

  // ── role ────────────────────────────────────────────────────────────────
  const role = node?.role;
  if (
    typeof role !== "string" ||
    !DICOM_NODE_ROLES.includes(role as DicomNodeRole)
  ) {
    errors.push("Rôle invalide (attendu : qr | store | both)");
  }

  // ── wado (optionnel) ──────────────────────────────────────────────────────
  const wado = node?.wado;
  if (wado !== undefined && wado !== null && wado !== "") {
    if (typeof wado !== "string" || !isParsableUrl(wado)) {
      errors.push("URL WADO invalide");
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Vrai si `s` est une URL absolue parsable (http/https/etc.). */
function isParsableUrl(s: string): boolean {
  try {
    // URL est disponible en Node et navigateur ; pas un accès DOM/réseau.
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Libellé lisible d'un nœud pour l'UI / les listes : `AET@host:port (rôle)`.
 * Purement cosmétique — ne valide rien. Les champs absents sont rendus par un
 * tiret `—` afin de ne jamais produire « undefined ».
 */
export function formatNodeLabel(
  node: Partial<DicomNode> | null | undefined
): string {
  const aet = node?.aet && node.aet.trim().length > 0 ? node.aet : "—";
  const host = node?.host && node.host.trim().length > 0 ? node.host : "—";
  const port =
    typeof node?.port === "number" && Number.isFinite(node.port)
      ? String(node.port)
      : "—";
  const role =
    node?.role && DICOM_NODE_ROLES.includes(node.role) ? node.role : "—";
  return `${aet}@${host}:${port} (${role})`;
}
