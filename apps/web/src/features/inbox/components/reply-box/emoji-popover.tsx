"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

import { cn } from "@ccp/shared/utils";

/**
 * Curated emoji popover for the composer. We ship ~140 of the most
 * frequently used emoji across 6 categories rather than pulling in a
 * 200+ KB emoji-mart bundle. Trade-off is conscious: the long tail of
 * skin-tone variants / niche flags can be typed via the OS keyboard,
 * and the picker stays snappy on cold load.
 *
 * Positioning: anchored as an absolute popover above its trigger via
 * the parent's relative container. Click-outside + Escape close it.
 * Clicking an emoji inserts at the textarea's current caret position
 * and KEEPS THE POPOVER OPEN — so an agent can drop several emoji in
 * a row without re-clicking the smile button.
 */

interface Category {
  label: string;
  icon: string;
  emojis: string[];
}

const CATEGORIES: Category[] = [
  {
    label: "Smileys",
    icon: "😀",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "🥹", "😅", "😂", "🤣", "🥲",
      "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗",
      "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓",
      "😎", "🥸", "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕",
      "🙁", "☹️", "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "😤",
      "😠", "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰",
      "😥", "😓", "🤗", "🤔", "🫡", "🤭", "🤫", "🤥", "😶", "🫥",
      "😐", "😑", "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱",
      "😴", "🤤", "😪", "😵", "🤐", "🥴", "🤢", "🤮", "🤧", "😷",
      "🤒", "🤕", "🤑", "🤠",
    ],
  },
  {
    label: "Gestures",
    icon: "👍",
    emojis: [
      "👍", "👎", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘",
      "🤙", "👈", "👉", "👆", "🖕", "👇", "☝️", "🫵", "👋", "🤚",
      "🖐️", "✋", "🖖", "🫱", "🫲", "🫳", "🫴", "👏", "🙌", "🫶",
      "👐", "🤲", "🤝", "🙏", "✍️", "💪", "🦾", "🦿", "🦵", "🦶",
    ],
  },
  {
    label: "Hearts",
    icon: "❤️",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔",
      "❤️‍🔥", "❤️‍🩹", "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝",
      "💟", "♥️", "💌", "💋", "💍", "🌹", "💐", "🌷",
    ],
  },
  {
    label: "Animals",
    icon: "🐶",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐻‍❄️", "🐨",
      "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤",
      "🦆", "🦅", "🦉", "🦄", "🐝", "🐛", "🦋", "🐌", "🐞", "🐢",
      "🐍", "🦎", "🐙", "🦑", "🦐", "🦞", "🦀", "🐠", "🐟", "🐬",
      "🐳", "🐋", "🦈",
    ],
  },
  {
    label: "Food",
    icon: "🍕",
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐",
      "🍈", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🍆", "🥑",
      "🥦", "🥬", "🥒", "🌶️", "🌽", "🥕", "🥔", "🍠", "🥐", "🍞",
      "🥖", "🥨", "🧀", "🥚", "🍳", "🧈", "🥞", "🧇", "🥓", "🥩",
      "🍗", "🍖", "🌭", "🍔", "🍟", "🍕", "🥪", "🌮", "🌯", "🥗",
      "🍝", "🍣", "🍜", "🍲", "🥘", "🍦", "🍰", "🧁", "🍪", "🍫",
      "🍿", "☕", "🍵", "🧃", "🥤", "🧋", "🍺", "🍷", "🥂", "🍾",
    ],
  },
  {
    label: "Objects",
    icon: "💡",
    emojis: [
      "🔥", "✨", "🎉", "🎊", "🎈", "🎁", "🏆", "🥇", "🥈", "🥉",
      "⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🥎", "🎱", "🏓", "🏸",
      "💡", "🔦", "🕯️", "📱", "💻", "⌨️", "🖱️", "💾", "💿", "📷",
      "📸", "🎥", "🎬", "📺", "🔔", "🔕", "🎵", "🎶", "🎙️", "🎤",
      "💰", "💵", "💳", "📊", "📈", "📉", "📅", "📆", "🗓️", "📝",
      "✏️", "📌", "📎", "🔗", "✅", "❌", "⚠️", "❓", "❗", "💯",
      "💥", "💫", "⭐", "🌟", "✨", "🎯", "🚀", "🌈", "☀️", "🌙",
    ],
  },
];

export function EmojiPopover({
  open,
  onClose,
  onPick,
  className,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
  className?: string;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + stopImmediatePropagation: Escape closes only this
      // popover, not also the layer beneath (e.g. message-selection mode).
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      const el = popoverRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    // Defer one tick so the same click that opened the popover doesn't
    // immediately close it on the document-level handler.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onClick);
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onClick);
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  const active = CATEGORIES[activeIdx]!;

  return (
    <motion.div
      ref={popoverRef}
      // Opacity-only fade (no scale/translate): the previous scale 0.98→1 read
      // as the popover "growing" after it appeared, especially janky in dev.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.1, ease: "easeOut" }}
      className={cn(
        "absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-border bg-popover shadow-xl",
        className,
      )}
    >
      <div className="flex items-center gap-0.5 border-b border-border p-1.5">
        {CATEGORIES.map((cat, i) => (
          <button
            key={cat.label}
            type="button"
            aria-label={cat.label}
            title={cat.label}
            onClick={() => setActiveIdx(i)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-base transition-colors",
              i === activeIdx ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            <span className="leading-none">{cat.icon}</span>
          </button>
        ))}
      </div>
      <div className="max-h-56 overflow-y-auto p-2">
        <div className="grid grid-cols-8 gap-0.5">
          {active.emojis.map((e, idx) => (
            <button
              key={`${active.label}-${idx}-${e}`}
              type="button"
              onClick={() => onPick(e)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-base transition-colors hover:bg-accent"
              aria-label={`Insert ${e}`}
            >
              <span className="leading-none">{e}</span>
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
