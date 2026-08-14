import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
// Import du module interne : l'index.js de pdf-parse@1.1.1 contient un bloc
// debug (`!module.parent`) qui, une fois bundlé par esbuild, tente de lire son
// fichier de test au démarrage → crash ENOENT en prod (vécu le 13.08.2026).
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { rasteriserPdf } from "./pdfRaster";
import { etudesSansImages, MOTIF_IMAGES_A_RAPATRIER } from "./backfill";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { storagePut, storageGetBuffer } from "../storage";
import { sendEmail } from "../email";
import { ENV } from "../_core/env";
import { insurerRequests } from "../../drizzle/schema";
import { extraireDemande } from "./extractRequest";
import { matchPatient, matchStudies } from "./matchPatient";
import { decideEnvoiAuto, envoyerReponse } from "./packageAndSend";
import { normaliserAdresseUnique } from "./adresseUnique";
import type { ExtractionDemande } from "./types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const INTERVALLE_MS = 2 * 60 * 1000;
const LONGUEUR_MAX_TEXTE = 20_000;
const PDF_MIN_CARACTERES = 80;

// Nombre de passes (2 min chacune) tentées sur un message IMAP en échec avant
// abandon. Le compteur vit pour toute la durée du process (persiste entre les
// appels de `traiterBoite`, un par passe) — c'est tout l'intérêt : il compte
// des ÉCHECS SUR PLUSIEURS PASSES, pas des tentatives dans une même passe.
// Clé = UID IMAP (stable pour la durée d'une session sur une boîte donnée ;
// non garanti après un changement d'UIDVALIDITY, cas limite non couvert).
const RETRY_MAX = 3;
const echecsParMessage = new Map<number, number>();

const MAX_TAILLE_PJ_OCTETS = 25 * 1024 * 1024; // 25 Mo par pièce jointe
const MAX_TOTAL_PJ_OCTETS = 100 * 1024 * 1024; // 100 Mo cumulés par message

export const MOTIF_PDF_SCANNE = "PDF scanné non lisible automatiquement";

// Marqueur générique posé dans `corpsTexte` par `traiterBoite`/`stockerPiecesJointes`
// pour signaler un motif qui doit FORCER le passage en validation humaine
// (PDF scanné illisible, PJ trop volumineuse ignorée, image d'un type non
// exploitable pour la vision…). `traiterDemande` (appelé plus tard, sur un
// requestId relu en base — il n'y a pas de colonne dédiée pour porter ces
// motifs avant l'écriture de `motifValidation`) extrait tous les marqueurs,
// les retire du texte transmis à l'extraction LLM (ni contenu de l'assureur
// ni instruction pour le LLM) et les ajoute aux motifs de validation — leur
// seule présence, quelle qu'elle soit, empêche TOUJOURS l'envoi automatique.
const REGEX_MOTIF_PJ = /\[\[MOTIF:([^\]]*)\]\]/g;

function marqueurMotif(motif: string): string {
  return `[[MOTIF:${motif}]]`;
}

// `nom`/`mime` viennent de l'en-tête d'une pièce jointe — contenu du mail,
// donc non fiable (attaquant potentiel) : bornés pour ne pas laisser un
// libellé de header démesuré gonfler `corpsTexte`/le mail de notification.
const LONGUEUR_MAX_LIBELLE_PJ = 120;

function tronquer(s: string): string {
  return s.length > LONGUEUR_MAX_LIBELLE_PJ
    ? `${s.slice(0, LONGUEUR_MAX_LIBELLE_PJ)}…`
    : s;
}

function motifPjVolumineuse(nom: string, octets: number): string {
  const mo = (octets / (1024 * 1024)).toFixed(1);
  return `Pièce jointe trop volumineuse ignorée (${tronquer(nom)}, ${mo} Mo)`;
}

function motifLimiteTotale(nom: string): string {
  return `Pièce jointe ignorée, limite cumulée des pièces jointes atteinte (${tronquer(nom)})`;
}

function motifImageNonExploitable(mime: string): string {
  return `Pièce jointe image non exploitable automatiquement (${tronquer(mime)})`;
}

/**
 * Échappe une valeur avant interpolation HTML (mail de notification au
 * gérant) — mêmes règles que `esc()` de `server/email.ts` (copie locale,
 * pas d'export partagé, cf. la même convention dans `packageAndSend.ts`).
 * Les motifs peuvent porter du contenu dérivé du mail (nom de fichier de
 * PJ, type MIME) : jamais interpolés bruts dans le HTML.
 */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EXT_PAR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};
const MIME_PAR_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_PAR_MIME).map(([mime, ext]) => [ext, mime])
);

function messageErreur(err: unknown, defaut: string): string {
  return err instanceof Error && err.message ? err.message : defaut;
}

function adresseDe(
  v: ParsedMail["from"] | ParsedMail["replyTo"]
): string | null {
  const a = v?.value?.[0]?.address;
  return a ? a.trim().toLowerCase() : null;
}

/**
 * Stocke les pièces jointes d'un message dans MinIO sous `insurer/<requestId>/…` :
 * images `image/*` de type reconnu telles quelles (destinées à l'extraction
 * vision), PDF via `pdf-parse` — texte concaténé au corps si ≥80 caractères,
 * sinon PDF scanné (stocké seul + motif posé). Une PJ >25 Mo, ou qui ferait
 * dépasser 100 Mo cumulés sur le message, est IGNORÉE (jamais stockée) + motif
 * posé. Une image d'un type non reconnu (heic, svg…) est archivée mais motif
 * posé (invisible pour la vision, cf. `MIME_PAR_EXT`). Chaque motif force la
 * validation humaine en aval (cf. `REGEX_MOTIF_PJ`).
 */
async function stockerPiecesJointes(
  requestId: number,
  attachments: ParsedMail["attachments"]
): Promise<{ attachmentKeys: string[]; ajoutTexte: string }> {
  const attachmentKeys: string[] = [];
  let ajoutTexte = "";
  let imgIdx = 0;
  let docIdx = 0;
  let autreIdx = 0;
  let totalOctets = 0;

  for (const att of attachments) {
    const contentType = (att.contentType || "").toLowerCase();
    const content = att.content as Buffer;
    const nom = att.filename || `pièce-jointe-${attachmentKeys.length + 1}`;

    if (content.length > MAX_TAILLE_PJ_OCTETS) {
      console.warn(
        `[insurer] PJ ignorée (trop volumineuse) : ${nom}, ${content.length} octets`
      );
      ajoutTexte += `\n\n${marqueurMotif(motifPjVolumineuse(nom, content.length))}`;
      continue;
    }
    if (totalOctets + content.length > MAX_TOTAL_PJ_OCTETS) {
      console.warn(`[insurer] PJ ignorée (cumul du message >100 Mo) : ${nom}`);
      ajoutTexte += `\n\n${marqueurMotif(motifLimiteTotale(nom))}`;
      continue;
    }

    if (contentType.startsWith("image/")) {
      const ext = EXT_PAR_MIME[contentType];
      if (!ext) {
        // Type image non mappé (heic, svg…) : archivé pour dossier, mais
        // l'extension de stockage ne matchera aucune entrée de
        // `MIME_PAR_EXT` — invisible pour la vision côté `traiterDemande`.
        console.warn(
          `[insurer] image de type non exploitable automatiquement : ${contentType}`
        );
        ajoutTexte += `\n\n${marqueurMotif(motifImageNonExploitable(contentType))}`;
        const { key } = await storagePut(
          `insurer/${requestId}/piece-${autreIdx++}`,
          content,
          contentType || "application/octet-stream"
        );
        attachmentKeys.push(key);
        totalOctets += content.length;
        continue;
      }
      const { key } = await storagePut(
        `insurer/${requestId}/img-${imgIdx++}.${ext}`,
        content,
        contentType
      );
      attachmentKeys.push(key);
      totalOctets += content.length;
      continue;
    }

    if (contentType === "application/pdf") {
      const { key } = await storagePut(
        `insurer/${requestId}/doc-${docIdx++}.pdf`,
        content,
        "application/pdf"
      );
      attachmentKeys.push(key);
      totalOctets += content.length;
      let texte = "";
      try {
        const resultat = await pdfParse(content);
        texte = (resultat.text || "").trim();
      } catch (err) {
        console.warn(
          "[insurer] échec lecture PDF (pdf-parse) :",
          messageErreur(err, String(err))
        );
      }
      if (texte.length >= PDF_MIN_CARACTERES) {
        ajoutTexte += `\n\n${texte}`;
        continue;
      }
      // PDF sans couche texte (scan de la photocopieuse) : rastériser les
      // pages en PNG stockés comme des images de PJ — `traiterDemande` les
      // relira par extension et les passera à l'extraction vision. Le motif
      // « PDF scanné » n'est posé QUE si la rastérisation ne produit rien
      // (pdftoppm absent, PDF corrompu…) : il force la validation humaine.
      let pages: Buffer[] = [];
      try {
        pages = await rasteriserPdf(content);
      } catch (err) {
        console.warn(
          "[insurer] échec rastérisation PDF scanné :",
          messageErreur(err, String(err))
        );
      }
      if (!pages.length) {
        ajoutTexte += `\n\n${marqueurMotif(MOTIF_PDF_SCANNE)}`;
        continue;
      }
      for (const page of pages) {
        if (totalOctets + page.length > MAX_TOTAL_PJ_OCTETS) {
          console.warn(
            "[insurer] pages rastérisées ignorées (cumul du message >100 Mo)"
          );
          break;
        }
        const { key } = await storagePut(
          `insurer/${requestId}/img-${imgIdx++}.png`,
          page,
          "image/png"
        );
        attachmentKeys.push(key);
        totalOctets += page.length;
      }
      continue;
    }

    const { key } = await storagePut(
      `insurer/${requestId}/piece-${autreIdx++}`,
      content,
      contentType || "application/octet-stream"
    );
    attachmentKeys.push(key);
    totalOctets += content.length;
  }

  return { attachmentKeys, ajoutTexte };
}

/**
 * Traite UN message IMAP déjà parsé : idempotence (skip si `messageId` déjà en
 * base), création de la ligne + stockage du corps et des pièces jointes.
 * Retourne `"creee"` pour une nouvelle ligne, `"doublon"` si déjà connue.
 * LÈVE si le message n'a pas de Message-ID exploitable (idempotence non
 * garantissable) ou en cas d'échec technique (DB indisponible…) — c'est
 * `traiterBoite` qui décide, sur cette exception, de retenter ou d'abandonner
 * (cf. `RETRY_MAX`) : cette fonction ne doit donc PAS avaler ces erreurs.
 */
async function traiterMessage(
  db: Db,
  parsed: ParsedMail
): Promise<"creee" | "doublon"> {
  const messageId = parsed.messageId || null;
  if (!messageId) {
    throw new Error("Message-ID absent : idempotence non garantissable");
  }

  const existants = await db
    .select()
    .from(insurerRequests)
    .where(eq(insurerRequests.messageId, messageId))
    .limit(1);
  if (existants.length) return "doublon";

  const from = adresseDe(parsed.from) || "";
  const replyTo = adresseDe(parsed.replyTo);
  // INSURER_REPLY_TO : destination unique forcée (le gérant envoie toujours à
  // la même adresse SUVA) — prime sur le Reply-To/From du mail transféré.
  const adresseReponse =
    normaliserAdresseUnique(ENV.insurerReplyTo) || replyTo || from || null;
  const texteBase = (parsed.text || "").slice(0, LONGUEUR_MAX_TEXTE);

  await db.insert(insurerRequests).values({
    messageId,
    expediteur: from,
    sujet: (parsed.subject || "").slice(0, 512) || null,
    recuLe: parsed.date ?? new Date(),
    statut: "recue",
    corpsTexte: texteBase,
    attachmentKeys: [],
    adresseReponse,
  });

  // Le repo ne dépend pas de l'insertId du driver MySQL (cf. convention du
  // reste du code, ex. routers.ts) : on relit la ligne par sa clé unique.
  const relues = await db
    .select()
    .from(insurerRequests)
    .where(eq(insurerRequests.messageId, messageId))
    .limit(1);
  const row = relues[0];
  if (!row) return "creee"; // créée mais introuvable : ne bloque pas le comptage

  const attachments = (parsed.attachments || []) as ParsedMail["attachments"];
  if (attachments.length) {
    try {
      const { attachmentKeys, ajoutTexte } = await stockerPiecesJointes(
        row.id,
        attachments
      );
      await db
        .update(insurerRequests)
        .set({
          attachmentKeys,
          corpsTexte: `${texteBase}${ajoutTexte}`,
        })
        .where(eq(insurerRequests.id, row.id));
    } catch (err) {
      // Best-effort : la ligne existe déjà (corps mail seul), une pièce
      // jointe indisponible ne doit pas faire perdre la demande.
      console.error(
        "[insurer] échec stockage pièces jointes :",
        messageErreur(err, String(err))
      );
    }
  }

  return "creee";
}

/**
 * Connecte à la boîte IMAP dédiée assureur, liste les messages non lus, crée
 * une ligne `insurerRequests` par nouveau message (idempotence sur
 * `messageId`) et les marque lus. Ne lève jamais.
 *
 * Un message en échec (parsing, DB…) n'est PAS marqué lu : il est retenté à
 * la passe suivante (2 min), jusqu'à `RETRY_MAX` échecs — au-delà, il est
 * marqué lu et une ligne dead-letter (`statut erreur`) est créée pour rester
 * visible dans l'UI, plutôt que de reboucler indéfiniment sur un message qui
 * ne passera jamais (poison message).
 */
export async function traiterBoite(): Promise<number> {
  if (!ENV.insurerImapHost) return 0;
  const db = await getDb();
  if (!db) return 0;

  let count = 0;
  let client: ImapFlow;
  try {
    client = new ImapFlow({
      host: ENV.insurerImapHost,
      port: ENV.insurerImapPort,
      // TLS pour l'IMAP public (993). Port 143 = Mailu interne sur le réseau
      // docker du VPS médical (jamais exposé) : en clair, comme mysql-medical.
      // doSTARTTLS:false car le Dovecot interne de Mailu ANNONCE STARTTLS mais
      // son upgrade échoue (le TLS est terminé par le front) — vécu le 13.08.2026.
      secure: ENV.insurerImapPort === 993,
      doSTARTTLS: ENV.insurerImapPort === 993 ? undefined : false,
      auth: { user: ENV.insurerImapUser, pass: ENV.insurerImapPass },
      logger: false,
    });
    await client.connect();
  } catch (err) {
    console.error(
      "[insurer] connexion IMAP échouée :",
      messageErreur(err, String(err))
    );
    return 0;
  }

  try {
    const lock = await client.getMailboxLock(ENV.insurerImapMailbox);
    try {
      // PHASE 1 — collecte : on épuise l'itérateur fetch SANS émettre d'autre
      // commande IMAP. Appeler messageFlagsAdd pendant le fetch interbloque
      // imapflow (la passe restait suspendue, connexion ouverte — vécu 13.08.2026).
      const messages: { uid: number; source?: Buffer }[] = [];
      for await (const msg of client.fetch(
        { seen: false },
        { source: true, uid: true }
      )) {
        messages.push({ uid: msg.uid, source: msg.source });
      }
      // PHASE 2 — traitement + marquage, une fois le fetch terminé.
      for (const msg of messages) {
        try {
          if (!msg.source) {
            throw new Error("message IMAP sans corps (source manquant)");
          }
          const parsed = await simpleParser(msg.source);
          const resultat = await traiterMessage(db, parsed);
          if (resultat === "creee") count++;
          echecsParMessage.delete(msg.uid);
          try {
            await client.messageFlagsAdd(msg.uid, ["\\Seen"]);
          } catch (err) {
            console.warn(
              "[insurer] échec marquage lu :",
              messageErreur(err, String(err))
            );
          }
        } catch (err) {
          const motif = messageErreur(err, String(err));
          console.error(
            `[insurer] échec traitement du message IMAP uid=${msg.uid} :`,
            motif
          );
          const tentatives = (echecsParMessage.get(msg.uid) ?? 0) + 1;
          if (tentatives < RETRY_MAX) {
            // Laissé NON LU : retenté à la prochaine passe (verrou
            // anti-réentrance + intervalle 2 min dans `demarrerPollerAssureur`).
            echecsParMessage.set(msg.uid, tentatives);
            continue;
          }
          // Abandon après RETRY_MAX passes en échec : dead-letter visible +
          // marqué lu pour ne pas reboucler indéfiniment.
          echecsParMessage.delete(msg.uid);
          try {
            await db.insert(insurerRequests).values({
              messageId: `sans-traitement:uid-${msg.uid}:${Date.now()}`,
              expediteur: "inconnu",
              sujet: null,
              recuLe: new Date(),
              statut: "erreur",
              corpsTexte: null,
              attachmentKeys: [],
              adresseReponse: null,
              erreur: `Abandonné après ${RETRY_MAX} tentatives : ${motif}`,
            });
            count++;
          } catch (err2) {
            console.error(
              "[insurer] échec création de la ligne dead-letter :",
              messageErreur(err2, String(err2))
            );
          }
          try {
            await client.messageFlagsAdd(msg.uid, ["\\Seen"]);
          } catch (err2) {
            console.warn(
              "[insurer] échec marquage lu (dead-letter) :",
              messageErreur(err2, String(err2))
            );
          }
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(
      "[insurer] échec lecture de la boîte :",
      messageErreur(err, String(err))
    );
  } finally {
    await client.logout().catch(() => {});
  }

  return count;
}

/**
 * Pipeline complet d'une demande déjà en base : extraction LLM → matching
 * patient/études → décision d'envoi automatique → envoi, OU passage en
 * validation humaine (statut `a_valider` + motifs persistés + notification
 * au gérant). Toute exception ⇒ statut `erreur` + colonne `erreur`, ne
 * rejette jamais (l'agent ne doit jamais faire tomber le serveur).
 */
export async function traiterDemande(requestId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const echouer = async (motif: string) => {
    try {
      await db
        .update(insurerRequests)
        .set({ statut: "erreur", erreur: motif })
        .where(eq(insurerRequests.id, requestId));
    } catch (err) {
      console.error(
        "[insurer] échec écriture du statut erreur :",
        messageErreur(err, String(err))
      );
    }
  };

  try {
    const rows = await db
      .select()
      .from(insurerRequests)
      .where(eq(insurerRequests.id, requestId))
      .limit(1);
    const row = rows[0];
    if (!row) return;

    const corpsTexteBrut = row.corpsTexte || "";
    // Motifs posés par `stockerPiecesJointes` (PDF scanné, PJ trop
    // volumineuse, image non exploitable…) : extraits puis retirés du texte
    // avant qu'il n'atteigne l'extraction LLM (ni contenu assureur, ni
    // instruction pour le modèle).
    let motifsPieces = Array.from(
      corpsTexteBrut.matchAll(REGEX_MOTIF_PJ),
      m => m[1]
    );
    const texte = corpsTexteBrut.replace(REGEX_MOTIF_PJ, "").trim();

    // Les images à soumettre à la vision sont relues depuis MinIO par clé.
    // Aucune re-vérification de taille ici : seules des PJ déjà bornées par
    // `MAX_TAILLE_PJ_OCTETS`/`MAX_TOTAL_PJ_OCTETS` à l'ingestion
    // (`stockerPiecesJointes`) ont pu être stockées, donc `attachmentKeys`
    // ne référence jamais un objet surdimensionné.
    const images: { data: Buffer; mime: string }[] = [];
    for (const key of row.attachmentKeys ?? []) {
      const ext = key.split(".").pop()?.toLowerCase() ?? "";
      const mime = MIME_PAR_EXT[ext];
      if (!mime) continue; // PDF ou autre PJ non image : hors vision
      try {
        const data = await storageGetBuffer(key);
        images.push({ data, mime });
      } catch (err) {
        console.warn(
          "[insurer] échec lecture PJ image :",
          messageErreur(err, String(err))
        );
      }
    }

    // Rattrapage : les demandes reçues AVANT le déploiement de la rastérisation
    // ont un PDF scanné stocké (doc-N.pdf) mais aucune image → extraction vide
    // et motif « PDF scanné ». Au re-traitement, on rastérise ces PDF stockés,
    // on stocke les pages en PNG et on les ajoute à `attachmentKeys` (persisté)
    // pour que la vision puisse enfin les lire. Idempotent : une fois les PNG
    // présents, cette branche ne se redéclenche pas.
    if (images.length === 0) {
      const clesPdf = (row.attachmentKeys ?? []).filter(k =>
        k.toLowerCase().endsWith(".pdf")
      );
      const nouvellesCles: string[] = [];
      let idxImg = 0;
      for (const clePdf of clesPdf) {
        try {
          const pdf = await storageGetBuffer(clePdf);
          const pages = await rasteriserPdf(pdf);
          for (const page of pages) {
            const { key } = await storagePut(
              `insurer/${requestId}/reimg-${idxImg++}.png`,
              page,
              "image/png"
            );
            nouvellesCles.push(key);
            images.push({ data: page, mime: "image/png" });
          }
        } catch (err) {
          console.warn(
            "[insurer] échec rastérisation PDF stocké au re-traitement :",
            messageErreur(err, String(err))
          );
        }
      }
      if (nouvellesCles.length) {
        const cumulees = [...(row.attachmentKeys ?? []), ...nouvellesCles];
        row.attachmentKeys = cumulees;
        await db
          .update(insurerRequests)
          .set({ attachmentKeys: cumulees })
          .where(eq(insurerRequests.id, requestId));
      }
    }

    // Le marqueur « PDF scanné non lisible » posé à l'ingestion devient faux dès
    // qu'on a des images à soumettre à la vision (rastérisées à l'instant OU
    // PNG déjà présents d'un re-traitement précédent) : on le retire de
    // `corpsTexte` (persisté) et des motifs du tour, pour ne pas afficher
    // « illisible » sur un scan qui a été lu.
    if (images.length > 0 && motifsPieces.includes(MOTIF_PDF_SCANNE)) {
      motifsPieces = motifsPieces.filter(m => m !== MOTIF_PDF_SCANNE);
      const corpsNettoye = (row.corpsTexte || "").replace(
        marqueurMotif(MOTIF_PDF_SCANNE),
        ""
      );
      row.corpsTexte = corpsNettoye;
      await db
        .update(insurerRequests)
        .set({ corpsTexte: corpsNettoye })
        .where(eq(insurerRequests.id, requestId));
    }

    let extraction: ExtractionDemande;
    try {
      extraction = await extraireDemande({ texte, images });
    } catch (err) {
      await echouer(
        `Extraction échouée : ${messageErreur(err, "erreur inconnue")}`
      );
      return;
    }

    await db
      .update(insurerRequests)
      .set({ statut: "extraite", extraction })
      .where(eq(insurerRequests.id, requestId));

    const matchP = await matchPatient(extraction.patient);
    const matchS =
      matchP.statut === "exact" && matchP.patientId
        ? await matchStudies(matchP.patientId, extraction.exams)
        : { tousTrouves: false, datesExactes: false, parExamen: [] };
    const studyIds = matchS.parExamen.flatMap(e => e.studyIds);

    await db
      .update(insurerRequests)
      .set({
        statut: "identifiee",
        patientId: matchP.patientId,
        studyIds,
      })
      .where(eq(insurerRequests.id, requestId));

    // Précédence : adresse extraite par le LLM (contenu du mail, non fiable)
    // si présente et VALIDE (une seule adresse plausible), sinon l'adresse de
    // réponse déjà persistée (Reply-To/From du mail lui-même, cf.
    // `traiterMessage`, elle aussi normalisée par défense en profondeur).
    // Elle ne sert QUE de cible d'envoi et d'entrée du contrôle de domaine
    // dans `decideEnvoiAuto` — aucun autre usage (pas d'identification
    // patient, pas de journalisation dédiée).
    //
    // Garde anti-smuggling (audit C1) : `extraction.adresseReponse` est du
    // texte libre lu par le LLM dans le CORPS du mail — un attaquant qui se
    // fait passer pour l'assureur peut y écrire une liste
    // ("attacker@evil.com, dossier@suva.ch") pour se faire mettre en copie
    // du colis DICOM+CR. Si l'adresse extraite existe mais échoue la
    // normalisation (pas une adresse unique), elle n'est JAMAIS utilisée —
    // motif posé pour forcer `a_valider` (jamais d'auto-envoi silencieux
    // avec repli), et on retombe sur l'adresse déjà persistée à l'ingestion.
    const motifsAdresse: string[] = [];
    const adresseExtraiteNormalisee = normaliserAdresseUnique(
      extraction.adresseReponse
    );
    const adresseForcee = normaliserAdresseUnique(ENV.insurerReplyTo);
    let adresseReponse: string | null;
    if (adresseForcee) {
      // Destination unique forcée (INSURER_REPLY_TO) : l'adresse lue dans le
      // courrier n'est jamais utilisée — supprime aussi la surface d'attaque
      // « adresse smugglée dans le corps du mail » tant que l'option est posée.
      adresseReponse = adresseForcee;
    } else if (extraction.adresseReponse && !adresseExtraiteNormalisee) {
      motifsAdresse.push("Adresse de réponse invalide ou multiple");
      adresseReponse = normaliserAdresseUnique(row.adresseReponse);
    } else {
      adresseReponse =
        adresseExtraiteNormalisee ??
        normaliserAdresseUnique(row.adresseReponse);
    }

    const decision = decideEnvoiAuto({
      expediteur: row.expediteur,
      matchPatientStatut: matchP.statut,
      tousTrouves: matchS.tousTrouves,
      datesExactes: matchS.datesExactes,
      adresseReponse,
      env: {
        trustedSenders: ENV.insurerTrustedSenders,
        autoSendDomains: ENV.insurerAutoSendDomains,
      },
    });

    // Garde anti-colis-vide (backfill) : si une étude trouvée est une fiche
    // méta-seule (images pas encore rapatriées du PACS), on ne peut pas encore
    // constituer le colis — motif posé, envoi auto bloqué, la passerelle du
    // cabinet rapatriera les images (cf. /api/insurer/etudes-a-rapatrier).
    const motifsImages =
      studyIds.length && (await etudesSansImages(studyIds))
        ? [MOTIF_IMAGES_A_RAPATRIER]
        : [];

    const motifs = [
      ...decision.motifs,
      ...motifsPieces,
      ...motifsAdresse,
      ...motifsImages,
    ];
    // Garde dure : tout motif posé au stockage des PJ (PDF scanné, PJ trop
    // volumineuse, image non exploitable…), une adresse de réponse invalide
    // (cf. `motifsAdresse`) OU des images pas encore rapatriées bloque TOUJOURS
    // l'envoi automatique, quel que soit le verdict de `decideEnvoiAuto`.
    const auto =
      decision.auto &&
      motifsPieces.length === 0 &&
      motifsAdresse.length === 0 &&
      motifsImages.length === 0;

    await db
      .update(insurerRequests)
      .set({ statut: "prete", adresseReponse })
      .where(eq(insurerRequests.id, requestId));

    if (auto) {
      // Statut final (`envoyee` ou `erreur`) géré par `envoyerReponse` elle-même.
      await envoyerReponse(requestId, {});
      return;
    }

    await db
      .update(insurerRequests)
      .set({ statut: "a_valider", motifValidation: motifs.join(" ; ") })
      .where(eq(insurerRequests.id, requestId));

    if (ENV.insurerNotifyEmail) {
      try {
        await sendEmail({
          to: ENV.insurerNotifyEmail,
          subject: "[MediView] Demande assureur à valider",
          html: `<p>Une demande d'imagerie assureur nécessite une validation manuelle (demande #${requestId}).</p><ul>${motifs
            .map(m => `<li>${esc(m)}</li>`)
            .join("")}</ul>`,
        });
      } catch (err) {
        console.warn(
          "[insurer] échec notification gérant :",
          messageErreur(err, String(err))
        );
      }
    }
  } catch (err) {
    await echouer(messageErreur(err, "Erreur technique lors du traitement"));
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let passeEnCours = false;

async function executerPasse(): Promise<void> {
  if (passeEnCours) return; // verrou anti-réentrance
  passeEnCours = true;
  try {
    await traiterBoite();
    const db = await getDb();
    if (db) {
      const enAttente = await db
        .select()
        .from(insurerRequests)
        .where(eq(insurerRequests.statut, "recue"))
        .limit(200);
      for (const row of enAttente) {
        try {
          await traiterDemande(row.id);
        } catch (err) {
          console.error(
            "[insurer] passe demande échouée :",
            messageErreur(err, String(err))
          );
        }
      }
    }
  } catch (err) {
    console.error(
      "[insurer] passe boîte échouée :",
      messageErreur(err, String(err))
    );
  } finally {
    passeEnCours = false;
  }
}

/**
 * Garde de cohérence au démarrage (audit I5) : si le poller est activé et
 * qu'au moins un domaine d'`INSURER_AUTO_SEND_DOMAINS` (condition 4 de
 * `decideEnvoiAuto`) est ABSENT de `REPORT_EMAIL_ALLOWED_DOMAINS` (garde
 * d'egress finale `isAllowedPhiRecipientStrict`, cf. `envoyerReponse`),
 * l'envoi automatique pour ce domaine échouera TOUJOURS à cette garde
 * finale — sans qu'aucune erreur ne remonte ailleurs qu'en base
 * (`insurerRequests.erreur`, invisible tant qu'on ne va pas la lire).
 * Avertissement explicite plutôt qu'un diagnostic à l'aveugle en prod.
 */
function avertirIncoherenceDomaines(): void {
  const manquants = ENV.insurerAutoSendDomains.filter(
    d => !ENV.reportEmailAllowedDomains.includes(d)
  );
  if (manquants.length > 0) {
    console.warn(
      `[insurer] INSURER_AUTO_SEND_DOMAINS contient des domaines absents de ` +
        `REPORT_EMAIL_ALLOWED_DOMAINS (${manquants.join(", ")}) : l'envoi ` +
        `automatique pour ces domaines échouera TOUJOURS à la garde d'egress ` +
        `— ajouter ces domaines à REPORT_EMAIL_ALLOWED_DOMAINS.`
    );
  }
}

/**
 * Démarre le worker périodique (2 min, verrou anti-réentrance). No-op + log
 * si `ENV.insurerImapHost` est vide (même pattern que `startAutoReportAgent`).
 * Jamais throw.
 */
export function demarrerPollerAssureur(): void {
  if (!ENV.insurerImapHost) {
    console.log("[insurer] poller IMAP désactivé (INSURER_IMAP_HOST absent)");
    return;
  }
  avertirIncoherenceDomaines();
  if (timer) return;
  timer = setInterval(() => {
    executerPasse().catch(err =>
      console.warn("[insurer] passe échouée :", messageErreur(err, String(err)))
    );
  }, INTERVALLE_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `[insurer] poller IMAP démarré (intervalle 2 min, boîte ${ENV.insurerImapMailbox})`
  );
}
