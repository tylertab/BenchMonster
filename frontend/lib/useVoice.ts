"use client";

import { useCallback, useRef, useState } from "react";
import { api } from "./api";

export type VoiceState = "idle" | "recording" | "thinking" | "speaking";

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** Push-to-talk recording plus reply playback via ElevenLabs TTS. */
export function useVoice() {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => stream.getTracks().forEach((t) => t.stop());
      (rec as MediaRecorder & { chunks: Blob[] }).chunks = chunks;
      rec.start();
      recorder.current = rec;
      setState("recording");
    } catch {
      setError("Microphone unavailable. Check browser permissions.");
    }
  }, []);

  /** Stops recording and resolves with the clip. */
  const stop = useCallback(
    () =>
      new Promise<Blob | null>((resolve) => {
        const rec = recorder.current as (MediaRecorder & { chunks: Blob[] }) | null;
        if (!rec) return resolve(null);
        rec.addEventListener(
          "stop",
          () => {
            recorder.current = null;
            setState("thinking");
            resolve(rec.chunks.length ? new Blob(rec.chunks, { type: rec.mimeType }) : null);
          },
          { once: true },
        );
        rec.stop();
      }),
    [],
  );

  const stopSpeaking = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setState("idle");
  }, []);

  const speak = useCallback(async (text: string) => {
    try {
      setState("speaking");
      const url = await api.tts(text);
      const el = new Audio(url);
      audio.current = el;
      el.onended = () => {
        URL.revokeObjectURL(url);
        if (audio.current === el) setState("idle");
      };
      await el.play();
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  }, []);

  return { state, setState, error, setError, start, stop, speak, stopSpeaking };
}
