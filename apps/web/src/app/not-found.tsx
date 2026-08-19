import { Button } from "@/components/ui/button";

/**
 * Root 404. Without this, an unknown URL renders Next's own bare "404 | This
 * page could not be found" — unstyled, off-brand, and with no way back into the
 * app. Deliberately mirrors SegmentError's chrome so the two dead ends look
 * like the same product.
 *
 * Plain <a>, not <Link>: this is the one route where the client router may have
 * nothing valid to push onto, and a full document load always lands.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        <h1 className="text-base font-semibold">This page doesn&apos;t exist.</h1>
        <p className="text-sm text-muted-foreground">
          The link may be out of date, or the page may have moved.
        </p>
        <div className="mt-2 flex gap-2">
          <Button asChild>
            <a href="/inbox">Back to inbox</a>
          </Button>
          <Button variant="outline" asChild>
            <a href="/login">Sign in</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
