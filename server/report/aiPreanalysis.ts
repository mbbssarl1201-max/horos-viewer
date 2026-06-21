import { TRPCError } from "@trpc/server";
import { PNG } from "pngjs";
import { ENV } from "../_core/env";
import {
  getStudyById,
  listSeriesByStudy,
  countRecentAccess,
  recordAccess,
  snapshotAiEvaluation,
} from "../db";

/**
 * Réduit une image PNG (base64) à `maxDim` px sur son plus grand côté, par
 * sous-échantillonnage au plus proche voisin (pur JS, pas de dépendance native).
 * Indispensable AVANT l'envoi au VLM : sur CPU, une grande image vision coûte
 * des milliers de tokens et plusieurs minutes d'encodage. En cas d'échec de
 * décodage, renvoie l'image d'origine (best-effort).
 */
export function downscalePngBase64(b64: string, maxDim: number): string {
  try {
    const src = PNG.sync.read(Buffer.from(b64, "base64"));
    const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
    if (scale >= 1) return b64;
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const dst = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      const sy = Math.min(src.height - 1, Math.floor(y / scale));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(src.width - 1, Math.floor(x / scale));
        const si = (sy * src.width + sx) * 4;
        const di = (y * w + x) * 4;
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
    return PNG.sync.write(dst).toString("base64");
  } catch {
    return b64;
  }
}

// Côté le plus grand (px) auquel on réduit chaque coupe avant l'envoi au VLM.
// La vision tournant sur GPU (L4), on conserve la pleine résolution des coupes
// CT (512 px) ; 768 est un plafond qui n'altère pas les coupes natives.
const VISION_MAX_DIM = 768;

export interface PreanalysisKeyImage {
  pngBase64: string;
  sliceIndex: number;
  // Étiquette de la série d'origine (mode « toute l'étude ») : ex.
  // « OS Dur Vol — CT ». Permet à l'IA de structurer le CR par série.
  seriesLabel?: string;
  // Date de l'examen antérieur (mode comparaison multi-antériorités) : permet
  // d'étiqueter chaque image antérieure par sa date.
  dateLabel?: string;
}

/**
 * Répartit un budget total d'images sur N séries, pondéré par leur taille
 * (nombre de coupes), avec au moins 1 image par série tant que le budget le
 * permet. Renvoie un tableau parallèle aux poids (somme ≤ total). PUR.
 */
export function distributeImageBudget(
  weights: readonly number[],
  total: number
): number[] {
  const n = weights.length;
  if (n === 0 || total <= 0) return weights.map(() => 0);
  // Plus de séries que d'images : 1 image pour les `total` premières séries.
  if (total <= n) return weights.map((_, i) => (i < total ? 1 : 0));
  const w = weights.map(x => Math.max(1, x || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const alloc = w.map(x => Math.max(1, Math.floor((total * x) / sum)));
  let used = alloc.reduce((a, b) => a + b, 0);
  // Distribue le reliquat aux plus grosses séries d'abord.
  const order = w
    .map((x, i) => [x, i] as const)
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i);
  let k = 0;
  while (used < total) {
    alloc[order[k % n]]++;
    used++;
    k++;
  }
  // Si l'allocation dépasse (arrondis), rogne les plus grosses.
  let over = used - total;
  let j = 0;
  while (over > 0) {
    const idx = order[j % n];
    if (alloc[idx] > 1) {
      alloc[idx]--;
      over--;
    }
    j++;
    if (j > n * total) break; // garde-fou
  }
  return alloc;
}

/**
 * Une série est-elle DIAGNOSTIQUE (vraies coupes à lire) ou un sous-produit
 * technique à ignorer dans le compte rendu ? Exclut : scanogramme/topogramme/
 * localizer (vues de repérage, 1-3 images), rapports de dose (« dose report »,
 * « SUMMARY », « SR »), captures secondaires de protocole. PURE.
 *
 * Pourquoi c'est critique : sur un scanner réel, l'étude contient souvent 2-3
 * scanogrammes (2 images chacun) en PLUS des séries de coupes (des centaines
 * d'images). Si on répartit le budget d'images sur TOUTES les séries, le
 * scanogramme (inutile au diagnostic) consomme du budget et POLLUE l'analyse —
 * d'où des comptes rendus vides « aspect osseux normal » lus sur 2 vues de
 * repérage au lieu des vraies coupes.
 */
export function isDiagnosticSeries(s: {
  seriesDescription?: string | null;
  modality?: string | null;
  numberOfInstances?: number | null;
}): boolean {
  const modality = (s.modality ?? "").trim().toUpperCase();
  // Modalités non-image / rapports : jamais des coupes à lire.
  if (["SR", "PR", "KO", "DOC", "OT"].includes(modality)) return false;
  const desc = (s.seriesDescription ?? "").toLowerCase();
  // Mots-clés de séries techniques (FR/EN) à exclure.
  const technical =
    /scano|topogram|topogramme|localizer|localiser|scout|surview|dose\s*report|dose\s*info|patient\s*protocol|summary|screen\s*save|secondary\s*capture|key\s*image/;
  if (technical.test(desc)) return false;
  // Série minuscule (≤3 images) ET intitulé évoquant un repérage : on exclut.
  // (On ne filtre PAS sur la seule taille : une vraie petite série localisée
  //  peut être pertinente ; c'est la combinaison taille+intitulé qui tranche.)
  return true;
}

/**
 * Sélectionne les séries à analyser dans une étude : garde les séries
 * DIAGNOSTIQUES ; si le filtre élimine TOUT (étude atypique), renvoie la liste
 * d'origine (jamais zéro — mieux vaut analyser que ne rien produire). PURE.
 */
export function selectDiagnosticSeries<
  T extends {
    seriesDescription?: string | null;
    modality?: string | null;
    numberOfInstances?: number | null;
  },
>(series: readonly T[]): T[] {
  const kept = series.filter(isDiagnosticSeries);
  return kept.length > 0 ? kept : series.slice();
}

export interface PreanalysisResult {
  technique: string;
  resultats: string;
  conclusion: string;
  model: string;
  // Coupe (numéro d'instance) désignée par l'IA comme montrant le mieux
  // l'anomalie, ou null si aucune anomalie / non fourni.
  keySliceNumber?: number | null;
  // L'IA a-t-elle repéré une anomalie ? (null si non précisé)
  abnormal?: boolean | null;
  // Verdict d'évolution comparative (mode antériorité) ; null hors comparaison.
  evolution?: "stable" | "progression" | "regression" | null;
}

// Cœur commun à TOUTES les modalités (méthode, prudence, lecture des repères
// incrustés, format de sortie). Le bloc spécifique à la modalité est inséré
// entre l'en-tête et le pied (cf. buildSystemPrompt) — c'est lui qui adapte le
// vocabulaire (échographie ≠ scanner) et évite les contresens (« structures
// osseuses » sur une écho).
const PROMPT_HEADER = [
  "Tu es un RADIOLOGUE SENIOR (30 ans d'expérience), méthodique, rigoureux et prudent. Tu réalises une pré-analyse d'imagerie pour aider UN MÉDECIN à rédiger son compte rendu. Tu produis un BROUILLON en français, destiné à être relu, corrigé et SIGNÉ par le médecin (tu n'es pas certifié dispositif médical).",
  "",
  "Démarche d'expert (applique-la en silence, ne restitue QUE les sections demandées en fin de réponse) :",
  "1. Identifie la modalité, la région et l'organe exploré (texte incrusté).",
  "2. Passe en revue chaque structure/organe de façon SYSTÉMATIQUE et ordonnée — ne te limite pas à la première chose vue.",
  "3. Pour chaque structure, compare à l'aspect NORMAL attendu (taille, échostructure/densité/signal, contours, symétrie) et recherche ACTIVEMENT les signes pathologiques.",
  "4. Si tu vois une anomalie, caractérise-la (localisation, taille si lisible, nature) et propose un diagnostic différentiel PRUDENT.",
  "5. Conclus en pondérant tes observations ; signale ce qui nécessite confirmation ou imagerie complémentaire.",
  "",
  "Méthode :",
  "- On te fournit un ÉCHANTILLON d'images/coupes de l'examen (numérotées) pour une vue d'ensemble. Raisonne sur l'ensemble ; tu ne vois pas tout, reste prudent sur ce qui pourrait se trouver entre deux images fournies.",
  "- Parcours les images une à une ; si tu repères une anomalie, IDENTIFIE le NUMÉRO de l'image qui la montre le mieux. MÊME EN L'ABSENCE D'ANOMALIE, choisis toujours l'image la plus représentative/informative, à joindre au compte rendu.",
  "- LIS le TEXTE incrusté dans l'image (organe exploré, latéralité, repère anatomique) ET les CURSEURS/MESURES éventuels (croix « + », repères « 1 », « 2 », pointillés, valeurs en cm/mm). Si une structure est ENTOURÉE DE CURSEURS, c'est qu'elle est MESURÉE donc jugée pertinente par l'opérateur : tu DOIS la décrire dans les Résultats et tu ne peux PAS conclure « aucune anomalie » en présence d'une lésion mesurée à l'écran.",
  "- Reste DESCRIPTIF : ne nomme une pathologie précise QUE si le signe est franc et clairement visible ; sinon décris l'anomalie et formule une hypothèse PRUDENTE.",
  "- Ne sur-interprète pas, MAIS ne passe JAMAIS sous silence une lésion focale, un kyste, un nodule, une masse, un épanchement, une dilatation ou toute structure mesurée à l'écran. Une fausse réassurance (« aucune anomalie » alors qu'une lésion est visible/mesurée) est plus grave qu'une réserve prudente.",
  '- N\'invente AUCUNE mesure ni valeur chiffrée que tu ne lis pas à l\'écran. Exprime toujours l\'incertitude ("aspect évocateur de", "à corréler à la clinique", "sous réserve des images non fournies").',
  "- Si des ANTÉCÉDENTS médicaux du patient sont fournis, relie EXPLICITEMENT tes observations et ta conclusion à ces antécédents (évolution, complication, récidive) — sans inventer d'antécédent non fourni.",
  "- N'identifie jamais le patient et n'invente aucun contexte clinique.",
].join("\n");

const PROMPT_FOOTER = [
  "",
  "Réponds UNIQUEMENT avec ces sections, exactement dans ce format (rien d'autre) :",
  "Technique:",
  "<description FACTUELLE et brève de l'acquisition d'après la modalité. N'invente NI produit de contraste, NI paramètres s'ils ne sont pas fournis.>",
  "",
  "Résultats:",
  "<description structurée de ce qui est visible sur l'ensemble des images>",
  "",
  "Conclusion:",
  "<synthèse prudente, hypothèses à confirmer>",
  "",
  "Anomalie:",
  "<oui ou non — y a-t-il une anomalie clairement visible, OU une lésion/structure mesurée à l'écran (curseurs) ?>",
  "",
  "Coupe-clé:",
  "<le NUMÉRO d'UNE des images fournies à joindre au compte rendu : celle qui montre le mieux l'anomalie si tu en repères une, SINON l'image la plus représentative. Donne TOUJOURS un numéro parmi les images fournies — jamais « aucune ».>",
].join("\n");

// Bloc de checklist + mises en garde PROPRE à la modalité. C'est ici qu'on évite
// d'appliquer les hypothèses du scanner (os, fenêtre osseuse) à une échographie.
export function modalityBlock(modality?: string): string {
  const m = (modality ?? "").trim().toUpperCase();
  if (m === "US")
    return [
      "MODALITÉ : ÉCHOGRAPHIE (ultrasons). N'emploie JAMAIS « structures osseuses » ni « fenêtre osseuse » : l'échographie ne montre pas l'os.",
      "- ÉTAPE 1 OBLIGATOIRE : IDENTIFIE LA RÉGION EXPLORÉE d'après le TEXTE INCRUSTÉ en haut/bas de l'image (nom de sonde + région), AVANT toute interprétation. Exemples de régions : SEIN/MAMMAIRE (sonde linéaire haute fréquence « 11L », « L »), THYROÏDE/COU, ABDOMEN (foie, rein, vésicule, pancréas, rate, aorte), PELVIS, VASCULAIRE/DOPPLER, PARTIES MOLLES, TESTICULE, MUSCULO-SQUELETTIQUE. NE PRÉSUME JAMAIS l'abdomen par défaut : adapte les organes recherchés à la région LUE.",
      "- Si la région est le SEIN : décris le tissu fibroglandulaire, recherche masses/nodules (forme, contours réguliers/irréguliers, orientation, échostructure, atténuation postérieure), kystes, microcalcifications, ganglions axillaires ; classe en BI-RADS si pertinent. NE cherche PAS de foie/rein.",
      "- Si la région est la THYROÏDE : lobes (taille, échostructure), nodules (composition, échogénicité, forme, contours, calcifications → EU-TIRADS si pertinent).",
      "- DOPPLER COULEUR : si des plages de COULEUR (rouge/bleu) sont présentes, c'est un Doppler de FLUX — décris la vascularisation (présente/absente, intra/périlésionnelle) ; ne confonds pas la couleur avec une lésion.",
      "- Pour chaque structure visible, décris : taille, échostructure (homogène/hétérogène), contours, et toute LÉSION FOCALE — KYSTE (anéchogène, arrondi, paroi fine, renforcement postérieur), nodule, masse, calcul (hyperéchogène + cône d'ombre), dilatation, épanchement.",
      "- Des CURSEURS de mesure (« + », « 1 », « 2 », pointillés, valeurs en mm/cm) posés sur une structure signalent une LÉSION/STRUCTURE MESURÉE : décris-la, REPORTE la valeur si lisible, et indique Anomalie = oui.",
    ].join("\n");
  if (m === "MR" || m === "MRI")
    return [
      "MODALITÉ : IRM (résonance magnétique). N'emploie PAS le concept de « fenêtre osseuse » (propre au scanner).",
      "- Décris le SIGNAL des structures selon les séquences visibles (T1/T2/FLAIR/diffusion si identifiables), les LÉSIONS FOCALES, anomalies de signal, œdème, effet de masse, et toute prise de contraste apparente.",
    ].join("\n");
  if (m === "CT")
    return [
      "MODALITÉ : SCANNER (tomodensitométrie). Décris de façon SYSTÉMATIQUE : structures osseuses, articulations/espaces, parties molles, organes, vaisseaux, et tout signe pertinent.",
      "- ATTENTION (fenêtre osseuse) : l'os cortical dense apparaît NORMALEMENT blanc/très brillant — anatomie NORMALE. Ne l'interprète JAMAIS comme une tumeur, une masse, une calcification suspecte ou un objet métallique. N'évoque « tumeur / masse / corps étranger / métal » QUE devant une lésion franchement pathologique (destruction osseuse nette, masse de parties molles évidente). En cas de doute, considère que c'est NORMAL.",
    ].join("\n");
  if (m === "CR" || m === "DX" || m === "DR" || m === "RX")
    return [
      "MODALITÉ : RADIOGRAPHIE (projection).",
      "- Décris : structures osseuses (corticales, trabéculation, alignement, recherche de trait de fracture), articulations/interlignes, parties molles, et tout épanchement, opacité ou clarté anormale.",
    ].join("\n");
  if (m === "MG")
    return [
      "MODALITÉ : MAMMOGRAPHIE. N'emploie pas le vocabulaire du scanner.",
      "- Décris : densité mammaire, masses (forme, contours), microcalcifications, distorsions architecturales, asymétries. Terminologie ACR/BI-RADS si pertinent.",
    ].join("\n");
  if (m === "PT" || m === "NM")
    return [
      "MODALITÉ : MÉDECINE NUCLÉAIRE / TEP.",
      "- Décris les foyers d'HYPERFIXATION anormale et leur localisation ; reste prudent sur l'intensité en l'absence de valeur SUV fournie.",
    ].join("\n");
  return [
    `MODALITÉ : ${m || "non précisée"}. Décris systématiquement les organes et structures visibles et tout signe pertinent, en ADAPTANT le vocabulaire à la modalité. N'emploie un terme spécifique (ex. « fenêtre osseuse ») QUE s'il correspond réellement à la modalité.`,
  ].join("\n");
}

// Prompt système complet, adapté à la modalité de l'examen.
export function buildSystemPrompt(modality?: string): string {
  return [PROMPT_HEADER, "", modalityBlock(modality), PROMPT_FOOTER].join("\n");
}

const COMPARATIVE_ADDENDUM = [
  "",
  "COMPARAISON D'ANTÉRIORITÉ :",
  "On te fournit DEUX examens du MÊME patient : l'EXAMEN ACTUEL et un EXAMEN ANTÉRIEUR (daté). Chaque coupe fournie est étiquetée par l'examen auquel elle appartient.",
  "- Compare les deux examens et décris l'ÉVOLUTION (apparition, disparition, stabilité, augmentation ou diminution d'une anomalie). Reste prudent et purement visuel : n'invente AUCUNE mesure chiffrée.",
  "- Dans la section Résultats, ajoute un paragraphe commençant par « Comparaison à l'examen du <date> : … » résumant l'évolution.",
  "- APRÈS la ligne Coupe-clé, ajoute une DERNIÈRE ligne supplémentaire, exactement à ce format :",
  "Évolution:",
  "<stable | progression | régression — l'anomalie est-elle globalement stable, en progression (aggravation/augmentation) ou en régression (amélioration/diminution) ?>",
].join("\n");

export async function generatePreanalysis(
  keyImages: PreanalysisKeyImage[],
  opts: {
    indication?: string;
    modality?: string;
    studyDescription?: string;
    antecedents?: string;
    totalSlices?: number;
    // Plafond d'images (mode approfondi) ; défaut 24 (cloud) / 16 (local).
    maxImages?: number;
    // Mesures objectives (segmentation TotalSegmentator) injectées pour ancrer le
    // rapport dans des volumes RÉELS — précision accrue, moins d'invention.
    measurements?: string;
    // Connaissances de référence (RAG) injectées comme DONNÉES : critères ACR/
    // TI-RADS/Fleischner, valeurs normales, sémiologie. Récupérées localement.
    references?: string;
    // Texte/mesures INCRUSTÉS lus par OCR (organe, valeurs cm/mm, curseurs).
    // Donnée « à vérifier » pour ancrer le rapport dans des valeurs RÉELLES.
    screenText?: string;
    prior?: {
      images: PreanalysisKeyImage[];
      date?: string;
      totalSlices?: number;
    };
  }
): Promise<PreanalysisResult> {
  const claudeConfigured = ENV.aiBackend === "claude" && !!ENV.anthropicApiKey;
  // Garde nLPD (audit H4) : pas d'envoi de pixels (PHI potentiellement brûlé)
  // vers Claude (cloud US) sans consentement documenté (DPA). Sinon → repli
  // Ollama local (PHI-safe), pour ne JAMAIS exfiltrer par défaut.
  const useClaude = claudeConfigured && ENV.cloudAiPhiConsent;
  if (claudeConfigured && !ENV.cloudAiPhiConsent) {
    console.warn(
      "[aiPreanalysis] AI_BACKEND=claude ignoré : MEDIVIEW_CLOUD_AI_PHI_CONSENT non activé (nLPD/DPA) → repli sur Ollama local."
    );
  }
  const comparing = !!opts.prior && opts.prior.images.length > 0;
  // Budget d'images adapté au modèle : Claude (grand contexte, cloud) encaisse
  // PLUS de coupes en PLEINE résolution → meilleure lecture de l'examen. Le
  // modèle local (GPU L4) reste à 16/768 px pour ne pas le saturer.
  const maxImages = opts.maxImages ?? (useClaude ? 24 : 16);
  const visionDim = useClaude ? 1024 : VISION_MAX_DIM;
  const perStudy = comparing
    ? Math.max(1, Math.floor(maxImages / 2))
    : maxImages;

  const chosen = keyImages.slice(0, perStudy);
  const curImages = chosen.map(k => downscalePngBase64(k.pngBase64, visionDim));
  const curSlices = chosen.map(k => k.sliceIndex);

  const priorChosen = comparing ? opts.prior!.images.slice(0, perStudy) : [];
  const priorImages = priorChosen.map(k =>
    downscalePngBase64(k.pngBase64, visionDim)
  );
  const priorSlices = priorChosen.map(k => k.sliceIndex);
  const priorDate = opts.prior?.date;

  const images = [...curImages, ...priorImages];
  // Budget de contexte du modèle vision. MESURÉ sur qwen2.5vl:7b : ~500 tokens
  // par image (768 px) + overhead prompt. 16 images ≈ 8 k, 32 images ≈ 16,5 k.
  // L'ancien plafond de 16384 FAISAIT ÉCHOUER l'analyse US (32 clichés → 16460
  // tokens > 16384 → HTTP 400 « exceed_context_size », CR vide). Le L4 24 Go
  // encaisse 32768 sans souci (validé). On dimensionne large avec marge.
  const numCtx = Math.min(32768, 6144 + 700 * Math.max(1, images.length));

  // Étiquette de CHAQUE image (parallèle à `images`), utilisée par le backend
  // Claude (bloc texte avant chaque image) pour distinguer actuel / antérieur.
  const multiSeries = chosen.some(k => k.seriesLabel);
  const labels = [
    ...chosen.map(k => {
      const tag = k.seriesLabel ? `[${k.seriesLabel}] ` : "";
      return comparing
        ? `EXAMEN ACTUEL — ${tag}Coupe n° ${k.sliceIndex} :`
        : `${tag}Coupe n° ${k.sliceIndex} :`;
    }),
    ...priorChosen.map(k => {
      const d = k.dateLabel ?? priorDate;
      return `EXAMEN ANTÉRIEUR${d ? ` du ${d}` : ""} — Coupe n° ${k.sliceIndex} :`;
    }),
  ];

  // Contexte de l'étude injecté pour ancrer le modèle.
  const ctxLines: string[] = [];
  if (opts.modality) ctxLines.push(`Modalité : ${opts.modality}`);
  if (opts.studyDescription) ctxLines.push(`Examen : ${opts.studyDescription}`);
  if (opts.indication)
    ctxLines.push(`Indication clinique : ${opts.indication}`);
  if (opts.antecedents)
    ctxLines.push(`Antécédents médicaux du patient : ${opts.antecedents}`);
  if (comparing) {
    const curTotal = opts.totalSlices ?? curImages.length;
    const priorTotal = opts.prior?.totalSlices ?? priorImages.length;
    ctxLines.push(
      `EXAMEN ACTUEL : ${curImages.length} coupe(s) (sur ${curTotal}), coupes n° ${curSlices.join(", ")}.`
    );
    ctxLines.push(
      `EXAMEN ANTÉRIEUR${priorDate ? ` du ${priorDate}` : ""} : ${priorImages.length} coupe(s) (sur ${priorTotal}), coupes n° ${priorSlices.join(", ")}.`
    );
    ctxLines.push(
      `Compare les deux examens, rédige Technique / Résultats (avec un paragraphe « Comparaison à l'examen du ${priorDate ?? "précédent"} : … ») / Conclusion, puis Anomalie (oui/non), Coupe-clé, et enfin Évolution (stable/progression/régression).`
    );
  } else if (multiSeries) {
    ctxLines.push(
      `Cet examen comporte PLUSIEURS SÉRIES (chaque image est étiquetée « [description — modalité] »). On te fournit ${images.length} image(s) réparties sur l'ENSEMBLE des séries du dossier.`
    );
    ctxLines.push(
      "Passe TOUTES les séries en revue. Structure les Résultats PAR SÉRIE / région anatomique (un paragraphe par série, en reprenant son intitulé), puis fais une Conclusion de SYNTHÈSE de l'examen complet. Indique Anomalie (oui/non) globale et le numéro de la Coupe-clé la plus pertinente."
    );
  } else {
    const total = opts.totalSlices ?? images.length;
    ctxLines.push(
      `Échantillon de ${images.length} coupe(s) réparties sur les ${total} coupes du volume. Dans l'ordre, ces images correspondent aux coupes n° : ${curSlices.join(", ")}.`
    );
    ctxLines.push(
      "Analyse l'ensemble de ces coupes selon la méthode, rédige Technique / Résultats / Conclusion, puis indique Anomalie (oui/non) et le numéro de la Coupe-clé."
    );
  }
  if (opts.measurements) {
    ctxLines.push(
      `MESURES OBJECTIVES (segmentation automatique du volume entier, volumes en mL). RÈGLES STRICTES :\n` +
        `- CITE EXPLICITEMENT les volumes des structures pertinentes dans la section Résultats (ex. « Cerveau : 1144 mL »).\n` +
        `- Ne CONTREDIS JAMAIS ces volumes ; signale toute valeur qui te paraît anormale pour l'âge/le contexte.\n` +
        `- N'invente AUCUNE autre mesure que celles fournies ici.\n` +
        `Mesures :\n${opts.measurements}`
    );
  }
  // Texte/mesures lus à l'écran (OCR) : DONNÉES factuelles à utiliser pour
  // citer les VRAIES valeurs, jamais à réinterpréter ni compléter.
  if (opts.screenText) {
    ctxLines.push("");
    ctxLines.push(
      "TEXTE ET MESURES LUS À L'ÉCRAN (transcription automatique — À VÉRIFIER, " +
        "ne pas réinterpréter ni inventer au-delà de ceci) :\n" +
        opts.screenText
    );
  }
  // Références de connaissances (RAG) : injectées comme DONNÉES, après le
  // contexte de l'étude. buildKnowledgeBlock préfixe déjà « à utiliser SI
  // PERTINENT ». N'invente rien : ce sont des références, pas le cas du patient.
  if (opts.references) {
    ctxLines.push("");
    ctxLines.push(opts.references);
  }
  const userText = ctxLines.join("\n");
  const base = buildSystemPrompt(opts.modality);
  const system = comparing ? `${base}\n${COMPARATIVE_ADDENDUM}` : base;

  if (useClaude) {
    return generateViaClaude(images, userText, labels, system);
  }
  return generateViaOllama(images, userText, numCtx, system);
}

/**
 * Localise l'anomalie sur une coupe (grounding vision) → boîte en FRACTIONS 0-1
 * de l'image (robuste au redimensionnement interne du modèle). null si rien.
 * Best-effort, APPROXIMATIF : à valider par le médecin.
 */
export async function locateAnomaly(
  pngBase64: string,
  opts: { cloud?: boolean } = {}
): Promise<{ x1: number; y1: number; x2: number; y2: number } | null> {
  const sys =
    "Tu localises l'anomalie PRINCIPALE sur une coupe d'imagerie médicale. " +
    "Réponds UNIQUEMENT par un JSON " +
    '{"x1":,"y1":,"x2":,"y2":} où chaque valeur est une FRACTION entre 0.0 et 1.0 ' +
    "(x = horizontal depuis la gauche, y = vertical depuis le haut) délimitant la zone anormale. " +
    "Si aucune anomalie nette, réponds {}. Aucun autre texte.";
  // Cloud Opus si actif (localisation bien plus précise que le local), sinon GPU.
  const txt = await focusedVisionRead(
    [pngBase64],
    sys,
    "Boîte de l'anomalie ?",
    !!opts.cloud,
    120
  );
  if (!txt) return null;
  const m = txt.match(/\{[^}]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const f = (v: any) =>
      typeof v === "number" ? Math.max(0, Math.min(1, v)) : NaN;
    const box = { x1: f(o.x1), y1: f(o.y1), x2: f(o.x2), y2: f(o.y2) };
    if (Object.values(box).some(Number.isNaN)) return null;
    if (box.x2 <= box.x1 || box.y2 <= box.y1) return null;
    return box;
  } catch {
    return null;
  }
}

/**
 * Double lecture : 2e modèle vision (indépendant) qui dit juste si une anomalie
 * nette est présente (oui/non). Sert à détecter les désaccords (signal d'incertitude).
 */
export async function secondOpinionAbnormal(
  images: PreanalysisKeyImage[],
  modality?: string,
  cloud = false
): Promise<boolean | null> {
  // Cloud Opus : 8 coupes en 1024px (lit les petits signes) ; local : 512px.
  const pics = images
    .slice(0, 8)
    .map(k => downscalePngBase64(k.pngBase64, cloud ? 1024 : 512));
  if (pics.length === 0) return null;
  const sys =
    "Tu es un SECOND lecteur en imagerie. On te montre des images d'un même examen. " +
    "Tiens compte de la MODALITÉ indiquée et lis le texte/les curseurs incrustés. " +
    "Y a-t-il une anomalie NETTE (lésion focale, kyste, nodule, masse, épanchement, dilatation, " +
    "fracture, hémorragie, asymétrie franche, OU une structure entourée de curseurs de mesure) ? " +
    "Réponds par UN SEUL mot : oui ou non.";
  const txt = await focusedVisionRead(
    pics,
    sys,
    modality ? `Modalité : ${modality}. Anomalie ?` : "Anomalie ?",
    cloud,
    24
  );
  if (!txt) return null;
  const mo = txt.toLowerCase().match(/\b(oui|yes|non|no)\b/);
  if (mo) return mo[1] === "oui" || mo[1] === "yes";
  return null;
}

/**
 * OCR des repères INCRUSTÉS : transcrit VERBATIM le texte et les chiffres
 * affichés/gravés sur les images (étiquette d'organe, mesures en cm/mm,
 * paramètres machine) — surtout utile en échographie où les mesures sont
 * brûlées dans l'image. Tâche de pure transcription (température 0, « n'invente
 * RIEN ») → bien plus sûre qu'une déduction. Le résultat est injecté comme
 * DONNÉE « à vérifier », jamais comme vérité. Best-effort, null si rien.
 */
const OCR_SYSTEM =
  "Tu fais de l'OCR et le REPÉRAGE DES MESURES sur des images d'imagerie (souvent échographie). DEUX tâches :\n" +
  "(1) Transcris EXACTEMENT le texte/les chiffres incrustés : organe (ex. « REIN G », « FOIE »), latéralité, valeurs en cm/mm, paramètres machine.\n" +
  "(2) Repère TOUT curseur/marqueur de mesure : croix « + », repères « 1 »/« 2 », lignes en POINTILLÉS ou TIRETS reliant deux points. Signale leur présence et l'organe concerné, MÊME si aucune valeur chiffrée n'est lisible (ex. « Curseur de mesure (croix +) présent sur le rein gauche, valeur non lisible »).\n" +
  "RÈGLE ABSOLUE : n'invente AUCUNE valeur chiffrée ; recopie ce qui est écrit et décris FACTUELLEMENT les curseurs visibles. Ne décris pas l'anatomie. Si vraiment rien (ni texte ni curseur), réponds exactement « aucun ».";

export async function extractBurnedInText(
  images: PreanalysisKeyImage[],
  opts: { cloud?: boolean } = {}
): Promise<string | null> {
  const n = images.length;
  if (n === 0) return null;
  // PLEINE résolution (1024) — un curseur fin « + » et un petit chiffre sont
  // illisibles en 512 px. On prend jusqu'à 6 frames réparties.
  const picks: string[] = [];
  const step = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n && picks.length < 6; i += step) {
    picks.push(downscalePngBase64(images[i].pngBase64, 1024));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    let txt = "";
    // Cloud (Opus) : lit les petits curseurs/chiffres bien mieux que le local.
    if (opts.cloud && ENV.anthropicApiKey) {
      const content: any[] = picks.map(b64 => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64 },
      }));
      content.push({
        type: "text",
        text: "Transcris le texte incrusté et signale tout curseur de mesure (croix +, pointillés), par organe.",
      });
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ENV.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: ENV.anthropicModel,
          max_tokens: 400,
          system: OCR_SYSTEM,
          messages: [{ role: "user", content }],
        }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      txt = (Array.isArray(data?.content) ? data.content : [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
    } else {
      const resp = await fetch(`${ENV.ollamaVisionUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: ENV.ollamaVisionModel,
          stream: false,
          keep_alive: -1,
          options: { num_ctx: 8192, num_predict: 250, temperature: 0 },
          messages: [
            { role: "system", content: OCR_SYSTEM },
            {
              role: "user",
              content: "Transcris le texte/les mesures affichés.",
              images: picks,
            },
          ],
        }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      txt = (data?.message?.content ?? "").trim();
    }
    if (!txt || /^aucun\.?$/i.test(txt)) return null;
    return txt;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Dessine un cadre (rectangle) sur une image PNG aux coords fractionnaires. */
export function drawAnomalyBox(
  pngBase64: string,
  box: { x1: number; y1: number; x2: number; y2: number },
  rgb: [number, number, number] = [255, 80, 80]
): string {
  try {
    const img = PNG.sync.read(Buffer.from(pngBase64, "base64"));
    const { width: w, height: h, data } = img;
    const x1 = Math.round(box.x1 * w);
    const y1 = Math.round(box.y1 * h);
    const x2 = Math.round(box.x2 * w);
    const y2 = Math.round(box.y2 * h);
    const th = Math.max(2, Math.round(Math.min(w, h) / 200));
    const set = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    };
    for (let t = 0; t < th; t++) {
      for (let x = x1; x <= x2; x++) {
        set(x, y1 + t);
        set(x, y2 - t);
      }
      for (let y = y1; y <= y2; y++) {
        set(x1 + t, y);
        set(x2 - t, y);
      }
    }
    return PNG.sync.write(img).toString("base64");
  } catch {
    return pngBase64;
  }
}

/** Recadre une image PNG sur une boîte (fractions 0-1) + marge, agrandie à
 * `outDim` px (zoom haute-déf sur la zone suspecte). Renvoie le clair si échec. */
export function cropPngBase64(
  pngBase64: string,
  box: { x1: number; y1: number; x2: number; y2: number },
  pad = 0.1,
  outDim = 1024
): string {
  try {
    const img = PNG.sync.read(Buffer.from(pngBase64, "base64"));
    const { width: w, height: h } = img;
    const x1 = Math.max(0, Math.floor((box.x1 - pad) * w));
    const y1 = Math.max(0, Math.floor((box.y1 - pad) * h));
    const x2 = Math.min(w, Math.ceil((box.x2 + pad) * w));
    const y2 = Math.min(h, Math.ceil((box.y2 + pad) * h));
    const cw = Math.max(1, x2 - x1);
    const ch = Math.max(1, y2 - y1);
    const scale = Math.max(1, Math.min(outDim / cw, outDim / ch));
    const ow = Math.round(cw * scale);
    const oh = Math.round(ch * scale);
    const out = new PNG({ width: ow, height: oh });
    for (let y = 0; y < oh; y++) {
      const sy = Math.min(ch - 1, Math.floor(y / scale)) + y1;
      for (let x = 0; x < ow; x++) {
        const sx = Math.min(cw - 1, Math.floor(x / scale)) + x1;
        const si = (sy * w + sx) * 4;
        const di = (y * ow + x) * 4;
        out.data[di] = img.data[si];
        out.data[di + 1] = img.data[si + 1];
        out.data[di + 2] = img.data[si + 2];
        out.data[di + 3] = 255;
      }
    }
    return PNG.sync.write(out).toString("base64");
  } catch {
    return pngBase64;
  }
}

/** Lecture vision FOCALISÉE (1 tâche, texte court). Cloud Opus si actif (lit
 * mieux les petits signes), sinon modèle local. null si échec. Best-effort. */
async function focusedVisionRead(
  imagesB64: string[],
  system: string,
  userText: string,
  cloud: boolean,
  maxTokens = 350
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    if (cloud && ENV.anthropicApiKey) {
      const content: any[] = imagesB64.map(b64 => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64 },
      }));
      content.push({ type: "text", text: userText });
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ENV.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: ENV.anthropicModel,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content }],
        }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const t = (Array.isArray(data?.content) ? data.content : [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      return t || null;
    }
    const resp = await fetch(`${ENV.ollamaVisionUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: ENV.ollamaVisionModel,
        stream: false,
        keep_alive: -1,
        options: { num_ctx: 8192, num_predict: maxTokens, temperature: 0.1 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userText, images: imagesB64 },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const t = (data?.message?.content ?? "").trim();
    return t || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Lecture en 2 temps : re-zoom HAUTE-DÉF sur la zone suspecte (box) d'une coupe
 * et description fine. Renvoie le détail, ou null. */
export async function zoomReadAnomaly(
  fullSliceB64: string,
  box: { x1: number; y1: number; x2: number; y2: number },
  modality: string | undefined,
  cloud: boolean
): Promise<string | null> {
  const crop = cropPngBase64(fullSliceB64, box, 0.12, 1024);
  const sys =
    "Tu es un radiologue senior. On te montre un AGRANDISSEMENT (zoom) de la zone " +
    "suspecte d'une coupe. Décris FINEMENT ce que tu vois dans cette zone (taille " +
    "apparente, contours, échostructure/densité, signes pertinents) de façon prudente. " +
    "N'invente aucune mesure chiffrée non lisible. 2-3 phrases maximum.";
  return focusedVisionRead(
    [crop],
    sys,
    `Modalité : ${modality || "?"}. Décris finement la zone suspecte agrandie.`,
    cloud,
    300
  );
}

/** Vérification critique (2e lecture contradictoire) de la conclusion proposée. */
export async function verifyConclusion(
  imagesB64: string[],
  conclusion: string,
  modality: string | undefined,
  cloud: boolean
): Promise<string | null> {
  const sys =
    "Tu es un radiologue senior qui RELIT de façon CRITIQUE et CONTRADICTOIRE un " +
    "brouillon. On te donne une conclusion proposée et les images. Confirme, NUANCE " +
    "ou CORRIGE-la d'après ce que tu vois réellement. Signale tout sur-diagnostic ou " +
    "élément manqué. Reste prudent et bref (2-3 phrases). Si tu es d'accord, dis-le simplement.";
  return focusedVisionRead(
    imagesB64,
    sys,
    `Modalité : ${modality || "?"}.\nConclusion proposée : « ${conclusion} »\nTon avis critique ?`,
    cloud,
    300
  );
}

async function generateViaOllama(
  images: string[],
  userText: string,
  numCtx: number,
  system: string
): Promise<PreanalysisResult> {
  const model = ENV.ollamaVisionModel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  let content = "";
  try {
    const resp = await fetch(`${ENV.ollamaVisionUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        // GPU dédié : on garde le modèle chargé en VRAM (évite le warm-up ~67 s
        // au premier compte rendu). -1 = pas de déchargement.
        keep_alive: -1,
        // 512 tokens tronquaient les CR multi-séries (Conclusion/Anomalie/
        // Coupe-clé coupées en fin de sortie → parsing incomplet, brouillon
        // amputé). 1024 couvre un CR structuré complet ; le GPU L4 l'encaisse
        // sans surcoût de latence notable.
        options: { num_ctx: numCtx, num_predict: 1024 },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: userText,
            images,
          },
        ],
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Ollama HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    content = data?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
  return {
    ...parseSections(content),
    ...parseKeySlice(content),
    evolution: parseEvolution(content).evolution,
    model: ENV.ollamaVisionModel,
  };
}

async function generateViaClaude(
  images: string[],
  userText: string,
  labels: string[],
  system: string
): Promise<PreanalysisResult> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: ENV.anthropicApiKey });
  // On étiquette CHAQUE image (bloc texte juste avant l'image) pour que le
  // modèle puisse désigner la coupe-clé et l'examen d'appartenance sans ambiguïté.
  const content: any[] = [];
  images.forEach((b64, i) => {
    content.push({
      type: "text",
      text: labels[i] ?? `Coupe n° ${i + 1} :`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: b64 },
    });
  });
  content.push({ type: "text", text: userText });
  // Timeout explicite (audit I-claude-timeout) : sans borne, une requête Claude
  // (thinking adaptatif + jusqu'à 16 images) peut pendre et bloquer la requête
  // tRPC. Aligné sur le timeout de 180 s de la branche Ollama.
  const resp = await client.messages.create(
    {
      model: ENV.anthropicModel,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content }],
    },
    { timeout: 240_000 }
  );
  const text = (resp.content as any[])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
  return {
    ...parseSections(text),
    ...parseKeySlice(text),
    evolution: parseEvolution(text).evolution,
    model: ENV.anthropicModel,
  };
}

// Indirection pour permettre au test de mocker l'appel réseau.
export const _internal = { generatePreanalysis };

function assertPng(b64: string) {
  const png = Buffer.from(b64, "base64");
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(sig)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Image clé : PNG attendu",
    });
  }
}

export interface RunAiPreanalysisInput {
  studyId: number;
  keyImages: PreanalysisKeyImage[];
  indication?: string;
  antecedents?: string;
  // Échantillonnage serveur du volume (analyse de TOUTE la série) :
  seriesId?: number;
  windowCenter?: number;
  windowWidth?: number;
  sampleCount?: number;
  // Analyse de TOUTE l'étude : échantillonne sur toutes les séries du dossier
  // (pas seulement `seriesId`), chaque image étiquetée de sa série.
  wholeStudy?: boolean;
  // Analyse approfondie : beaucoup plus de coupes (cas douteux). Plus lent/coûteux.
  deepAnalysis?: boolean;
  // Antériorité à comparer (mesure d'évolution) ; absente → pas de comparaison.
  priorStudyId?: number;
  priorSeriesId?: number;
  // Comparaison AUTOMATIQUE avec TOUTES les antériorités du patient (jusqu'aux
  // 3 plus récentes), sans antériorité explicite. Évolution dans le temps.
  compareAllPriors?: boolean;
  // Mode précis (CT) : segmenter d'abord le volume (TotalSegmentator) et ancrer
  // le rapport vision dans les volumes mesurés.
  includeSegmentation?: boolean;
  // Segmentation en pleine résolution (1.5mm) — plus précise, ~2x plus lente.
  highResSegmentation?: boolean;
  // Double lecture : avis d'un 2e modèle (détecte les désaccords).
  doubleRead?: boolean;
}

export interface RunAiPreanalysisResult extends PreanalysisResult {
  // Image de la coupe désignée par l'IA, rendue côté serveur, à retenir comme
  // image clé du compte rendu (null si pas d'anomalie / rendu impossible).
  keyImage?: { pngBase64: string; sliceIndex: number } | null;
  // Date (DICOM DA, brute) de l'antériorité réellement comparée, ou null.
  comparedPriorDate?: string | null;
  // Double lecture : verdict du 2e modèle + accord avec le 1er.
  secondOpinion?: {
    abnormal: boolean | null;
    model: string;
    agree: boolean;
  } | null;
}

export async function runAiPreanalysis(
  input: RunAiPreanalysisInput,
  ctx: { user: { id: number }; req?: { ip?: string } }
): Promise<RunAiPreanalysisResult> {
  // Signale une activité au plan de contrôle GPU : réarme le minuteur de mise en
  // veille pour que le GPU ne s'endorme pas pendant une séance de comptes rendus.
  // Best-effort (n'échoue jamais) ; no-op si le pilotage GPU n'est pas configuré.
  void (await import("./gpuControl")).gpuTouch();

  const recent = await countRecentAccess(
    ctx.user.id,
    "study.ai.preanalysis",
    60
  );
  if (recent >= 30) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Limite de pré-analyses atteinte, réessayez plus tard.",
    });
  }
  const study = await getStudyById(input.studyId);
  if (!study)
    throw new TRPCError({ code: "NOT_FOUND", message: "Étude introuvable" });

  // Anti-IDOR : la série demandée DOIT appartenir à l'étude (sinon un client
  // pourrait faire rendre/exfiltrer les coupes d'une série arbitraire — PHI).
  // Même garde que l'envoi de compte rendu.
  if (input.seriesId) {
    const series = await listSeriesByStudy(input.studyId);
    if (!series.some((s: any) => s.id === input.seriesId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Série inconnue pour cette étude",
      });
    }
  }

  const wc = input.windowCenter ?? 40;
  const ww = input.windowWidth ?? 400;

  // Analyse de TOUT le volume : le serveur échantillonne des coupes réparties
  // sur la série (dans la fenêtre W/L du médecin → fractures visibles). Repli
  // sur les images clés capturées côté client si l'échantillonnage échoue.
  let images: PreanalysisKeyImage[] = [];
  let totalSlices = 0;
  // Vision cloud (Claude) active → on échantillonne PLUS de coupes (grand
  // contexte) pour une meilleure couverture du volume ; sinon budget local.
  const cloudVision =
    ENV.aiBackend === "claude" &&
    !!ENV.anthropicApiKey &&
    ENV.cloudAiPhiConsent;
  // Budget d'images. Mode « analyse approfondie » → bien plus de coupes (cas
  // douteux, plus lent/coûteux mais exhaustif).
  //
  // ADAPTATIF À LA MODALITÉ : en ÉCHOGRAPHIE (US), il n'y a pas un « volume »
  // continu mais un PETIT NOMBRE de clichés DISTINCTS, chacun documentant une
  // structure/mesure précise — il faut donc les voir (presque) TOUS, pas un
  // échantillon de 16 qui en manquerait la moitié (d'où des CR vagues). Sur un
  // CT/MR (centaines de coupes redondantes), l'échantillon réparti reste le bon
  // compromis vitesse/couverture.
  const modalityUpper = ((study as any).modality ?? "").trim().toUpperCase();
  const isUltrasound = modalityUpper === "US";
  const imgBudget = isUltrasound
    ? input.deepAnalysis
      ? cloudVision
        ? 48
        : 40
      : cloudVision
        ? 40
        : 32
    : input.deepAnalysis
      ? cloudVision
        ? 40
        : 24
      : cloudVision
        ? 24
        : 16;
  // Comparaison d'antériorité(s) → on réduit le budget de l'étude courante pour
  // laisser de la place aux images antérieures (sans exploser le total/coût).
  const comparingPriors = !!input.priorStudyId || !!input.compareAllPriors;
  const currentBudget = comparingPriors
    ? Math.max(8, Math.floor(imgBudget / 2))
    : imgBudget;
  // Mode « toute l'étude » : échantillonne sur TOUTES les séries du dossier
  // (budget réparti par taille), chaque image étiquetée de sa série → l'IA lit
  // l'examen complet et structure le CR par série. Anti-IDOR implicite : toutes
  // les séries appartiennent à l'étude demandée.
  if (input.wholeStudy) {
    try {
      const { sampleSeriesPngs } = await import("./aiSampling");
      const allSeriesRaw = await listSeriesByStudy(input.studyId);
      // Filtre les séries NON diagnostiques (scanogramme/localizer/SUMMARY/dose
      // report) : sinon elles consomment du budget d'images et polluent le CR
      // (« aspect normal » lu sur 2 vues de repérage au lieu des vraies coupes).
      const allSeries = selectDiagnosticSeries(allSeriesRaw as any);
      const budget = distributeImageBudget(
        allSeries.map((s: any) => s.numberOfInstances ?? 1),
        currentBudget
      );
      for (let i = 0; i < allSeries.length; i++) {
        const cnt = budget[i];
        if (!cnt) continue;
        const s: any = allSeries[i];
        try {
          const sampled = await sampleSeriesPngs(s.id, {
            windowCenter: wc,
            windowWidth: ww,
            count: cnt,
            maxDim: cloudVision ? 1024 : 768,
          });
          const label = `${s.seriesDescription || `Série ${s.seriesNumber ?? s.id}`} — ${s.modality || "?"}`;
          for (const x of sampled.images) {
            images.push({
              pngBase64: x.pngBase64,
              sliceIndex: x.sliceNumber,
              seriesLabel: label,
            });
          }
          totalSlices += sampled.totalSlices;
        } catch {
          // série non rendable → on continue avec les autres
        }
      }
    } catch (e) {
      console.warn("[aiPreanalysis] échantillonnage multi-séries échoué:", e);
    }
  }
  if (input.seriesId && images.length === 0) {
    try {
      const { sampleSeriesPngs } = await import("./aiSampling");
      const sampled = await sampleSeriesPngs(input.seriesId, {
        windowCenter: wc,
        windowWidth: ww,
        // Coupes réparties sur tout le volume. Cloud Claude : 24 (12 en
        // comparaison) ; local : 16 (8 en comparaison).
        count: input.sampleCount ?? currentBudget,
        // Pleine résolution pour Claude (lit plus de détail) ; 768 en local.
        maxDim: cloudVision ? 1024 : 768,
      });
      images = sampled.images.map(s => ({
        pngBase64: s.pngBase64,
        sliceIndex: s.sliceNumber,
      }));
      totalSlices = sampled.totalSlices;
    } catch (e) {
      console.warn("[aiPreanalysis] échantillonnage série échoué:", e);
    }
  }
  if (images.length === 0) {
    input.keyImages.forEach(k => assertPng(k.pngBase64));
    images = input.keyImages;
    totalSlices = images.length;
  }

  // --- Antériorité (mesure d'évolution) : fail-soft de bout en bout. ---------
  let prior:
    | { images: PreanalysisKeyImage[]; date?: string; totalSlices?: number }
    | undefined;
  let comparedPriorDate: string | null = null;
  if (input.priorStudyId) {
    try {
      const priorStudy = await getStudyById(input.priorStudyId);
      if (priorStudy) {
        // Anti-IDOR : l'antériorité DOIT être du même patient (lève FORBIDDEN).
        assertSamePatientStudies(study as any, priorStudy as any);
        const priorSeriesList = await listSeriesByStudy(input.priorStudyId);
        const priorSeriesId =
          input.priorSeriesId &&
          priorSeriesList.some((s: any) => s.id === input.priorSeriesId)
            ? input.priorSeriesId
            : pickPriorSeriesId(
                priorSeriesList as any,
                (study as any).modality ?? null
              );
        if (priorSeriesId) {
          const { sampleSeriesPngs } = await import("./aiSampling");
          const sampledPrior = await sampleSeriesPngs(priorSeriesId, {
            windowCenter: wc,
            windowWidth: ww,
            count: 8,
          });
          if (sampledPrior.images.length > 0) {
            prior = {
              images: sampledPrior.images.map(s => ({
                pngBase64: s.pngBase64,
                sliceIndex: s.sliceNumber,
              })),
              date: (priorStudy as any).studyDate ?? undefined,
              totalSlices: sampledPrior.totalSlices,
            };
            comparedPriorDate = (priorStudy as any).studyDate ?? null;
          }
        }
      }
    } catch (e) {
      // FORBIDDEN (patient différent) doit remonter ; le reste est fail-soft.
      if (e instanceof TRPCError && e.code === "FORBIDDEN") throw e;
      console.warn("[aiPreanalysis] comparaison antériorité échouée:", e);
    }
  }

  // Comparaison AUTOMATIQUE avec TOUTES les antériorités (jusqu'aux 3 plus
  // récentes du MÊME patient — listPriorStudiesForStudy est résolu par patient,
  // donc anti-IDOR par construction). Chaque image antérieure est étiquetée de
  // sa date. Fail-soft. N'écrase pas une antériorité explicite déjà choisie.
  if (!prior && input.compareAllPriors) {
    try {
      const { listPriorStudiesForStudy } = await import("../db");
      const { sampleSeriesPngs } = await import("./aiSampling");
      const priors = (await listPriorStudiesForStudy(input.studyId)).slice(
        0,
        3
      );
      const priorImgs: PreanalysisKeyImage[] = [];
      let mostRecent: string | null = null;
      const perPrior = Math.max(2, Math.floor(currentBudget / 3));
      for (const p of priors as any[]) {
        try {
          const sl = await listSeriesByStudy(p.id);
          const sid = pickPriorSeriesId(
            sl as any,
            (study as any).modality ?? null
          );
          if (!sid) continue;
          const sp = await sampleSeriesPngs(sid, {
            windowCenter: wc,
            windowWidth: ww,
            count: perPrior,
            maxDim: cloudVision ? 1024 : 768,
          });
          const d = p.studyDate ?? undefined;
          for (const x of sp.images) {
            priorImgs.push({
              pngBase64: x.pngBase64,
              sliceIndex: x.sliceNumber,
              dateLabel: d,
            });
          }
          if (d && !mostRecent) mostRecent = d;
        } catch {
          // antériorité non rendable → on continue
        }
      }
      if (priorImgs.length > 0) {
        prior = { images: priorImgs, date: mostRecent ?? undefined };
        comparedPriorDate = mostRecent;
      }
    } catch (e) {
      console.warn(
        "[aiPreanalysis] comparaison multi-antériorités échouée:",
        e
      );
    }
  }

  // Mode précis : segmentation du volume entier → volumes objectifs injectés
  // dans le prompt vision. Fail-soft (si indispo, on garde le rapport vision seul).
  let measurements: string | undefined;
  if (input.includeSegmentation && input.seriesId && ENV.segServiceUrl) {
    try {
      const { segmentCtSeries } = await import("./ctSegmentation");
      const seg = await segmentCtSeries(input.seriesId, {
        highRes: input.highResSegmentation,
      });
      if (seg.structures.length) {
        measurements = seg.structures
          .slice(0, 30)
          .map(s => `${s.name}: ${s.volumeMl} mL`)
          .join(" ; ");
      }
    } catch (e) {
      console.warn("[aiPreanalysis] segmentation (mode précis) échouée:", e);
    }
  }

  // RAG : récupère des connaissances de référence radiologiques (critères,
  // valeurs normales, sémiologie) pertinentes pour CETTE modalité/région, et
  // les injecte comme DONNÉES dans le prompt. Tout est LOCAL (embeddings Ollama
  // + base knowledge_chunks) → PHI-safe. Fail-soft : si indispo, rapport sans RAG.
  let references: string | undefined;
  try {
    const query = [
      (study as any).modality,
      (study as any).studyDescription,
      input.indication,
    ]
      .filter(Boolean)
      .join(" — ")
      .trim();
    if (query) {
      const { embedText } = await import("../knowledge/embeddings");
      const { searchSimilar } = await import("../knowledge/store");
      const { selectRelevant, buildKnowledgeBlock } = await import(
        "../knowledge/retrieve"
      );
      const sims = await searchSimilar(await embedText(query), 8);
      const block = buildKnowledgeBlock(
        selectRelevant(sims, { minScore: 0.5, maxChunks: 4, maxChars: 2500 })
      );
      if (block) references = block;
    }
  } catch (e) {
    console.warn("[aiPreanalysis] RAG références indisponible:", e);
  }

  // OCR des repères incrustés (organe, mesures, curseurs) → ancre le rapport
  // dans les VRAIES valeurs affichées. Fail-soft, PHI-safe (vision GPU CH).
  let screenText: string | undefined;
  try {
    screenText =
      (await extractBurnedInText(images, { cloud: cloudVision })) ?? undefined;
  } catch (e) {
    console.warn("[aiPreanalysis] OCR repères incrustés échoué:", e);
  }

  const result = await _internal.generatePreanalysis(images, {
    indication: input.indication,
    antecedents: input.antecedents,
    modality: (study as any).modality ?? undefined,
    studyDescription: (study as any).studyDescription ?? undefined,
    totalSlices,
    maxImages: imgBudget,
    measurements,
    references,
    screenText,
    prior,
  });

  // Précision déterministe : on annexe les volumes RÉELS mesurés au rapport, sans
  // dépendre du LLM (un petit modèle ne les cite pas de façon fiable). Données
  // objectives, clairement étiquetées « indicatif » → le médecin valide.
  if (measurements) {
    result.resultats =
      `${result.resultats}\n\nVolumes mesurés (segmentation automatique, indicatif) : ${measurements}`.trim();
  }

  // Image clé du compte rendu :
  //  - si l'IA SIGNALE une anomalie et donne un numéro → SA coupe (localisation
  //    de la lésion, ce que le médecin veut voir) ;
  //  - sinon (examen normal / pas de numéro fiable) → la coupe du MILIEU de
  //    l'échantillon, représentative du volume — JAMAIS la 1re coupe (un petit
  //    modèle tend sinon à renvoyer un numéro bas arbitraire sur un examen normal).
  let keyImage: RunAiPreanalysisResult["keyImage"] = null;
  let keySlice: number | null = null;
  if (result.abnormal === true && result.keySliceNumber) {
    keySlice = result.keySliceNumber;
  } else if (images.length > 0) {
    keySlice = images[Math.floor(images.length / 2)].sliceIndex;
  }
  if (input.seriesId && keySlice) {
    try {
      const { renderSliceByNumber } = await import("./aiSampling");
      const b64 = await renderSliceByNumber(input.seriesId, keySlice, {
        windowCenter: wc,
        windowWidth: ww,
      });
      if (b64) keyImage = { pngBase64: b64, sliceIndex: keySlice };
    } catch (e) {
      console.warn("[aiPreanalysis] rendu coupe-clé échoué:", e);
    }
  }

  // Annotation de l'anomalie : si l'IA a repéré une anomalie, on localise la zone
  // et on dessine un cadre sur l'image clé (approximatif, à valider). Best-effort.
  if (keyImage && result.abnormal === true) {
    try {
      const original = keyImage.pngBase64;
      const box = await locateAnomaly(original, { cloud: cloudVision });
      if (box) {
        keyImage = {
          pngBase64: drawAnomalyBox(original, box),
          sliceIndex: keyImage.sliceIndex,
        };
        // Lecture en 2 temps : re-zoom HAUTE-DÉF sur la zone localisée pour une
        // description fine des petits signes. Annexé au CR (à valider).
        try {
          const zoom = await zoomReadAnomaly(
            original,
            box,
            (study as any).modality ?? undefined,
            cloudVision
          );
          if (zoom) {
            result.resultats =
              `${result.resultats}\n\nAnalyse ciblée (zoom haute résolution sur la zone suspecte, à valider) : ${zoom}`.trim();
          }
        } catch (e) {
          console.warn("[aiPreanalysis] zoom ciblé échoué:", e);
        }
      }
    } catch (e) {
      console.warn("[aiPreanalysis] annotation anomalie échouée:", e);
    }
  }

  // Double lecture : avis d'un 2e modèle (détecte les désaccords = incertitude).
  let secondOpinion: RunAiPreanalysisResult["secondOpinion"] = null;
  if (input.doubleRead) {
    try {
      const ab2 = await secondOpinionAbnormal(
        images,
        (study as any).modality ?? undefined,
        cloudVision
      );
      secondOpinion = {
        abnormal: ab2,
        model: cloudVision ? ENV.anthropicModel : ENV.ollamaVisionModel2,
        // accord seulement si le 2e modèle a donné un avis NET (non null).
        agree: ab2 !== null && ab2 === (result.abnormal ?? null),
      };
    } catch (e) {
      console.warn("[aiPreanalysis] 2e lecture échouée:", e);
    }
  }

  // Vérification critique : relecture CONTRADICTOIRE de la conclusion (anti
  // sur-/sous-diagnostic) quand une anomalie est signalée. Annexée au CR (à
  // valider). Fail-soft.
  if (result.abnormal === true && result.conclusion) {
    try {
      const verifyImgs = images
        .slice(0, cloudVision ? 6 : 4)
        .map(k => downscalePngBase64(k.pngBase64, cloudVision ? 1024 : 768));
      const v = await verifyConclusion(
        verifyImgs,
        result.conclusion,
        (study as any).modality ?? undefined,
        cloudVision
      );
      if (v) {
        result.resultats =
          `${result.resultats}\n\nVérification (2e lecture critique indépendante, à valider) : ${v}`.trim();
      }
    } catch (e) {
      console.warn("[aiPreanalysis] vérification conclusion échouée:", e);
    }
  }

  await recordAccess({
    userId: ctx.user.id,
    action: "study.ai.preanalysis",
    studyId: study.id,
    detail: result.model,
    ipAddress: ctx.req?.ip ?? null,
  });

  // Mode validation : snapshot du brouillon IA pour cette étude (le médecin le
  // jugera après lecture). Best-effort — ne bloque jamais la pré-analyse.
  try {
    await snapshotAiEvaluation({
      studyId: study.id,
      userId: ctx.user.id,
      model: result.model,
      modality: (study as any).modality ?? null,
      aiAbnormal: result.abnormal ?? null,
      aiConclusion: result.conclusion ?? null,
    });
  } catch (e) {
    console.warn("[aiPreanalysis] snapshot évaluation échoué:", e);
  }

  return { ...result, keyImage, comparedPriorDate, secondOpinion };
}

// Extrait l'anomalie (oui/non) et le numéro de coupe-clé renvoyés par l'IA.
export function parseKeySlice(text: string): {
  abnormal: boolean | null;
  keySliceNumber: number | null;
} {
  // Capture la VALEUR qui suit l'étiquette de section "Anomalie:" — l'étiquette
  // DOIT être en début de ligne, avec deux-points, et suivie d'un mot complet
  // (\b) pour NE PAS matcher "anomalie(s)" employé dans une phrase (ex.
  // "sans anomalies visibles" en Conclusion, qui inverserait le verdict !).
  // Le modèle local répond rarement par un strict "oui/non" : il écrit
  // "présente", "oui, kyste de 3 cm", "non visible", "absence d'anomalie"…
  // On lit donc oui/non explicite (prioritaire), puis un vocabulaire
  // positif/négatif. Une fausse réassurance étant le pire risque, en cas de
  // doute (formulation positive trouvée) on conclut abnormal=true.
  const line = text.match(/(?:^|\n)\s*Anomalie\b\s*:\s*([^\n]*)/i);
  let abnormal: boolean | null = null;
  if (line) {
    const v = line[1].toLowerCase();
    // Négations explicites d'abord ("non", "aucune", "absence de", "pas d'").
    const neg =
      /\b(non|no)\b|aucune?\b|absence\b|\bpas d|sans anomalie|\bnormal/.test(v);
    const pos =
      /\b(oui|yes)\b|pr[ée]sen(t|te|ce)|anormal|l[ée]sion|\bvisible/.test(v);
    // "non" l'emporte si présent (le modèle écrit parfois "non, RAS visible").
    if (neg) abnormal = false;
    else if (pos) abnormal = true;
    // ni l'un ni l'autre → null (on ne devine pas).
  }
  // Robuste aux formats du modèle : "Coupe-clé: 47", "Coupe-clé : coupe n° 47",
  // ou le numéro sur la ligne SUIVANTE. On prend le 1er entier dans les ~80
  // caractères qui suivent l'étiquette (newlines incluses) ; "aucune" → null.
  let keySliceNumber: number | null = null;
  const after = text.split(/Coupe[-\s]?cl[ée]\s*:?/i)[1];
  if (after) {
    const num = after.slice(0, 80).match(/\d+/);
    if (num) keySliceNumber = parseInt(num[0], 10);
  }
  return { abnormal, keySliceNumber };
}

// Extrait le verdict d'évolution comparative (ligne « Évolution: stable |
// progression | régression »). Tolérant à la casse et aux accents. Renvoie le
// texte NETTOYÉ de cette ligne (elle ne doit pas polluer la Conclusion) ;
// verdict null si la ligne est absente.
export function parseEvolution(text: string): {
  evolution: "stable" | "progression" | "regression" | null;
  cleaned: string;
} {
  const m = text.match(
    /\n?\s*[EÉeé]volution\s*:?\s*(stable|progression|régression|regression)\b/i
  );
  if (!m) return { evolution: null, cleaned: text };
  const raw = m[1].toLowerCase();
  const evolution =
    raw === "stable"
      ? "stable"
      : raw === "progression"
        ? "progression"
        : "regression";
  return { evolution, cleaned: text.replace(m[0], "").trimEnd() };
}

// Garde anti-IDOR : une antériorité ne peut être comparée que si elle appartient
// au MÊME patient que l'étude courante (sinon fuite PHI inter-patients). Lève
// FORBIDDEN sinon.
//
// Comparaison PRIMAIRE = `patientFk` (FK interne `patients.id`, vérité de la
// base) : immunisée contre les collisions de PatientID DICOM inter-sources (deux
// patients distincts pouvant partager un même PatientID si importés de sources
// hétérogènes). Repli = PatientID DICOM (trim) quand la FK n'est pas disponible
// (ex. appel avec des objets partiels) ; un id vide ne rapproche personne.
export function assertSamePatientStudies(
  current: { patientFk?: number | null; patientId?: string | null },
  prior: { patientFk?: number | null; patientId?: string | null }
): void {
  const forbidden = () => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "L'antériorité doit appartenir au même patient.",
    });
  };
  // Vérité DB : si les deux FK internes sont connues, elles font foi.
  if (current.patientFk != null && prior.patientFk != null) {
    if (current.patientFk !== prior.patientFk) forbidden();
    return;
  }
  // Repli : PatientID DICOM.
  const a = (current.patientId ?? "").trim();
  const b = (prior.patientId ?? "").trim();
  if (a === "" || b === "" || a !== b) forbidden();
}

// Série de l'antériorité à comparer : 1re série de MÊME modalité que la
// courante si elle existe, sinon la 1re série, sinon null. Fonction pure.
export function pickPriorSeriesId(
  series:
    | readonly { id: number; modality?: string | null }[]
    | null
    | undefined,
  currentModality?: string | null
): number | null {
  if (!series || series.length === 0) return null;
  const wanted = (currentModality ?? "").trim().toUpperCase();
  if (wanted) {
    const m = series.find(
      s => (s.modality ?? "").trim().toUpperCase() === wanted
    );
    if (m) return m.id;
  }
  return series[0].id;
}

export function parseSections(text: string): {
  technique: string;
  resultats: string;
  conclusion: string;
} {
  // On retire d'abord les lignes méta finales (Anomalie / Coupe-clé) pour
  // qu'elles ne soient pas absorbées dans la Conclusion.
  const cut = text.search(
    /\n\s*(Anomalie|Coupe[-\s]?cl[ée]|[EÉeé]volution)\s*:/i
  );
  if (cut >= 0) text = text.slice(0, cut);
  // Étiquettes de section TOLÉRANTES : un modèle local (qwen 7b) ne respecte
  // pas toujours l'accent ni le pluriel ("Resultats", "Résultat",
  // "Constatations", "RÉSULTATS"). On accepte ces variantes pour ne JAMAIS
  // perdre silencieusement la Conclusion (sinon le médecin reçoit un brouillon
  // amputé). Les classes [eé]/[ée] couvrent les formes sans accent.
  // Technique : "Technique"
  const T = "Technique";
  // Résultats : "Résultats"/"Resultats"/"Résultat"/"Constatations"/"Constatation"
  const R = "(?:R[ée]sultats?|Constatations?)";
  // Conclusion : "Conclusion"/"Conclusions"
  const C = "Conclusions?";
  // Format attendu : Technique / Résultats / Conclusion.
  const m3 = text.match(
    new RegExp(
      `${T}\\s*:?\\s*([\\s\\S]*?)\\n\\s*${R}\\s*:?\\s*([\\s\\S]*?)\\n\\s*${C}\\s*:?\\s*([\\s\\S]*)$`,
      "i"
    )
  );
  if (m3)
    return {
      technique: m3[1].trim(),
      resultats: m3[2].trim(),
      conclusion: m3[3].trim(),
    };
  // Repli : ancien format à 2 sections (Résultats / Conclusion), technique vide.
  const m2 = text.match(
    new RegExp(
      `${R}\\s*:?\\s*([\\s\\S]*?)\\n\\s*${C}\\s*:?\\s*([\\s\\S]*)$`,
      "i"
    )
  );
  if (m2)
    return { technique: "", resultats: m2[1].trim(), conclusion: m2[2].trim() };
  // Repli ultime : tout dans resultats.
  return { technique: "", resultats: text.trim(), conclusion: "" };
}
