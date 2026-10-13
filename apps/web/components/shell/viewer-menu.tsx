import { LogOut, User } from "lucide-react";
import Link from "next/link";
import type { Session } from "@/lib/session-token";

/**
 * Who is signed in, and the way out. Mock mode shows the fake viewer with a "demo mode" tag instead of a sign-out
 * button, since there is nothing to sign out of. Sign-out is a plain form POST so it works without JavaScript.
 */
export function ViewerMenu({ session }: { session: Session | null }) {
  if (!session) {
    return (
      <Link href="/sign-in" className="shrink-0 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2 text-sm" title={session.name ?? session.login}>
      {session.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={session.avatar_url} alt="" width={24} height={24} className="size-6 rounded-full ring-1 ring-border" referrerPolicy="no-referrer" />
      ) : (
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border" aria-hidden="true">
          <User className="size-3.5" />
        </span>
      )}
      <span className="font-mono text-xs">{session.login}</span>
      {session.demo ? (
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">demo mode</span>
      ) : (
        <form action="/auth/sign-out" method="post">
          <button
            type="submit"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label={`Sign out ${session.login}`}
          >
            <LogOut className="size-3.5" aria-hidden="true" />
            Sign out
          </button>
        </form>
      )}
    </div>
  );
}
