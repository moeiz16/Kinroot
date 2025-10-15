import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Kinroot buttons: 2 px paper corners. `string` is the oxblood primary, `ink` a neutral strong action,
// `line` the secondary on paper, `quiet` a text button, `link` an ink link with an oxblood underline.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[2px] border border-transparent font-sans font-semibold whitespace-nowrap no-underline transition-[background-color,border-color,color] duration-150 outline-none cursor-pointer disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        string: "bg-string text-on-string hover:bg-string-hover",
        ink: "bg-ink text-canvas hover:bg-ink-2",
        line: "bg-paper border-rule-strong text-ink hover:border-ink",
        quiet: "bg-transparent text-ink hover:bg-paper-2",
        link: "h-auto! px-0! bg-transparent text-ink underline decoration-string decoration-[1.5px] underline-offset-4 hover:text-string",
      },
      size: {
        default: "h-[38px] px-4 text-[14px]",
        sm: "h-[30px] px-2.5 text-[13px]",
        icon: "size-[30px] p-0 text-muted hover:text-ink",
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
