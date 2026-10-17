import { describe, expect, it } from "vitest";
import { isCrossSite } from "../lib/fetch-site.ts";

describe("isCrossSite", () => {
  it("is true only for Sec-Fetch-Site: cross-site, whatever the case", () => {
    expect(isCrossSite(new Headers({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSite(new Headers({ "Sec-Fetch-Site": " Cross-Site " }))).toBe(true);
    for (const v of ["same-origin", "same-site", "none"]) expect(isCrossSite(new Headers({ "sec-fetch-site": v }))).toBe(false);
    expect(isCrossSite(new Headers())).toBe(false); // a browser or client that does not send it is not accused
    expect(isCrossSite({ get: () => null })).toBe(false);
  });
});
