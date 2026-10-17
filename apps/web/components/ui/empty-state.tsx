import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

/**
 * The one empty state: a dashed box with a title, one line that says where things come from, and, when there is a
 * command that fills the list, that command with a copy button. Used wherever a list has nothing (feed, tasks,
 * projects, assets, workers, the Access lists, a project's decisions, GitHub installations).
 */
export function EmptyState({ title, children, command, className, as: Tag = "h2" }: { title: string; children?: ReactNode; command?: string; className?: string; as?: "h2" | "h3" | "p" }) {
  return (
    <div className={cn("rounded-md border border-dashed p-6 sm:p-8", className)}>
      <Tag className="text-base font-medium">{title}</Tag>
      {children != null && <p className="mt-2 max-w-prose text-sm text-muted-foreground">{children}</p>}
      {command && (
        <div className="relative mt-4">
          <pre className="overflow-x-auto rounded-md border bg-card p-3 pr-12 font-mono text-xs leading-5">
            <code className="language-bash">{command}</code>
          </pre>
          <CopyButton text={command} className="absolute right-2 top-2" />
        </div>
      )}
    </div>
  );
}
