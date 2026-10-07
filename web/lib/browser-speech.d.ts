// Ambient types for browser APIs this TypeScript's lib.dom doesn't declare yet:
// SpeechRecognition (plus Chrome's on-device `available`/`install` statics),
// SpeechRecognitionEvent/ErrorEvent, and the Translator API. lib.dom.d.ts
// already declares SpeechRecognitionResultList, SpeechSynthesisVoice and the
// global speechSynthesis, so those are reused rather than redeclared here.
//
// ponytail: hand-rolled from MDN/Chrome's own docs, not a published spec
// package — narrowed to exactly what convo-support.ts and convo-checklist.tsx
// call. Upgrade to @types/dom-speech-recognition (or whatever TS ships once
// these APIs stabilize) if this drifts from the real surface.

export {};

declare global {
  type SpeechAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

  interface SpeechRecognition extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    processLocally?: boolean;
    start(track?: MediaStreamTrack): void;
    stop(): void;
    abort(): void;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
    onend: ((event: Event) => void) | null;
    onstart: ((event: Event) => void) | null;
  }

  interface SpeechRecognitionStatic {
    new (): SpeechRecognition;
    prototype: SpeechRecognition;
    available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<SpeechAvailability>;
    install?: (opts: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
  }

  interface SpeechRecognitionEvent extends Event {
    readonly results: SpeechRecognitionResultList;
    // The lowest index in `results` this event actually changed — onresult only
    // has to walk from here, not re-process every result from 0 each time.
    readonly resultIndex: number;
  }

  interface SpeechRecognitionErrorEvent extends Event {
    readonly error: string;
  }

  interface TranslatorDownloadProgressEvent extends Event {
    readonly loaded: number;
  }

  interface TranslatorMonitor extends EventTarget {
    addEventListener(type: 'downloadprogress', listener: (event: TranslatorDownloadProgressEvent) => void): void;
  }

  interface Translator {
    translate(text: string): Promise<string>;
    destroy(): void;
  }

  interface TranslatorStatic {
    availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<SpeechAvailability>;
    create(opts: { sourceLanguage: string; targetLanguage: string; monitor?: (m: TranslatorMonitor) => void }): Promise<Translator>;
  }

  interface Window {
    SpeechRecognition?: SpeechRecognitionStatic;
    webkitSpeechRecognition?: SpeechRecognitionStatic;
    Translator?: TranslatorStatic;
  }
}
