/**
 * Where asset bytes live. One interface, two adapters:
 *
 * - `BlobStore`: Vercel Blob with `access: 'private'`. Chosen when `BLOB_READ_WRITE_TOKEN` is set. Reads go through
 *   presigned URLs minted per request (`issueSignedToken` + `presignUrl` from `@vercel/blob`), never a public URL.
 * - `LocalStore`: files under `${RELAY_HOME||~/.harness}/assets/`. Signed URLs are `file://` paths carrying an
 *   HMAC token; the web app verifies the token with `verifyLocalSignedUrl` and streams the file itself.
 *
 * Keys are relative paths like `<project>/<asset id>/<filename>`; the same key works in both adapters.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PutOptions {
  contentType: string;
}

export interface AssetStore {
  readonly kind: "local" | "blob";
  /** Write bytes under `key` (relative path, forward slashes). Overwrites. */
  put(key: string, data: Buffer | Readable, opts: PutOptions): Promise<void>;
  /** A URL that grants read access to `key` for `ttlSeconds`. */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * Make `key` reachable at a permanent public URL. Blob: copies into the public store named by
   * `BLOB_PUBLIC_READ_WRITE_TOKEN`. Local: throws `PublishUnsupportedError` (there is nothing to publish to).
   */
  publish(key: string, opts: PutOptions): Promise<string>;
}

export class PublishUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishUnsupportedError";
  }
}

export const ASSETS_HOME = join(process.env.RELAY_HOME ?? join(homedir(), ".harness"), "assets");

/** Reject keys that could escape the root or carry odd separators. */
export function assertSafeKey(key: string): void {
  if (!key || key.includes("\\") || key.startsWith("/") || key.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`unsafe storage key: ${key}`);
  }
}

// ---------- local ----------

const SIGNING_KEY_FILE = ".signing-key";

/**
 * Local signed URL: `file:///<root>/<key>?exp=<unix seconds>&sig=<base64url HMAC-SHA256(secret, "<key>\n<exp>")>`.
 * The secret is `RELAY_ASSET_SIGNING_KEY` when set, else 32 random bytes written once to `<root>/.signing-key` (0600).
 * The app does not hand the file URL to a browser; it verifies `key`/`exp`/`sig` with `verifyLocalSignedUrl` and
 * streams the file from disk itself.
 */
export class LocalStore implements AssetStore {
  readonly kind = "local" as const;
  private secret: Buffer | undefined;

  constructor(readonly root: string = ASSETS_HOME) {}

  private pathFor(key: string): string {
    assertSafeKey(key);
    const p = normalize(join(this.root, ...key.split("/")));
    const rel = relative(this.root, p);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`unsafe storage key: ${key}`);
    return p;
  }

  /** The key a path under the root maps back to (forward slashes). */
  keyFor(path: string): string {
    const rel = relative(this.root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path is outside the asset root: ${path}`);
    return rel.split(sep).join("/");
  }

  signingSecret(): Buffer {
    if (this.secret) return this.secret;
    const env = process.env.RELAY_ASSET_SIGNING_KEY;
    if (env) {
      this.secret = Buffer.from(env, "utf8");
      return this.secret;
    }
    const file = join(this.root, SIGNING_KEY_FILE);
    if (!existsSync(file)) {
      mkdirSync(this.root, { recursive: true });
      writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    }
    this.secret = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    return this.secret;
  }

  sign(key: string, exp: number): string {
    return createHmac("sha256", this.signingSecret()).update(`${key}\n${exp}`).digest("base64url");
  }

  /** True when `sig` is the HMAC for `key`/`exp` and `exp` is in the future. */
  verify(key: string, exp: number, sig: string, now: number = Date.now()): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < now) return false;
    try {
      assertSafeKey(key);
    } catch {
      return false;
    }
    const want = Buffer.from(this.sign(key, exp));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  async put(key: string, data: Buffer | Readable, _opts: PutOptions): Promise<void> {
    const p = this.pathFor(key);
    mkdirSync(dirname(p), { recursive: true });
    if (Buffer.isBuffer(data)) await writeFile(p, data);
    else await pipeline(data, createWriteStream(p));
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const p = this.pathFor(key);
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds));
    const url = pathToFileURL(p);
    url.searchParams.set("exp", String(exp));
    url.searchParams.set("sig", this.sign(key, exp));
    return url.toString();
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
    // Drop the now-empty asset folder so the tree does not fill with husks; ignore when siblings remain.
    await rm(dirname(this.pathFor(key)), { recursive: false }).catch(() => {});
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch {
      return false;
    }
  }

  async publish(): Promise<string> {
    throw new PublishUnsupportedError("publish requires Vercel Blob: set BLOB_READ_WRITE_TOKEN (private store) and BLOB_PUBLIC_READ_WRITE_TOKEN (public store)");
  }
}

export interface VerifiedLocalUrl {
  ok: true;
  key: string;
  path: string;
  exp: number;
}

/** Parse and verify a LocalStore signed URL. Returns the key and absolute path when the token is valid and unexpired. */
export function verifyLocalSignedUrl(url: string, store: LocalStore = new LocalStore(), now: number = Date.now()): VerifiedLocalUrl | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "not a url" };
  }
  if (u.protocol !== "file:") return { ok: false, reason: "not a file url" };
  const exp = Number(u.searchParams.get("exp"));
  const sig = u.searchParams.get("sig") ?? "";
  u.search = "";
  let path: string;
  let key: string;
  try {
    path = fileURLToPath(u);
    key = store.keyFor(path);
  } catch {
    return { ok: false, reason: "path outside asset root" };
  }
  if (!store.verify(key, exp, sig, now)) return { ok: false, reason: exp * 1000 < now ? "expired" : "bad signature" };
  return { ok: true, key, path, exp };
}

// ---------- Vercel Blob ----------

/**
 * `@vercel/blob` with `access: 'private'` (SDK 2.8). Calls used:
 *   put(pathname, body, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true })
 *   issueSignedToken({ pathname, operations: ['get'], validUntil })  -> { delegationToken, clientSigningToken }
 *   presignUrl(signedToken, { operation: 'get', pathname, access: 'private', validUntil }) -> { presignedUrl }
 *   head(pathname) (BlobNotFoundError => false), del(pathname)
 *   publish: get(pathname, { access: 'private' }).stream -> put(pathname, stream, { access: 'public', token: BLOB_PUBLIC_READ_WRITE_TOKEN })
 * Docs: https://vercel.com/docs/vercel-blob/using-blob-sdk
 */
export class BlobStore implements AssetStore {
  readonly kind = "blob" as const;
  constructor(
    private readonly token: string = process.env.BLOB_READ_WRITE_TOKEN ?? "",
    private readonly publicToken: string | undefined = process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
  ) {
    if (!token) throw new Error("BlobStore needs BLOB_READ_WRITE_TOKEN");
  }

  private sdk() {
    return import("@vercel/blob");
  }

  async put(key: string, data: Buffer | Readable, opts: PutOptions): Promise<void> {
    assertSafeKey(key);
    const { put } = await this.sdk();
    await put(key, data, { access: "private", contentType: opts.contentType, addRandomSuffix: false, allowOverwrite: true, token: this.token });
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    assertSafeKey(key);
    const { issueSignedToken, presignUrl } = await this.sdk();
    const validUntil = Date.now() + Math.max(1, Math.floor(ttlSeconds)) * 1000;
    const signed = await issueSignedToken({ pathname: key, operations: ["get"], validUntil, token: this.token });
    const { presignedUrl } = await presignUrl(signed, { operation: "get", pathname: key, access: "private", validUntil });
    return presignedUrl;
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const { del } = await this.sdk();
    await del(key, { token: this.token });
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const { head, BlobNotFoundError } = await this.sdk();
    try {
      await head(key, { token: this.token });
      return true;
    } catch (e) {
      if (e instanceof BlobNotFoundError) return false;
      throw e;
    }
  }

  async publish(key: string, opts: PutOptions): Promise<string> {
    assertSafeKey(key);
    if (!this.publicToken) throw new PublishUnsupportedError("publish needs BLOB_PUBLIC_READ_WRITE_TOKEN for a public Blob store; the private store never exposes a permanent URL");
    const { get, put } = await this.sdk();
    const src = await get(key, { access: "private", token: this.token });
    if (!src || src.statusCode !== 200) throw new Error(`asset bytes missing in the private store: ${key}`);
    const out = await put(key, src.stream, { access: "public", contentType: opts.contentType, addRandomSuffix: false, allowOverwrite: true, token: this.publicToken });
    return out.url;
  }
}

/** Blob when `BLOB_READ_WRITE_TOKEN` is set, else the local folder. */
export function openAssetStore(opts: { root?: string } = {}): AssetStore {
  if (process.env.BLOB_READ_WRITE_TOKEN) return new BlobStore();
  return new LocalStore(opts.root);
}
