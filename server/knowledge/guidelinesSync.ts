import { embedText } from "./embeddings";
import { chunkMarkdown } from "./chunk";
import { insertChunks, clearKnowledge } from "./store";

export interface RssItem {
  title: string;
  content: string;
  link: string;
}

export function buildGuidelinesSource(name: string): string {
  return `guidelines:${name.toLowerCase().replace(/\s+/g, "-")}`;
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemMatches = Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g));
  for (const m of itemMatches) {
    const block = m[1];
    const title =
      block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ??
      block.match(/<title>(.*?)<\/title>/)?.[1] ??
      "";
    const description =
      block.match(
        /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/
      )?.[1] ??
      block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ??
      "";
    const link = block.match(/<link>(.*?)<\/link>/)?.[1] ?? "";
    if (title) {
      items.push({
        title: title.trim(),
        content: `${title.trim()}\n\n${description.replace(/<[^>]+>/g, "").trim()}`,
        link: link.trim(),
      });
    }
  }
  return items;
}

interface GuidelinesSource {
  name: string;
  url: string;
  type: "rss" | "html";
}

const SOURCES: GuidelinesSource[] = [
  {
    name: "ESR",
    url: "https://www.myesr.org/rss/guidelines",
    type: "rss",
  },
  {
    name: "ACR",
    url: "https://www.acr.org/Clinical-Resources/ACR-Appropriateness-Criteria",
    type: "html",
  },
];

async function fetchSource(src: GuidelinesSource): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(src.url, { signal: controller.signal });
    if (!resp.ok) return "";
    return await resp.text();
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

async function syncSource(src: GuidelinesSource): Promise<number> {
  const raw = await fetchSource(src);
  if (!raw) return 0;
  const source = buildGuidelinesSource(src.name);

  let markdownItems: string[] = [];
  if (src.type === "rss") {
    const items = parseRssItems(raw);
    markdownItems = items.map(it => `# ${it.title}\n\n${it.content}`);
  } else {
    // HTML: extraction basique du texte
    const text = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    markdownItems = [`# ${src.name} Guidelines\n\n${text.slice(0, 20000)}`];
  }

  if (markdownItems.length === 0) return 0;
  const combined = markdownItems.join("\n\n---\n\n");
  const chunks = chunkMarkdown(`${src.name}.md`, combined);

  // Purge les anciens chunks de cette source
  await clearKnowledge(source);

  let inserted = 0;
  for (const chunk of chunks) {
    try {
      const embedding = await embedText(`${chunk.heading}\n${chunk.content}`);
      await insertChunks([
        {
          source,
          heading: chunk.heading,
          content: chunk.content,
          embedding,
        },
      ]);
      inserted++;
    } catch {
      // fail-soft : on continue avec le chunk suivant
    }
  }
  return inserted;
}

export async function syncGuidelines(): Promise<{
  inserted: number;
  sources: string[];
}> {
  let totalInserted = 0;
  const syncedSources: string[] = [];
  for (const src of SOURCES) {
    const n = await syncSource(src);
    if (n > 0) {
      totalInserted += n;
      syncedSources.push(buildGuidelinesSource(src.name));
    }
  }
  return { inserted: totalInserted, sources: syncedSources };
}
