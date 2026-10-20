import { describe, expect, it } from "vitest";
import { githubEvents } from "../lib/webhooks/github.ts";
import { productionFromLabels, resolveProject } from "../lib/webhooks/project.ts";

const hint = (over: Partial<Parameters<typeof resolveProject>[0]> = {}) => ({ repo: "acme/productions", issue: 7, labels: [], repoName: "productions", ...over });

describe("resolveProject", () => {
  it("prefers the task row, then a production label, then the repository's name", async () => {
    expect(await resolveProject(hint(), async () => "nightfall")).toBe("nightfall");
    expect(await resolveProject(hint({ labels: [{ name: "agent:claude" }, { name: "production:daybreak" }] }), async () => "nightfall")).toBe("nightfall");
    expect(await resolveProject(hint({ labels: [{ name: "agent:claude" }, { name: "production:daybreak" }] }), async () => null)).toBe("daybreak");
    expect(await resolveProject(hint({ labels: [{ name: "agent:claude" }] }), async () => undefined)).toBe("productions");
    expect(await resolveProject(hint())).toBe("productions");
    expect(await resolveProject(hint({ repoName: null }))).toBeNull();
  });

  it("asks the store only with a repo and an issue, and shrugs off a failing lookup", async () => {
    let asked = 0;
    const lookup = async () => (asked++, "x");
    expect(await resolveProject(hint({ issue: null }), lookup)).toBe("productions");
    expect(await resolveProject(hint({ repo: null }), lookup)).toBe("productions");
    expect(asked).toBe(0);
    expect(
      await resolveProject(hint({ labels: ["production:daybreak"] }), async () => {
        throw new Error("store down");
      }),
    ).toBe("daybreak");
  });

  it("reads production labels as strings or GitHub label objects and ignores the rest", () => {
    expect(productionFromLabels([{ name: "priority:high" }, { name: "production:night.fall-2" }])).toBe("night.fall-2");
    expect(productionFromLabels(["production:x"])).toBe("x");
    expect(productionFromLabels([{ name: "production:" }, { name: "productions:x" }, 3, null])).toBeNull();
    expect(productionFromLabels("production:x")).toBeNull();
  });
});

describe("githubEvents on a shared repo", () => {
  const payload = (labels: Array<{ name: string }>) => ({
    action: "labeled",
    label: { name: "agent:claude" },
    issue: { number: 7, title: "Teaser cut", html_url: "https://github.com/acme/productions/issues/7", labels },
    repository: { full_name: "acme/productions", name: "productions" },
    sender: { login: "kyle", type: "User" },
  });

  it("names the task's project, else the label's, else the repo's; the lane label is read from core's lanes", async () => {
    const fromTask = await githubEvents("issues", payload([{ name: "agent:claude" }, { name: "production:daybreak" }]), "d1", { taskProject: async () => "nightfall" });
    expect(fromTask).toMatchObject([{ kind: "issue.labeled", project: "nightfall", repo: "acme/productions", issue: 7, lane: "claude" }]);
    const fromLabel = await githubEvents("issues", payload([{ name: "agent:claude" }, { name: "production:daybreak" }]), "d2", { taskProject: async () => null });
    expect(fromLabel[0]?.project).toBe("daybreak");
    const fromRepo = await githubEvents("issues", payload([{ name: "agent:claude" }]), "d3");
    expect(fromRepo[0]?.project).toBe("productions");
    // a label that is not a lane is not an event of record
    expect(await githubEvents("issues", { ...payload([]), label: { name: "stage:cut" } }, "d4")).toEqual([]);
  });
});
