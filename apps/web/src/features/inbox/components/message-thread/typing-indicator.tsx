"use client";

import { AnimatePresence, motion } from "framer-motion";

import type { User } from "@ccp/shared/types";

/**
 * Typing indicator — appears just above the reply box. Renders the names of
 * other teammates currently typing in this thread (already filtered against
 * the caller's userId by useTyping).
 */
export function TypingIndicator({
  typingUserIds,
  memberById,
  visitorTyping = false,
  visitorName,
}: {
  typingUserIds: string[];
  memberById: Map<string, User>;
  /** A website-widget visitor is typing (not a teammate). */
  visitorTyping?: boolean;
  /** The contact's display name, for the "… is typing" sentence. */
  visitorName?: string;
}) {
  const names = typingUserIds
    .map((id) => memberById.get(id)?.name.split(" ")[0])
    .filter((n): n is string => Boolean(n));

  const teammateSentence =
    names.length === 0
      ? ""
      : names.length === 1
        ? `${names[0]} is typing…`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing…`
          : `${names.length} teammates are typing…`;

  // The visitor's own typing takes visual priority — it's the customer waiting.
  const sentence = visitorTyping
    ? `${visitorName?.split(" ")[0] || "Customer"} is typing…`
    : teammateSentence;
  const active = visitorTyping || names.length > 0;

  return (
    <>
      {/* Persistent screen-reader announcer — always mounted (empty when idle)
          so a teammate starting to type is a CONTENT change inside an existing
          live region. A region mounted with its text already present is
          frequently NOT announced by NVDA/JAWS/VoiceOver. The visual row below
          is aria-hidden so this is the single source of the announcement. */}
      <p className="sr-only" role="status" aria-live="polite">
        {sentence}
      </p>
      <AnimatePresence>
        {active && (
          <motion.div
            aria-hidden
            initial={{ opacity: 0, y: 4, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: 4, height: 0 }}
            transition={{ duration: 0.14 }}
            className="bg-background"
          >
            <div className="mx-auto flex w-full max-w-6xl items-center px-6 py-1.5 text-2xs">
              <span className="inline-flex items-center gap-2 rounded-full bg-muted/30 px-3 py-1 text-foreground/70">
                <TypingDots />
                <span>{sentence}</span>
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function TypingDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1.5 rounded-full bg-muted-foreground"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -1, 0] }}
          transition={{
            duration: 0.9,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.15,
          }}
        />
      ))}
    </span>
  );
}
