/**
 * When an approved run starts (cloud/start.ts): the marks a start leaves in a task's thread, and the rule that a
 * grant is for one run. The thread readers run on an in-memory board, where a profile of the client is
 * `board:client:<profile>`.
 */
import { describe, expect, it } from "vitest";
import { connectBoard } from "../src/board/client.ts";
import { deskFor, grantFor, openFor } from "../src/board/desk.ts";
import { LABEL, RELAY_MESSAGE } from "../src/board/mapping.ts";
import { grantText, isDecidingActor } from "../src/board/schemas.ts";
import { actorProfile, SITE_PROFILE } from "../src/board/site.ts";
import { grantsOf, grantDigest, toTask } from "../src/board/tasks.ts";
import { registerWorker } from "../src/board/workers.ts";
import { cloudNames } from "../src/cloud/plan.ts";
import { CLOUD_MAX_STARTS, CLOUD_START_GRACE_MS, cloudFailedKey, cloudFailedText, cloudGrantOf, cloudMarksOf, cloudStart, cloudStartKey, cloudStartText, parseCloudMark, type CloudMark } from "../src/cloud/start.ts";
import { relayBoard } from "./helpers/board.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-24T12:00:00Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * MIN).toISOString();
const start = (n: number, minutesAgo: number, grant = "g1"): CloudMark => ({ kind: "start", grant, n, at: at(minutesAgo), sandbox: `relay-cloud-x-${n}`, nonce: "abcd" });
const failed = (n: number, minutesAgo: number, grant = "g1", why = "the sandbox was refused"): CloudMark => ({ kind: "failed", grant, n, at: at(minutesAgo), why });

describe("the marks", () => {
  it("are read back as they were written", () => {
    const text = cloudStartText({ grant: "790.800", n: 2, sandbox: "relay-cloud-0a1b2c3d-4e5f60", capUsd: 2, timeoutMs: 30 * MIN, nonce: "9f8e7d6c" });
    expect(text).toBe("Cloud run, start 2 under grant 790.800: sandbox relay-cloud-0a1b2c3d-4e5f60, cap $2.00, at most 30 min. [9f8e7d6c]");
    expect(parseCloudMark(text)).toEqual({ kind: "start", grant: "790.800", n: 2, sandbox: "relay-cloud-0a1b2c3d-4e5f60", nonce: "9f8e7d6c" });
    const gone = cloudFailedText({ grant: "790.800", n: 2, why: "npm install exited 1:\n  ETIMEDOUT   registry.npmjs.org" });
    expect(gone).toBe("Cloud run, start 2 under grant 790.800 did not come up: npm install exited 1: ETIMEDOUT registry.npmjs.org");
    expect(parseCloudMark(gone)).toEqual({ kind: "failed", grant: "790.800", n: 2, why: "npm install exited 1: ETIMEDOUT registry.npmjs.org" });
  });

  it("are nothing else: a line that only resembles one is no mark", () => {
    for (const text of ["", "Cloud run approved.", "Cloud run, start 1 under grant g1: sandbox x, cap $2.00, at most 30 min.", "note: Cloud run, start 1 under grant g1 did not come up: x", "Cloud run, start one under grant g1 did not come up: x"]) expect(parseCloudMark(text)).toBeUndefined();
  });

  it("have one key per task, grant and try", () => {
    expect(cloudStartKey("790.771", "790.800", 1)).toBe("relay-cloud:790.771:790.800:1");
    expect(new Set([cloudStartKey("a", "g", 1), cloudStartKey("a", "g", 2), cloudStartKey("a", "h", 1), cloudStartKey("b", "g", 1), cloudFailedKey("a", "g", 1)]).size).toBe(5);
  });
});

describe("cloudStart", () => {
  it("starts a grant that has not been started", () => {
    expect(cloudStart([], "g1", NOW)).toEqual({ start: 1 });
  });

  it("waits while a start is young, under this grant or any other: one sandbox per task at a time", () => {
    expect(cloudStart([start(1, 2)], "g1", NOW)).toEqual({ wait: "starting", n: 1 });
    expect(cloudStart([start(1, 2, "g0")], "g1", NOW)).toEqual({ wait: "starting", n: 1 });
    expect(cloudStart([start(1, CLOUD_START_GRACE_MS / MIN - 1)], "g1", NOW)).toMatchObject({ wait: "starting" });
  });

  it("tries again only a start that is marked as not having come up", () => {
    expect(cloudStart([start(1, 2), failed(1, 1)], "g1", NOW)).toEqual({ start: 2 });
    expect(cloudStart([start(1, 30), failed(1, 29), start(2, 20), failed(2, 19)], "g1", NOW)).toEqual({ start: 3 });
  });

  it("never follows a start that may have run: the grant is spent, and the owner is asked again", () => {
    expect(cloudStart([start(1, 11)], "g1", NOW)).toEqual({ wait: "ended", n: 1 });
    expect(cloudStart([start(1, 600)], "g1", NOW)).toEqual({ wait: "ended", n: 1 });
    expect(cloudStart([start(1, 40), failed(1, 39), start(2, 30)], "g1", NOW)).toEqual({ wait: "ended", n: 2 });
    // a failure under another grant, or of another try, says nothing about this start
    expect(cloudStart([start(1, 30), failed(1, 29, "g0"), failed(2, 29)], "g1", NOW)).toEqual({ wait: "ended", n: 1 });
  });

  it("gives up after three starts that did not come up", () => {
    const marks = [1, 2, 3].flatMap((n) => [start(n, 60 - n * 10), failed(n, 59 - n * 10, "g1", `try ${n} refused`)]);
    expect(CLOUD_MAX_STARTS).toBe(3);
    expect(cloudStart(marks, "g1", NOW)).toEqual({ wait: "gave-up", n: 3, why: "try 3 refused" });
  });

  it("starts a new grant after an old one is spent", () => {
    expect(cloudStart([start(1, 90, "g0")], "g1", NOW)).toEqual({ start: 1 });
    expect(cloudStart([start(1, 90, "g0"), start(1, 60, "g1")], "g2", NOW)).toEqual({ start: 1 });
  });
});

describe("reading a thread", () => {
  async function site() {
    const b = await relayBoard();
    await registerWorker(b.as("mini"), { name: "mini", host: "mini.local", lanes: ["claude"], labels: [], version: "0.4.0" }, []);
    const session = await connectBoard(b);
    const person = deskFor(session, { actor: "human:kyle" });
    const { task } = await openFor(person, { project: "demo", repo: "acme/demo", title: "Add dark mode", body: "Toggle in the header.", lane: "claude" });
    return { b, session, person, id: task.id, trusted: session.from, own: b.as(SITE_PROFILE) };
  }

  it("finds the paid run a signed-in person approved, with the reply that carries it", async () => {
    const s = await site();
    expect(cloudGrantOf(await s.b.thread(s.id), s.trusted)).toBeUndefined();
    await grantFor(s.person, s.id, { cloudCapUsd: 2 });
    const thread = await s.b.thread(s.id);
    const grant = cloudGrantOf(thread, s.trusted)!;
    expect(grant.capUsd).toBe(2);
    expect(thread.replies.find((m) => m.id === grant.id)!.by.actor).toBe(`board:client:${SITE_PROFILE}`);
    expect(grantsOf(thread, s.trusted).cloudCapUsd).toBe(2);
  });

  it("takes the last grant, and none a capability set made", async () => {
    const s = await site();
    await grantFor(s.person, s.id, { cloudCapUsd: 2 });
    await grantFor(s.person, s.id, { set: "deploy" });
    const first = cloudGrantOf(await s.b.thread(s.id), s.trusted)!;
    await grantFor(s.person, s.id, { cloudCapUsd: 5 });
    const second = cloudGrantOf(await s.b.thread(s.id), s.trusted)!;
    expect(first.capUsd).toBe(2);
    expect(second.capUsd).toBe(5);
    expect(second.id).not.toBe(first.id);
  });

  it("believes no grant a stranger wrote, nor one for another wording of the task", async () => {
    const s = await site();
    const digest = grantDigest(await s.b.thread(s.id));
    // the person's own profile is not one of relay's: their words are never data
    await s.b.as(actorProfile("human:kyle")).reply(s.id, { text: grantText({ cloud_cap_usd: 9, digest }), labels: { [LABEL.relay]: RELAY_MESSAGE.log }, noSync: true });
    await s.b.as("someone-else").reply(s.id, { text: grantText({ cloud_cap_usd: 9, digest }), noSync: true });
    await s.own.reply(s.id, { text: grantText({ cloud_cap_usd: 9, digest: "0".repeat(64) }), noSync: true });
    expect(cloudGrantOf(await s.b.thread(s.id), s.trusted)).toBeUndefined();
  });

  it("believes a decision from a trusted principal itself or the site's own profile, and from no worker's", () => {
    const site = "vercel:project:p1:production";
    const trusted = [site, "vercel:user:u1"];
    expect(isDecidingActor(`${site}+${SITE_PROFILE}`, trusted)).toBe(true);
    expect(isDecidingActor("vercel:user:u1", trusted)).toBe(true);
    expect(isDecidingActor(`board:client:${SITE_PROFILE}`, ["board:client"])).toBe(true);
    for (const actor of [`${site}+relay-cloud-0a1b2c3d-claude`, `${site}+relay-site-claude`, `${site}+relay-brief`, `${site}+human-kyle`, "vercel:user:u1+relay-studio-claude", "vercel:user:u2", `vercel:user:u2+${SITE_PROFILE}`, "board:client:relay-mini-claude"]) expect(isDecidingActor(actor, [...trusted, "board:client"]), actor).toBe(false);
  });

  it("does not believe a grant or a mark written as a worker's profile: a paid run's lane can post as its worker", async () => {
    const s = await site();
    const digest = grantDigest(await s.b.thread(s.id));
    // the profile the sandbox writes as: one of relay's own, believed for a run's reports and for nothing that spends
    const lane = s.b.as(cloudNames(s.id).profile);
    await lane.reply(s.id, { text: grantText({ cloud_cap_usd: 10, digest }), labels: { [LABEL.relay]: RELAY_MESSAGE.log }, noSync: true });
    const thread = await s.b.thread(s.id);
    expect(grantsOf(thread, s.trusted).cloudCapUsd).toBeNull();
    expect(cloudGrantOf(thread, s.trusted)).toBeUndefined();

    await grantFor(s.person, s.id, { cloudCapUsd: 2 });
    const grant = cloudGrantOf(await s.b.thread(s.id), s.trusted)!;
    await s.own.reply(s.id, { text: cloudStartText({ grant: grant.id, n: 1, sandbox: "relay-cloud-a-b", capUsd: 2, timeoutMs: 30 * MIN, nonce: "0123abcd" }), noSync: true });
    await lane.reply(s.id, { text: cloudFailedText({ grant: grant.id, n: 1, why: "forged from inside, to be started again" }), noSync: true });
    const marks = cloudMarksOf(await s.b.thread(s.id), s.trusted);
    expect(marks.map((m) => m.kind)).toEqual(["start"]);
    expect(cloudStart(marks, grant.id, Date.now() + CLOUD_START_GRACE_MS + 1)).toEqual({ wait: "ended", n: 1 });
  });

  it("reads the marks the site left, and none anyone else wrote", async () => {
    const s = await site();
    const text = cloudStartText({ grant: "g1", n: 1, sandbox: "relay-cloud-a-b", capUsd: 2, timeoutMs: 30 * MIN, nonce: "0123abcd" });
    await s.b.as(actorProfile("human:kyle")).reply(s.id, { text, noSync: true });
    await s.b.as("someone-else").reply(s.id, { text: cloudFailedText({ grant: "g1", n: 1, why: "forged, to have it start again" }), noSync: true });
    expect(cloudMarksOf(await s.b.thread(s.id), s.trusted)).toEqual([]);
    await s.own.reply(s.id, { text, labels: { [LABEL.relay]: RELAY_MESSAGE.log }, noSync: true, id: cloudStartKey(s.id, "g1", 1) });
    const marks = cloudMarksOf(await s.b.thread(s.id), s.trusted);
    expect(marks).toMatchObject([{ kind: "start", grant: "g1", n: 1, sandbox: "relay-cloud-a-b", nonce: "0123abcd" }]);
    // the forged failure is not among them, so the start is not tried again
    expect(cloudStart(marks, "g1", Date.now() + CLOUD_START_GRACE_MS + 1)).toEqual({ wait: "ended", n: 1 });
  });

  it("keeps the first mark posted under a key: a second instance reads the first one's word back", async () => {
    const s = await site();
    const key = cloudStartKey(s.id, "g1", 1);
    const post = (nonce: string) => s.own.reply(s.id, { text: cloudStartText({ grant: "g1", n: 1, sandbox: "relay-cloud-a-b", capUsd: 2, timeoutMs: 30 * MIN, nonce }), labels: { [LABEL.relay]: RELAY_MESSAGE.log }, noSync: true, id: key });
    const [a, b] = await Promise.all([post("aaaa1111"), post("bbbb2222")]);
    expect(a.id).toBe(b.id);
    expect(parseCloudMark(a.text)!.nonce).toBe(parseCloudMark(b.text)!.nonce);
    expect(cloudMarksOf(await s.b.thread(s.id), s.trusted)).toHaveLength(1);
  });
});
