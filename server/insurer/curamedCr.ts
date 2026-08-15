// Rapport curaMED en pièce jointe : quand l'assureur demande « images et
// rapport », le CR écrit n'existe pas dans MediView pour les examens
// historiques — il est dans le stock curaMED déjà téléchargé sur ce VPS
// (/opt/medical/curamed-import : index.csv 187k lignes + 43 Go de PDF),
// monté en LECTURE SEULE dans le conteneur (CURAMED_IMPORT_DIR).
//
// Cœur de sélection PUR (scoring testé isolément) ; l'accès fichiers est
// concentré dans deux helpers. Fail-open contrôlé : si le stock est absent,
// la recherche renvoie [] et le mail part sans CR (comme avant).
import { promises as fs } from "fs";
import { join } from "path";
import { regionsDe } from "./anatomie";

const CURAMED_DIR = process.env.CURAMED_IMPORT_DIR ?? "/curamed";

export type DocCuramed = {
  nom: string;
  prenom: string;
  ddn: string; // chiffres uniquement (JJMMAAAA → aaaammjj normalisé)
  titre: string;
  date: string; // YYYYMMDD (chiffres) ou ""
  type: string;
  reference: string;
};

function normaliser(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** JJ.MM.AAAA → YYYYMMDD (chiffres), sinon "". */
function versYmd(d: string): string {
  const m = (d || "").trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return "";
  return `${m[3]}${m[2].padStart(2, "0")}${m[1].padStart(2, "0")}`;
}

// ── Index CSV (chargé une fois, ~187k lignes) ──────────────────────────────
let indexCache: Map<string, DocCuramed[]> | null = null;

function cleIdentite(nom: string, prenom: string, ddnDigits: string): string {
  return `${normaliser(nom)}|${normaliser(prenom)}|${ddnDigits}`;
}

/** Parse UNE ligne CSV (champs éventuellement quotés, virgules internes). */
function champsCsv(ligne: string): string[] {
  const out: string[] = [];
  let cur = "";
  let dansQuote = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (c === '"') {
      dansQuote = !dansQuote;
    } else if (c === "," && !dansQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function chargerIndex(): Promise<Map<string, DocCuramed[]>> {
  if (indexCache) return indexCache;
  const idx = new Map<string, DocCuramed[]>();
  try {
    const brut = await fs.readFile(join(CURAMED_DIR, "index.csv"), "utf8");
    const lignes = brut.split("\n");
    for (let i = 1; i < lignes.length; i++) {
      const l = lignes[i].replace(/\r$/, "");
      if (!l) continue;
      const ch = champsCsv(l);
      if (ch.length < 7) continue;
      // La référence est TOUJOURS le dernier champ (des virgules peuvent
      // traîner dans titre malgré les quotes — leçon de l'import initial).
      const reference = ch[ch.length - 1].trim();
      const doc: DocCuramed = {
        nom: ch[0],
        prenom: ch[1],
        ddn: versYmd(ch[2]),
        titre: ch.slice(3, ch.length - 3).join(","),
        date: versYmd(ch[ch.length - 3]),
        type: ch[ch.length - 2],
        reference,
      };
      const cle = cleIdentite(doc.nom, doc.prenom, doc.ddn);
      const tab = idx.get(cle);
      if (tab) tab.push(doc);
      else idx.set(cle, [doc]);
    }
    indexCache = idx;
  } catch {
    // Stock absent (dev local, volume non monté…) : recherche vide.
    indexCache = idx;
  }
  return idx;
}

// ── Sélection (PUR) ────────────────────────────────────────────────────────
const MOTS_IMAGERIE = [
  "scanner",
  "ct",
  "irm",
  "mri",
  "radio",
  "radiographie",
  "echo",
  "echographie",
  "ultrason",
  "pet",
  "scinti",
  "angio",
  "mammo",
];
const JOUR_MS = 86_400_000;

function ymdMs(ymd: string): number | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  return Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(4, 6)) - 1,
    Number(ymd.slice(6, 8))
  );
}

/**
 * Sélectionne le(s) CR pertinents parmi les documents d'un patient :
 * proximité de date avec l'examen (le CR est écrit de J à J+21), mention
 * d'imagerie dans le titre, région anatomique concordante, mention de la
 * date d'examen dans le titre (« … du 08.12.25 »). Seuil conservateur :
 * mieux vaut ne rien joindre que joindre le mauvais document.
 */
export function selectionnerCrDocs(
  docs: DocCuramed[],
  examDatesYmd: string[],
  descriptionDemande: string
): (DocCuramed & { score: number })[] {
  const regsDemande = regionsDe(descriptionDemande);
  const datesMs = examDatesYmd
    .map(ymdMs)
    .filter((x): x is number => x !== null);

  const scores = docs.map(doc => {
    let score = 0;
    const titre = normaliser(doc.titre);

    const imagerie = MOTS_IMAGERIE.some(m =>
      new RegExp(`(^|[^a-z])${m}($|[^a-z])`).test(titre)
    );
    if (imagerie) score += 2;

    if (regsDemande.size) {
      const regsTitre = regionsDe(doc.titre);
      const intersecte = Array.from(regsTitre).some(r => regsDemande.has(r));
      if (intersecte) score += 3;
      else if (regsTitre.size) score -= 3; // autre région : contre-indice fort
    }

    const docMs = ymdMs(doc.date);
    if (docMs !== null && datesMs.length) {
      const deltaJ = Math.min(
        ...datesMs.map(d => Math.abs(docMs - d) / JOUR_MS)
      );
      if (deltaJ <= 2) score += 2;
      else if (deltaJ <= 21) score += 1;
      else score -= 2; // document éloigné de l'examen
    }

    // « … du 08.12.25 » / « du 08.12.2025 » dans le titre = date d'examen.
    for (const d of examDatesYmd) {
      const jj = d.slice(6, 8);
      const mm = d.slice(4, 6);
      const aa = d.slice(2, 4);
      if (
        titre.includes(`${jj}.${mm}.${aa}`) ||
        titre.includes(`${jj}.${mm}.${d.slice(0, 4)}`)
      ) {
        score += 3;
        break;
      }
    }

    const type = normaliser(doc.type);
    if (type === "radiologie" || type === "rapport") score += 1;

    return { ...doc, score };
  });

  return scores
    .filter(d => d.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ── Recherche complète (identité → docs → fichiers) ────────────────────────
async function cheminDuDocument(reference: string): Promise<string | null> {
  // Convention du crawl API : files/api/<2 premiers caractères>/<ref>__… ;
  // repli : sous-dossiers de files/ (imports zip).
  const candidatsDirs = [
    join(CURAMED_DIR, "files", "api", reference.slice(0, 2)),
    join(CURAMED_DIR, "files"),
  ];
  for (const dir of candidatsDirs) {
    try {
      const fichiers = await fs.readdir(dir);
      const hit = fichiers.find(
        f => f.startsWith(`${reference}__`) && f.toLowerCase().endsWith(".pdf")
      );
      if (hit) return join(dir, hit);
    } catch {
      /* dossier absent : essayer le suivant */
    }
  }
  return null;
}

export type CrTrouve = {
  titre: string;
  date: string;
  reference: string;
  chemin: string;
};

/**
 * CR curaMED d'un patient pour des examens donnés. Identité = celle du
 * DOSSIER MediView matché (déchiffrée), jamais le texte du mail assureur.
 */
export async function chercherCrCuramed(args: {
  nom: string;
  prenom: string;
  ddnDigits: string; // YYYYMMDD
  examDatesYmd: string[];
  descriptionDemande: string;
}): Promise<CrTrouve[]> {
  const idx = await chargerIndex();
  const docs = [
    ...(idx.get(cleIdentite(args.nom, args.prenom, args.ddnDigits)) ?? []),
    ...(idx.get(cleIdentite(args.prenom, args.nom, args.ddnDigits)) ?? []),
  ];
  if (!docs.length) return [];
  const retenus = selectionnerCrDocs(
    docs,
    args.examDatesYmd,
    args.descriptionDemande
  );
  const out: CrTrouve[] = [];
  for (const d of retenus) {
    const chemin = await cheminDuDocument(d.reference);
    if (chemin) {
      out.push({
        titre: d.titre,
        date: d.date,
        reference: d.reference,
        chemin,
      });
    }
  }
  return out;
}

export async function lireCrPdf(chemin: string): Promise<Buffer> {
  // Garde chemin : uniquement sous le stock curaMED monté RO.
  if (!chemin.startsWith(CURAMED_DIR)) {
    throw new Error("chemin CR hors du stock curaMED");
  }
  return fs.readFile(chemin);
}
