"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
 *
 * Search: a small input at the top filters a flat list built from the
 * same category data + a lightweight keyword map (below). With text in
 * the box we show one flat grid; clearing it restores the category tabs.
 *
 * Recents: the last ~16 picked emoji persist to localStorage under
 * `inbox:emoji:recents` (most-recent-first, de-duped). All storage
 * access is guarded for private-mode / disabled-storage browsers.
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

/**
 * Lightweight keyword map for search. Keys are emoji, values are a
 * space-joined string of names/synonyms. Anything not listed still
 * matches via its category label (appended at build time below), so
 * a search for "food" or "animal" surfaces the whole section even
 * without a per-emoji entry. No new dependency, ~a few KB of strings.
 */
const KEYWORDS: Record<string, string> = {
  "😀": "grin happy smile", "😃": "happy smile joy", "😄": "happy smile laugh",
  "😁": "grin beaming smile", "😆": "laugh haha", "🥹": "happy tears proud",
  "😅": "sweat nervous laugh", "😂": "joy lol laugh cry", "🤣": "rofl lmao laugh",
  "🥲": "smile tear", "😊": "smile blush happy", "😇": "angel innocent halo",
  "🙂": "slight smile", "🙃": "upside down silly", "😉": "wink",
  "😌": "relieved calm", "😍": "love heart eyes", "🥰": "love adore hearts",
  "😘": "kiss blow", "😗": "kiss", "😙": "kiss smile", "😚": "kiss",
  "😋": "yum tasty tongue", "😛": "tongue silly", "😝": "tongue silly",
  "😜": "wink tongue silly", "🤪": "crazy zany goofy", "🤨": "skeptical raised eyebrow",
  "🧐": "monocle inspect curious", "🤓": "nerd geek glasses", "😎": "cool sunglasses",
  "🥸": "disguise glasses", "🤩": "star struck wow excited", "🥳": "party celebrate",
  "😏": "smirk", "😒": "unamused meh", "😞": "sad disappointed", "😔": "sad pensive",
  "😟": "worried", "😕": "confused", "🙁": "frown sad", "☹️": "frown sad",
  "😣": "persevere struggle", "😖": "confounded", "😫": "tired", "😩": "weary",
  "🥺": "pleading puppy eyes please", "😢": "cry sad tear", "😭": "sob cry bawl",
  "😤": "huff triumph frustrated", "😠": "angry mad", "😡": "rage furious mad",
  "🤬": "swearing cursing angry", "🤯": "mind blown shocked", "😳": "flushed embarrassed",
  "🥵": "hot heat sweat", "🥶": "cold freezing", "😱": "scream fear shock",
  "😨": "fearful scared", "😰": "anxious sweat", "😥": "sad relieved", "😓": "sweat down",
  "🤗": "hug", "🤔": "thinking hmm", "🫡": "salute respect", "🤭": "giggle oops",
  "🤫": "shush quiet secret", "🤥": "lying liar", "😶": "no mouth silent", "🫥": "invisible dotted",
  "😐": "neutral", "😑": "expressionless", "😬": "grimace awkward", "🙄": "eye roll",
  "😯": "surprised hushed", "😦": "frown open", "😧": "anguished", "😮": "wow surprised oh",
  "😲": "astonished shocked", "🥱": "yawn tired bored", "😴": "sleep zzz",
  "🤤": "drool", "😪": "sleepy", "😵": "dizzy", "🤐": "zipper mouth quiet",
  "🥴": "woozy drunk", "🤢": "sick nausea", "🤮": "vomit puke sick", "🤧": "sneeze sick",
  "😷": "mask sick", "🤒": "thermometer sick ill", "🤕": "bandage hurt injured",
  "🤑": "money mouth rich", "🤠": "cowboy",
  "👍": "thumbs up yes like good approve", "👎": "thumbs down no dislike bad",
  "👌": "ok perfect", "🤌": "pinched fingers italian", "🤏": "pinch small tiny",
  "✌️": "victory peace", "🤞": "fingers crossed luck hope", "🫰": "fingers crossed money",
  "🤟": "love you", "🤘": "rock horns", "🤙": "call shaka hang loose", "👈": "point left",
  "👉": "point right", "👆": "point up", "🖕": "middle finger rude", "👇": "point down",
  "☝️": "point up index", "🫵": "point you", "👋": "wave hi hello bye",
  "🤚": "raised back hand", "🖐️": "hand splayed", "✋": "raised hand stop high five",
  "🖖": "vulcan spock", "🫱": "hand right", "🫲": "hand left", "🫳": "palm down",
  "🫴": "palm up", "👏": "clap applause", "🙌": "raise hands celebrate praise",
  "🫶": "heart hands love", "👐": "open hands", "🤲": "palms up together",
  "🤝": "handshake deal agree", "🙏": "pray please thanks hope", "✍️": "writing hand",
  "💪": "muscle strong flex", "🦾": "mechanical arm", "🦿": "mechanical leg",
  "🦵": "leg", "🦶": "foot",
  "❤️": "red heart love", "🧡": "orange heart", "💛": "yellow heart", "💚": "green heart",
  "💙": "blue heart", "💜": "purple heart", "🖤": "black heart", "🤍": "white heart",
  "🤎": "brown heart", "💔": "broken heart heartbreak", "❤️‍🔥": "heart fire burning love",
  "❤️‍🩹": "mending heart healing", "❣️": "heart exclamation", "💕": "two hearts love",
  "💞": "revolving hearts", "💓": "beating heart", "💗": "growing heart", "💖": "sparkling heart",
  "💘": "heart arrow cupid", "💝": "heart gift ribbon", "💟": "heart decoration", "♥️": "heart suit",
  "💌": "love letter", "💋": "kiss lips lipstick", "💍": "ring engagement diamond",
  "🌹": "rose flower", "💐": "bouquet flowers", "🌷": "tulip flower",
  "🐶": "dog puppy", "🐱": "cat kitten", "🐭": "mouse", "🐹": "hamster", "🐰": "rabbit bunny",
  "🦊": "fox", "🐻": "bear", "🐼": "panda", "🐻‍❄️": "polar bear", "🐨": "koala",
  "🐯": "tiger", "🦁": "lion", "🐮": "cow", "🐷": "pig", "🐸": "frog", "🐵": "monkey",
  "🐔": "chicken", "🐧": "penguin", "🐦": "bird", "🐤": "chick baby bird", "🦆": "duck",
  "🦅": "eagle", "🦉": "owl", "🦄": "unicorn", "🐝": "bee", "🐛": "bug caterpillar",
  "🦋": "butterfly", "🐌": "snail", "🐞": "ladybug", "🐢": "turtle", "🐍": "snake",
  "🦎": "lizard", "🐙": "octopus", "🦑": "squid", "🦐": "shrimp", "🦞": "lobster",
  "🦀": "crab", "🐠": "fish tropical", "🐟": "fish", "🐬": "dolphin", "🐳": "whale spout",
  "🐋": "whale", "🦈": "shark",
  "🍏": "green apple", "🍎": "apple red", "🍐": "pear", "🍊": "orange tangerine",
  "🍋": "lemon", "🍌": "banana", "🍉": "watermelon", "🍇": "grapes", "🍓": "strawberry",
  "🫐": "blueberries", "🍈": "melon", "🍒": "cherries", "🍑": "peach", "🥭": "mango",
  "🍍": "pineapple", "🥥": "coconut", "🥝": "kiwi", "🍅": "tomato", "🍆": "eggplant",
  "🥑": "avocado", "🥦": "broccoli", "🥬": "leafy greens lettuce", "🥒": "cucumber",
  "🌶️": "chili pepper spicy hot", "🌽": "corn", "🥕": "carrot", "🥔": "potato",
  "🍠": "sweet potato", "🥐": "croissant", "🍞": "bread", "🥖": "baguette", "🥨": "pretzel",
  "🧀": "cheese", "🥚": "egg", "🍳": "fried egg cooking", "🧈": "butter", "🥞": "pancakes",
  "🧇": "waffle", "🥓": "bacon", "🥩": "steak meat", "🍗": "chicken drumstick poultry",
  "🍖": "meat bone", "🌭": "hot dog", "🍔": "burger hamburger", "🍟": "fries",
  "🍕": "pizza", "🥪": "sandwich", "🌮": "taco", "🌯": "burrito", "🥗": "salad",
  "🍝": "pasta spaghetti", "🍣": "sushi", "🍜": "ramen noodles", "🍲": "stew pot",
  "🥘": "paella pan food", "🍦": "ice cream soft serve", "🍰": "cake slice",
  "🧁": "cupcake", "🍪": "cookie", "🍫": "chocolate", "🍿": "popcorn", "☕": "coffee hot tea",
  "🍵": "tea green", "🧃": "juice box", "🥤": "soda drink cup", "🧋": "bubble tea boba",
  "🍺": "beer", "🍷": "wine", "🥂": "cheers champagne clink", "🍾": "champagne bottle celebrate",
  "🔥": "fire lit hot flame", "✨": "sparkles shine", "🎉": "party tada celebrate confetti",
  "🎊": "confetti ball party", "🎈": "balloon", "🎁": "gift present", "🏆": "trophy win award",
  "🥇": "gold medal first", "🥈": "silver medal second", "🥉": "bronze medal third",
  "⚽": "soccer football", "🏀": "basketball", "🏈": "american football", "⚾": "baseball",
  "🎾": "tennis", "🏐": "volleyball", "🥎": "softball", "🎱": "pool 8 ball billiards",
  "🏓": "ping pong table tennis", "🏸": "badminton", "💡": "idea light bulb",
  "🔦": "flashlight torch", "🕯️": "candle", "📱": "phone mobile", "💻": "laptop computer",
  "⌨️": "keyboard", "🖱️": "mouse computer", "💾": "save floppy disk", "💿": "disc cd",
  "📷": "camera", "📸": "camera flash photo", "🎥": "movie camera film", "🎬": "clapper action film",
  "📺": "tv television", "🔔": "bell notification", "🔕": "mute bell silent", "🎵": "music note",
  "🎶": "music notes", "🎙️": "microphone studio", "🎤": "mic sing karaoke",
  "💰": "money bag cash", "💵": "dollar money cash", "💳": "credit card payment",
  "📊": "bar chart stats", "📈": "chart up growth trending", "📉": "chart down decline",
  "📅": "calendar date", "📆": "calendar", "🗓️": "calendar spiral", "📝": "memo note writing",
  "✏️": "pencil write edit", "📌": "pin pushpin", "📎": "paperclip attach", "🔗": "link chain url",
  "✅": "check done yes complete", "❌": "cross no wrong cancel", "⚠️": "warning caution alert",
  "❓": "question", "❗": "exclamation important", "💯": "100 hundred perfect score",
  "💥": "boom collision explosion", "💫": "dizzy star sparkle", "⭐": "star",
  "🌟": "glowing star", "🎯": "target bullseye dart goal", "🚀": "rocket launch ship",
  "🌈": "rainbow", "☀️": "sun sunny", "🌙": "moon crescent night",
};

const RECENTS_KEY = "inbox:emoji:recents";
const RECENTS_LIMIT = 16;

/**
 * Flat, pre-built searchable index. Each entry carries the emoji plus a
 * lower-cased haystack (per-emoji keywords + its category label) so the
 * filter is a single substring scan with no per-keystroke allocation of
 * the index itself. De-duped on emoji (some appear in two categories).
 */
const SEARCH_INDEX: { emoji: string; haystack: string }[] = (() => {
  const seen = new Set<string>();
  const out: { emoji: string; haystack: string }[] = [];
  for (const cat of CATEGORIES) {
    for (const emoji of cat.emojis) {
      if (seen.has(emoji)) continue;
      seen.add(emoji);
      const kw = KEYWORDS[emoji] ?? "";
      out.push({
        emoji,
        haystack: `${kw} ${cat.label}`.toLowerCase(),
      });
    }
  }
  return out;
})();

function readRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string").slice(0, RECENTS_LIMIT);
  } catch {
    return [];
  }
}

function writeRecents(next: string[]) {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Private mode / storage disabled — recents are best-effort.
  }
}

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
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  const [placeBelow, setPlaceBelow] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /**
   * Flip below the trigger when opening upward would run the panel off the top
   * of its clipping ancestor. The reply box always has room above; a message
   * hover-toolbar near the top of a scrolled feed (team chat's thread panel,
   * most visibly) does not, and the panel was simply cut off by the scroller's
   * overflow. Measured in a LAYOUT effect so the flip happens before paint —
   * no visible jump.
   */
  useLayoutEffect(() => {
    if (!open) {
      setPlaceBelow(false);
      return;
    }
    const el = popoverRef.current;
    if (!el) return;
    let clipTop = 0;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden") {
        clipTop = node.getBoundingClientRect().top;
        break;
      }
    }
    if (el.getBoundingClientRect().top < clipTop + 4) setPlaceBelow(true);
  }, [open]);

  // Load recents + reset transient UI each time the popover opens, and
  // autofocus the search box for keyboard-first use.
  useEffect(() => {
    if (!open) return;
    setRecents(readRecents());
    setQuery("");
    setActiveIdx(0);
    // rAF so focus lands after the popover is painted/positioned.
    const raf = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

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

  const trimmed = query.trim().toLowerCase();
  const isSearching = trimmed.length > 0;

  const results = useMemo(() => {
    if (!isSearching) return [];
    return SEARCH_INDEX.filter((entry) => entry.haystack.includes(trimmed)).map((e) => e.emoji);
  }, [isSearching, trimmed]);

  if (!open) return null;

  const active = CATEGORIES[activeIdx]!;

  // Insert the emoji (popover stays open for multi-insert) and bump it to
  // the front of recents.
  const handlePick = (emoji: string) => {
    onPick(emoji);
    setRecents((prev) => {
      const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, RECENTS_LIMIT);
      writeRecents(next);
      return next;
    });
  };

  const renderGrid = (emojis: string[], keyPrefix: string) => (
    <div className="grid grid-cols-8 gap-0.5 pointer-coarse:grid-cols-7">
      {emojis.map((e, idx) => (
        <button
          key={`${keyPrefix}-${idx}-${e}`}
          type="button"
          onClick={() => handlePick(e)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-base transition-colors hover:bg-accent pointer-coarse:h-9 pointer-coarse:w-9"
          aria-label={`Insert ${e}`}
        >
          <span className="leading-none">{e}</span>
        </button>
      ))}
    </div>
  );

  return (
    <motion.div
      ref={popoverRef}
      // Opacity-only fade (no scale/translate): the previous scale 0.98→1 read
      // as the popover "growing" after it appeared, especially janky in dev.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.1, ease: "easeOut" }}
      className={cn(
        "absolute left-0 z-50 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-xl",
        placeBelow ? "top-full mt-2" : "bottom-full mb-2",
        className,
      )}
    >
      <div className="border-b border-border p-1.5">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji"
          aria-label="Search emoji"
          className="h-7 w-full rounded-md bg-accent/50 px-2 text-xs text-foreground placeholder:text-muted-foreground focus:bg-accent focus:outline-none"
        />
      </div>

      {!isSearching && (
        <div className="flex items-center gap-0.5 border-b border-border p-1.5">
          {CATEGORIES.map((cat, i) => (
            <button
              key={cat.label}
              type="button"
              aria-label={cat.label}
              title={cat.label}
              onClick={() => setActiveIdx(i)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md text-base transition-colors pointer-coarse:h-9 pointer-coarse:w-9",
                i === activeIdx ? "bg-accent" : "hover:bg-accent",
              )}
            >
              <span className="leading-none">{cat.icon}</span>
            </button>
          ))}
        </div>
      )}

      <div className="max-h-56 overflow-y-auto p-2">
        {isSearching ? (
          results.length > 0 ? (
            renderGrid(results, "search")
          ) : (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">No emoji found</p>
          )
        ) : (
          <>
            {recents.length > 0 && (
              <div className="mb-2">
                <p className="px-1 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent
                </p>
                {renderGrid(recents, "recent")}
              </div>
            )}
            {renderGrid(active.emojis, active.label)}
          </>
        )}
      </div>
    </motion.div>
  );
}
