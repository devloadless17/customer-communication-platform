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
 * Format selection:
 *   1. audio/ogg;codecs=opus — Meta's preferred voice-note format, also
 *      what WhatsApp itself uses. Firefox + Chrome 105+ produce this.
 *   2. audio/mp4 — Safari's native MediaRecorder output.
 *   3. audio/webm;codecs=opus — Chrome's older default; if we land here
 *      Meta may transcode or may reject (we let the retry flow handle
 *      that rather than block recording on unsupported browsers).
 *
 * Mic permissions: getUserMedia prompts on first use; subsequent
 * recordings on the same origin reuse the granted permission silently
 * until the user revokes it. A denial surfaces as an error toast via
 * the `onError` callback so the agent knows to flip the browser perm.
 */

const MIME_CANDIDATES = [
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm;codecs=opus",
] as const;

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

  const start = async (): Promise<void> => {
    if (isRecording) return;
    const mime = pickRecorderMime();
    if (!mime) {
      onErrorRef.current(
        "This browser can't record audio. Try Chrome, Firefox, or Safari.",
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
      setDurationSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
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
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        cleanup();
        setIsRecording(false);
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        const mime = mimeRef.current || "audio/ogg";
        const blob = new Blob(chunksRef.current, { type: mime });
        cleanup();
        setIsRecording(false);
        setDurationSec(0);
        setLevels(new Array(28).fill(0));
        if (blob.size === 0) {
          resolve(null);
          return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = new File([blob], `voice-${stamp}.${extForMime(mime)}`, {
          type: mime,
        });
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
        className="size-8 text-destructive hover:bg-destructive/10"
        onClick={onCancel}
        title="Discard recording"
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
        <div className="flex h-6 flex-1 items-center gap-[2px]">
          {levels.map((v, i) => (
            <span
              key={i}
              className={cn(
                "w-[3px] rounded-full bg-foreground/70",
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
        className="size-8 rounded-full"
        onClick={onSend}
        title="Send voice message"
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
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground"
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <Mic className="size-4" />
    </Button>
  );
}
