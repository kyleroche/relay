/**
 * Build of the published package `@kyleroche/relay`: `src/main.ts` and the MCP stdio entry are bundled with
 * `@relay/core` and `@relay/mcp` inlined, so the tarball carries no workspace packages. Everything in
 * `dependencies` and `optionalDependencies` stays external and is installed by npm. `scripts/postbuild.mjs` then
 * copies the hook scripts and the SQL migrations next to the bundle (see `runtimePaths` in @relay/core).
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];

/**
 * Two command modules compute paths from the checkout layout (`RELAY_ROOT` is four directories above
 * `_common.ts`; the templates sit under packages/cli). In the bundle every module shares dist/relay.js's
 * `import.meta.url`, so those two constants are pointed at `runtimePaths()` instead. A rewrite that finds nothing
 * to rewrite fails the build: a changed line surfaces here, not as a package that cannot find its files. Once a
 * module uses `runtimePaths(` itself it is left alone, so this plugin retires line by line.
 */
const REWRITES: Record<string, Array<[RegExp, string]>> = {
  "_common.ts": [[/export const RELAY_ROOT = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\.", "\.\.", "\.\.", "\.\."\);/, "export const RELAY_ROOT = runtimePaths().root;"]],
  "link.ts": [[/const TEMPLATES = join\(RELAY_ROOT, "packages", "cli", "templates"\);/, "const TEMPLATES = runtimePaths().templatesDir;"]],
};

function runtimePathsRewrite(): Plugin {
  return {
    name: "relay-runtime-paths",
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]commands[\\/](?:_common|link)\.ts$/ }, async (args) => {
        let contents = await readFile(args.path, "utf8");
        if (contents.includes("runtimePaths(")) return { contents, loader: "ts" };
        for (const [re, to] of REWRITES[basename(args.path)] ?? []) {
          if (!re.test(contents)) throw new Error(`${args.path}: expected ${re.source.slice(0, 40)}…; import runtimePaths from @relay/core and use it directly, then drop this rewrite from tsup.config.ts`);
          contents = contents.replace(re, to);
        }
        return { contents: `import { runtimePaths } from "@relay/core";\n${contents}`, loader: "ts" };
      });
    },
  };
}

export default defineConfig({
  entry: { relay: "src/main.ts", "relay-mcp": "../mcp/src/stdio.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: ["@relay/core", "@relay/mcp"],
  external,
  esbuildPlugins: [runtimePathsRewrite()],
  onSuccess: "node scripts/postbuild.mjs",
});
