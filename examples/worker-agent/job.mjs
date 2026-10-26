/**
 * The app's work. Replace this with the real thing: drive the digitizing app, read `job.job.inputs[*].url` for the
 * artwork, honour `job.job.params`, and upload each output with `ctx.upload(...)`. The default below proves the loop
 * end to end without an app: it writes one text file summarising the claim and uploads it as the output, so the
 * task reaches `review` on the board with a card a person can approve or reject.
 *
 * @param {import("./loop.mjs").Claim} job      what relay_work_claim returned: issue, brief, job (manifest + inputs), review_note
 * @param {import("./loop.mjs").JobContext} ctx  log, heartbeat, upload({filename, bytes, contentType, title, replaces})
 * @returns {Promise<import("./loop.mjs").JobResult>}
 */
export async function doJob(job, ctx) {
  const lines = [
    `# ${job.task_id}: ${job.issue.title}`,
    "",
    `lane: ${job.lane}`,
    `inputs: ${job.job?.inputs.length ?? 0}`,
    ...(job.job?.inputs ?? []).map((i) => `  - ${i.as ?? i.id}: ${i.title} (${i.mime}, v${i.version})`),
    `params: ${JSON.stringify(job.job?.params ?? {})}`,
    `outputs expected: ${(job.job?.outputs ?? []).map((o) => o.name + (o.format ? `.${o.format}` : "")).join(", ") || "(none named)"}`,
    "",
    job.review_note ? `review note to address: ${job.review_note}` : "first attempt",
    "",
    "brief:",
    job.brief || "(none)",
  ];
  ctx.log(`summarising ${job.job?.inputs.length ?? 0} input(s)`);
  const name = job.job?.outputs[0]?.name ?? "summary";
  const row = await ctx.upload({ filename: `${name}.txt`, bytes: new TextEncoder().encode(lines.join("\n") + "\n"), contentType: "text/plain", title: name, description: "Written by the example worker: a summary of the job in place of the real output." });
  return { summary: `example worker: summarised the job as ${row.title}`, assets: [row.id] };
}
