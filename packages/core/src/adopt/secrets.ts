/**
 * The secret check `relay adopt` runs on every text before it goes into a repository file or a decision. A match
 * skips the whole file: adopt copies notes a person wrote for themselves into places other people and machines read,
 * so a false alarm (the person redacts the note and runs it again) costs less than one key in a pull request.
 *
 * Only the kind of thing that matched is ever reported, never the match.
 */

export interface SecretMarker {
  /** What the report calls it. */
  name: string;
  re: RegExp;
}

/** A value of 20 or more key-like characters with a letter and a digit in it: what a credential looks like, and a placeholder or a variable reference does not. */
const KEYLIKE = "(?=[A-Za-z0-9+/_\\-]*[0-9])(?=[A-Za-z0-9+/_\\-]*[A-Za-z])[A-Za-z0-9+/_\\-]{20,}";

export const SECRET_MARKERS: readonly SecretMarker[] = [
  { name: "private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: "Slack token", re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Slack webhook", re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { name: "model provider key", re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|xai-[A-Za-z0-9]{32,})/ },
  { name: "Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|\bwhsec_[A-Za-z0-9]{24,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "Shopify token", re: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/ },
  { name: "Vercel token", re: /\bvc[a-z]_[A-Za-z0-9]{24,}/ },
  { name: "relay token", re: /\br(?:ly|ac|cs|rt|dc|in)_[A-Za-z0-9_-]{24,}/ },
  { name: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "credentials in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`<>]+:[^\s/@"'`<>]{3,}@[^\s/"'`<>]+/i },
  { name: "bearer token", re: new RegExp(`\\b[Bb]earer\\s+${KEYLIKE}`) },
  { name: "assigned secret", re: new RegExp(`(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*["'\`]?\\s*[:=]\\s*["'\`]?${KEYLIKE}`, "i") },
];

/** The kinds of secret the text looks like it holds; empty when it holds none. */
export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const m of SECRET_MARKERS) if (m.re.test(text)) hits.push(m.name);
  return hits;
}
