// Semis RAG : fiches CT thoracique (appris d'un vrai CR). GÉNÉRIQUES (textbook),
// AUCUNE donnée patient. Source `radio-ref-thorax`. Idempotent. Embeddings LOCAUX.
//   docker exec -w /app horos-app-1 node seed-radio-ref-thorax.mjs
import mysql from "mysql2/promise";

const SOURCE = "radio-ref-thorax";
const OLLAMA = process.env.OLLAMA_URL || "http://ollama-hermes:11434";
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const FICHES = [
  {
    heading: "CT thoracique — revue systématique du compte rendu",
    content:
      "Ordre de revue : voies aériennes (trachée, bronches : épaississement, impactions, arbre en bourgeon) ; parenchyme pulmonaire (nodules, masses, condensation, verre dépoli, emphysème, fibrose) par lobe ; plèvre (épanchement, épaississement, pneumothorax) ; médiastin et hiles (adénopathies, masses) ; cœur et gros vaisseaux (taille des cavités, tronc et artères pulmonaires, aorte, matériel chirurgical) ; paroi thoracique et structures osseuses (rachis dorsal, côtes). Conclusion synthétique répondant à l'indication.",
  },
  {
    heading: "Arbre en bourgeon (tree-in-bud) et impactions mucoïdes — CT",
    content:
      "L'« arbre en bourgeon » = micronodules centrolobulaires reliés à de fines structures linéaires ramifiées, traduisant un comblement des bronchioles distales (mucus, pus, cellules). Les impactions mucoïdes sont des bronches dilatées comblées de mucus. Évoque une atteinte des petites voies aériennes : bronchiolite infectieuse (bactérienne, mycobactéries dont tuberculose/MAC), aspiration, mucoviscidose, panbronchiolite. À localiser par lobe et préciser le caractère focal ou diffus.",
  },
  {
    heading: "Emphysème pulmonaire — sous-types au CT",
    content:
      "Emphysème = zones d'hypodensité/hyperclarté sans paroi nette par destruction alvéolaire. Sous-types : centrolobulaire (prédomine aux sommets, lié au tabac), paraseptal (sous-pleural et le long des septa, risque de bulles et de pneumothorax), panlobulaire (prédomine aux bases, déficit en alpha-1-antitrypsine). Préciser la distribution et la sévérité.",
  },
  {
    heading: "Signes CT d'hypertension artérielle pulmonaire (HTAP)",
    content:
      "Signes : dilatation du tronc de l'artère pulmonaire (diamètre > 29–30 mm = évocateur ; ~35 mm = franchement dilaté), rapport diamètre artère pulmonaire / aorte ascendante > 1, dilatation des cavités cardiaques DROITES, hypertrophie du ventricule droit, septum interventriculaire RECTILIGNE ou PARADOXAL (bombant vers le VG, traduisant la surcharge de pression droite), reflux de contraste dans les veines sus-hépatiques (si injection). Mesurer le tronc de l'AP.",
  },
  {
    heading: "Nodule pulmonaire calcifié et granulome séquellaire",
    content:
      "Une calcification dense, complète, centrale, lamellaire (« en pop-corn » pour l'hamartome) est un critère de BÉNIGNITÉ : granulome calcifié séquellaire (tuberculose, histoplasmose anciennes). À distinguer d'un nodule non calcifié ou à calcification excentrée/punctiforme, qui relève de la surveillance Fleischner. Mentionner « granulome calcifié séquellaire, sans caractère suspect ».",
  },
  {
    heading:
      "Status post-chirurgie cardiaque au CT — matériels reconnaissables",
    content:
      "Reconnaître : valve prothétique (anneau/disque dense aortique ou mitral), plastie mitrale (anneau), tube de remplacement de l'aorte ascendante, procédure de Bentall (tube aortique + valve aortique + réimplantation des coronaires), sternotomie (cerclages sternaux), pontages, sondes/électrodes de pacemaker. Décrire le matériel visible et conclure « status post-chirurgie cardiaque » avec le type probable.",
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
