import { Bot, Server, Sparkles, User } from "lucide-react";
import { parseActor } from "@/lib/events";
import { cn } from "@/lib/utils";

/**
 * Four actor kinds, four marks: human is a circle, bot a rounded square, runner a square,
 * agent a diamond. Shape carries the distinction so it survives grayscale and color-blindness.
 */
export function ActorChip({ actor, className, hideName = false }: { actor: string; className?: string; hideName?: boolean }) {
  const { kind, name } = parseActor(actor);
  const Icon = kind === "human" ? User : kind === "bot" ? Bot : kind === "runner" ? Server : Sparkles;
  const shape =
    kind === "human"
      ? "rounded-full"
      : kind === "bot"
        ? "rounded-md"
        : kind === "runner"
          ? "rounded-none"
          : "rounded-sm rotate-45 [&>svg]:-rotate-45";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs", className)} title={actor}>
      <span className={cn("inline-flex size-4 shrink-0 items-center justify-center bg-muted text-muted-foreground ring-1 ring-border", shape)} aria-hidden="true">
        <Icon className="size-2.5" />
      </span>
      {!hideName && (
        <span className="truncate">
          <span className="sr-only">{kind} </span>
          {name}
        </span>
      )}
    </span>
  );
}
