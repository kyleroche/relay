/** `relay asset …`: put, ls, get, review, publish, expire. See docs/ASSETS.md. */
import type { Command } from "commander";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { openHarness, openAssetStore, ingestFile, previewExpiredAssets, purgeExpiredAssets, PublishUnsupportedError, repo } from "@relay/core";
import type { AssetKind, AssetRow, AssetStatus } from "@relay/core";

const log = (m: string) => console.error(`[relay] ${m}`);

function defaultActor(): string {
  let user = process.env.USER ?? process.env.USERNAME;
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = "unknown";
    }
  }
  return `human:${user}`;
}

const intOpt = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number.parseInt(v, 10));

function line(a: AssetRow): string {
  const dims = a.width && a.height ? `${a.width}x${a.height}` : "";
  const dur = a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)}s` : "";
  const size = a.size >= 1_048_576 ? `${(a.size / 1_048_576).toFixed(1)}M` : a.size >= 1024 ? `${Math.round(a.size / 1024)}K` : `${a.size}B`;
  return `${a.id}  ${a.status.padEnd(10)} ${a.kind.padEnd(5)} v${String(a.version).padEnd(2)} ${(a.project ?? "-").padEnd(14)} ${[dims, dur, size].filter(Boolean).join(" ").padEnd(18)} ${a.title}`;
}

export function registerAssetCommands(program: Command): void {
  const asset = program.command("asset").description("Store, version, review and publish media produced by agents (docs/ASSETS.md)");

  asset
    .command("put")
    .argument("<file>")
    .requiredOption("--project <slug>", "project the asset belongs to")
    .option("--issue <n>", "GitHub issue number")
    .option("--pr <n>", "GitHub pull request number")
    .option("--title <text>", "title (default: the file name, or the parent's title with --replaces)")
    .option("--description <text>")
    .option("--replaces <id>", "asset id this file supersedes (becomes the next version)")
    .option("--tag <tag...>", "tags")
    .option("--by <actor>", "creator, e.g. bot:grok or runner:mini", defaultActor())
    .description("Ingest a file: sniff, hash, measure, thumbnail, store, record")
    .action(async (file: string, o: { project: string; issue?: string; pr?: string; title?: string; description?: string; replaces?: string; tag?: string[]; by: string }) => {
      const h = await openHarness();
      try {
        const store = openAssetStore();
        const path = resolve(file);
        const row = await ingestFile(h.db, store, {
          path,
          project: o.project,
          issue: intOpt(o.issue), // undefined keeps the parent's value when --replaces is set
          pr: intOpt(o.pr),
          title: o.title, // default: the parent's title with --replaces, else the file name
          description: o.description,
          replaces: o.replaces ?? null,
          createdBy: o.by,
          tags: o.tag,
          log,
        });
        log(`store: ${store.kind}`);
        console.log(JSON.stringify(row, null, 2));
      } finally {
        await h.close();
      }
    });

  asset
    .command("ls")
    .option("--project <slug>")
    .option("--status <status>", "pending | approved | rejected | superseded | published")
    .option("--kind <kind>", "image | video | audio | pdf | html | file")
    .option("-n <n>", "rows", "50")
    .description("List assets, pending first, newest first")
    .action(async (o: { project?: string; status?: AssetStatus; kind?: AssetKind; n: string }) => {
      const h = await openHarness();
      try {
        const opts: Parameters<typeof repo.listAssets>[1] = { limit: Number(o.n) };
        if (o.project) opts.project = o.project;
        if (o.status) opts.status = o.status;
        if (o.kind) opts.kind = o.kind;
        for (const a of await repo.listAssets(h.db, opts)) console.log(line(a));
      } finally {
        await h.close();
      }
    });

  asset
    .command("get")
    .argument("<id>")
    .option("--ttl <seconds>", "signed URL lifetime", "3600")
    .description("Metadata, version chain, and a signed view URL")
    .action(async (id: string, o: { ttl: string }) => {
      const h = await openHarness();
      try {
        const a = await repo.getAsset(h.db, id);
        if (!a) throw new Error(`asset ${id} not found`);
        const store = openAssetStore();
        const versions = await repo.listVersions(h.db, id);
        const url = await store.getSignedUrl(a.storage_key, Number(o.ttl));
        const thumb_url = a.thumb_key ? await store.getSignedUrl(a.thumb_key, Number(o.ttl)) : null;
        console.log(JSON.stringify({ ...a, store: store.kind, url, thumb_url, versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, created_at: v.created_at })) }, null, 2));
      } finally {
        await h.close();
      }
    });

  asset
    .command("review")
    .argument("<id>")
    .option("--approve", "approve")
    .option("--reject", "reject")
    .option("--note <text>", "why; a rejection note becomes a project decision")
    .option("--by <actor>", "reviewer", defaultActor())
    .description("Approve or reject an asset; writes asset.reviewed (and a review decision on reject)")
    .action(async (id: string, o: { approve?: boolean; reject?: boolean; note?: string; by: string }) => {
      if (!!o.approve === !!o.reject) throw new Error("pass exactly one of --approve or --reject");
      const h = await openHarness();
      try {
        const row = await repo.reviewAsset(h.db, id, { decision: o.approve ? "approved" : "rejected", by: o.by, note: o.note ?? null });
        console.log(line(row));
      } finally {
        await h.close();
      }
    });

  asset
    .command("publish")
    .argument("<id>")
    .option("--by <actor>", "publisher", defaultActor())
    .description("Copy the asset to the public Blob store and record its permanent URL (needs Blob)")
    .action(async (id: string, o: { by: string }) => {
      const h = await openHarness();
      try {
        const a = await repo.getAsset(h.db, id);
        if (!a) throw new Error(`asset ${id} not found`);
        const store = openAssetStore();
        let url: string;
        try {
          url = await store.publish(a.storage_key, { contentType: a.mime });
        } catch (e) {
          if (e instanceof PublishUnsupportedError) {
            log(`not published: ${e.message}`);
            process.exitCode = 2;
            return;
          }
          throw e;
        }
        const row = await repo.publishAsset(h.db, id, url, { by: o.by });
        console.log(row.public_url);
      } finally {
        await h.close();
      }
    });

  asset
    .command("expire")
    .option("--yes", "actually delete; default is a dry run")
    .description("Remove rejected and superseded assets past RELAY_ASSET_RETENTION_DAYS (dry run unless --yes)")
    .action(async (o: { yes?: boolean }) => {
      const h = await openHarness();
      try {
        if (!o.yes) {
          const rows = await previewExpiredAssets(h.db);
          for (const a of rows) console.log(`${line(a)}  expired ${a.expires_at}`);
          log(`${rows.length} asset(s) would be removed; pass --yes to delete`);
          return;
        }
        const r = await purgeExpiredAssets(h.db, openAssetStore());
        for (const x of r.removed) console.log(`${x.id}  ${x.keys.join(", ")}`);
        log(`removed ${r.removed.length} asset(s)${r.failedKeys.length ? `; ${r.failedKeys.length} key(s) failed to delete: ${r.failedKeys.join(", ")}` : ""}`);
        if (r.failedKeys.length) process.exitCode = 1;
      } finally {
        await h.close();
      }
    });
}
