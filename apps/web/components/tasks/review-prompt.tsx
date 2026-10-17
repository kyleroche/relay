import { MessageSquareText } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * "Review from chat": the prompt to hand a bot that should drive the review, behind a button in the Tasks header and
 * in a sheet, like every other thing a person types here (DESIGN.md, item 7). The buttons on each task page do the
 * same by hand.
 */
export function ReviewPrompt({ prompt }: { prompt: string }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <MessageSquareText className="size-3.5" aria-hidden="true" /> Review from chat
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Review from chat</SheetTitle>
          <SheetDescription>Hand this to the bot that should tell you when a preview is up and approve when you say so. The buttons on each task page do the same thing by hand.</SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <div className="relative">
            <pre className="whitespace-pre-wrap break-words rounded-md border bg-card p-3 pr-12 text-xs leading-5">
              <code className="language-text">{prompt}</code>
            </pre>
            <CopyButton text={prompt} className="absolute right-2 top-2" />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
