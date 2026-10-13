import { NextResponse, type NextRequest } from "next/server";
import { problem } from "@/lib/api";
import { dataMode } from "@/lib/data";
import { MOCK_ASSET_SEEDS } from "@/lib/mock";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A placeholder picture: the title on a soft gradient, at the asset's aspect ratio. */
function svg(title: string, sub: string, w: number, h: number): string {
  const fs = Math.round(Math.min(w, h) / 14);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a78d6"/><stop offset="1" stop-color="#1baf7a"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect x="${w * 0.08}" y="${h * 0.14}" width="${w * 0.84}" height="${h * 0.72}" rx="${fs / 2}" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.5)"/>
  <text x="${w / 2}" y="${h / 2 - fs * 0.2}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${fs}" font-weight="600" fill="#fff" text-anchor="middle">${esc(title)}</text>
  <text x="${w / 2}" y="${h / 2 + fs * 1.1}" font-family="ui-monospace, monospace" font-size="${Math.round(fs * 0.55)}" fill="rgba(255,255,255,0.85)" text-anchor="middle">${esc(sub)}</text>
</svg>`;
}

/** A one-page PDF with a few lines of text. Offsets are computed so the xref table is valid. */
function pdf(title: string, lines: string[]): Buffer {
  const content = ["BT", "/F1 20 Tf", "72 740 Td", `(${title.replace(/[()\\]/g, "")}) Tj`, "/F1 11 Tf", "0 -36 Td", ...lines.flatMap((l) => [`(${l.replace(/[()\\]/g, "")}) Tj`, "0 -16 Td"]), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function html(title: string, description: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;color:#1f2328;background:#fff}header{padding:28px 32px;border-bottom:1px solid #e5e7eb}h1{margin:0;font-size:22px}main{padding:24px 32px;max-width:720px}.entry{padding:14px 0;border-bottom:1px solid #eee}.v{font:12px ui-monospace,monospace;color:#6b7280}</style></head>
<body><header><h1>${esc(title)}</h1><p class="v">rendered from the preview build · mock asset</p></header>
<main><p>${esc(description)}</p>
<div class="entry"><div class="v">v0.4.0 · today</div><strong>Changelog collection</strong> lands as an MDX content type with per-entry pages.</div>
<div class="entry"><div class="v">v0.3.2 · 3 days ago</div><strong>Dark mode</strong> no longer flickers on first paint; theme is read from a cookie.</div>
<div class="entry"><div class="v">v0.3.1 · last week</div><strong>OG images</strong> render with the system font and no remote fetch at build.</div>
<p class="v" id="js">scripts are sandboxed: </p><script>document.getElementById('js').textContent += (typeof window.parent.document === 'undefined' || (()=>{try{return window.parent.document && 'same-origin'}catch(e){return 'opaque origin, as intended'}})())</script>
</main></body></html>`;
}

function csv(): string {
  const rows = ["date,account,debit,credit,balance"];
  for (let i = 0; i < 40; i++) rows.push(`2026-10-${String(1 + (i % 12)).padStart(2, "0")},acct-${1000 + (i % 7)},${(i * 37.5).toFixed(2)},${(i * 37.5).toFixed(2)},0.00`);
  return rows.join("\n") + "\n";
}

/** Bytes for the demo assets in mock mode. Each kind gets something a browser can render. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (dataMode() !== "mock") return problem(404, "Not Found", "Mock assets exist in mock mode only.", req.nextUrl.pathname);
  const seed = MOCK_ASSET_SEEDS.find((s) => s.id === id);
  if (!seed) return problem(404, "Not Found", "No such mock asset.", req.nextUrl.pathname);
  const thumb = req.nextUrl.searchParams.get("thumb") === "1";
  const headers = { "cache-control": "public, max-age=3600" };
  const sub = `${seed.project} · ${seed.pr ? `#${seed.pr}` : seed.issue ? `#${seed.issue}` : ""} · v${seed.version ?? 1}`;
  if (thumb || seed.kind === "image") {
    const w = thumb ? 512 : seed.width ?? 1200;
    const h = thumb ? Math.round((512 * (seed.height ?? 800)) / (seed.width ?? 1200)) : seed.height ?? 800;
    return new NextResponse(svg(seed.title, thumb && seed.kind === "video" ? `poster · ${sub}` : sub, w, h), { headers: { ...headers, "content-type": "image/svg+xml; charset=utf-8" } });
  }
  if (seed.kind === "pdf") {
    const body = pdf(seed.title, [seed.description, "", "Idempotency keys are stored with the request hash and the stored response for 24 hours.", "A replay with the same key and body returns the stored response with Idempotency-Replayed: true.", "A replay with the same key and a different body is a 422.", "", `relay asset ${seed.id}`]);
    return new NextResponse(new Uint8Array(body), { headers: { ...headers, "content-type": "application/pdf", "content-disposition": `inline; filename="design-note.pdf"` } });
  }
  if (seed.kind === "html") {
    return new NextResponse(html(seed.title, seed.description), { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox allow-scripts; default-src 'self' 'unsafe-inline'" } });
  }
  if (seed.kind === "file") return new NextResponse(csv(), { headers: { ...headers, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="reconciliation.csv"` } });
  return problem(404, "Not Found", "The mock video has a poster but no playable bytes.", req.nextUrl.pathname);
}
