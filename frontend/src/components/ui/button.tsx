import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Kinroot buttons: leaf corners (round on two opposite corners, sharp on the others). `primary` is the moss action,
// `ink` a strong neutral action, `line` the outlined secondary, `quiet` a text button, `link` a moss-underlined link.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border-[1.5px] border-transparent font-sans font-bold whitespace-nowrap no-underline transition-[background-color,border-color,color] duration-150 outline-none cursor-pointer disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-moss text-on-moss border-moss hover:bg-[var(--moss-hover)] hover:border-[var(--moss-hover)]",
        ink: "bg-ink text-paper border-ink hover:bg-ink-2",
        line: "bg-surface border-rule-strong text-ink hover:border-ink",
        quiet: "bg-transparent text-ink hover:bg-sunk",
        link: "h-auto! px-0! border-0 bg-transparent text-moss-ink underline decoration-moss decoration-[1.5px] underline-offset-4 hover:text-ink",
      },
      size: {
        default: "h-[42px] px-[18px] text-[14px]",
        sm: "h-[32px] px-3 text-[13px]",
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
