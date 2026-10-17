import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { FlowDiagram } from "@/components/info/flow-diagram";
import { CopyButton } from "@/components/copy-button";
import { JsonLd, organizationLd, softwareApplicationLd } from "@/components/seo/json-ld";
import { RelayMark } from "@/components/shell/relay-mark";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ACCESS_ALTERNATIVES, ACCESS_INTRO, ACCESS_STEPS, ACCOUNTS, FLOW, INSTALL_AGENT_PROMPT, INSTALL_SHELL, LICENSE, MAKER, RULES, TAGLINE, WHAT_IS } from "@/lib/content/info";
import { AUTHOR, ISSUES_URL, REPO_URL, SITE_URL } from "@/lib/site";

/**
 * The public landing: what relay is, the five rules, how a task flows, install, accounts, the agent surface, who
 * makes it. Served at / to anonymous visitors and at /info for everyone (canonical /). `lib/content/info.ts` is the
 * single source for this page and its Markdown mirror.
 */

export const LANDING_METADATA: Metadata = {
  title: { absolute: "relay — your coding-agent subscriptions as one system" },
  description:
    "relay is a free, open-source harness that makes Claude Code, Codex and Grok subscriptions work as one system: GitHub issues as the task bus, runners on your own machines, shared memory, and a feed of everything agents did. Five rules, how a task flows, quick install.",
  alternates: { canonical: "/", types: { "text/markdown": `${SITE_URL}/` } },
  robots: { index: true, follow: true },
};

import { AgenticScore } from "./agentic-score";

export function Landing() {
  return (
    <>
      <JsonLd data={[softwareApplicationLd(), organizationLd()]} />
      <article className="mx-auto max-w-3xl py-10 sm:py-16">
        <header>
          <div className="flex items-center gap-2 text-primary">
            <RelayMark className="size-6" />
            <span className="font-mono text-xs uppercase tracking-wider">open source · Apache-2.0 · free</span>
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            relay. <span className="text-muted-foreground">{TAGLINE}</span>
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-7 text-muted-foreground">
            relay is a developer tool for macOS and Linux that turns the Claude Code, Codex and Grok subscriptions you already pay for into one system. It costs nothing and runs on your own machines.
          </p>
          <AgenticScore />
          <div className="mt-6 flex flex-wrap gap-2">
            <a href="#install" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              Install
            </a>
            <a href={REPO_URL} rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1 rounded-md border px-4 text-sm hover:bg-accent">
              GitHub <ArrowUpRight className="size-3.5" />
            </a>
            <Link href="/docs" className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-accent">
              Read the docs
            </Link>
          </div>
        </header>

        <section aria-labelledby="what" className="mt-14">
          <h2 id="what" className="text-xl font-semibold tracking-tight">What relay is</h2>
          <div className="mt-3 flex flex-col gap-4 text-[15px] leading-7 text-muted-foreground">
            {WHAT_IS.map((p) => (
              <p key={p.slice(0, 24)}>{p}</p>
            ))}
          </div>
        </section>

        <section aria-labelledby="rules" className="mt-14">
          <h2 id="rules" className="text-xl font-semibold tracking-tight">The five rules</h2>
          <ol className="mt-4 flex flex-col divide-y">
            {RULES.map((r, i) => (
              <li key={r.title} className="grid grid-cols-[2rem_1fr] gap-x-3 py-4">
                <span className="font-mono text-sm text-primary">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3 className="font-medium">{r.title}</h3>
                  <p className="mt-1 text-[15px] leading-7 text-muted-foreground">{r.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="flow" className="mt-14">
          <h2 id="flow" className="text-xl font-semibold tracking-tight">How a task flows</h2>
          <div className="mt-6 grid gap-8 sm:grid-cols-[18rem_1fr] sm:items-start">
            <FlowDiagram className="mx-auto w-full max-w-xs sm:mx-0" />
            <ol className="flex flex-col gap-4 text-[15px] leading-7">
              {FLOW.map((f, i) => (
                <li key={f.step} className="flex gap-3">
                  <span className="mt-0.5 font-mono text-sm text-primary">{i + 1}</span>
                  <div>
                    <p className="font-medium">{f.step}</p>
                    <p className="text-muted-foreground">{f.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">Every step above is a row in the feed, which the people who run this relay see after signing in.</p>
        </section>

        <section aria-labelledby="install" className="mt-14">
          <h2 id="install" className="text-xl font-semibold tracking-tight">Quick install</h2>
          <p className="mt-3 text-[15px] leading-7 text-muted-foreground">Paste this into whichever coding agent you use:</p>
          <div className="relative mt-3">
            <pre className="whitespace-pre-wrap break-words rounded-md border bg-card p-4 pr-12 text-[13px] leading-6">
              <code className="language-text">{INSTALL_AGENT_PROMPT}</code>
            </pre>
            <CopyButton text={INSTALL_AGENT_PROMPT} className="absolute right-2 top-2" />
          </div>
          <p className="mt-6 text-[15px] leading-7 text-muted-foreground">Or by hand:</p>
          <div className="relative mt-3">
            <pre className="overflow-x-auto rounded-md border bg-card p-4 pr-12 font-mono text-[13px] leading-6">
              <code className="language-bash">{INSTALL_SHELL}</code>
            </pre>
            <CopyButton text={INSTALL_SHELL} className="absolute right-2 top-2" />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Node 24 is pinned through <code className="rounded bg-muted px-1 font-mono text-xs">.node-version</code>; pnpm picks it up. Nothing here needs an account with relay: it is free, and the default is the whole thing.
          </p>
        </section>

        <section aria-labelledby="accounts" className="mt-14">
          <h2 id="accounts" className="text-xl font-semibold tracking-tight">Link your model accounts</h2>
          <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
            relay never asks for a token. Log in to each tool you own, on each machine that will run work. <code className="rounded bg-muted px-1 font-mono text-xs">relay doctor</code> tells you which ones it found; machines without a login simply do not get that lane's label.
          </p>
          <div className="mt-4 overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead>Login</TableHead>
                  <TableHead>Plan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ACCOUNTS.map((a) => (
                  <TableRow key={a.tool}>
                    <TableCell className="font-medium">{a.tool}</TableCell>
                    <TableCell className="font-mono text-xs">{a.login}</TableCell>
                    <TableCell className="text-muted-foreground">{a.plan}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <section aria-labelledby="agents" className="mt-14">
          <h2 id="agents" className="text-xl font-semibold tracking-tight">For agents</h2>
          <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
            This site is built to be read by agents as well as people. Every page is server-rendered, this page and the docs are served as Markdown on request (<code className="rounded bg-muted px-1 font-mono text-xs">Accept: text/markdown</code>), and the API and MCP server are described in machine-readable form. The MCP server answers <code className="rounded bg-muted px-1 font-mono text-xs">initialize</code> and <code className="rounded bg-muted px-1 font-mono text-xs">tools/list</code> without a token.
          </p>
          <div className="mt-5 rounded-lg border p-4">
            <h3 className="text-sm font-medium">Getting access as an agent</h3>
            <p className="mt-1 text-sm text-muted-foreground">{ACCESS_INTRO}</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              {ACCESS_STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-muted-foreground">{ACCESS_ALTERNATIVES}</p>
          </div>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            {[
              ["/docs/api#access", "How to get access (device flow, invite, consent)"],
              ["/.well-known/oauth-authorization-server", "OAuth 2.1 authorization server metadata"],
              ["/docs/api", "REST API and MCP guide"],
              ["/openapi.json", "OpenAPI 3.1 description"],
              ["/mcp", "MCP server, Streamable HTTP"],
              ["/llms.txt", "llms.txt"],
              ["/.well-known/agent-skills/index.json", "Agent skill: install relay"],
              ["/.well-known/ai-catalog.json", "AI catalog"],
            ].map(([href, label]) => (
              <li key={href}>
                <a href={href} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 hover:border-primary/50">
                  <span>{label}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{href}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="maker" className="mt-14">
          <h2 id="maker" className="text-xl font-semibold tracking-tight">Who makes it</h2>
          <p className="mt-3 text-[15px] leading-7 text-muted-foreground">{MAKER}</p>
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <li>
              <a href={AUTHOR.url} className="text-primary underline underline-offset-4" rel="noopener noreferrer">
                {AUTHOR.name} on GitHub
              </a>
            </li>
            <li>
              <a href={ISSUES_URL} className="text-primary underline underline-offset-4" rel="noopener noreferrer">
                Issues and support
              </a>
            </li>
            <li>
              <Link href="/about" className="text-primary underline underline-offset-4">About</Link>
            </li>
            <li>
              <Link href="/contact" className="text-primary underline underline-offset-4">Contact</Link>
            </li>
            <li>
              <Link href="/privacy" className="text-primary underline underline-offset-4">Privacy</Link>
            </li>
          </ul>
        </section>

        <section aria-labelledby="license" className="mt-14">
          <h2 id="license" className="text-xl font-semibold tracking-tight">License</h2>
          <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
            {LICENSE}{" "}
            <a href={REPO_URL} className="text-primary underline underline-offset-4" rel="noopener noreferrer">
              Source on GitHub
            </a>
            .
          </p>
        </section>
      </article>
    </>
  );
}
