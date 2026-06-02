# Notification sounds

Drop optional audio files here to override the built-in synthesized tones used
by the notification-sound engine
(`apps/web/src/lib/notifications/notification-sound.ts`).

| File | Played when | Fallback if absent |
|------|-------------|--------------------|
| `message.mp3` | a new inbound customer message arrives (and the "New messages" toggle is on) | a soft synthesized two-note "ding" |
| `ring.mp3` | an incoming WhatsApp call is ringing (and the "Calls" toggle is on) | a synthesized two-tone ring cycle |

## Notes
- **Hybrid by design.** The engine fetches each file once (on first audio
  unlock). If the file is missing (404) or won't decode, that category silently
  falls back to its synth tone — so the feature works with or without these
  files, and adding them later needs **zero code change**.
- Keep them **short**: `message.mp3` ~0.3–0.8 s; `ring.mp3` ≤ ~3 s (the ring
  re-fires on a ~3.2 s cycle while a call is ringing, and a longer file is
  capped to the cycle to avoid overlap).
- Any browser-decodable format works despite the `.mp3` names if you also update
  the `SOUND_FILES` map in the engine; `.mp3` is the safest cross-browser choice.
- Per-device on/off lives in `localStorage` (`ccp.sound.prefs`); these files are
  just the sound source, not the preference.

This README also keeps the directory tracked in git (empty dirs aren't).
