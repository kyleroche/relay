import type { GuidanceKind } from "../db/guidance.ts";

/**
 * Rule-based kind classifier. Precedence: moderation > limits > api > style > prompting. Cheap and deterministic;
 * a Jev/Sonnet pass can refine later, but the rules keep onboarding free and offline-safe.
 */
const rules: Array<{ kind: GuidanceKind; re: RegExp; weight: number }> = [
  { kind: "moderation", re: /\b(moderat|sensitive|prohibit|policy|safety|compliance|watermark|copyright|privacy)/i, weight: 3 },
  { kind: "limits", re: /\b(limit|maximum|max\.?|up to|quota|rate limit|concurren|duration|resolution|expire|timeout|supported (formats|sizes))/i, weight: 2 },
  { kind: "api", re: /\b(endpoint|request body|response|parameter|curl|json|sdk|api key|http|status code|content\.role|output_format)/i, weight: 2 },
  { kind: "style", re: /\b(style|aesthetic|camera|lighting|cinematic|genre|lens|composition|color grade|shot size)/i, weight: 1.5 },
  { kind: "prompting", re: /\b(prompt|describe|instruction|example|timestamp|reference|storyboard|keyframe|technique)/i, weight: 1 },
];

export function classifyChunk(title: string, text: string): GuidanceKind {
  const hay = `${title}\n${text}`;
  let best: { kind: GuidanceKind; score: number } = { kind: "prompting", score: 0 };
  for (const r of rules) {
    const n = (hay.match(new RegExp(r.re.source, "gi")) ?? []).length;
    const score = n * r.weight + (r.re.test(title) ? r.weight * 3 : 0);
    if (score > best.score) best = { kind: r.kind, score };
  }
  return best.kind;
}
