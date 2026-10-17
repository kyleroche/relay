/**
 * Write-backs to GitHub for the asset review loop (docs/ASSETS.md, "GitHub"). Uses the site's GitHub client (the
 * GitHub App when configured, else GITHUB_APP_TOKEN or GITHUB_TOKEN); without any every call is a silent no-op, so a
 * deployment that only reads webhooks keeps working. Failures are logged, never thrown: a comment is a courtesy, the
 * review already happened.
 */
import { siteGitHub } from "@/lib/integrations";
import { SITE_URL } from "@/lib/site";
import type { Asset } from "@/lib/types";

async function gh(method: string, path: string, body: unknown): Promise<boolean> {
  try {
    const client = await siteGitHub();
    if (!client) return false;
    await client.request(method, path, body);
    return true;
  } catch (e) {
    console.error(`[relay] github ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Issues and pull requests share the comments endpoint; `number` is whichever the asset carries (PR first). */
function target(asset: Pick<Asset, "issue" | "pr">): number | null {
  return asset.pr ?? asset.issue ?? null;
}

const fmtSize = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** "A new asset awaits review" on the task, with the viewer link (the viewer mints its own signed URL per visit). */
export async function commentUploaded(repo: string | null | undefined, asset: Asset): Promise<boolean> {
  const n = target(asset);
  if (!repo || !n) return false;
  const dims = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : "";
  const body = [
    `**relay asset** ${asset.version > 1 ? `v${asset.version} of ` : ""}[${asset.title}](${SITE_URL}/assets/${asset.id}) is ready for review.`,
    "",
    `${asset.kind} · ${asset.mime} · ${fmtSize(asset.size)}${dims} · by \`${asset.created_by}\``,
    asset.description ? `\n> ${asset.description}` : "",
    "",
    `Approve or reject at ${SITE_URL}/assets/${asset.id}, or with \`relay asset review ${asset.id} --approve|--reject\`.`,
    "",
    `<!-- relay:asset ${asset.id} uploaded -->`,
  ].join("\n");
  return gh("POST", `/repos/${repo}/issues/${n}/comments`, { body });
}

/** The decision, and on rejection the issue is reopened so the next attempt picks the note up from its brief. */
export async function commentReviewed(repo: string | null | undefined, asset: Asset): Promise<boolean> {
  const n = target(asset);
  if (!repo || !n) return false;
  const rejected = asset.status === "rejected";
  const body = [
    `**relay asset** [${asset.title}](${SITE_URL}/assets/${asset.id}) (v${asset.version}) was **${rejected ? "rejected" : "approved"}** by \`${asset.reviewed_by ?? "a reviewer"}\`.`,
    asset.review_note ? `\n> ${asset.review_note}` : "",
    rejected ? "\nThe note is recorded as a project decision; the next attempt will see it in its brief." : "",
    "",
    `<!-- relay:asset ${asset.id} ${asset.status} -->`,
  ].join("\n");
  const ok = await gh("POST", `/repos/${repo}/issues/${n}/comments`, { body });
  if (rejected && asset.issue) await gh("PATCH", `/repos/${repo}/issues/${asset.issue}`, { state: "open" });
  return ok;
}
