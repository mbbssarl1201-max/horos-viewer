import { TRPCError } from "@trpc/server";
import { PNG } from "pngjs";
import { ENV } from "../_core/env";
import { anthropicMessagesFetch } from "./anthropicClient";
import { isFableModel } from "./anthropicModel";
import { pickCrProvider } from "./crProvider";
import { buildPriorReportBlock, type PriorReportRow } from "./priorReportBlock";
import {
  getStudyById,
  listSeriesByStudy,
  countRecentAccess,
  recordAccess,
  snapshotAiEvaluation,
} from "../db";

/**
 * Appel VLM unifié : Infomaniak (VLM managé CH, format OpenAI image_url) si
 * `VISION_PROVIDER=infomaniak` + clé configurée, SINON Ollama local (A100, format
 * natif `images:[]`) — comportement historique par défaut. Renvoie le texte, lève
 * en cas d'échec HTTP (les appelants gèrent déjà try/catch → null, ou remontent).
 */
async function chatVision(p: {
  system: string;
  userText: string;
  images: string[]; // PNG base64 (sans préfixe data:)
  numCtx?: number;
  numPredict?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const useInfomaniak =
    ENV.visionProvider === "infomaniak" &&
    !!ENV.infomaniakVisionKey &&
    !!ENV.infomaniakVisionUrl;

  if (useInfomaniak) {
    const content = [
      { type: "text", text: p.userText },
      ...p.images.map(b => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${b}` },
      })),
    ];
    const resp = await fetch(ENV.infomaniakVisionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.infomaniakVisionKey}`,
      },
      signal: p.signal,
      body: JSON.stringify({
        model: ENV.infomaniakVisionModel,
        max_tokens: p.numPredict ?? 1024,
        temperature: p.temperature ?? 0,
        messages: [
          { role: "system", content: p.system },
          { role: "user", content },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`Infomaniak vision HTTP ${resp.status}`);
    const data: any = await resp.json();
    return (data?.choices?.[0]?.message?.content ?? "").trim();
  }

  // Défaut historique : Ollama local (A100), format natif images[].
  const resp = await fetch(`${ENV.ollamaVisionUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: p.signal,
    body: JSON.stringify({
      model: ENV.ollamaVisionModel,
      stream: false,
      keep_alive: -1,
      options: {
        num_ctx: p.numCtx ?? 8192,
        num_predict: p.numPredict ?? 1024,
        temperature: p.temperature ?? 0,
      },
      messages: [
        { role: "system", content: p.system },
        { role: "user", content: p.userText, images: p.images },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const data: any = await resp.json();
  return (data?.message?.content ?? "").trim();
}

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
  "6. RÉPONDS EXPLICITEMENT à l'indication clinique dans la conclusion, MÊME si l'examen est normal (ex. indication « hernie ? » → « pas de hernie objectivable »).",
  "7. GRADE les lésions quand une classification existe (Meyerding pour l'antélisthésis/spondylolisthésis ; Kellgren-Lawrence pour l'arthrose 0–IV ; Outerbridge/ICRS pour la chondropathie 0–IV ; BI-RADS, EU-TIRADS, ACR-TIRADS ; Fleischner ; LI-RADS ; Bosniak pour les kystes rénaux I–IV ; AAST pour les traumatismes d'organes solides grade I–V ; Fisher pour l'hémorragie sous-arachnoïdienne).",
  "8. DISTINGUE l'AIGU du CHRONIQUE/dégénératif ou séquellaire — crucial en contexte traumatique (une arthrose/chondropathie n'est pas une lésion traumatique aiguë).",
  "9. SIGNALE les LIMITES de la technique (CT natif peu sensible à l'ischémie aiguë et aux parties molles/tendons ; IRM bas champ/ouverte = résolution limitée ; artéfacts) et propose l'examen complémentaire adapté.",
  "10. DRAPEAUX ROUGES — findings qui DOIVENT TOUJOURS figurer en tête de la Conclusion, même si le reste de l'examen est rassurant : MASSE TISSULAIRE suspecte (contours irréguliers, envahissement, adénopathies), DESTRUCTION OSSEUSE AGRESSIVE, COMPRESSION MÉDULLAIRE ou DE LA QUEUE DE CHEVAL, STÉNOSE ARTÉRIELLE SERRÉE (≥ 70 %), DISSECTION ARTÉRIELLE, OCCLUSION ARTÉRIELLE AIGUË, HÉMORRAGIE INTRACRÂNIENNE, EMBOLIE PULMONAIRE, PNEUMOTHORAX COMPRESSIF, ÉPANCHEMENT PÉRICARDIQUE/TAMPONNADE. Ne minimise JAMAIS un drapeau rouge — le signaler clairement en Conclusion même en cas de doute.",
  "",
  "Style de rédaction (compte rendu radiologique — Institut Médical de Champel) :",
  "- Style CONCIS et précis. TERMINOLOGIE radiologique standard. PAS de remplissage, PAS de phrases d'introduction, PAS de formules de prudence répétées (« à corréler à la clinique » : au plus UNE fois en Conclusion).",
  "- LE FORMAT DÉPEND DE LA MODALITÉ ET DE LA RÉGION (voir instructions spécifiques à la modalité ci-dessous) :",
  "  • IRM (Dr Eva Son) : section nommée 'Description' (prose libre, groupée par région) + Conclusion en LISTE NUMÉROTÉE (1. / 2. / 3. ...).",
  "  • SCANNER standard (Dr Eva Son) : section nommée 'Description' + paragraphes « Au niveau [région]... » + Conclusion : 1 phrase si normal, sinon 1 phrase EN GRAS par finding.",
  "  • SCANNER MULTI-RÉGION TRAUMA (≥ 3 zones) : section « Résultats » + régions NOM EN MAJUSCULES : + mêmes règles de conclusion.",
  "  • ÉCHOGRAPHIE SEIN (Dr Eva Son) : section 'Description' + prose libre par zone (sein + axillaire) + conclusion 1-2 phrases.",
  "  • ÉCHOGRAPHIE ABDOMEN / PELVIS (Dr Kolo) : format LABEL : DESCRIPTION — chaque organe commence par son nom suivi de deux-points sur la même ligne (ex. « Foie : Volume, forme et échostructure homogènes, sans lésion focale. »). Organes normaux décrits EXPLICITEMENT.",
  "  • ÉCHOGRAPHIE MUSCULO-SQUELETTIQUE (Dr Kolo) : sous-groupes anatomiques (ex. « Coiffe des rotateurs : »), puis « Structure : description. » par ligne sans puce ni gras.",
  "- CONCLUSION ÉCHOGRAPHIE : 1 à 2 phrases DIRECTES. Bilan global + réponse à l'indication. PAS de paraphrase des Résultats.",
  "- CLASSIFICATION : si applicable (BI-RADS, EU-TIRADS, LI-RADS, Bosniak…), indiquer EN GRAS sur une ligne dédiée après la Conclusion (ex. « **Classification : BI-RADS 1** »).",
  "",
  "Méthode :",
  "- On te fournit un ÉCHANTILLON d'images/coupes de l'examen (numérotées) pour une vue d'ensemble. Raisonne sur l'ensemble ; tu ne vois pas tout, reste prudent sur ce qui pourrait se trouver entre deux images fournies.",
  "- Parcours les images une à une ; si tu repères une anomalie, IDENTIFIE le NUMÉRO de l'image qui la montre le mieux. MÊME EN L'ABSENCE D'ANOMALIE, choisis toujours l'image la plus représentative/informative, à joindre au compte rendu.",
  "- LIS le TEXTE incrusté dans l'image (organe exploré, latéralité, repère anatomique) ET les CURSEURS/MESURES éventuels (croix « + », repères « 1 », « 2 », pointillés, valeurs en cm/mm). Si une structure est ENTOURÉE DE CURSEURS, c'est qu'elle est MESURÉE donc jugée pertinente par l'opérateur : tu DOIS la décrire dans les Résultats et tu ne peux PAS conclure « aucune anomalie » en présence d'une lésion mesurée à l'écran.",
  "- Reste DESCRIPTIF : ne nomme une pathologie précise QUE si le signe est franc et clairement visible ; sinon décris l'anomalie et formule une hypothèse PRUDENTE.",
  "- Ne sur-interprète pas, MAIS ne passe JAMAIS sous silence une lésion focale, un kyste, un nodule, une masse, un épanchement, une dilatation ou toute structure mesurée à l'écran. Une fausse réassurance (« aucune anomalie » alors qu'une lésion est visible/mesurée) est plus grave qu'une réserve prudente.",
  "- N'invente AUCUNE mesure ni valeur chiffrée que tu ne lis pas à l'écran. Exprime l'incertitude SEULEMENT quand elle est justifiée (« aspect évocateur de »), sans répéter la même réserve à chaque phrase.",
  "- Si des ANTÉCÉDENTS médicaux du patient sont fournis, relie EXPLICITEMENT tes observations et ta conclusion à ces antécédents (évolution, complication, récidive) — sans inventer d'antécédent non fourni.",
  "- N'identifie jamais le patient et n'invente aucun contexte clinique.",
].join("\n");

const PROMPT_FOOTER = [
  "",
  "Réponds UNIQUEMENT avec ces sections, exactement dans ce format (rien d'autre) :",
  "Technique:",
  "<description FACTUELLE et brève de l'acquisition d'après la modalité. N'invente NI produit de contraste, NI paramètres s'ils ne sont pas fournis.>",
  "",
  "Résultats: (IRM uniquement : nomme cette section « Description: » — voir instructions modalité)",
  "<format selon la modalité et la région — structure PAR ORGANE/région : prose groupée par région pour IRM (section nommée Description) ; régions en MAJUSCULES pour CT (RACHIS LOMBAIRE : [...]) ; label:description pour écho abdominale ; puces grasses pour écho sein/thyroïde ; structure:description pour musculo. Ordre anatomique logique. Structures normales décrites explicitement.>",
  "",
  "Conclusion:",
  "<IRM/Scanner : liste numérotée 1./2./3. — un finding par point. Échographie : 1 à 2 phrases directes.>",
  "",
  "Classification: <BI-RADS / EU-TIRADS / LI-RADS / etc. si applicable — sinon omettre cette ligne>",
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
      "- Si la région est le SEIN/MAMMAIRE (style Dr Eva Son) : section nommée « Description: ». PROSE LIBRE par zone anatomique (PAS de puces ni de rubriques fixes). Commencer par « Au niveau du sein droit/gauche, [description du tissu graisseux sous-cutané et de tout finding focal avec : taille, forme, contours, échostructure, atténuation postérieure, vascularisation au Doppler, présence ou absence de masse solide, de kyste, de distorsion architecturale]. Absence d'adénopathie intramammaire. Au niveau du creux axillaire droit/gauche, [adénopathie pathologique ou absence ; perméabilité vasculaire au Doppler]. » Conclusion : 1-2 phrases directes (finding principal + bilan normal/anormal). Ex. : « Image hyperéchogène superficielle du sein droit compatible avec un œdème focal d'origine mécanique. Absence d'anomalie suspecte mammaire ou axillaire. » Technique habituelle : « Examen réalisé sur appareil Aloka Arietta V70 avec sonde linéaire L55 et étude Doppler. » NE cherche PAS de foie/rein.",
      "- Si la région est la THYROÏDE : rubriques standard en puces grasses : « • **Lobe droit :** », « • **Lobe gauche :** », « • **Isthme :** », « • **Vascularisation Doppler :** ». Pour tout nodule : composition, échogénicité, forme, contours, calcifications → EU-TIRADS si pertinent.",
      "- Si la région est l'ABDOMEN / PELVIS (foie, rein, vésicule, pancréas, rate, aorte, utérus, ovaires) : utilise le format LABEL : DESCRIPTION (style Dr Kolo) — chaque organe = son nom suivi de deux-points puis la description sur la même ligne, SANS puce, SANS gras. Ordre anatomique :",
      "  1. Foie : volume, forme, échostructure, lésion focale, contours, voies biliaires.",
      "  2. Voies biliaires et vésicule : distension VB, lithiase, épaississement pariétal.",
      "  3. Pancréas : visualisation, échostructure, anomalie.",
      "  4. Rate : taille, parenchyme.",
      "  5. Reins : dimensions, contours, dilatation des cavités excrétrices, lithiase.",
      "  6. Aorte abdominale : calibre.",
      "  7. Doppler couleur portal : perméabilité du tronc porte (flux hépatopète), branches intra-hépatiques, veines hépatiques, VCI.",
      "  8. Exploration pelvienne : vessie, utérus (endomètre si curseur visible), ovaires, épanchement, adénomégalies.",
      "  Formulations NORMALES Dr Kolo : « Foie : Volume, forme et échostructure homogènes, sans lésion focale identifiable. Contours hépatiques réguliers. Voies biliaires intra- et extra-hépatiques non dilatées. » / « Voies biliaires et vésicule : Vésicule biliaire bien tendue, sans image lithiasique ni épaississement pariétal. » / « Pancréas : Correctement visualisé, d'échostructure homogène, sans anomalie visible. » / « Rate : De taille normale, à parenchyme homogène. » / « Reins : Dimensions respectées, contours réguliers, sans dilatation des cavités excrétrices et sans image lithiasique. » / « Aorte abdominale : De calibre normal et régulier. » / « Doppler couleur portal : Tronc porte perméable avec un flux hépatopète régulier. Branches intra-hépatiques, veines hépatiques principales et VCI perméables et de morphologie normale. »",
      "- Si la région est MUSCULO-SQUELETTIQUE / ARTICULAIRE (épaule, genou, coude, cheville, tendon, fascia, parties molles) : organise les Résultats par sous-groupes anatomiques (ex. « Coiffe des rotateurs : » / « Bourse sous-acromiale : » / « Articulation gléno-humérale : »), puis chaque structure sur sa propre ligne au format « Structure : description. » sans puce ni gras. Ex. : « Tendon du supraépineux : Épais, continu, sans déchirure ni calcification. » / « Bourse sous-acromio-deltoïdienne : Non épanouie, sans épanchement. » Conclusion en 1-2 phrases avec recommandation IRM si indiquée.",
      "- Si la région est VASCULAIRE / DOPPLER ARTÉRIEL ou VEINEUX DÉDIÉ (TSA, carotides, artères des membres, veines des membres inférieurs) : format LABEL : DESCRIPTION par vaisseau, style Dr Kolo :",
      "  • TSA/CAROTIDES : pour chaque vaisseau (ACC droite/gauche, ACI droite/gauche, ACE, artères vertébrales) — perméabilité, flux (laminaire/turbulent), épaisseur intima-média (IMT si mesurée), plaques (localisation, taille, morphologie, caractère calcifié/mou/mixte, sténose estimée en %), pic systolique (PSV) et index de résistivité (RI) si valeurs visibles. Drapeau rouge : sténose ≥ 50 % → signaler en Conclusion avec estimation NASCET.",
      "  • VEINES MEMBRES INFÉRIEURS (phlébologie) : compressibilité de chaque segment (veine fémorale commune, veine fémorale superficielle, veine poplitée, veines jambières), flux spontané et modulé, présence d'un thrombus (aigu = mou/non compressible ; chronique = échogène/partiellement recanalise). Drapeau rouge : TVP confirmée → signaler en premier.",
      "  • Formules normales TSA : « Artère carotide commune droite : Perméable, flux laminaire, paroi fine. IMT normal. Pas de plaque. / Artère carotide interne droite : Perméable, flux laminaire, sans sténose significative. / Artère vertébrale droite : Perméable, flux antérograde. »",
      "- DOPPLER COULEUR : si des plages de COULEUR (rouge/bleu) sont présentes, c'est un Doppler de FLUX — décris la vascularisation (présente/absente, intra/périlésionnelle) ; ne confonds pas la couleur avec une lésion.",
      "- Pour chaque structure visible, décris : taille, échostructure (homogène/hétérogène), contours, et toute LÉSION FOCALE — KYSTE (anéchogène, arrondi, paroi fine, renforcement postérieur), nodule, masse, calcul (hyperéchogène + cône d'ombre), dilatation, épanchement.",
      "- Des CURSEURS de mesure (« + », « 1 », « 2 », pointillés, valeurs en mm/cm) posés sur une structure signalent une LÉSION/STRUCTURE MESURÉE : décris-la, REPORTE la valeur si lisible, et indique Anomalie = oui.",
    ].join("\n");
  if (m === "MR" || m === "MRI")
    return [
      "MODALITÉ : IRM (résonance magnétique). N'emploie PAS le concept de « fenêtre osseuse » (propre au scanner).",
      "FORMAT DU COMPTE RENDU — Style Dr Eva Son, Institut Médical de Champel :",
      "IMPORTANT : dans ta réponse, nomme la section des constatations « Description: » et NON « Résultats: ».",
      "- Section 'Description' : PROSE LIBRE, phrases courtes et directes, groupées par région/structure anatomique (PAS de puces, PAS d'étiquettes en gras, PAS de listes à points).",
      "  • Si l'examen couvre PLUSIEURS RÉGIONS (ex. rachis lombaire + genou), commence chaque région par son nom suivi de deux-points : « Rachis lombaire : [prose continu]. » puis saut de ligne, « Genou gauche : [prose continu]. »",
      "  • Ordre classique : constats normaux/neutres d'abord (alignement, hauteur, signal), puis anomalies.",
      "  • Formules RACHIS normales : « Alignement [cervical/lombaire] conservé. Hauteur des corps vertébraux respectée. Pas de tassement, pas d'anomalie focale agressive du signal osseux. Disques [X] sans hernie significative. Pas de sténose canalaire ni foraminale significative. Cône médullaire de morphologie et de signal conservés. »",
      "  • Pour les anomalies discales : niveau précis (L4-L5), type (protrusion/hernie), côté (médiane/paramédiane droite/gauche/foraminale), structure comprimée (racine L5 droite/moelle). Exemple : « Discrète protrusion discale paramédiane droite L4-L5, avec conflit de la racine L5 droite. »",
      "  • Formules GENOU normales : « Alignement fémoro-tibial conservé. Pas d'épanchement articulaire significatif. Ménisques sans fissure visible. Ligaments croisés et collatéraux continus. Appareil extenseur conservé. Pas de lésion osseuse aiguë, pas d'œdème osseux focal, pas de kyste poplité significatif. »",
      "  • Formules ÉPAULE : épanchement gléno-huméral, état de la coiffe (supraépineux, infraépineux, sous-scapulaire, long biceps), bourse sous-acromio-deltoïdienne, intervalle des rotateurs, signal osseux (œdème, lésion de Bankart). Drapeau rouge : déchirure transfixiante + subluxation/occlusion → signaler en premier.",
      "  • IRM PELVIS FÉMININ — ordre : utérus (position, dimensions, contours, myomètres, signal endomètre, lésion myomateuse : localisation sous-séreux/intramural/sous-muqueux, taille), ovaires (dimensions, follicules, kyste/masse, signal), Douglas/cul-de-sac (épanchement, endométriose), paroi vésicale, adénopathies pelviennes. Formules normales : « Utérus en antéversion, de dimensions normales, contours réguliers, sans lésion myomateuse identifiable. Endomètre fin, de signal homogène. Ovaires non individualisés / de dimensions normales, sans lésion focale kystique ni solide. Pas d'épanchement dans le cul-de-sac de Douglas. Pas d'adénopathie pelvienne significative. Paroi vésicale d'aspect normal. »",
      "  • IRM CÉRÉBRALE — ordre : structures médianes (en place / déviation), système ventriculaire (taille pour l'âge, hydrocéphalie), parenchyme sus-tentoriel (hypersignal FLAIR/T2, lésion ischémique, masse, contusion), parenchyme sous-tentoriel/cervelet/tronc, selle turcique, corps calleux, paquets acoustico-faciaux, sinus (opacité), diffusion (restriction = lésion aiguë), TOF (perméabilité vaisseaux intracrâniens). Formules normales : « Les structures médianes sont en place. Le système ventriculaire est de taille normale pour l'âge. Pas d'argument pour une lésion ischémique récente en diffusion. Pas d'hypersignal FLAIR pathologique significatif. Pas de syndrome de masse rétro-orbitaire. Pas d'anomalie des paquets acoustico-faciaux. Selle turcique et corps calleux sans anomalie. Axes vasculaires intracrâniens proximaux perméables sur le TOF 3D. » Drapeaux rouges cérébraux : hémorragie (T2*/SWI hypointense), lésion de diffusion restreinte (ischémie aiguë), effet de masse avec déplacement des structures médianes → toujours en tête de Conclusion.",
      "  • Décris le SIGNAL T1/T2/FLAIR/diffusion (si identifiables), les LÉSIONS FOCALES, œdème osseux, épanchement, état des structures (ménisques/ligaments/tendons/coiffe).",
      "- 'Constatations supplémentaires' (optionnel) : si l'examen révèle des trouvailles HORS champ principal (ex. mastoïdite sur IRM cérébrale, polype sur IRM pelvienne), les regrouper dans un paragraphe dédié AVANT la Conclusion, intitulé exactement « Constatations supplémentaires ». Ex. : « Constatations supplémentaires : présence d'un important comblement des cellules mastoïdiennes à gauche, compatible avec une mastoïdite non coalescente. Pas d'anomalie des orbites. »",
      "- Section 'Conclusion' : LISTE NUMÉROTÉE — un finding par numéro (1. / 2. / 3. ...). Le plus cliniquement important en premier. Si examen strictement normal : « 1. IRM [région] sans anomalie significative décelable. » Jamais de prose libre en Conclusion pour l'IRM.",
      "- TECHNIQUE IRM CHAMPEL (si applicable) : « Examen réalisé sur IRM ouverte Basda avec aimant permanent Nd-Fe-B, antenne [région], sans injection de GBCAs, avec séquences localizer, T1, T2 et T2 FS dans les plans usuels. »",
    ].join("\n");
  if (m === "CT")
    return [
      "MODALITÉ : SCANNER / ANGIO-SCANNER (tomodensitométrie). Style Dr Eva Son, Institut Médical de Champel.",
      "FORMAT DU COMPTE RENDU — deux variantes selon le contexte :",
      "VARIANTE A — CT STANDARD (focal, régional) : nomme la section « Description: ».",
      "  Sous-format A1 — CT CÉRÉBRAL (et sinus/rochers/orbites) : prose continue décrivant structures par ordre clinique, PAS de préfixe « Au niveau ». Formule normale cérébrale : « Absence d'hémorragie intracrânienne, d'effet de masse, de foyer de ramollissement visible ou d'anomalie expansive identifiable au CT natif. Ventricules et espaces sous-arachnoïdiens de taille conservée. Sinus de la face et rochers sans anomalie significative visible. Pas d'anomalie orbitaire évidente dans les limites de l'examen tomodensitométrique natif. »",
      "  Conclusion CT cérébral : EN GRAS (même si normal). Ex. : « **Examen CT cérébral dans les limites de la norme. Absence d'anomalie intracrânienne aiguë identifiable au scanner de débrouillage.** »",
      "  Sous-format A2 — CT OSTÉO-ARTICULAIRE / RACHIS / CORPS ENTIER : paragraphes « Au niveau [région], ... ».",
      "  Ex. CT rachis/bassin : « Au niveau L5-S1, présence d'un syndesmophyte postérieur récessal gauche associé à une probable hernie discale calcifiée ancienne, au contact de la racine S1 gauche. Au niveau L3-L4, remaniements interfacetaires bilatéraux avec présence de phénomène de vacuum articulaire en faveur d'une atteinte dégénérative avec composante inflammatoire postérieure. Pas de fracture ni de lésion traumatique aiguë identifiable. Le bassin et la hanche gauche sont sans anomalie osseuse décelable. »",
      "  Ex. CT corps entier (normal) : « Au niveau cervical, alignement conservé sans fracture ni luxation, sans anomalie osseuse décelable. Les parties molles cervicales sont sans collection ni emphysème. Les voies aériennes sont libres. Au niveau thoracique, le parenchyme pulmonaire est bien aéré sans foyer de contusion, sans condensation, sans verre dépoli ni pneumothorax. Absence d'épanchement pleural ou péricardique. Le médiastin est de morphologie conservée sans adénopathie pathologique identifiable. Au niveau abdomino-pelvien, le foie, la rate, le pancréas, les surrénales et les reins sont d'aspect habituel sans lésion focale. »",
      "VARIANTE B — CT MULTI-RÉGION TRAUMA (≥ 3 régions distinctes nommées) : nomme la section « Résultats: ».",
      "  Chaque région : NOM EN MAJUSCULES + espace + deux-points, puis prose. Ex. : « RACHIS LOMBAIRE : Signes d'arthrose postérieure étagée... ÉPAULE DROITE : L'examen est dans la norme... BASSIN ET HANCHES : L'anneau pelvien est intègre... »",
      "ANGIO-SCANNER VASCULAIRE : variante B avec régions AXES CAROTIDIENS ET VERTÉBRAUX :, TERRITOIRE INTRACRÂNIEN :, PARENCHYME CÉRÉBRAL :.",
      "  Formules normales ANGIO-TSA : « AXES CAROTIDIENS ET VERTÉBRAUX : Perméables, sans sténose hémodynamiquement significative ni signe de dissection. TERRITOIRE INTRACRÂNIEN : Axes proximaux perméables. PARENCHYME CÉRÉBRAL : Pas d'hémorragie intracrânienne visible. »",
      "SECTION CONCLUSION (variantes A ostéo/corps entier + variante B) :",
      "  Examen NORMAL → une phrase courte. Ex. : « Examen dans les limites de la norme sans lésion traumatique. »",
      "  Examen PATHOLOGIQUE → une phrase courte PAR FINDING en **gras** sur sa propre ligne. Ex. : « **Syndesmophyte récessal gauche L5-S1 avec probable hernie discale calcifiée ancienne.**\\n**Remaniements interfacetaires inflammatoires L3-L4 bilatéraux.**\\n**Absence de lésion traumatique aiguë.** »",
      "TECHNIQUE CT CHAMPEL : « Examen CT hélicoïdal sur Toshiba 128 barrettes Aquilion CX réalisé [sans injection de produit de contraste / après injection intraveineuse de X ml d'Iomeron 350, lot XXXXXX] [avec acquisitions centrées sur / corps entier incluant le membre supérieur gauche], avec reconstructions multiplanaires [en filtres dur et mou]. »",
      "ATTENTION (fenêtre osseuse) : l'os cortical dense apparaît NORMALEMENT blanc/très brillant. N'évoque une lésion pathologique QUE devant une destruction osseuse nette ou une masse de parties molles évidente.",
    ].join("\n");
  if (m === "CR" || m === "DX" || m === "DR" || m === "RX")
    return [
      "MODALITÉ : RADIOGRAPHIE STANDARD (projection).",
      "IDENTIFIE LA RÉGION d'après le texte incrusté, puis applique le plan correspondant :",
      "- THORAX (face ± profil) : ordonnancement systématique —",
      "  1. Cardiomédiastinal : index cardiothoracique (normal < 0,5), silhouette cardiaque, médiastin (élargi ?), hilaires (opacité, masse).",
      "  2. Parenchyme pulmonaire : opacité(s) (systématisée/non systématisée, alvéolaire/interstitielle, foyer), clarté anormale (pneumothorax — drapeau rouge : pneumothorax compressif), réticulaire/micronodulaire.",
      "  3. Plèvre : épanchement pleural (comblement du cul-de-sac, opacité en nappe), pachypleurite, calcifications.",
      "  4. Coupoles diaphragmatiques : niveau, sous-phrénique.",
      "  5. Os visibles : côtes (fracture, arc antérieur/postérieur/latéral), clavicules, sternum, vertèbres dorsales.",
      "  Formules normales thorax : « Index cardiothoracique normal. Médiastin sans élargissement. Hilaires d'aspect normal. Parenchyme pulmonaire sans opacité ni foyer. Pas d'épanchement pleural. Coupoles diaphragmatiques en place. »",
      "- OS / ARTICULAIRE : trait de fracture (siège, déplacement en mm, angulation en °, comminutif ?), tassement vertébral (hauteur, mur antérieur/postérieur), alignement, interlignes articulaires (pincement → Kellgren-Lawrence I–IV), ostéophytes, densité osseuse apparente, parties molles (gonflement, emphysème, calcification).",
      "- RACHIS : alignement sagittal (lordose/cyphose), hauteur des corps vertébraux, espaces discaux, trous de conjugaison (si profil), signes de spondylarthropathie.",
      "- SINUS / CRÂNE : opacité sinusienne (ethmoïdale/maxillaire/frontale/sphénoïdale), niveau hydro-aérique, fracture du massif facial, calvaria.",
      "- ABDOMEN SANS PRÉPARATION (ASP) : gaz (distribution normale/iléus/pneumopéritoine drapeau rouge), calcifications (lithiases vésiculaire, rénale, vasculaire, pancréatique), ombres des psoas, clartés sous-diaphragmatiques.",
      "- Drapeaux rouges RX : pneumothorax compressif, large épanchement pleural compressif, médiastin élargi (dissection ?), pneumopéritoine, déplacement médiastinal.",
    ].join("\n");
  if (m === "MG")
    return [
      "MODALITÉ : MAMMOGRAPHIE (± ÉCHOGRAPHIE MAMMAIRE COMBINÉE). Terminologie ACR/BI-RADS. Style radiologues genevois (Imagerive/Unilabs/Champel).",
      "FORMAT — section 'Description' en PROSE CONTINUE (pas de puces) :",
      "  1. DENSITÉ : catégorie ACR (a = essentiellement graisseux / b = densité fibroglandulaire modérée / c = hétérogène / d = extrêmement dense) + symétrie globale.",
      "  2. MASSES / OPACITÉS : localisation (sein D ou G, cadran, rayon horloge, superficiel/profond), forme (arrondie/ovale/irrégulière), contours (circonscrits/obscurcis/microlobulés/indistincts/spiculés), taille si lisible, stabilité vs antérieur.",
      "  3. MICROCALCIFICATIONS : présence/absence, morphologie (rondes bénignes / amorphes / pléomorphes / linéaires branchées suspectes), distribution (éparse / groupée / segmentaire).",
      "  4. DISTORSIONS ARCHITECTURALES et ASYMÉTRIES : présence/absence, localisation.",
      "  5. ÉCHOGRAPHIE (si réalisée sur le même examen) : « L'échographie est normale à droite » ou finding focal (taille, rayon horloge + profondeur, échostructure, vascularisation Doppler).",
      "  6. ADÉNOPATHIES axillaires : mentionner explicitement.",
      "  Formule NORMALE avec comparatif : « Les seins sont inchangés depuis [date], de densité modérée, globalement symétriques, sans surdensité suspecte apparue ni désorganisation architecturale. Pas de microcalcifications suspectes. L'échographie est normale à droite et à gauche. Pas d'image suspecte apparue. Pas d'adénopathie. »",
      "  Formule NORMALE sans comparatif : « Seins de densité b, globalement symétriques. Pas de masse, de microcalcification suspecte ni de distorsion architecturale. »",
      "  Formule avec FIBROADÉNOME stable : « Petite opacité fibroadénomateuse superficielle externe gauche stable. »",
      "CONCLUSION : 1 phrase de synthèse directe, puis BI-RADS + densité sur la ligne suivante.",
      "  Ex. normal : « Contrôle normal et stable depuis 2025 avec un petit fibroadénome dans le sein gauche. »",
      "  Puis : « Densité b. BI-RADS 2 »",
      "BI-RADS : 1 (normal), 2 (bénin), 3 (probablement bénin → suivi 6 mois), 4 (suspect → biopsie), 5 (très suspect → biopsie urgente), 6 (malin connu). TOUJOURS inclure dans la Conclusion.",
      "DRAPEAU ROUGE : BI-RADS 4 ou 5 → signaler EN PREMIER dans la Conclusion avec recommandation de cytoponction/biopsie guidée.",
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
    // Texte du (des) CR SIGNÉ(S) antérieur(s) du même patient (cf.
    // buildPriorReportBlock). Ancre l'évolution sur ce qui avait réellement été
    // écrit/signalé, au-delà de la seule comparaison visuelle. Jamais un brouillon.
    priorReports?: string;
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
  const claudeUsable = claudeConfigured && ENV.cloudAiPhiConsent;
  // Infomaniak (CH, nLPD natif) : prioritaire par défaut (« auto »). CR_PROVIDER
  // permet de router le CR vers Claude (ex. Fable 5) sans retirer la clé
  // Infomaniak, qui reste utilisée par les autres chemins vision.
  const infomaniakUsable =
    !!ENV.infomaniakVisionKey && !!ENV.infomaniakVisionUrl;
  const crBackend = pickCrProvider({
    crProvider: ENV.crProvider,
    claudeUsable,
    infomaniakUsable,
  });
  const useClaude = crBackend === "claude";
  const useInfomaniakCR = crBackend === "infomaniak";
  if (claudeConfigured && !ENV.cloudAiPhiConsent) {
    console.warn(
      "[aiPreanalysis] AI_BACKEND=claude ignoré : MEDIVIEW_CLOUD_AI_PHI_CONSENT non activé (nLPD/DPA) → repli sur Ollama local."
    );
  }
  const comparing = !!opts.prior && opts.prior.images.length > 0;
  // Budget d'images adapté au modèle : Claude (grand contexte, cloud) encaisse
  // PLUS de coupes en PLEINE résolution → meilleure lecture de l'examen. Le
  // modèle local (GPU L4) reste à 16/768 px pour ne pas le saturer.
  const maxImages = opts.maxImages ?? (useClaude || useInfomaniakCR ? 32 : 16);
  // Résolution d'envoi : Claude/Infomaniak lisent mieux les PETITS signes en
  // haute déf. 1568 px = côté optimal (au-delà redimensionné sans gain).
  // Le modèle local reste à VISION_MAX_DIM (768) — au-delà il sature.
  const visionDim = useClaude || useInfomaniakCR ? 1568 : VISION_MAX_DIM;
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
  // Texte du CR antérieur signé : DONNÉES validées par le médecin, pour ancrer la
  // comparaison d'évolution (n'a de sens que lorsqu'on compare une antériorité).
  if (comparing && opts.priorReports) {
    ctxLines.push("");
    ctxLines.push(opts.priorReports);
  }
  const userText = ctxLines.join("\n");
  const base = buildSystemPrompt(opts.modality);
  const system = comparing ? `${base}\n${COMPARATIVE_ADDENDUM}` : base;

  if (useInfomaniakCR) {
    return generateViaInfomaniak(images, userText, labels, system);
  }
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
  // Cloud Opus : 8 coupes en 1568px (lit les petits signes) ; local : 512px.
  const pics = images
    .slice(0, 8)
    .map(k => downscalePngBase64(k.pngBase64, cloud ? 1568 : 512));
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
  // PLEINE résolution (1568) — un curseur fin « + » et un petit chiffre sont
  // illisibles en 512 px. On prend jusqu'à 6 frames réparties.
  const picks: string[] = [];
  const step = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n && picks.length < 6; i += step) {
    picks.push(downscalePngBase64(images[i].pngBase64, 1568));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    let txt = "";
    const ikOcr =
      opts.cloud && !!ENV.infomaniakVisionKey && !!ENV.infomaniakVisionUrl;
    // Infomaniak (CH) en priorité cloud ; Anthropic en repli ; sinon local.
    if (ikOcr) {
      const content: any[] = [
        ...picks.map(b64 => ({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${b64}` },
        })),
        {
          type: "text",
          text: "Transcris le texte incrusté et signale tout curseur de mesure (croix +, pointillés), par organe.",
        },
      ];
      const r = await fetch(ENV.infomaniakVisionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.infomaniakVisionKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: ENV.infomaniakVisionModel,
          max_tokens: 400,
          messages: [
            { role: "system", content: OCR_SYSTEM },
            { role: "user", content },
          ],
        }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      txt = (d?.choices?.[0]?.message?.content ?? "").trim();
    } else if (opts.cloud && ENV.anthropicApiKey) {
      // Cloud (Opus) : lit les petits curseurs/chiffres bien mieux que le local.
      const content: any[] = picks.map(b64 => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64 },
      }));
      content.push({
        type: "text",
        text: "Transcris le texte incrusté et signale tout curseur de mesure (croix +, pointillés), par organe.",
      });
      const data = await anthropicMessagesFetch(
        {
          model: ENV.anthropicModel,
          max_tokens: 400,
          system: OCR_SYSTEM,
          messages: [{ role: "user", content }],
        },
        controller.signal,
        ENV.anthropicApiKey
      );
      if (!data) return null;
      txt = (Array.isArray(data?.content) ? data.content : [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
    } else {
      txt = await chatVision({
        system: OCR_SYSTEM,
        userText: "Transcris le texte/les mesures affichés.",
        images: picks,
        numCtx: 8192,
        numPredict: 250,
        temperature: 0,
        signal: controller.signal,
      });
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
    const ikFvr =
      cloud && !!ENV.infomaniakVisionKey && !!ENV.infomaniakVisionUrl;
    if (ikFvr) {
      const content: any[] = [
        ...imagesB64.map(b64 => ({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${b64}` },
        })),
        { type: "text", text: userText },
      ];
      const r = await fetch(ENV.infomaniakVisionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.infomaniakVisionKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: ENV.infomaniakVisionModel,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
        }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      const t = (d?.choices?.[0]?.message?.content ?? "").trim();
      return t || null;
    } else if (cloud && ENV.anthropicApiKey) {
      const content: any[] = imagesB64.map(b64 => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64 },
      }));
      content.push({ type: "text", text: userText });
      const data = await anthropicMessagesFetch(
        {
          model: ENV.anthropicModel,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content }],
        },
        controller.signal,
        ENV.anthropicApiKey
      );
      if (!data) return null;
      const t = (Array.isArray(data?.content) ? data.content : [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      return t || null;
    }
    const t = await chatVision({
      system,
      userText,
      images: imagesB64,
      numCtx: 8192,
      numPredict: maxTokens,
      temperature: 0.1,
      signal: controller.signal,
    });
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  let content = "";
  try {
    content = await chatVision({
      system,
      userText,
      images,
      numCtx,
      numPredict: 1024,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const useInfomaniak =
    ENV.visionProvider === "infomaniak" &&
    !!ENV.infomaniakVisionKey &&
    !!ENV.infomaniakVisionUrl;
  return {
    ...parseSections(content),
    ...parseKeySlice(content),
    evolution: parseEvolution(content).evolution,
    model: useInfomaniak ? ENV.infomaniakVisionModel : ENV.ollamaVisionModel,
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
  const { anthropicCreate } = await import("./anthropicClient");
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
  const resp = await anthropicCreate(
    client,
    {
      model: ENV.anthropicModel,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content }],
    },
    // Fable 5 : thinking toujours actif → tours nettement plus longs (mesuré
    // 107 s pour 8 coupes ; l'analyse pleine résolution peut dépasser 240 s).
    { timeout: isFableModel(ENV.anthropicModel) ? 600_000 : 240_000 }
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

async function generateViaInfomaniak(
  images: string[],
  userText: string,
  labels: string[],
  system: string
): Promise<PreanalysisResult> {
  const content: any[] = [];
  images.forEach((b64, i) => {
    content.push({
      type: "text",
      text: labels[i] ?? `Coupe n° ${i + 1} :`,
    });
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${b64}` },
    });
  });
  content.push({ type: "text", text: userText });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  try {
    const resp = await fetch(ENV.infomaniakVisionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.infomaniakVisionKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: ENV.infomaniakVisionModel,
        max_tokens: 2000,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Infomaniak CR: HTTP ${resp.status} — ${err.slice(0, 200)}`,
      });
    }
    const data = await resp.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    return {
      ...parseSections(text),
      ...parseKeySlice(text),
      evolution: parseEvolution(text).evolution,
      model: ENV.infomaniakVisionModel,
    };
  } finally {
    clearTimeout(timeout);
  }
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
            maxDim: cloudVision ? 1568 : 768,
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
        maxDim: cloudVision ? 1568 : 768,
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

  // --- MULTI-FENÊTRAGE CT (levier précision) --------------------------------
  // Un même scanner doit être lu sous PLUSIEURS fenêtres : un nodule pulmonaire
  // n'est visible qu'en fenêtre PARENCHYMATEUSE, un trait de fracture qu'en
  // fenêtre OSSEUSE, etc. La fenêtre W/L par défaut (parties molles 40/400) les
  // masque. On ré-échantillonne donc quelques coupes clés en fenêtre OSSEUSE et
  // PULMONAIRE, étiquetées, et on les ajoute au lot envoyé à l'IA. Cloud Claude
  // uniquement (grand contexte) ; CT/CTA seulement ; jamais en comparaison
  // d'antériorité (budget réservé à l'évolution).
  const isCT = modalityUpper === "CT" || modalityUpper === "CTA";
  if (
    cloudVision &&
    isCT &&
    !comparingPriors &&
    images.length > 0 &&
    (input.seriesId || input.wholeStudy)
  ) {
    try {
      const { sampleSeriesPngs } = await import("./aiSampling");
      // Série diagnostique de référence pour le re-fenêtrage.
      let refSeriesId: number | undefined = input.seriesId ?? undefined;
      if (!refSeriesId && input.wholeStudy) {
        const allSeriesRaw = await listSeriesByStudy(input.studyId);
        const diag = selectDiagnosticSeries(allSeriesRaw as any);
        // La plus grosse série diagnostique (le vrai volume) porte le signal.
        const biggest = [...(diag as any[])].sort(
          (a: any, b: any) =>
            (b.numberOfInstances ?? 0) - (a.numberOfInstances ?? 0)
        )[0];
        refSeriesId = biggest?.id;
      }
      if (refSeriesId) {
        // Fenêtres standard radiologiques. On évite de redonner la fenêtre déjà
        // envoyée (parties molles ~40/400) pour ne pas gaspiller le budget.
        const extraWindows: Array<{
          label: string;
          wc: number;
          ww: number;
        }> = [
          { label: "fenêtre OSSEUSE", wc: 400, ww: 1800 },
          { label: "fenêtre PULMONAIRE", wc: -550, ww: 1600 },
        ];
        for (const win of extraWindows) {
          try {
            const s = await sampleSeriesPngs(refSeriesId, {
              windowCenter: win.wc,
              windowWidth: win.ww,
              count: 4,
              maxDim: 1568,
            });
            for (const x of s.images) {
              images.push({
                pngBase64: x.pngBase64,
                sliceIndex: x.sliceNumber,
                seriesLabel: `${win.label} (WC ${win.wc} / WW ${win.ww})`,
              });
            }
          } catch {
            // fenêtre non rendable → on continue
          }
        }
      }
    } catch (e) {
      console.warn("[aiPreanalysis] multi-fenêtrage CT échoué:", e);
    }
  }

  // --- Antériorité (mesure d'évolution) : fail-soft de bout en bout. ---------
  let prior:
    | { images: PreanalysisKeyImage[]; date?: string; totalSlices?: number }
    | undefined;
  let comparedPriorDate: string | null = null;
  // Antériorités RÉELLEMENT comparées (images échantillonnées) → on ira chercher
  // le TEXTE de leur CR signé pour ancrer l'évolution (cf. buildPriorReportBlock).
  const priorStudiesForText: { id: number; date?: string | null }[] = [];
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
            priorStudiesForText.push({
              id: input.priorStudyId,
              date: (priorStudy as any).studyDate ?? null,
            });
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
            maxDim: cloudVision ? 1568 : 768,
          });
          const d = p.studyDate ?? undefined;
          for (const x of sp.images) {
            priorImgs.push({
              pngBase64: x.pngBase64,
              sliceIndex: x.sliceNumber,
              dateLabel: d,
            });
          }
          if (sp.images.length > 0) {
            priorStudiesForText.push({ id: p.id, date: p.studyDate ?? null });
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
  // Segmentation = TotalSegmentator (CT uniquement, `isCT` défini plus haut). On
  // la gate à la modalité CT pour qu'un includeSegmentation « toujours actif » ne
  // perde pas de temps en écho/IRM (où elle ne s'applique pas).
  if (
    input.includeSegmentation &&
    isCT &&
    input.seriesId &&
    ENV.segServiceUrl
  ) {
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

  // Texte des CR SIGNÉS antérieurs (fail-soft) : seuls les CR validés sont repris
  // (buildPriorReportBlock filtre `status === "signed"`) → jamais un brouillon IA.
  let priorReports: string | undefined;
  if (priorStudiesForText.length > 0) {
    try {
      const { getReportByStudy } = await import("../db");
      const rows: PriorReportRow[] = [];
      for (const ps of priorStudiesForText) {
        const rep = await getReportByStudy(ps.id);
        if (rep) {
          rows.push({
            date: ps.date ?? null,
            status: (rep as any).status,
            conclusion: (rep as any).conclusion ?? null,
          });
        }
      }
      priorReports = buildPriorReportBlock(rows);
    } catch (e) {
      console.warn("[aiPreanalysis] lecture CR antérieur échouée:", e);
    }
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
    priorReports,
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
    keySlice = images[Math.floor(images.length / 2)]!.sliceIndex;
  }
  // Priorité 1 : image déjà rendue dans l'échantillon (toujours disponible,
  // même quand le storage ou renderSliceByNumber échoue : multi-frame, compression
  // non supportée, etc.). La qualité est légèrement inférieure (downscale IA) mais
  // garantie de présence — mieux qu'une image clé manquante.
  if (keySlice !== null) {
    const fromSample = images.find(img => img.sliceIndex === keySlice);
    if (fromSample)
      keyImage = {
        pngBase64: fromSample.pngBase64,
        sliceIndex: fromSample.sliceIndex,
      };
  }
  // Priorité 2 : re-rendu haute résolution depuis le stockage.
  if (!keyImage && input.seriesId && keySlice !== null) {
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
  // SYSTÉMATIQUE en cloud (Claude) — le 2e regard rattrape les ratés, et le coût
  // est négligeable face au risque clinique (Règle #1). Reste optionnel en local
  // (GPU L4 : éviter de doubler la charge sur chaque examen).
  let secondOpinion: RunAiPreanalysisResult["secondOpinion"] = null;
  if (input.doubleRead || cloudVision) {
    try {
      // 2e lecture INDÉPENDANTE : toujours le modèle LOCAL (qwen), distinct du
      // rapport principal (Opus) → vrai 2e avis (rattrape les angles morts), et
      // gratuit/local (pas d'appel Opus en plus). Un désaccord = vraie
      // divergence inter-modèles = signal d'incertitude pertinent.
      const ab2 = await secondOpinionAbnormal(
        images,
        (study as any).modality ?? undefined,
        false
      );
      secondOpinion = {
        abnormal: ab2,
        model: ENV.ollamaVisionModel2,
        // accord seulement si le 2e modèle a donné un avis NET (non null).
        agree: ab2 !== null && ab2 === (result.abnormal ?? null),
      };
    } catch (e) {
      console.warn("[aiPreanalysis] 2e lecture échouée:", e);
    }
  }

  // Vérification critique : relecture CONTRADICTOIRE de la conclusion (anti
  // sur-/sous-diagnostic). Annexée au CR (à valider). Fail-soft.
  //  - Anomalie signalée → on challenge le sur-diagnostic (« est-ce vraiment
  //    pathologique ? »).
  //  - Examen déclaré NORMAL en cloud → on challenge la FAUSSE RÉASSURANCE
  //    (Règle #1 : « a-t-on manqué quelque chose ? »), le raté le plus grave.
  const shouldVerify =
    !!result.conclusion &&
    (result.abnormal === true || (cloudVision && result.abnormal === false));
  if (shouldVerify) {
    try {
      const verifyImgs = images
        .slice(0, cloudVision ? 6 : 4)
        .map(k => downscalePngBase64(k.pngBase64, cloudVision ? 1568 : 768));
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
  // Tolère le décor markdown autour de l'étiquette (« **Anomalie :** oui »,
  // « ## Anomalie ») — cf. parseSections. Le \b reste : il évite de matcher
  // « anomalie(s) » employé dans une phrase.
  const line = text.match(
    /(?:^|\n)\s*(?:#{1,4}[ \t]+)?(?:\*{1,3}|_{1,3})?Anomalie\b\s*:\s*(?:\*{1,3}|_{1,3})?[ \t]*([^\n]*)/i
  );
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
    /\n?\s*(?:#{1,4}[ \t]+)?(?:\*{1,3}|_{1,3})?[EÉeé]volution(?:\*{1,3}|_{1,3})?\s*:?\s*(?:\*{1,3}|_{1,3})?(stable|progression|régression|regression)\b(?:\*{1,3}|_{1,3})?/i
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
  // Décor markdown OPTIONNEL autour d'une étiquette : les prompts demandent du
  // gras (« conclusion EN GRAS », « **Classification : BI-RADS 1** ») et les
  // modèles décorent alors souvent l'ÉTIQUETTE elle-même (« **Conclusion :** »,
  // « ## Conclusion »). Sans cette tolérance, l'étiquette décorée ne matche pas
  // → Conclusion silencieusement perdue, ou lignes méta qui fuient dans le CR.
  const B = "(?:#{1,4}[ \\t]+)?(?:\\*{1,3}|_{1,3})?";
  // Après le deux-points, tolérer aussi la fermeture du gras (« :** »).
  const A = "\\s*:?\\s*(?:\\*{1,3}|_{1,3})?[ \\t]*";
  // On retire d'abord les lignes méta finales (Anomalie / Coupe-clé) pour
  // qu'elles ne soient pas absorbées dans la Conclusion.
  const cut = text.search(
    new RegExp(
      `\\n\\s*${B}(Anomalie|Coupe[-\\s]?cl[ée]|[EÉeé]volution)${B}\\s*:`,
      "i"
    )
  );
  if (cut >= 0) text = text.slice(0, cut);
  // Étiquettes de section TOLÉRANTES : un modèle local (qwen 7b) ne respecte
  // pas toujours l'accent ni le pluriel ("Resultats", "Résultat",
  // "Constatations", "RÉSULTATS"). On accepte ces variantes pour ne JAMAIS
  // perdre silencieusement la Conclusion (sinon le médecin reçoit un brouillon
  // amputé). Les classes [eé]/[ée] couvrent les formes sans accent.
  // Technique : "Technique"
  const T = `${B}Technique${B}`;
  // Résultats : "Résultats"/"Resultats"/"Résultat"/"Constatations"/"Constatation"
  const R = `${B}(?:R[ée]sultats?|Constatations?|Description)${B}`;
  // Conclusion : "Conclusion"/"Conclusions"
  const C = `${B}Conclusions?${B}`;
  // Format attendu : Technique / Résultats / Conclusion.
  const m3 = text.match(
    new RegExp(
      `${T}${A}([\\s\\S]*?)\\n\\s*${R}${A}([\\s\\S]*?)\\n\\s*${C}${A}([\\s\\S]*)$`,
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
    new RegExp(`${R}${A}([\\s\\S]*?)\\n\\s*${C}${A}([\\s\\S]*)$`, "i")
  );
  if (m2)
    return { technique: "", resultats: m2[1].trim(), conclusion: m2[2].trim() };
  // Repli ultime : tout dans resultats.
  return { technique: "", resultats: text.trim(), conclusion: "" };
}
