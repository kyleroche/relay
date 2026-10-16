import { SITE_URL } from "@/lib/site";

interface Report {
  score?: number;
  score_label?: string;
  scanned_at?: string;
  report_url?: string;
}

/**
 * The site's live agent-readiness score from is-agentic.com (Vercel's scanner on Ora's checks). Fetched on the
 * server and cached for an hour; renders nothing when the report API is unavailable, so the landing never depends
 * on it. The scan is public, so showing it is honest advertising rather than a claim.
 */
export async function AgenticScore() {
  const target = new URL(SITE_URL).hostname;
  let report: Report | undefined;
  try {
    const res = await fetch(`https://is-agentic.com/api/v1/report?url=${encodeURIComponent(`https://${target}`)}`, {
      next: { revalidate: 3600 },
      headers: { accept: "application/json" },
    });
    if (res.ok) report = (await res.json()) as Report;
  } catch {
    report = undefined;
  }
  if (!report || typeof report.score !== "number") return null;
  const when = report.scanned_at ? new Date(report.scanned_at).toISOString().slice(0, 10) : undefined;
  return (
    <a
      href={report.report_url ?? `https://is-agentic.com/scan/${target}`}
      className="mt-6 inline-flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-accent"
      rel="noopener"
      title={report.score_label ?? "Agent readiness"}
    >
      <span className="font-mono text-lg font-semibold tabular-nums">{report.score}<span className="text-muted-foreground">/100</span></span>
      <span className="text-muted-foreground">
        agent readiness on is-agentic.com{when ? `, scanned ${when}` : ""}
      </span>
    </a>
  );
}
