import { defineDynamic, defineInstructions } from "eve/instructions";
import { LEAD_SCOPES, relayStatus } from "../lib/relay-env.ts";

/**
 * What the lead is told while relay is not connected. Without it the model would see no relay tools and either invent
 * a task ID or apologize vaguely; with it, whoever asks learns exactly what the operator has to do. Read from the
 * environment on each call, like the connection itself, so the two never disagree.
 */
export default defineDynamic(() => {
  const relay = relayStatus();
  if (relay.connected) return null;
  const scopes = LEAD_SCOPES.join(",");
  const state = relay.invalid ?? `Not set: ${relay.missing.join(", ")}.`;
  return defineInstructions({
    content: [
      "# relay is not connected",
      "",
      "You have no relay tools in this session. You cannot open, read or change a task, and you cannot read memory.",
      "Do not act as if you could. Never invent a task ID, a state or a preference.",
      "",
      "When someone asks for work, tell them relay is not connected and what the operator must do:",
      "",
      `1. Mint a token for the lead with these scopes: ${scopes}. Either on the relay site's Access page ("Mint a token by hand"), or on a machine set up for that site: \`relay token create --name lead --scopes ${scopes}\`.`,
      "2. In the lead's Vercel project, set RELAY_SITE to the site's URL and RELAY_TOKEN to that token.",
      "3. Redeploy the lead.",
      "",
      state,
    ].join("\n"),
  });
});
