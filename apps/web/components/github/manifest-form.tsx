"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Where GitHub's manifest flow starts: the organization's app settings when one is named, else the person's own. Mirrors lib/github-app.ts `manifestTarget`. */
const target = (org: string): string => {
  const o = org.trim();
  return o && /^[\w.-]+$/.test(o) ? `https://github.com/organizations/${o}/settings/apps/new` : "https://github.com/settings/apps/new";
};

/**
 * One form: the organization (optional) and Create. The manifest flow is a browser POST to GitHub whose URL names the
 * owner, so the action is set from the field as the form is submitted; the manifest and the signed state ride along as
 * hidden fields. Nothing is typed or copied after this: GitHub shows the app, asks to confirm, and posts the
 * credentials back to /setup/github/callback.
 */
export function ManifestForm({ manifest, state, disabled, initialOrg = "" }: { manifest: string; state: string; disabled: boolean; initialOrg?: string }) {
  const [org, setOrg] = useState(initialOrg);
  const label = org.trim() ? `Create in ${org.trim()} on GitHub` : "Create on my account on GitHub";
  return (
    <form
      method="post"
      action={`${target(org)}?state=${encodeURIComponent(state)}`}
      onSubmit={(e) => {
        e.currentTarget.action = `${target(org)}?state=${encodeURIComponent(state)}`;
      }}
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
    >
      <input type="hidden" name="manifest" value={manifest} />
      <label className="flex flex-1 flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Organization (empty for your own account)</span>
        <Input name="org" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="acme" autoComplete="off" disabled={disabled} />
      </label>
      <Button type="submit" disabled={disabled}>
        {label}
      </Button>
    </form>
  );
}
