import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 font-sans text-[14px] text-fg shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-high",
        className
      )}
      {...props}
    />
  )
}

export { Input }
