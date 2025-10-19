import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Status language: a glyph, a word and a tint. Never colour alone.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-sm px-2 py-[5px] font-sans text-[12.5px] leading-none font-semibold whitespace-nowrap no-underline [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      tone: {
        clear: "bg-moss-tint text-moss-ink",
        review: "bg-review-tint text-review",
        high: "bg-high-tint text-high",
        neutral: "bg-sunk text-ink-2",
        restricted: "hatch text-ink",
        unknown: "border-dashed! text-muted",
        ink: "bg-ink text-paper",
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
