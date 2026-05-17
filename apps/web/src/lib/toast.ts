// Single import surface for app-wide toasts. Always import from here, never
// directly from "sonner" — keeps the API swappable and lets us add semantics
// (e.g. dedupe by id, custom defaults) in one place if needed later.
export { toast } from "sonner";
