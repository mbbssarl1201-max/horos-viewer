import { getDb } from "../db";
import { knowledgeChunks } from "../../drizzle/schema";
import { eq, sql } from "drizzle-orm";
import { cosineSimilarity } from "./embeddings";

export interface ChunkToInsert {
  source: string;
  heading: string;
  content: string;
  embedding: number[];
}

export async function insertChunks(rows: ChunkToInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB indisponible");
  await db.insert(knowledgeChunks).values(
    rows.map(r => ({
      source: r.source.slice(0, 512),
      heading: (r.heading || "").slice(0, 512),
      content: r.content,
      embedding: JSON.stringify(r.embedding),
    }))
  );
  return rows.length;
}

export interface SimilarChunk {
  source: string;
  heading: string | null;
  content: string;
  score: number;
}

/** Charge les chunks, calcule le cosinus en JS, renvoie le top-k. */
export async function searchSimilar(
  queryEmbedding: number[],
  k = 5
): Promise<SimilarChunk[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      source: knowledgeChunks.source,
      heading: knowledgeChunks.heading,
      content: knowledgeChunks.content,
      embedding: knowledgeChunks.embedding,
    })
    .from(knowledgeChunks);
  const scored: SimilarChunk[] = [];
  for (const r of rows) {
    let emb: number[];
    try {
      emb = JSON.parse(r.embedding);
    } catch {
      continue;
    }
    scored.push({
      source: r.source,
      heading: r.heading,
      content: r.content,
      score: cosineSimilarity(queryEmbedding, emb),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}

export async function knowledgeStats(): Promise<{
  chunks: number;
  sources: number;
}> {
  const db = await getDb();
  if (!db) return { chunks: 0, sources: 0 };
  const [c] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(knowledgeChunks);
  const [s] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${knowledgeChunks.source})` })
    .from(knowledgeChunks);
  return { chunks: Number(c?.n ?? 0), sources: Number(s?.n ?? 0) };
}

export async function clearKnowledge(source?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  if (source) {
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.source, source));
  } else {
    await db.delete(knowledgeChunks);
  }
}
