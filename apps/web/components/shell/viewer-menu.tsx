"use client";

import { BookOpen, Compass, KeyRound, LogOut, Monitor, Moon, Server, Sun, User } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { GitHubMark } from "@/components/shell/github-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Session } from "@/lib/session-token";

const THEMES = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

/**
 * The avatar menu: who is signed in, the machine and access configuration (workers, tokens, the GitHub App), the
 * theme, the reference pages and the way out. Anonymous visitors get a plain Sign in link instead; their theme
 * control sits in the footer. Sign-out is a form POST so it works without JavaScript once the menu is open; mock
 * mode shows "demo" in the header row and no Sign out, since there is nothing to sign out of.
 */
export function ViewerMenu({ session }: { session: Session | null }) {
  const { theme, setTheme } = useTheme();
  if (!session) {
    return (
      <Link href="/sign-in" className="shrink-0 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
        Sign in
      </Link>
    );
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className="inline-flex shrink-0 items-center justify-center rounded-full outline-none ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:ring-2 data-[state=open]:ring-ring/50"
        aria-label={`Account menu for ${session.login}`}
        title={session.name ?? session.login}
      >
        {session.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={session.avatar_url} alt="" width={28} height={28} className="size-7 rounded-full ring-1 ring-border" referrerPolicy="no-referrer" />
        ) : (
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border" aria-hidden="true">
            <User className="size-4" />
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{session.login}</span>
            {session.demo && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">demo</span>}
          </span>
          {session.name && session.name !== session.login && <span className="truncate text-xs text-muted-foreground">{session.name}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/workers">
            <Server /> Workers
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/tokens">
            <KeyRound /> Access
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/setup/github">
            <GitHubMark className="size-4 text-muted-foreground" /> GitHub App
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          {THEMES.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon className="text-muted-foreground" /> {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/info">
            <Compass /> Overview
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/docs">
            <BookOpen /> Docs
          </Link>
        </DropdownMenuItem>
        {!session.demo && (
          <>
            <DropdownMenuSeparator />
            <form action="/auth/sign-out" method="post">
              <DropdownMenuItem asChild>
                <button type="submit" className="w-full" aria-label={`Sign out ${session.login}`}>
                  <LogOut /> Sign out
                </button>
              </DropdownMenuItem>
            </form>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
