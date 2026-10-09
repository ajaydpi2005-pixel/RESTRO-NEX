"use client";

/**
 * Phase 11 — kitchen alert sounds (Web Audio, no audio files).
 *
 * Browsers only allow audio after a user gesture, so the board starts silent
 * and `unlockSound()` must be called from a click handler first.
 */

let context: AudioContext | null = null;

export function unlockSound(): boolean {
  if (typeof window === "undefined") return false;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return false;
  context ??= new Ctor();
  if (context.state === "suspended") void context.resume();
  return true;
}

function tone(ctx: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.4, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

/** Two rising tones: a new ticket arrived. */
export function playNewTicket(): void {
  if (!context || context.state !== "running") return;
  const now = context.currentTime;
  tone(context, 740, now, 0.18);
  tone(context, 988, now + 0.2, 0.25);
}

/** Three short beeps: an order or item was cancelled or removed. */
export function playCancelled(): void {
  if (!context || context.state !== "running") return;
  const now = context.currentTime;
  tone(context, 620, now, 0.15);
  tone(context, 620, now + 0.22, 0.15);
  tone(context, 620, now + 0.44, 0.2);
}
