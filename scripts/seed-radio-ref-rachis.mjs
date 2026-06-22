// Semis RAG : fiches IRM du rachis lombaire (appris d'un vrai CR). GÉNÉRIQUES
// (textbook), AUCUNE donnée patient. Source `radio-ref-rachis`. Idempotent.
//   docker exec -w /app horos-app-1 node seed-radio-ref-rachis.mjs
import mysql from "mysql2/promise";

const SOURCE = "radio-ref-rachis";
const OLLAMA = process.env.OLLAMA_URL || "http://ollama-hermes:11434";
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const FICHES = [
  {
    heading: "IRM du rachis lombaire — revue systématique",
    content:
      "Revue : alignement (lordose, listhésis) ; corps vertébraux (hauteur, tassement, œdème/infiltration en T2 FS et T1) ; disques niveau par niveau (déshydratation, hauteur, fissuration annulaire, protrusion/hernie) ; canal rachidien, récessus latéraux et foramens (sténose, conflit radiculaire) ; cône terminal et filum (position, signal) ; parties molles para-vertébrales ; articulaires postérieures ; ± sacro-iliaques et bassin si inclus. Conclusion : niveau(x) atteint(s), type de hernie, racine en conflit, degré de compression.",
  },
  {
    heading: "Hernie discale lombaire — nomenclature IRM",
    content:
      "Type : protrusion (base large > saillie) vs extrusion (saillie > base, ± fragment exclu/migré). Rapport au ligament longitudinal postérieur : SOUS-ligamentaire (contenue) vs trans-ligamentaire (rompue). Topographie axiale : médiane, para-médiane, récessale (récessus latéral/sous-articulaire), foraminale, extra-foraminale. Préciser le niveau (ex. L5-S1), le côté, et le retentissement (refoulement/compression d'une racine, empreinte sur le sac dural).",
  },
  {
    heading: "Fissuration annulaire (annular tear) et HIZ — IRM",
    content:
      "La fissuration/déchirure de l'anneau fibreux (annulus) se traduit par une zone de hypersignal T2 dans l'anneau postérieur (HIZ, high-intensity zone), souvent associée à une discopathie et à des lombalgies. Décrire son étendue (focale, étendue, médio-latérale) ; elle précède/accompagne souvent une hernie sous-ligamentaire.",
  },
  {
    heading:
      "Conflit radiculaire lombaire — quelle racine selon la topographie",
    content:
      "Dans le récessus latéral, la hernie comprime la racine DESCENDANTE (traversante) : à L4-L5 → racine L5 ; à L5-S1 → racine S1. Dans le foramen, c'est la racine SORTANTE du niveau (à L4-L5 → racine L4) qui est touchée. Graduer le conflit : contact simple, refoulement, compression franche. Noter un conflit éventuellement POSITIONNEL (visible selon la position, sans compression franche au repos).",
  },
  {
    heading: "Discopathie dégénérative et anomalies Modic des plateaux — IRM",
    content:
      "Discopathie : perte du signal T2 du disque (déshydratation), pincement, ± phénomène du vide discal. Modic (signal des plateaux vertébraux adjacents) : type 1 (œdème/inflammation : hyposignal T1, hypersignal T2 ; actif/douloureux), type 2 (involution graisseuse : hypersignal T1 et T2), type 3 (sclérose : hyposignal T1 et T2). Préciser le niveau et le type.",
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
