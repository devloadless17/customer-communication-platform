/**
 * Widget runtime counters, in a LEAF module that imports nothing.
 *
 * The health controller reports the live visitor-socket count, but importing the
 * gateway to get it created a require cycle (health → gateway → realtime/db → …),
 * which typecheck accepts and Node then breaks at runtime with
 * "ReferenceError: widgetVisitorSocketCount is not defined" — the binding is still
 * in its temporal dead zone when the controller body runs. Keeping the counter in
 * a dependency-free module gives both sides something safe to import.
 *
 * The gateway registers a getter on init; readers get 0 until then.
 */
let counter: (() => number) | null = null;

/** Called by the widget gateway once its namespace is bound. */
export function setWidgetVisitorSocketCounter(fn: () => number): void {
  counter = fn;
}

/**
 * Live visitor sockets on the "/widget" namespace. Never throws — a metrics probe
 * must not be able to take /health down.
 */
export function widgetVisitorSocketCount(): number {
  try {
    return counter ? counter() : 0;
  } catch {
    return 0;
  }
}
