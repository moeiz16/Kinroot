import * as React from "react"
import { cn } from "@/lib/utils"
import * as ResizablePrimitive from "react-resizable-panels"

function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)}
      {...props}
    />
  )
}

function ResizablePanel(props: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

/** The binding gutter between the folio and the exhibit: a stitched seam you can drag. */
function ResizableHandle({ className, ...props }: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle>) {
  return (
    <ResizablePrimitive.PanelResizeHandle data-slot="resizable-handle" className={cn("binding", className)} {...props}>
      <span className="binding-stitch" aria-hidden />
    </ResizablePrimitive.PanelResizeHandle>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
