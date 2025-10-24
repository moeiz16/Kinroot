import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-[80px] w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 font-sans text-[14px] leading-normal text-fg shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-high",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
