import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-[84px] w-full resize-y rounded-[2px] border border-rule-strong bg-paper px-3 py-2.5 font-sans text-[15px] leading-normal text-ink outline-none placeholder:text-muted focus-visible:border-ink disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-high",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
