import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-[2px] border border-rule-strong bg-paper px-3 font-sans text-[15px] text-ink outline-none placeholder:text-muted focus-visible:border-ink disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-high",
        className
      )}
      {...props}
    />
  )
}

export { Input }
