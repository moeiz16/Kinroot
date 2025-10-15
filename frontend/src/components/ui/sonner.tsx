import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/lib/theme"

// Toasts are pinned slips: paper, an oxblood pin dot, and a drop that settles flat.
const Toaster = (props: ToasterProps) => {
  const theme = useTheme()
  return (
    <Sonner
      theme={theme}
      className="toaster"
      position="bottom-center"
      toastOptions={{ unstyled: true, classNames: { toast: "slip-toast", title: "slip-toast-title", description: "slip-toast-desc" } }}
      {...props}
    />
  )
}

export { Toaster }
