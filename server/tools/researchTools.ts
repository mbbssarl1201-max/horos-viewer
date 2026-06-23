import { ENV } from "../_core/env";
import { embedText } from "../knowledge/embeddings";
import { searchSimilar } from "../knowledge/store";
import { selectRelevant, buildKnowledgeBlock } from "../knowledge/retrieve";

const NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// ─── PubMed à la demande ──────────────────────────────────────────────────
export async function pubmedSearchFn(args: {
  query: string;
  maxResults?: number;
}): Promise<{
  available: boolean;
  results: Array<{
    pmid: string;
    title: string;
    abstract: string;
    year: string;
  }>;
}> {
  const maxResults = Math.min(args.maxResults ?? 5, 10);
  const apiKey = ENV.ncbiApiKey ? `&api_key=${ENV.ncbiApiKey}` : "";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const searchUrl =
      `${NCBI_BASE}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance` +
      `&retmax=${maxResults}&term=${encodeURIComponent(args.query)}${apiKey}`;
    const searchResp = await fetch(searchUrl, { signal: controller.signal });
    if (!searchResp.ok) return { available: false, results: [] };
    const searchData = await searchResp.json();
    const idlist: string[] = searchData?.esearchresult?.idlist ?? [];
    if (idlist.length === 0) return { available: true, results: [] };

    const fetchUrl =
      `${NCBI_BASE}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text` +
      `&id=${idlist.join(",")}${apiKey}`;
    const fetchResp = await fetch(fetchUrl, { signal: controller.signal });
    if (!fetchResp.ok) return { available: false, results: [] };
    const raw = await fetchResp.text();

    const results = parseAbstractsText(raw, idlist);
    return { available: true, results };
  } catch {
    return { available: false, results: [] };
  } finally {
    clearTimeout(t);
  }
}

/** Parse le texte brut efetch en tableau structuré. */
function parseAbstractsText(
  text: string,
  idlist: string[]
): Array<{ pmid: string; title: string; abstract: string; year: string }> {
  const blocks = text.split(/\n\n(?=\d+\.)/).filter(Boolean);
  return blocks.map((block, i) => {
    const lines = block
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);
    const title = lines[0]?.replace(/^\d+\.\s*/, "") ?? "";
    const pmidMatch = block.match(/PMID:\s*(\d+)/);
    const pmid = pmidMatch?.[1] ?? idlist[i] ?? "";
    const yearMatch = block.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch?.[0] ?? "";
    const abstractStart = block.indexOf("Abstract:");
    const abstract =
      abstractStart >= 0
        ? block
            .slice(abstractStart + 9)
            .trim()
            .slice(0, 800)
        : lines.slice(2, 5).join(" ").slice(0, 800);
    return { pmid, title, abstract, year };
  });
}

// ─── Guidelines indexées (recherche locale) ────────────────────────────────
export async function searchGuidelinesFn(args: {
  query: string;
}): Promise<{ context: string; sources: string[] }> {
  try {
    const emb = await embedText(args.query);
    const hits = await searchSimilar(emb, 5, { sourcePrefix: "guidelines:" });
    const selected = selectRelevant(hits);
    return {
      context: buildKnowledgeBlock(selected),
      sources: selected.map(s => s.source),
    };
  } catch {
    return { context: "", sources: [] };
  }
}
