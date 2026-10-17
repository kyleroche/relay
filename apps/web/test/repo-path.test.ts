import { describe, expect, it } from "vitest";
import { isRepoRelativePath } from "@/lib/api";

describe("isRepoRelativePath", () => {
  it("accepts Next.js route segments and ordinary nested paths", () => {
    for (const p of ["app/md/[[...path]]/route.ts", "src/app/api/auth/[...nextauth]/route.ts", "app/(marketing)/page.tsx", "a/b.c/d@2x.png", "README.md", "src/+page.svelte"]) expect(isRepoRelativePath(p), p).toBe(true);
  });
  it("rejects absolute paths, parent segments, empty and dot segments, backslashes and NUL", () => {
    for (const p of ["/etc/passwd", "../x", "a/../b", "a/./b", "a//b", "a/", "", "a\\b", "a\0b"]) expect(isRepoRelativePath(p), p).toBe(false);
  });
});
