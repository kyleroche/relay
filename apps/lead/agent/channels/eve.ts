import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel, type EveAuthFn } from "eve/channels/eve";

const local = localDev();

/**
 * A local development server may replace tools with fixed outcomes, which is how `eve eval` checks the lead's
 * behavior without a relay behind it, and may read the agent's description, which the eval runner asks for first.
 * `localDev()` answers nowhere else, so no deployed caller gets either.
 */
const localWithStubs: EveAuthFn = async (request) => {
  const caller = await local(request);
  return caller ? { ...caller, allowToolStubs: true, allowAgentInfo: true } : null;
};

/**
 * The conversation door: eve's HTTP API, where the owner talks to the lead (`eve dev`, `eve remote connect`). In
 * production it takes Vercel OIDC tokens of the lead's own project only; the site's wake-ups have their own route.
 */
export default eveChannel({
  auth: [vercelOidc(), localWithStubs],
});
