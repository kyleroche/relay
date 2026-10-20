import { describe, expect, it } from "vitest";
import { homeQuery } from "../lib/home-query.ts";

describe("the home query string", () => {
  it("filters the board by project and keeps the open column", () => {
    expect(homeQuery({})).toEqual({});
    expect(homeQuery({ project: "nightfall" })).toEqual({ project: "nightfall" });
    expect(homeQuery({ project: "all" })).toEqual({});
    expect(homeQuery({ project: "nightfall", all: "review" })).toEqual({ project: "nightfall", all: "review" });
    expect(homeQuery({ all: "done" })).toEqual({ all: "done" });
    expect(homeQuery({ project: ["a", "b"] })).toEqual({ project: "a" });
    expect(homeQuery({ project: "" })).toEqual({});
  });

  it("sends a feed filter to /feed, the project along with it", () => {
    expect(homeQuery({ lane: "claude" })).toEqual({ redirect: "/feed?lane=claude" });
    expect(homeQuery({ kind: "pr.merged", actor: "human:kyle" })).toEqual({ redirect: "/feed?actor=human%3Akyle&kind=pr.merged" });
    expect(homeQuery({ project: "relay", lane: "codex", all: "review" })).toEqual({ redirect: "/feed?lane=codex&project=relay" });
    expect(homeQuery({ project: "all", lane: "codex" })).toEqual({ redirect: "/feed?lane=codex" });
  });
});
