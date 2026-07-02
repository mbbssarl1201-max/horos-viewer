// Semis RAG : fiches de référence IRM pelvienne féminine (gynécologique).
// Connaissances GÉNÉRIQUES (textbook) — AUCUNE donnée patient. Source dédiée
// `radio-ref-gyn` (additive, n'altère pas les fiches `radio-ref` existantes).
// Idempotent : purge la source puis ré-insère. Embeddings LOCAUX (nomic-embed-text
// sur ollama-hermes) → PHI-safe. À lancer DANS le conteneur app (mysql2 + réseau).
//
//   docker exec horos-app-1 node /tmp/seed-gyn-pelvic-ref.mjs
import mysql from "mysql2/promise";

const SOURCE = "radio-ref-gyn";
const OLLAMA = process.env.OLLAMA_URL || "http://ollama-hermes:11434";
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const FICHES = [
  {
    heading: "IRM pelvienne féminine — protocole et structure du compte rendu",
    content:
      "Protocole : T2 FSE multiplan (axial, sagittal, coronal) ± T1 SE ± saturation de graisse ± gadolinium. Revue SYSTÉMATIQUE : utérus (position antéversé/rétroversé, dimensions 3 axes, zone jonctionnelle, myomètre, endomètre), col utérin, ovaires et annexes, recherche d'endométriome et d'endométriose profonde (ligaments utéro-sacrés, torus, Douglas, cloison recto-vaginale, vessie, recto-sigmoïde), épanchement pelvien, vessie et recto-sigmoïde. Conclusion = synthèse des findings positifs ET des négatifs pertinents répondant explicitement à l'indication clinique.",
  },
  {
    heading: "Adénomyose — critères IRM (zone jonctionnelle)",
    content:
      "Le critère clé est l'épaisseur de la zone jonctionnelle (JZ) en T2 : JZ ≥ 12 mm = adénomyose ; 8–12 mm = douteux/borderline ; < 8 mm = normal. Signes associés : épaississement focal ou diffus de la JZ, contours mal définis, foci kystiques myométriaux en hypersignal T2 (± hypersignal T1), utérus globuleux, rapport JZ/myomètre augmenté. L'adénomyose est une cause fréquente de douleur pelvienne et de ménométrorragies.",
  },
  {
    heading: "Dimensions utérines normales et endomètre (IRM)",
    content:
      "Utérus normal (femme en âge de procréer) : environ 7–9 cm (longueur) × 4–5 cm (largeur) × 3–4 cm (antéro-postérieur), variable avec la parité ; plus petit en post-ménopause. Un utérus globuleux/augmenté oriente vers adénomyose ou myomes. Endomètre : épaisseur variable selon la phase du cycle (fin en phase folliculaire précoce, plus épais en phase sécrétoire) ; en post-ménopause < 5 mm sans traitement hormonal.",
  },
  {
    heading: "Kyste de Naboth (col utérin)",
    content:
      "Kyste de rétention mucineux des glandes endocervicales, fréquent et bénin. IRM : hypersignal T2 franc, bien limité, paroi fine, sans rehaussement nodulaire suspect. À décrire comme « sans caractère suspect » ; aucune surveillance spécifique nécessaire.",
  },
  {
    heading: "Endométriome ovarien — critères IRM",
    content:
      "Kyste ovarien endométriosique : hypersignal T1 marqué PERSISTANT sur les séquences avec saturation de graisse (sang/produits de dégradation), associé à un « shading » en T2 (hyposignal T2 relatif du contenu). Souvent multiple/bilatéral. Recherche systématique devant douleur pelvienne chronique ou suspicion d'endométriose. Diagnostic différentiel : kyste hémorragique (résolutif), tératome (graisse macroscopique chutant en saturation de graisse).",
  },
  {
    heading: "Endométriose pelvienne profonde — sémiologie IRM",
    content:
      "Nodules/plaques fibreux en hyposignal T2 (± spots hypersignal T1 hémorragiques). Localisations à explorer : ligaments utéro-sacrés, torus utérin, cul-de-sac de Douglas, cloison recto-vaginale, paroi vésicale (dôme), jonction recto-sigmoïdienne, fosses ovariennes. Signes indirects : rétractions, adhérences, ovaires « kissing », oblitération du cul-de-sac, élévation du recto-sigmoïde. En l'absence de ces signes, conclure explicitement « pas d'argument IRM en faveur d'une endométriose profonde ».",
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
