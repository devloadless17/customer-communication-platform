/**
 * The human-readable status page the Meta data-deletion callback points at.
 *
 * Meta requires it: "The link and confirmation number must give the user access to a
 * human-readable explanation of the status of their request, including a legitimate
 * justification for any refusal to delete." So this page has to explain what we did,
 * what we kept, and WHY — a bare "request received" would not satisfy the second half.
 *
 * Deliberately STATIC rather than a per-code lookup. Recording each request would
 * need a table, and adding a migration while a concurrent session owns
 * prisma/schema.prisma is a conflict I chose not to create. The consequence is
 * honest and bounded: this page explains the standing policy accurately for every
 * request, and cannot report a per-request timestamp. If per-request status is
 * wanted, the shape is a `DataDeletionRequest` row keyed by the confirmation code
 * that the callback writes and this page reads.
 *
 * No `noindex` games: this is a policy page and being indexable is fine.
 */

export const metadata = {
  title: "Data deletion request",
  description:
    "What happens when you ask us to delete the data we hold from your Facebook or Instagram messages.",
};

export default async function DataDeletionStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Data deletion request</h1>

      {code ? (
        <p className="mt-4 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
          Your confirmation code is{" "}
          <strong className="font-mono font-medium">{code}</strong>. Keep it if you need
          to refer to this request.
        </p>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          This page explains how we handle a request to delete the data we hold about
          you. If you arrived here from Facebook or Instagram, your confirmation code
          was shown alongside the link.
        </p>
      )}

      <section className="mt-8 space-y-3 text-sm leading-relaxed">
        <h2 className="text-base font-medium">What we received</h2>
        <p>
          We received and verified your request. Verification matters: we only act on
          requests that carry a valid signature from Meta, so nobody can ask us to
          delete someone else&apos;s data.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm leading-relaxed">
        <h2 className="text-base font-medium">What we delete</h2>
        <p>
          We remove your contact record from the business you messaged. After that you
          no longer appear in their contact directory, their search, their exported
          contact files, or any audience they build for future messages. We stop
          processing you as a contact.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm leading-relaxed">
        <h2 className="text-base font-medium">What we keep, and why</h2>
        <p>
          The messages themselves stay with the business you were talking to. We are
          not the owner of that conversation — we provide the software the business
          uses, and the conversation is their business record, in the same way a shop
          keeps a record of an order or a complaint. Businesses have their own legal
          reasons to retain those records, and we are not able to overrule them.
        </p>
        <p>
          If you want the message history itself erased, that request has to go to the
          business you messaged, because it is theirs to decide. They can do it from
          inside our software. If you tell us who they are, we will pass your request
          on to them.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm leading-relaxed">
        <h2 className="text-base font-medium">If your request needs more work</h2>
        <p>
          Facebook and Instagram identify you to us with an account-specific ID, and it
          is not always the same ID we stored when you messaged a business. When the
          two don&apos;t line up automatically, a person on our side completes the
          request by hand. That takes longer than the automatic case, and your
          confirmation code is how we track it.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm leading-relaxed">
        <h2 className="text-base font-medium">Questions</h2>
        <p>
          Reply to the business you messaged, or contact us with your confirmation
          code and we will tell you the current status of your request.
        </p>
      </section>
    </main>
  );
}
