import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Status language: a glyph, a word and a tint. Never colour alone.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[5px] font-sans text-[12px] leading-none font-medium whitespace-nowrap no-underline [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      tone: {
        clear: "bg-clear-tint text-clear",
        review: "bg-review-tint text-review",
        high: "bg-high-tint text-high",
        neutral: "bg-subtle text-fg-2",
        restricted: "bg-subtle text-fg-2 border border-border",
        unknown: "border border-dashed border-border-strong text-muted",
        ink: "bg-fg text-bg",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

function Badge({
  className,
  tone,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"
  return (
    <Comp
      data-slot="badge"
      data-tone={tone ?? "neutral"}
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
