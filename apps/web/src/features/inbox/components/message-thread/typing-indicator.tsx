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
}: {
  typingUserIds: string[];
  memberById: Map<string, User>;
}) {
  const names = typingUserIds
    .map((id) => memberById.get(id)?.name.split(" ")[0])
    .filter((n): n is string => Boolean(n));

  return (
    <AnimatePresence>
      {names.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 4, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: 4, height: 0 }}
          transition={{ duration: 0.14 }}
          className="border-t border-border bg-background"
        >
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-1.5 text-[11px] text-muted-foreground">
            <TypingDots />
            <span>
              {names.length === 1
                ? `${names[0]} is typing…`
                : names.length === 2
                  ? `${names[0]} and ${names[1]} are typing…`
                  : `${names.length} teammates are typing…`}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1 rounded-full bg-muted-foreground"
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
