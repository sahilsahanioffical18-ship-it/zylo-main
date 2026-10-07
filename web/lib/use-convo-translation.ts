'use client';

// The free translation pipeline for Zylo Translator Convo: on-device Translator API
// first, then Google's free translation through our server (/api/translate), with
// MyMemory's free API as the last resort. Verified live, not unit-tested (see
// the plan) — chunking, parsing and the engine chain live in translate-chain.ts,
// which is tested; this hook is just the browser/network glue around it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { SERVER_URL } from '@/lib/api';
import { languageFor } from '@/lib/convo-languages';
import { translatorSupport } from '@/lib/convo-support';
import { chunkForMyMemory, createLru, parseMyMemory, translateVia, type Engine } from '@/lib/translate-chain';

export type PairState = 'checking' | 'ready' | 'downloadable' | 'downloading' | 'unavailable' | 'none';

const DEFAULT_ON_DEVICE_BUDGET_MS = 1500;
const CREATE_TIMEOUT_MS = 8000;
const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;
const MYMEMORY_TIMEOUT_MS = 6000;
const GOOGLE_TIMEOUT_MS = 6000; // the server itself gives Google 5s

function pairKey(from: string, to: string): string {
  return `${from}>${to}`;
}

// Rejects (rather than falling back to a value) so a caller's own try/catch or
// translateVia's per-engine catch treats a timeout exactly like any other failure.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// Dev drill toggle for the acceptance drill ("force quota reached today, showing
// original text") — never set by this app itself, only flipped by hand in DevTools.
function forcedQuotaDrill(): boolean {
  try {
    return localStorage.getItem('zylo.forceQuota') === '1';
  } catch {
    return false;
  }
}

export function useConvoTranslation(opts: { enabled: boolean; pairs: readonly (readonly [string, string])[] }): {
  pairState: (from: string, to: string) => PairState;
  progress: number | null;
  prepare: (from: string, to: string) => Promise<void>;
  translate: (text: string, from: string, to: string, o: { onDeviceOnly: boolean; budgetMs?: number }) => Promise<string | null>;
  quotaReached: boolean;
} {
  const { enabled } = opts;
  const { getToken, isSignedIn } = useAuth();
  const [pairStates, setPairStatesState] = useState<Map<string, PairState>>(new Map());
  const [progress, setProgress] = useState<number | null>(null);
  const [quotaReached, setQuotaReachedState] = useState(false);

  const translatorCache = useRef<Map<string, Translator>>(new Map());
  const resultCache = useRef(createLru<string>(200));
  const quotaReachedRef = useRef(false);
  const downloadsRef = useRef(new Map<string, number>());

  const cacheTranslator = useCallback((key: string, translator: Translator) => {
    translatorCache.current.get(key)?.destroy();
    translatorCache.current.set(key, translator);
  }, []);

  const setPairState = useCallback((key: string, value: PairState) => {
    setPairStatesState((prev) => {
      if (prev.get(key) === value) return prev;
      const next = new Map(prev);
      next.set(key, value);
      return next;
    });
  }, []);

  const pairState = useCallback((from: string, to: string): PairState => pairStates.get(pairKey(from, to)) ?? 'checking', [pairStates]);

  // Content-keyed, not the array reference: `pairs` is naturally a fresh array on
  // most renders (the caller builds it from partner.lang/myLang each time), and
  // this keeps the probe from re-running unless the actual pairs changed. The ref
  // (not opts.pairs directly) is what the effect below reads, so pairsKey alone —
  // not the ever-changing array reference — is what needs to be in its deps.
  const pairsKey = opts.pairs.map(([a, b]) => pairKey(a, b)).join(',');
  const pairsRef = useRef(opts.pairs);
  useEffect(() => {
    pairsRef.current = opts.pairs;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    for (const [from, to] of pairsRef.current) {
      probePair(from, to);
    }

    async function probePair(from: string, to: string) {
      const key = pairKey(from, to);
      const fromDev = languageFor(from)?.onDevice ?? null;
      const toDev = languageFor(to)?.onDevice ?? null;
      const support = await translatorSupport(window, fromDev, toDev); // bounded: PROBE_TIMEOUT_MS
      if (cancelled) return;

      // Captured as a local so TS can narrow it (a `window.X` property access
      // doesn't narrow as reliably as a local const across the `await` above).
      const TranslatorCtor = window.Translator;
      if (support !== 'available' || !fromDev || !toDev || !TranslatorCtor) {
        setPairState(key, support === 'available' ? 'unavailable' : support);
        return;
      }
      try {
        const translator = await withTimeout(TranslatorCtor.create({ sourceLanguage: fromDev, targetLanguage: toDev }), CREATE_TIMEOUT_MS);
        if (cancelled) {
          translator.destroy();
          return;
        }
        cacheTranslator(key, translator);
        setPairState(key, 'ready');
      } catch {
        // Create can throw for reasons other than "needs a download" (e.g.
        // NotAllowedError with no user activation yet) — either way, the download
        // click (prepare()) is the recovery path, so both land on 'downloadable'.
        if (!cancelled) setPairState(key, 'downloadable');
      }
    }

    return () => {
      cancelled = true;
    };
  }, [enabled, pairsKey, setPairState, cacheTranslator]);

  useEffect(
    () => () => {
      for (const t of translatorCache.current.values()) t.destroy();
      translatorCache.current.clear();
    },
    [],
  );

  const prepare = useCallback(
    async (from: string, to: string) => {
      const key = pairKey(from, to);
      const fromDev = languageFor(from)?.onDevice ?? null;
      const toDev = languageFor(to)?.onDevice ?? null;
      const TranslatorCtor = window.Translator;
      if (!fromDev || !toDev || !TranslatorCtor) return;

      // The overall figure is the slowest download still running.
      const report = () => setProgress(downloadsRef.current.size ? Math.min(...downloadsRef.current.values()) : null);
      setPairState(key, 'downloading');
      downloadsRef.current.set(key, 0);
      report();
      try {
        const translator = await withTimeout(
          TranslatorCtor.create({
            sourceLanguage: fromDev,
            targetLanguage: toDev,
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                downloadsRef.current.set(key, e.loaded);
                report();
              });
            },
          }),
          PREPARE_TIMEOUT_MS,
        );
        cacheTranslator(key, translator);
        setPairState(key, 'ready');
      } catch {
        setPairState(key, 'downloadable');
      } finally {
        downloadsRef.current.delete(key);
        report();
      }
    },
    [setPairState, cacheTranslator],
  );

  // Google via our server: signed-in only (the route needs a user), so the public
  // device check falls straight through to MyMemory. null on any failure.
  const googleEngine = useCallback(
    async (text: string, from: string, to: string): Promise<string | null> => {
      if (!isSignedIn) return null;
      const token = await getToken();
      const res = await fetch(`${SERVER_URL}/api/translate?${new URLSearchParams({ from, to, text })}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { text?: unknown };
      return typeof body.text === 'string' && body.text.trim() ? body.text : null;
    },
    [getToken, isSignedIn],
  );

  const myMemoryEngine = useCallback(async (text: string, from: string, to: string): Promise<string | null> => {
    if (quotaReachedRef.current) return null;
    if (forcedQuotaDrill()) {
      quotaReachedRef.current = true;
      setQuotaReachedState(true);
      return null;
    }
    const fromMM = languageFor(from)?.mymemory ?? from;
    const toMM = languageFor(to)?.mymemory ?? to;
    const chunks = chunkForMyMemory(text);
    if (chunks.length === 0) return null;

    const parts: string[] = [];
    for (const chunk of chunks) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MYMEMORY_TIMEOUT_MS);
      let json: unknown;
      try {
        const email = process.env.NEXT_PUBLIC_MYMEMORY_EMAIL;
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${fromMM}|${toMM}${email ? `&de=${encodeURIComponent(email)}` : ''}`;
        const res = await fetch(url, { signal: controller.signal });
        json = await res.json();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
      const parsed = parseMyMemory(json);
      if ('quota' in parsed) {
        quotaReachedRef.current = true;
        setQuotaReachedState(true);
        return null;
      }
      if ('error' in parsed) return null;
      parts.push(parsed.text);
    }
    return parts.join(' ');
  }, []);

  const translate = useCallback(
    async (text: string, from: string, to: string, o: { onDeviceOnly: boolean; budgetMs?: number }): Promise<string | null> => {
      const cacheKey = `${from}|${to}|${text}`;
      const cached = resultCache.current.get(cacheKey);
      if (cached !== undefined) return cached;

      const budgetMs = o.budgetMs ?? DEFAULT_ON_DEVICE_BUDGET_MS;
      const engines: Engine[] = [
        async (t, f, tt) => {
          const translator = translatorCache.current.get(pairKey(f, tt));
          if (!translator) return null;
          return withTimeout(translator.translate(t), budgetMs);
        },
      ];
      if (!o.onDeviceOnly) engines.push(googleEngine, myMemoryEngine);

      const result = await translateVia(engines, text, from, to);
      if ('failed' in result) return null;
      resultCache.current.set(cacheKey, result.text);
      return result.text;
    },
    [googleEngine, myMemoryEngine],
  );

  return { pairState, progress, prepare, translate, quotaReached };
}
