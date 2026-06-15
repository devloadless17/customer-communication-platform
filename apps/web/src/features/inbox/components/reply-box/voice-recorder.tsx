"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Send, Trash2 } from "lucide-react";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { cn } from "@ccp/shared/utils";

/**
 * Voice-message recorder (WhatsApp-style). The composer's mic button
 * mounts <RecordingBar> in place of the toolbar; the bar shows a live
 * mic-level visualizer + mm:ss timer, and Cancel / Send buttons. On
 * Send, the recorder yields a File that goes through the normal media
 * upload path — server doesn't know it was recorded inline.
 *
 * Format selection (Meta-acceptable only — see lessons below):
 *   1. audio/ogg;codecs=opus — Meta's preferred voice-note format, also
 *      what WhatsApp itself uses. Firefox + Chrome 105+ produce this.
 *   2. audio/mp4 — Safari's native MediaRecorder output.
 *
 * `audio/webm` is INTENTIONALLY NOT a fallback. Chrome's older default
 * was webm, but Meta's `sendMedia` endpoint rejects audio/webm at the
 * provider edge AFTER an apparently-successful upload, producing a
 * confusing `provider_rejected` with no actionable message at the
 * agent. If neither ogg/opus nor mp4 is supported (very old Chrome /
 * Edge), the recorder refuses to start and surfaces a clear error
 * instead of producing a file the user can't actually send.
 *
 * Mic permissions: getUserMedia prompts on first use; subsequent
 * recordings on the same origin reuse the granted permission silently
 * until the user revokes it. A denial surfaces as an error toast via
 * the `onError` callback so the agent knows to flip the browser perm.
 */

const MIME_CANDIDATES = [
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/**
 * Hard cap on recording length. Without it `durationSec` ticks forever, the
 * agent walks away mid-record, and the eventual multi-minute blob only fails
 * the size check AFTER a slow upload. At the cap we auto-STOP capture cleanly
 * (we never auto-send — an irreversible Meta send must be a deliberate click);
 * the captured clip stays recoverable via `stopAndCollect`, so the user can
 * still hit Send (or Cancel) on the bar.
 */
const MAX_RECORDING_SEC = 300; // 5 minutes
/** Show the remaining-time countdown in the bar once within this window. */
const COUNTDOWN_FROM_SEC = 15;

function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // isTypeSupported throws on some Safari builds — keep iterating.
    }
  }
  return null;
}

function extForMime(mime: string): string {
  if (mime.startsWith("audio/ogg")) return "ogg";
  if (mime.startsWith("audio/mp4")) return "m4a";
  if (mime.startsWith("audio/webm")) return "webm";
  return "audio";
}

interface VoiceRecorderHandle {
  start: () => Promise<void>;
  stopAndCollect: () => Promise<File | null>;
  cancel: () => void;
  isRecording: boolean;
  durationSec: number;
  levels: number[];
}

/**
 * Hook that owns the MediaRecorder + AudioContext analyser. Returns a
 * stable handle the caller can wire to mic-button + send/cancel UI.
 */
export function useVoiceRecorder(opts: {
  onError: (message: string) => void;
}): VoiceRecorderHandle {
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  const [isRecording, setIsRecording] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => new Array(28).fill(0));

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  // Holds the File finalized when the cap auto-stops capture, so a later
  // `stopAndCollect()` returns the captured audio instead of the empty
  // already-inactive recorder. Cleared on cancel / fresh start / cleanup.
  const cappedFileRef = useRef<File | null>(null);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mimeRef = useRef<string>("");

  const cleanup = () => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  };

  // Build a File from the current chunks using the active mime. Shared by the
  // cap auto-stop and `stopAndCollect`'s onstop so the naming/format is
  // identical regardless of which path finalized the recording.
  const buildFile = (): File | null => {
    const mime = mimeRef.current || "audio/ogg";
    const blob = new Blob(chunksRef.current, { type: mime });
    if (blob.size === 0) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([blob], `voice-${stamp}.${extForMime(mime)}`, {
      type: mime,
    });
  };

  // Stop any in-flight recording when the host unmounts (chat switch
  // mid-record). Without this the mic tracks stay hot in the background.
  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.stop();
      } catch {
        // already inactive
      }
      cleanup();
    };
  }, []);

  // Auto-stop when MAX_RECORDING_SEC is hit. Stops mic capture + the timer/raf
  // loops but leaves `isRecording` true so the bar stays up; the finalized clip
  // lands in `cappedFileRef` for `stopAndCollect()` to return. NEVER auto-sends.
  const finalizeAtCap = (): void => {
    // Freeze the timer so it doesn't re-enter this on the next 250ms tick.
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.onstop = () => {
      // Build the File BEFORE cleanup wipes the chunks, then keep stream/ctx
      // torn down (cleanup) but preserve the captured File for collection.
      cappedFileRef.current = buildFile();
      cleanup();
    };
    try {
      recorder.stop();
    } catch {
      // already inactive — nothing to finalize
    }
    onErrorRef.current("Max voice length reached (5:00) — send or discard.");
  };

  const start = async (): Promise<void> => {
    if (isRecording) return;
    const mime = pickRecorderMime();
    if (!mime) {
      onErrorRef.current(
        "This browser can't record in a WhatsApp-compatible audio format. " +
          "Please update to a recent Chrome (105+), Firefox, or Safari.",
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      onErrorRef.current("Microphone API unavailable in this browser.");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const message =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Microphone permission denied. Enable it in the browser address bar to record voice messages."
          : name === "NotFoundError"
            ? "No microphone found on this device."
            : "Couldn't access the microphone.";
      onErrorRef.current(message);
      return;
    }

    streamRef.current = stream;
    mimeRef.current = mime;
    chunksRef.current = [];
    cappedFileRef.current = null;

    // Live mic-level meter via WebAudio analyser. We sample RMS at
    // ~30Hz and shift it into a fixed-length ring so the bars animate
    // left-to-right like WhatsApp's recording UI. Cheaper than a real
    // FFT visualizer and visually indistinguishable at this size.
    const AudioCtxCtor: typeof AudioContext | undefined =
      typeof window !== "undefined"
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext)
        : undefined;
    if (AudioCtxCtor) {
      try {
        const ctx = new AudioCtxCtor();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const loop = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i]! - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          // Slight non-linearity so quiet speech still moves the bar
          // visibly without making loud peaks look the same as moderate
          // speech.
          const norm = Math.min(1, Math.pow(rms * 2.4, 0.6));
          setLevels((prev) => {
            const next = prev.slice(1);
            next.push(norm);
            return next;
          });
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      } catch {
        // Analyser failure is non-fatal — the bar just stays flat.
      }
    }

    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setDurationSec(0);
    tickRef.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      if (elapsed >= MAX_RECORDING_SEC) {
        // Clamp the displayed timer at the cap and auto-stop capture. We DON'T
        // auto-send — the finalized clip is stashed so the user still chooses
        // Send or Discard on the bar.
        setDurationSec(MAX_RECORDING_SEC);
        finalizeAtCap();
        return;
      }
      setDurationSec(elapsed);
    }, 250);

    try {
      recorder.start(250);
    } catch (err) {
      cleanup();
      onErrorRef.current(
        err instanceof Error ? err.message : "Couldn't start recording.",
      );
      return;
    }
    setIsRecording(true);
  };

  const stopAndCollect = (): Promise<File | null> => {
    return new Promise((resolve) => {
      // If the cap already finalized the recording, hand back the stashed clip.
      if (cappedFileRef.current) {
        const file = cappedFileRef.current;
        cappedFileRef.current = null;
        cleanup();
        setIsRecording(false);
        setDurationSec(0);
        setLevels(new Array(28).fill(0));
        resolve(file);
        return;
      }
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        cleanup();
        setIsRecording(false);
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        const file = buildFile();
        cleanup();
        setIsRecording(false);
        setDurationSec(0);
        setLevels(new Array(28).fill(0));
        resolve(file);
      };
      try {
        recorder.stop();
      } catch {
        cleanup();
        setIsRecording(false);
        resolve(null);
      }
    });
  };

  const cancel = (): void => {
    // Drop any clip the cap may have finalized.
    cappedFileRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // Drop the data on the floor by clearing chunks BEFORE stop fires.
      recorder.onstop = () => {
        cleanup();
        setIsRecording(false);
        setDurationSec(0);
        setLevels(new Array(28).fill(0));
      };
      chunksRef.current = [];
      try {
        recorder.stop();
      } catch {
        cleanup();
        setIsRecording(false);
        setDurationSec(0);
        setLevels(new Array(28).fill(0));
      }
      return;
    }
    cleanup();
    setIsRecording(false);
    setDurationSec(0);
    setLevels(new Array(28).fill(0));
  };

  return { start, stopAndCollect, cancel, isRecording, durationSec, levels };
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Inline recording bar — replaces the composer toolbar while a
 * recording is in progress.
 */
export function RecordingBar({
  durationSec,
  levels,
  onCancel,
  onSend,
}: {
  durationSec: number;
  levels: number[];
  onCancel: () => void;
  onSend: () => void;
}) {
  // Countdown shown only in the final stretch so the cap auto-stop isn't a
  // surprise. `remaining` clamps at 0; the hook stops capture at the cap.
  const remaining = Math.max(0, MAX_RECORDING_SEC - durationSec);
  const showCountdown = remaining <= COUNTDOWN_FROM_SEC;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-3 px-2 pb-2 pt-1"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 pointer-coarse:size-9 text-destructive hover:bg-destructive/10"
        onClick={onCancel}
        title="Discard recording"
        aria-label="Discard recording"
      >
        <Trash2 className="size-4" />
      </Button>

      <div className="flex flex-1 items-center gap-2 rounded-full bg-muted/60 px-3 py-1.5">
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-destructive" />
        </span>
        <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-foreground">
          {formatDuration(durationSec)}
        </span>
        {showCountdown && (
          <span
            className="shrink-0 font-mono text-xs tabular-nums text-destructive"
            aria-live="polite"
            title="Time remaining before the recording auto-stops"
          >
            -0:{remaining.toString().padStart(2, "0")}
          </span>
        )}
        <div className="flex h-6 flex-1 items-center gap-0.5">
          {levels.map((v, i) => (
            <span
              key={i}
              className={cn(
                "w-.75 rounded-full bg-foreground/70",
                "transition-[height] duration-75",
              )}
              style={{ height: `${Math.max(8, v * 100)}%` }}
            />
          ))}
        </div>
      </div>

      <Button
        type="button"
        size="icon"
        className="size-8 pointer-coarse:size-9 rounded-full"
        onClick={onSend}
        title="Send voice message"
        aria-label="Send voice message"
      >
        <Send className="size-4" />
      </Button>
    </motion.div>
  );
}

/**
 * Microphone trigger button for the toolbar. Stays a plain icon button
 * to match the surrounding chrome (paperclip / sparkles / smile).
 */
export function MicButton({
  onClick,
  disabled,
  title,
  ariaLabel,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  /** Concise accessible name (the `title` may carry contextual disabled copy
   *  that's too verbose as an a11y name). Falls back to `title`. */
  ariaLabel?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 pointer-coarse:size-9 text-muted-foreground"
      type="button"
      disabled={disabled}
      aria-label={ariaLabel ?? title}
      title={title}
      onClick={onClick}
    >
      <Mic className="size-4" />
    </Button>
  );
}
