import { defineDynamic, defineInstructions } from "eve/instructions";

/** A task says "by 2026-11-27", not "by Friday": the worker reads it on another day. The lead needs today's date for that. */
export default defineDynamic((ctx) => defineInstructions({ content: `Today is ${ctx.now.toISOString().slice(0, 10)} (UTC).` }));
