/**
 * Notification-sound engine — framework-agnostic singleton (no React).
 *
 * Owns the audio + the per-device on/off prefs for the two alert categories
 * (new inbound messages, incoming calls). It is a *singleton module* rather
 * than a hook/context because the sound is triggered from several unrelated
 * places that must share one audio backend and outlive any single component:
 *   - the app-wide `message:new` subscription (NotificationSoundProvider)
 *   - the inbox incoming-call toast (start/stop the ring)
 * The React layer (NotificationSoundProvider) only seeds prefs, wires the
 * autoplay unlock, and exposes prefs to the settings UI.
 *
 * Hybrid source: on unlock it tries to decode an audio file from
 * `/public/sounds/`; if the file is absent (404) or won't decode, it falls
 * back to a synthesized Web-Audio tone. So the feature makes noise out of the
 * box, and dropping in branded `.mp3`s later needs zero code change.
 *
 * Prefs are PER-DEVICE (localStorage) on purpose — sound is private and
 * device-shaped (muting your phone shouldn't mute your laptop), and browser
 * autoplay is gated per-document anyway. See the approved plan for the
 * rationale vs. the server-persisted availability feature.
 *
 * SSR-safe: nothing in this module touches `window` / `AudioContext` at import
 * time — every browser access is lazy, behind a `typeof window` guard or only
 * reachable after `unlock()` (which only runs in a user gesture on the client).
 */

/**
 * "messages" means CUSTOMER message. "team" is deliberately separate rather
 * than folded into it: muting customer pings while keeping teammate pings
 * (or the reverse) is the obvious thing an agent wants, and one shared toggle
 * makes that impossible.
 */
export type SoundCategory = "messages" | "calls" | "team";
export type SoundPrefs = Record<SoundCategory, boolean>;

const STORAGE_KEY = "ccp.sound.prefs";
const DEFAULT_PREFS: SoundPrefs = { messages: true, calls: true, team: true };

/** Min gap between message dings so an inbound burst can't machine-gun. */
const MESSAGE_THROTTLE_MS = 1500;
/** Ring cadence — one ring "cycle" per interval while a call is active. */
const RING_CYCLE_MS = 3200;
/** Output level for both file playback and synth. Deliberately gentle. */
const GAIN = 0.35;

/** First file that decodes wins; otherwise the slot uses synth. */
const SOUND_FILES: Record<SoundCategory, string> = {
  messages: "/sounds/message.mp3",
  calls: "/sounds/ring.mp3",
  // No file shipped yet — falls back to the synth ding, which is the
  // documented hybrid behaviour, not an oversight.
  team: "/sounds/team.mp3",
};

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

class NotificationSoundEngine {
  private prefs: SoundPrefs = { ...DEFAULT_PREFS };
  private prefsLoaded = false;

  private ctx: AudioContext | null = null;
  private unlocked = false;

  // Decoded file buffers: null = not tried yet, false = tried & unavailable
  // (use synth), AudioBuffer = play the file.
  private buffers: Record<SoundCategory, AudioBuffer | null | false> = {
    messages: null,
    calls: null,
    team: null,
  };
  private decoding = false;

  private lastMessageToneAt = 0;
  // Separate throttle clock from customer messages so a busy inbox can't
  // swallow a teammate's DM ding (and vice versa).
  private lastTeamToneAt = 0;

  // Active call ids (ref-counted). The ring loops while this is non-empty so
  // two simultaneous incoming calls = one continuous ring, and it only stops
  // when the last one clears.
  private activeCalls = new Set<string>();
  private ringTimer: ReturnType<typeof setInterval> | null = null;

  // Which conversation is on screen (reported by the inbox). The provider uses
  // it to suppress the ding for the thread you're actively viewing.
  private activeThreadId: string | null = null;

  // ---------------------------------------------------------------- prefs ---

  loadPrefs(): SoundPrefs {
    if (typeof window === "undefined") return { ...this.prefs };
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SoundPrefs>;
        this.prefs = {
          messages:
            typeof parsed.messages === "boolean" ? parsed.messages : DEFAULT_PREFS.messages,
          calls: typeof parsed.calls === "boolean" ? parsed.calls : DEFAULT_PREFS.calls,
          // Parsed per-key, so prefs saved before this category existed load
          // unchanged with `team` defaulting on — no migration needed.
          team: typeof parsed.team === "boolean" ? parsed.team : DEFAULT_PREFS.team,
        };
      }
    } catch {
      // Malformed storage — fall back to defaults already in this.prefs.
    }
    this.prefsLoaded = true;
    return { ...this.prefs };
  }

  /** Re-read from storage (cross-tab `storage` event). Kills the ring if calls
   *  were just muted in another tab. */
  reloadPrefs(): SoundPrefs {
    const wasCallsOn = this.prefs.calls;
    const next = this.loadPrefs();
    if (wasCallsOn && !next.calls) this.stopAllCallRings();
    return next;
  }

  getPrefs(): SoundPrefs {
    if (!this.prefsLoaded) return this.loadPrefs();
    return { ...this.prefs };
  }

  setPrefs(partial: Partial<SoundPrefs>): SoundPrefs {
    this.prefs = { ...this.prefs, ...partial };
    this.prefsLoaded = true;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
      } catch {
        // Private mode / quota — keep the in-memory value, just don't persist.
      }
    }
    if (partial.calls === false) this.stopAllCallRings();
    return { ...this.prefs };
  }

  // -------------------------------------------------------- active thread ---

  setActiveThread(id: string | null): void {
    this.activeThreadId = id;
  }

  getActiveThread(): string | null {
    return this.activeThreadId;
  }

  // ------------------------------------------- unlock + file decode (lazy) ---

  /** Must be called from within a user gesture (browser autoplay policy).
   *  Idempotent. Also kicks off file decode and resumes a pending ring that
   *  arrived before the first gesture. */
  unlock(): void {
    if (typeof window === "undefined") return;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return;
    if (!this.ctx) {
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    this.unlocked = true;
    void this.decodeFiles();
    // A call may have started ringing before the first gesture (timer couldn't
    // start then). Start it now that we're unlocked.
    if (this.activeCalls.size > 0 && this.ringTimer === null && this.getPrefs().calls) {
      this.beginRing();
    }
  }

  private async decodeFiles(): Promise<void> {
    if (!this.ctx || this.decoding) return;
    this.decoding = true;
    try {
      await Promise.all(
        (Object.keys(SOUND_FILES) as SoundCategory[]).map(async (cat) => {
          if (this.buffers[cat] !== null) return; // already decided
          try {
            const res = await fetch(SOUND_FILES[cat], { cache: "force-cache" });
            if (!res.ok) {
              this.buffers[cat] = false; // no file → synth
              return;
            }
            const arr = await res.arrayBuffer();
            this.buffers[cat] = await this.ctx!.decodeAudioData(arr.slice(0));
          } catch {
            this.buffers[cat] = false; // unreachable / undecodable → synth
          }
        }),
      );
    } finally {
      this.decoding = false;
    }
  }

  // ------------------------------------------------------------ emitters ---

  private resumeIfSuspended(): void {
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
  }

  private playBuffer(buf: AudioBuffer): AudioBufferSourceNode | null {
    if (!this.ctx) return null;
    this.resumeIfSuspended();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = GAIN;
    src.connect(gain).connect(this.ctx.destination);
    src.start();
    return src;
  }

  /** Soft two-note "ding" (rising), shaped so it reads as a notification, not
   *  a harsh square-wave beep. */
  private synthDing(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.resumeIfSuspended();
    const now = ctx.currentTime;
    const notes: { f: number; at: number }[] = [
      { f: 880, at: 0 },
      { f: 1318.5, at: 0.09 },
    ];
    for (const { f, at } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const start = now + at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(GAIN, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    }
  }

  /** One ring cycle (two warbled bursts then silence until the next cycle). */
  private synthRingCycle(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.resumeIfSuspended();
    const now = ctx.currentTime;
    const bursts: { start: number; dur: number }[] = [
      { start: 0, dur: 0.4 },
      { start: 0.5, dur: 0.4 },
    ];
    for (const b of bursts) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, now + b.start);
      osc.frequency.setValueAtTime(480, now + b.start + 0.2);
      gain.gain.setValueAtTime(0.0001, now + b.start);
      gain.gain.exponentialRampToValueAtTime(GAIN, now + b.start + 0.02);
      gain.gain.setValueAtTime(GAIN, now + b.start + b.dur - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + b.start + b.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + b.start);
      osc.stop(now + b.start + b.dur + 0.02);
    }
  }

  // -------------------------------------------------------- public plays ---

  /** Fire the new-message ding. Respects the `messages` pref + throttle.
   *  No-op before the first gesture (can't play) — the agent will have clicked
   *  by the time real traffic arrives. */
  playMessageTone(): void {
    if (!this.unlocked || !this.ctx || !this.getPrefs().messages) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this.lastMessageToneAt < MESSAGE_THROTTLE_MS) return;
    this.lastMessageToneAt = now;
    const buf = this.buffers.messages;
    if (buf) this.playBuffer(buf);
    else this.synthDing();
  }

  /** Fire the team-chat ding (a DM or an @-mention). Same throttle window as
   *  customer messages so a burst can't machine-gun. */
  playTeamTone(): void {
    if (!this.unlocked || !this.ctx || !this.getPrefs().team) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this.lastTeamToneAt < MESSAGE_THROTTLE_MS) return;
    this.lastTeamToneAt = now;
    const buf = this.buffers.team;
    if (buf) this.playBuffer(buf);
    else this.synthDing();
  }

  /** One-shot team sound for the settings preview — bypasses pref + throttle. */
  previewTeam(): void {
    if (!this.unlocked || !this.ctx) return;
    const buf = this.buffers.team;
    if (buf) this.playBuffer(buf);
    else this.synthDing();
  }

  /** One-shot message sound for the settings preview — bypasses pref + throttle
   *  (only ever called when the user just enabled it). */
  previewMessage(): void {
    if (!this.unlocked || !this.ctx) return;
    const buf = this.buffers.messages;
    if (buf) this.playBuffer(buf);
    else this.synthDing();
  }

  /** One ring cycle for the settings preview (not the full loop). */
  playCallSample(): void {
    if (!this.unlocked || !this.ctx) return;
    const buf = this.buffers.calls;
    if (buf) {
      const src = this.playBuffer(buf);
      if (src) window.setTimeout(() => stopSource(src), 1200);
    } else {
      this.synthRingCycle();
    }
  }

  // ----------------------------------------------------------- call ring ---

  /** Start (or join) the ring for an incoming call. Ref-counted by callId and
   *  gated by the `calls` pref. */
  startCallRing(callId: string): void {
    if (!this.getPrefs().calls) return;
    this.activeCalls.add(callId);
    if (this.ringTimer !== null) return; // already ringing
    if (!this.unlocked || !this.ctx) return; // unlock() resumes it post-gesture
    this.beginRing();
  }

  stopCallRing(callId: string): void {
    this.activeCalls.delete(callId);
    if (this.activeCalls.size === 0) this.clearRingTimer();
  }

  stopAllCallRings(): void {
    this.activeCalls.clear();
    this.clearRingTimer();
  }

  private beginRing(): void {
    this.ringCycle(); // ring immediately…
    this.ringTimer = setInterval(() => this.ringCycle(), RING_CYCLE_MS); // …then repeat
  }

  private clearRingTimer(): void {
    if (this.ringTimer !== null) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
  }

  private ringCycle(): void {
    if (!this.ctx) return;
    const buf = this.buffers.calls;
    if (buf) {
      const src = this.playBuffer(buf);
      // Cap a long file to the cycle window so cycles never overlap.
      if (src) window.setTimeout(() => stopSource(src), RING_CYCLE_MS - 100);
    } else {
      this.synthRingCycle();
    }
  }
}

function stopSource(src: AudioBufferSourceNode): void {
  try {
    src.stop();
  } catch {
    // Already stopped/ended — fine.
  }
}

export const notificationSound = new NotificationSoundEngine();
