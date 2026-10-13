import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/data";
import { readRepoFile } from "@/lib/docs";

const SKILL_PATH = "skills/relay/SKILL.md";

function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const out: Record<string, string> = {};
  if (!m?.[1]) return out;
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Agent skills index: the relay install skill with its digest, served from skills/relay/SKILL.md. */
export function GET() {
  const md = readRepoFile(SKILL_PATH);
  if (!md) return NextResponse.json({ version: 1, skills: [] }, { status: 200 });
  const fm = frontmatter(md);
  const sha256 = createHash("sha256").update(md).digest("hex");
  return NextResponse.json(
    {
      version: 1,
      skills: [
        {
          name: fm.name ?? "relay",
          description: fm.description ?? "",
          license: fm.license ?? "Apache-2.0",
          path: SKILL_PATH,
          url: `${SITE_URL}/${SKILL_PATH}`,
          files: [{ path: "SKILL.md", url: `${SITE_URL}/${SKILL_PATH}`, sha256, size: Buffer.byteLength(md) }],
          sha256,
        },
      ],
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
