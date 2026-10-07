// ZyloChat's list: people's messages, Zylo AI's answers and its nudges in arrival order,
// the reducer that applies the server's ai:* events to it, and the stall rule. Zero local
// imports, free of React and the DOM, so node --test can run it alone (see
// caption-feed.ts).

export type PersonMessage = {
  kind: 'person';
  userId: string;
  name: string;
  text: string;
  ts: number;
  toAi?: boolean; // a question to Zylo AI, tagged "→ Zylo AI"
};

export type AiStatus = 'thinking' | 'streaming' | 'done' | 'failed';

// Why Zylo AI spoke up unasked (server/lib/nudge.js).
export type NudgeReason = 'quiet' | 'stuck' | 'circles';

export type AiAnswer = {
  kind: 'ai';
  id: string;
  askedBy: { userId: string; name: string } | null; // null for a nudge: nobody asked
  text: string;
  status: AiStatus;
  ts: number;
  // This browser's clock at the last ai:start or ai:chunk; the stall rule reads it.
  heardAt: number;
  nudge?: NudgeReason; // set on a nudge, which arrives whole
};

export type ChatItem = PersonMessage | AiAnswer;

// The server's events, as use-meeting.ts hands them over.
export type AiEvent =
  | { type: 'start'; id: string; askedBy: { userId: string; name: string }; ts: number }
  | { type: 'chunk'; id: string; delta: string }
  | { type: 'done'; id: string; text: string }
  | { type: 'failed'; id: string }
  | { type: 'nudge'; id: string; text: string; reason: NudgeReason; ts: number };

export type AiErrorReason = 'disabled' | 'not_configured';

export const AI_NAME = 'Zylo AI';
export const AI_FAILED_TEXT = 'The AI couldn’t answer. Try again.';
export const AI_ERROR_TEXT: Record<AiErrorReason, string> = {
  not_configured: 'AI isn’t set up on this server.',
  disabled: 'The host turned AI off.',
};
// The line above a nudge, saying why Zylo AI spoke up.
export const NUDGE_CAPTION: Record<NudgeReason, string> = {
  quiet: 'AI noticed: quiet for a while',
  stuck: 'AI noticed: someone said they’re stuck',
  circles: 'AI noticed: the chat is going in circles',
};

// ponytail: keep the last 200 in memory; nothing is stored anyway, so scrollback has a
// floor. Raise it or virtualise if a long meeting ever loses history people wanted.
export const MAX_CHAT_ITEMS = 200;

// An answer streams from the asker's server; if that server dies mid-answer nothing
// more ever arrives, so a bubble that hears nothing for this long fails on its own.
export const AI_STALL_MS = 45_000;

// While nudges are on, the browser tells the server its own person spoke (the quiet
// clock) at most this often: the fact only, never audio or text.
export const SPEECH_REPORT_MS = 10_000;

const answering = (item: ChatItem): item is AiAnswer =>
  item.kind === 'ai' && (item.status === 'thinking' || item.status === 'streaming');

const stalled = (item: ChatItem, now: number): item is AiAnswer => answering(item) && now - item.heardAt >= AI_STALL_MS;

const capped = (items: ChatItem[]): ChatItem[] => items.slice(-MAX_CHAT_ITEMS);

export function addMessage(items: ChatItem[], message: Omit<PersonMessage, 'kind'>): ChatItem[] {
  return capped([...items, { ...message, kind: 'person' }]);
}

function advance(answer: AiAnswer, event: Exclude<AiEvent, { type: 'start' } | { type: 'nudge' }>, now: number): AiAnswer {
  if (event.type === 'chunk') {
    if (!answering(answer)) return answer; // finished or failed: no more pieces
    return { ...answer, text: answer.text + event.delta, status: 'streaming', heardAt: now };
  }
  // The full text always wins over the pieces, even after the stall rule gave up on it.
  if (event.type === 'done') return answer.status === 'done' ? answer : { ...answer, text: event.text, status: 'done' };
  return answering(answer) ? { ...answer, status: 'failed' } : answer;
}

// Applies one ai:* event. Hands back `items` itself when nothing changes, so React skips
// the render: a repeated start or nudge, pieces after the answer finished, and any event
// for an answer this list never saw start (we joined mid-answer, or it scrolled out).
export function applyAi(items: ChatItem[], event: AiEvent, now: number): ChatItem[] {
  const index = items.findIndex((item) => item.kind === 'ai' && item.id === event.id);
  if (event.type === 'start') {
    if (index !== -1) return items;
    const { id, askedBy, ts } = event;
    return capped([...items, { kind: 'ai', id, askedBy, text: '', status: 'thinking', ts, heardAt: now }]);
  }
  // A nudge arrives whole: a finished answer nobody asked for, carrying why.
  if (event.type === 'nudge') {
    if (index !== -1) return items;
    const { id, text, reason, ts } = event;
    return capped([...items, { kind: 'ai', id, askedBy: null, text, status: 'done', ts, heardAt: now, nudge: reason }]);
  }
  if (index === -1) return items;
  const answer = items[index] as AiAnswer;
  const next = advance(answer, event, now);
  return next === answer ? items : items.map((item, i) => (i === index ? next : item));
}

// The stall rule. Hands back `items` itself when nothing stalled.
export function failStalled(items: ChatItem[], now: number): ChatItem[] {
  if (!items.some((item) => stalled(item, now))) return items;
  return items.map((item): ChatItem => (stalled(item, now) ? { ...item, status: 'failed' } : item));
}

// Answers that finished since the last call, each handed out once: `seen` keeps their ids.
export function newlyDone(items: ChatItem[], seen: Set<string>): AiAnswer[] {
  const fresh = items.filter((item): item is AiAnswer => item.kind === 'ai' && item.status === 'done' && !seen.has(item.id));
  for (const answer of fresh) seen.add(answer.id);
  return fresh;
}

// Whether to tell the server our person spoke, given when we last did.
export const shouldReportSpeech = (lastAt: number, now: number): boolean => now - lastAt >= SPEECH_REPORT_MS;

// Why Ask AI can't be used right now, or null when it can.
export function askAiBlocked(aiAvailable: boolean, aiEnabled: boolean): string | null {
  if (!aiAvailable) return AI_ERROR_TEXT.not_configured;
  if (!aiEnabled) return AI_ERROR_TEXT.disabled;
  return null;
}
