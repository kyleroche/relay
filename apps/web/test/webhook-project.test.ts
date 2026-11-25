import { describe, expect, it } from "vitest";
import { githubEvents } from "../lib/webhooks/github.ts";
import { productionFromLabels, resolveProject } from "../lib/webhooks/project.ts";

describe("resolveProject", () => {
  it("prefers a production label, then the repository's name", () => {
    expect(resolveProject({ labels: [{ name: "agent:claude" }, { name: "production:daybreak" }], repoName: "productions" })).toBe("daybreak");
    expect(resolveProject({ labels: [{ name: "agent:claude" }], repoName: "productions" })).toBe("productions");
    expect(resolveProject({ labels: undefined, repoName: "productions" })).toBe("productions");
    expect(resolveProject({ labels: [], repoName: null })).toBeNull();
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

  it("names the label's project, else the repo's; the lane label is read from core's lanes", () => {
    const fromLabel = githubEvents("issues", payload([{ name: "agent:claude" }, { name: "production:daybreak" }]), "d2");
    expect(fromLabel).toMatchObject([{ kind: "issue.labeled", project: "daybreak", repo: "acme/productions", issue: 7, lane: "claude" }]);
    const fromRepo = githubEvents("issues", payload([{ name: "agent:claude" }]), "d3");
    expect(fromRepo[0]?.project).toBe("productions");
    // a label that is not a lane is not an event of record
    expect(githubEvents("issues", { ...payload([]), label: { name: "stage:cut" } }, "d4")).toEqual([]);
  });
});
