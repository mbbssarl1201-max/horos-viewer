import { embedText } from "../knowledge/embeddings";
import { searchSimilar } from "../knowledge/store";
import { selectRelevant, buildKnowledgeBlock } from "../knowledge/retrieve";

export async function searchVaultFn(args: {
  query: string;
}): Promise<{ context: string; sources: string[] }> {
  try {
    const emb = await embedText(args.query);
    const hits = await searchSimilar(emb, 5, { sourcePrefix: "vault:" });
    const selected = selectRelevant(hits);
    return {
      context: buildKnowledgeBlock(selected),
      sources: selected.map(s => s.source),
    };
  } catch {
    return { context: "", sources: [] };
  }
}
