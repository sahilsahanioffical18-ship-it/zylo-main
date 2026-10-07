// Zylo AI: any OpenAI-compatible chat API (xAI's Grok, NVIDIA's hosted models), chosen
// in .env. Plain fetch, no SDK; the answer streams back as server-sent events.

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const MAX_TOKENS = 600;
const TIMEOUT_MS = 30_000;
const MAX_LINE = 500;

const SYSTEM_PROMPT = [
  'You are Zylo AI, a shared assistant inside a live video meeting.',
  'Everyone in the meeting sees your reply at the same time.',
  'Answer in plain, short, concrete language — a few sentences or a short list.',
  'You only see the chat text below; you cannot hear the call or see video, so never claim to.',
  "When participants disagree, don't declare a winner unless it's a verifiable fact; instead, name the specific point their views actually differ on, so the group can settle it themselves.",
].join(' ');

// The chat so far as one transcript, oldest first, "Name: text" per line (answers are
// "Zylo AI: ..."), then the question if there is one (a nudge has none). Whitespace runs
// in a name or a message become one space, so neither can fake a line from someone else.
// Earlier lines are cut to 500 characters (an emoji cut in half becomes U+FFFD, never a
// lone surrogate); the question (at most 2,000, the chat rule) is kept whole.
function promptFor(history, question = null) {
  const flat = (value) => value.replace(/\s+/g, ' ').trim();
  const line = ({ name, text }) => `${flat(name)}: ${flat(text)}`;
  const lines = history.map((entry) => line(entry).slice(0, MAX_LINE));
  if (question) lines.push(line(question));
  return [{ role: 'user', content: lines.join('\n').toWellFormed() }];
}

// One server-sent line: the answer text it adds, '' for anything to skip, null at
// [DONE]. Heartbeats carry an empty or missing choices array (reading choices[0] off
// those is the classic crash); reasoning models add reasoning_content, never shown.
function contentOf(line) {
  if (!line.startsWith('data:')) return '';
  const data = line.slice(5).trim();
  if (data === '[DONE]') return null;
  try {
    const content = JSON.parse(data)?.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

// An answer with no text is a failure, never something to show.
function answerOf(text) {
  if (!text.trim()) throw new Error('AI provider sent an empty answer');
  return text;
}

// null when not configured: both a key and a model are needed. There is no default
// model on purpose: older Grok names silently bill at flagship rates.
function createAi({ baseUrl, apiKey, model, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!apiKey || !model) return null;
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;

  // Resolves to the whole answer once the stream ends; onDelta gets each piece on the
  // way. The timeout covers the whole answer, not just the first byte. system and
  // maxTokens default to Ask AI's; a nudge passes its own.
  async function stream({ messages, onDelta = () => {}, signal, system = SYSTEM_PROMPT, maxTokens = MAX_TOKENS }) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) throw new Error(`AI provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const decoder = new TextDecoder();
    let buffered = '';
    let full = '';
    for await (const bytes of res.body) {
      const lines = (buffered + decoder.decode(bytes, { stream: true })).split('\n');
      buffered = lines.pop(); // a line still arriving
      for (const line of lines) {
        const piece = contentOf(line);
        if (piece === null) return answerOf(full);
        if (!piece) continue;
        full += piece;
        onDelta(piece);
      }
    }
    return answerOf(full);
  }

  return { model, stream };
}

module.exports = { createAi, promptFor, SYSTEM_PROMPT };
