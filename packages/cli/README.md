# @kyleroche/relay

The `relay` command: your coding-agent subscriptions (Claude Code, Codex, Grok) working as one system. GitHub
issues are the task bus, runners on your own machines run the vendor CLIs under the machine's own login, a Postgres
database holds shared memory and an append-only event feed, and a small web app shows it all. Credentials never
leave the machine they were created on.

Needs Node 24 or newer. No checkout required:

```bash
npx @kyleroche/relay doctor     # what is installed, logged in, and reachable
npx @kyleroche/relay setup      # hooks + memory MCP server into each CLI you have; prints the plan, --yes writes
cd ~/code/some-repo && npx @kyleroche/relay link
```

`relay link` is the only per-repo step: it registers the repo, digests its files and writes the project summary
(Sonnet, a few cents), renders `relay.md` from that summary, and installs the owned sections, caller workflows and
labels. Re-running it is safe and makes no model calls unless files changed.

The package ships the CLI (`dist/relay.js`), the stdio memory server the CLIs talk to (`dist/relay-mcp.js`), the
dependency-free session hooks `relay setup` installs (`dist/hooks/`), the SQL migrations, and the caller workflow
templates. Locally it runs on an embedded Postgres (PGlite) under `~/.harness`; set `DATABASE_URL` for a server.

Source, architecture and the hosted web app: [github.com/kyleroche/relay](https://github.com/kyleroche/relay) and
[relay.kyro.house](https://relay.kyro.house). Apache-2.0.
