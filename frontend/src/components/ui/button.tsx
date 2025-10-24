import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Kinroot buttons. `primary` is the plum action (one per view), `ink` a strong neutral action, `line` the outlined
// secondary, `quiet` a text button, `link` an inline plum link.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent font-sans font-medium whitespace-nowrap no-underline transition-[background-color,border-color,color] duration-150 outline-none cursor-pointer disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-brand text-brand-fg border-brand hover:bg-brand-hover hover:border-brand-hover shadow-sm",
        ink: "bg-fg text-bg border-fg hover:opacity-90",
        line: "bg-surface border-border-strong text-fg hover:bg-subtle shadow-xs",
        quiet: "bg-transparent text-fg-2 hover:bg-subtle hover:text-fg",
        link: "h-auto! px-0! border-0 bg-transparent text-brand hover:underline underline-offset-4",
      },
      size: {
        default: "h-9 px-3.5 text-[13.5px]",
        sm: "h-8 px-2.5 text-[13px]",
        icon: "size-8 p-0 text-muted hover:text-fg",
      },
    },
    defaultVariants: { variant: "line", size: "default" },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "line"}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
