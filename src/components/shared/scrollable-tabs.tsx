/**
 * ScrollableTabs — wraps shadcn Tabs so the strip becomes horizontally
 * scrollable when items don't fit within the viewport.
 *
 * Drop-in replacement for any place using the shadcn TabsList directly.
 * The wrapper div has `overflow-x-auto` and a no-scrollbar class so the
 * scrolling is implicit rather than visually heavy.
 *
 * Usage — same API as shadcn Tabs, just import from here:
 *
 *   <ScrollableTabs value={tab} onValueChange={setTab}>
 *     <ScrollableTabsList>
 *       <ScrollableTabsTrigger value="a">A</ScrollableTabsTrigger>
 *       ...
 *     </ScrollableTabsList>
 *     <TabsContent value="a">...</TabsContent>
 *   </ScrollableTabs>
 *
 * Or use as a wrapper around an existing TabsList:
 *
 *   <Tabs ...>
 *     <ScrollableTabsList>...your existing TabsTrigger children...</ScrollableTabsList>
 *   </Tabs>
 */

import type { ComponentProps } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export const ScrollableTabs = Tabs;
export const ScrollableTabsTrigger = TabsTrigger;
export const ScrollableTabsContent = TabsContent;

export function ScrollableTabsList({ className, ...props }: ComponentProps<typeof TabsList>) {
  return (
    // Outer scroll container — this is where the magic happens. The inner
    // TabsList stays its natural width (whatever its triggers add up to);
    // when that exceeds the viewport, this div scrolls horizontally.
    // [&::-webkit-scrollbar]:hidden + scrollbar-width:none for a clean look.
    <div
      className={cn(
        "w-full overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]",
      )}
    >
      <TabsList className={cn("min-w-max", className)} {...props} />
    </div>
  );
}
