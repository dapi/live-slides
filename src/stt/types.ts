export type SttState = "idle" | "connecting" | "ready" | "error";

export interface SttEvents {
  /** Text of the phrase still being spoken; replaces the previous partial. */
  onPartial(text: string): void;
  /** A finished phrase. */
  onFinal(text: string): void;
  onState(state: SttState, detail?: string): void;
}

export interface SttEngine {
  readonly name: string;
  start(): Promise<void>;
  /** 16 kHz mono signed 16-bit little-endian PCM. */
  push(pcm: Uint8Array): void;
  stop(): Promise<void>;
}
