// Semis RAG : fiches de référence CT abdomino-pelvien / traumatologie / rachis.
// Connaissances GÉNÉRIQUES (textbook) — AUCUNE donnée patient. Source dédiée
// `radio-ref-ct-abdo`. Idempotent (purge puis ré-insère). Embeddings LOCAUX.
//   docker exec -w /app horos-app-1 node seed-ct-abdo-ref.mjs
import mysql from "mysql2/promise";

const SOURCE = "radio-ref-ct-abdo";
const OLLAMA = process.env.OLLAMA_URL || "http://ollama-hermes:11434";
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const FICHES = [
  {
    heading: "CT abdomino-pelvien — revue systématique du compte rendu",
    content:
      "Ordre de revue : bases pulmonaires ; foie (taille, contours, parenchyme, lésion focale) et voies biliaires ; vésicule biliaire (paroi, lithiase) ; pancréas ; rate ; surrénales ; reins et voies urinaires (dilatation des cavités, lithiase, uretères) ; vessie ; tube digestif (épaississement pariétal) ; péritoine et adénopathies ; épanchement ; aorte et axes iliaques ; structures osseuses (lésion lytique/condensante). Conclusion = synthèse des findings positifs et des négatifs pertinents répondant à l'indication.",
  },
  {
    heading: "Appendicite aiguë au CT — critères",
    content:
      "Signes : appendice de diamètre > 6–7 mm, paroi épaissie et rehaussée (si injection), infiltration de la graisse péri-appendiculaire (stranding), appendicolithe, épanchement local, voire abcès ou plastron. À l'inverse, un appendice de calibre infra-centimétrique sans infiltration de la graisse adjacente écarte une appendicite. Devant une douleur de la fosse iliaque droite, conclure explicitement sur l'appendice.",
  },
  {
    heading: "Hernie discale lombaire et conflit radiculaire — terminologie",
    content:
      "Décrire : niveau (ex. L5-S1), type (protrusion vs extrusion), topographie (médiane, paramédiane, récessale/sous-articulaire, foraminale, extra-foraminale) et le CONFLIT radiculaire (racine comprimée). À L4-L5 une hernie récessale touche typiquement L5 ; à L5-S1 elle touche S1. Préciser sténose canalaire/foraminale associée et discopathie dégénérative. Le CT voit la hernie mais l'IRM reste l'examen de référence pour le conflit radiculaire.",
  },
  {
    heading:
      "Pan-scanner post-traumatique (natif) — checklist et signes hémorragiques",
    content:
      "Revue : encéphale (hémorragie intra-axiale/contusion, hématome extra/sous-dural, engagement, ventricules) ; os crâne/massif facial/rochers (fracture, niveau hydro-aérique = hémosinus) ; rachis cervical/thoracique/lombaire (fracture, tassement, recul du mur postérieur) ; thorax (pneumothorax, hémothorax, contusion pulmonaire, fractures de côtes, médiastin) ; abdomen (lacération d'organe plein, hémopéritoine, pneumopéritoine) ; pelvis (fracture, hématome) ; membres (fracture, luxation, diastasis). Le sang aigu est SPONTANÉMENT HYPERDENSE au CT natif (~50–70 UH). Distinguer lésions aiguës et séquelles chroniques.",
  },
  {
    heading: "Sacro-iliite et spondyloarthrite au CT",
    content:
      "Au CT : érosions des berges sacro-iliaques, condensation/sclérose sous-chondrale, pincement ou ankylose de l'interligne ; syndesmophytes (ponts osseux para-vertébraux ou para-sacro-iliaques). Le CT montre les lésions structurales chroniques ; l'inflammation active (œdème osseux) nécessite l'IRM. Un syndesmophyte para-sacro-iliaque évoque une spondyloarthrite.",
  },
  {
    heading: "Hernie de paroi (inguinale) au CT",
    content:
      "Décrire : siège (inguinale directe/indirecte, fémorale, ombilicale, éventration), taille du collet (étroit = risque d'étranglement), contenu (graisse, anse digestive) et signes de complication : engouement, occlusion d'amont, souffrance digestive (épaississement/défaut de rehaussement de la paroi, infiltration de la graisse). « Collet étroit non compliquée » = pas de signe d'occlusion ni de souffrance.",
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
