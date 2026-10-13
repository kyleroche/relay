import { approxTokens, sha256 } from "../util.ts";

export interface RawChunk {
  index: number;
  title: string;
  text: string;
  tokens: number;
  id: string;
}

/** Split markdown-ish text by heading path, then pack paragraphs into ≤ maxTokens chunks. */
export function chunkDocument(text: string, opts: { sourceUrl: string; pageTitle: string; maxTokens?: number }): RawChunk[] {
  const max = opts.maxTokens ?? 800;
  const lines = text.split("\n");
  const headings: string[] = [];
  const sections: Array<{ title: string; paras: string[] }> = [{ title: opts.pageTitle, paras: [] }];
  let buf: string[] = [];
  let inCode = false;
  const flushPara = () => {
    const p = buf.join("\n").trim();
    if (p) sections[sections.length - 1]!.paras.push(p);
    buf = [];
  };
  for (const line of lines) {
    if (line.startsWith("```")) inCode = !inCode;
    const h = !inCode ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (h) {
      flushPara();
      const level = h[1]!.length;
      headings.length = level - 1;
      headings[level - 1] = h[2]!.trim();
      sections.push({ title: [opts.pageTitle, ...headings.filter(Boolean)].join(" > "), paras: [] });
      continue;
    }
    if (line.trim() === "" && !inCode) flushPara();
    else buf.push(line);
  }
  flushPara();

  const chunks: RawChunk[] = [];
  const push = (title: string, body: string) => {
    const t = body.trim();
    if (!t) return;
    const index = chunks.length;
    chunks.push({ index, title, text: t, tokens: approxTokens(t), id: sha256(`${opts.sourceUrl}#${index}:${t.slice(0, 200)}`) });
  };
  for (const s of sections) {
    let acc = "";
    for (const p of s.paras) {
      if (approxTokens(p) > max) {
        if (acc) push(s.title, acc), (acc = "");
        // hard split an oversized paragraph (usually a table or code block)
        for (let i = 0; i < p.length; i += max * 4) push(s.title, p.slice(i, i + max * 4));
        continue;
      }
      if (approxTokens(acc + "\n\n" + p) > max) {
        push(s.title, acc);
        acc = p;
      } else acc = acc ? acc + "\n\n" + p : p;
    }
    if (acc) push(s.title, acc);
  }
  return chunks;
}
