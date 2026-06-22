// Semis RAG v2 : fiches apprises de vrais CR (ostéo-articulaire, neuro, pelvis,
// trauma, principes de rédaction). GÉNÉRIQUES (textbook) — AUCUNE donnée patient.
// Source dédiée `radio-ref-v2`. Idempotent. Embeddings LOCAUX (nomic-embed-text).
//   docker exec -w /app horos-app-1 node seed-radio-ref-v2.mjs
import mysql from "mysql2/promise";

const SOURCE = "radio-ref-v2";
const OLLAMA = process.env.OLLAMA_URL || "http://ollama-hermes:11434";
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const FICHES = [
  {
    heading: "Spondylolyse et spondylolisthésis (lyse isthmique) — CT/IRM",
    content:
      "Lyse isthmique = défect de la pars interarticularis (isthme vertébral), le plus souvent en L5 (parfois L4), uni- ou bilatérale ; bien vue au CT (interruption de l'isthme). Elle autorise un glissement antérieur du corps vertébral = antélisthésis (spondylolisthésis), gradé selon Meyerding par le pourcentage de glissement sur le plateau sous-jacent : grade I < 25 %, II 25–50 %, III 50–75 %, IV > 75 %. Décrire : niveau, caractère uni/bilatéral de la lyse, grade de l'antélisthésis, retentissement sur les foramens/canal.",
  },
  {
    heading: "Arthrose et chondropathie du genou — grades et compartiments",
    content:
      "Le genou a 3 compartiments : fémoro-tibial médial, fémoro-tibial latéral, fémoro-patellaire. Une atteinte des 3 = tricompartimentale. Signes dégénératifs : pincement de l'interligne, ostéophytes, sclérose sous-chondrale, géodes, irrégularités cartilagineuses. La chondropathie se grade (type Outerbridge) de I (ramollissement) à IV (perte cartilagineuse complète avec os sous-chondral à nu). Distinguer les remaniements DÉGÉNÉRATIFS/chroniques d'une lésion traumatique AIGUË (important en contexte de traumatisme).",
  },
  {
    heading: "Scanner cérébral natif — ce qu'il montre et ses limites",
    content:
      "Le CT cérébral natif détecte bien : l'hémorragie aiguë (spontanément HYPERDENSE, ~50–70 UH), l'effet de masse, l'engagement, l'hydrocéphalie, les fractures osseuses, une lésion expansive. Revue : parenchyme, hémorragie intra/extra-axiale, ventricules et espaces sous-arachnoïdiens, ligne médiane, os de la voûte et de la base, ± sinus/rochers/orbites. LIMITES à mentionner : l'ischémie aiguë est peu/pas visible les premières heures, la fosse postérieure est masquée par les artéfacts osseux, et la démyélinisation/petites lésions nécessitent l'IRM. Conclure « dans les limites de l'examen natif ».",
  },
  {
    heading: "IRM cérébrale et du rachis cervical — revue systématique",
    content:
      "Cérébral : effet de masse, hémorragie, foyer de démyélinisation, ramollissement/ischémie (diffusion si disponible), ventricules et espaces sous-arachnoïdiens. Rachis cervical : alignement, hauteur des disques, hernie discale compressive, calibre du canal et des foramens, signal médullaire (myélopathie). Parties molles cervicales si incluses. Sur IRM à champ ouvert (bas champ), signaler que la résolution et les séquences sont plus limitées qu'à 1,5 T / 3 T et proposer une corrélation à plus haut champ si besoin.",
  },
  {
    heading: "Cicatrice de césarienne et granulome cicatriciel — IRM pelvienne",
    content:
      "Après césarienne, la cicatrice siège à l'isthme utérin (segment inférieur). Un remaniement cicatriciel inflammatoire (granulome) se présente comme un épaississement nodulaire para-médian, en discret hypersignal T2, avec rehaussement modéré après gadolinium, ± effacement du plan graisseux vésico-utérin. À distinguer d'une endométriose de cicatrice, d'une collection/abcès (rehaussement périphérique) ou d'une récidive tumorale. Mesurer la zone jonctionnelle, l'endomètre et le myomètre. Proposer corrélation échographique ou IRM haut champ si doute.",
  },
  {
    heading:
      "Bilan CT post-traumatique — aigu vs séquellaire et findings incidents",
    content:
      "Devant un traumatisme, chercher activement les lésions AIGUËS : fracture (trait, déplacement, enfoncement), luxation, diastasis articulaire, hématome, hémorragie (sang hyperdense au natif), épanchement. Bien DISTINGUER ces lésions aiguës des remaniements dégénératifs/séquellaires préexistants (arthrose, chondropathie, anciens cals). Le CT natif est limité pour les parties molles et les tendons (ex. une rupture du tendon calcanéen n'est pas exclue au CT → écho/IRM). Mentionner les findings INCIDENTS pertinents (ex. sinusite maxillaire = épaississement muqueux).",
  },
  {
    heading: "Sinusite et atteinte des sinus au scanner",
    content:
      "Signes scanographiques de sinusite : épaississement muqueux tapissant les parois du sinus, niveau hydro-aérique (sinusite aiguë), comblement complet, ± érosion osseuse (formes compliquées). Préciser le(s) sinus atteint(s) (maxillaire, ethmoïdal, frontal, sphénoïdal). Souvent un finding incident sur un CT crânien ou cervical.",
  },
  {
    heading:
      "Paroi abdominale : hernie ombilicale et diastasis des grands droits — CT",
    content:
      "Hernie ombilicale/de la ligne blanche : défect aponévrotique avec sac herniaire (graisse ± anse) ; préciser taille du collet et signes de complication (engouement, occlusion, souffrance digestive). Diastasis des muscles grands droits : écartement (augmentation de la distance inter-rectus) sans défect aponévrotique vrai, sans sac herniaire. Le CT objective le défect et son contenu ; en l'absence de défect ou de sac, conclure « pas de hernie ni de diastasis objectivable ».",
  },
  {
    heading: "Principes de rédaction d'un compte rendu radiologique",
    content:
      "Répondre EXPLICITEMENT à l'indication clinique dans la conclusion, y compris quand le résultat est négatif (ex. « pas de hernie objectivable »). GRADER les lésions quand une classification existe (Meyerding pour l'antélisthésis, Outerbridge pour la chondropathie, BI-RADS, TI-RADS, Fleischner, LI-RADS…). Donner des MESURES chiffrées. SIGNALER les limites de la technique (CT natif, IRM bas champ, artéfacts) et proposer l'examen complémentaire adapté. Distinguer aigu vs chronique/dégénératif. Conclusion synthétique, volontiers en puces.",
  },
];

async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.embedding)) throw new Error("embedding manquant");
  return j.embedding;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL absent");
  const conn = await mysql.createConnection(url);
  await conn.execute("DELETE FROM knowledge_chunks WHERE source = ?", [SOURCE]);
  let n = 0;
  for (const f of FICHES) {
    const e = await embed(`${f.heading}\n${f.content}`);
    await conn.execute(
      "INSERT INTO knowledge_chunks (source, heading, content, embedding) VALUES (?, ?, ?, ?)",
      [SOURCE, f.heading, f.content, JSON.stringify(e)]
    );
    n++;
    console.log(`  + ${f.heading} (dim ${e.length})`);
  }
  const [rows] = await conn.execute(
    "SELECT COUNT(*) AS c FROM knowledge_chunks WHERE source = ?",
    [SOURCE]
  );
  await conn.end();
  console.log(
    `[OK] ${n} fiches semées ; total source '${SOURCE}' = ${rows[0].c}`
  );
}

main().catch(e => {
  console.error("[ERREUR]", e.message);
  process.exit(1);
});
