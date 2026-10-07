'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AI_FAILED_TEXT, AI_NAME, NUDGE_CAPTION, type AiAnswer, type ChatItem, type PersonMessage } from '@/lib/ai-chat';
import { brand } from '@/lib/brand';
import { MAX_CHAT_LENGTH, validateChatText } from '@/lib/chat-rules';

// Counter only shows once someone is close to the ceiling — no need to clutter the
// composer for the other 95% of messages.
const SHOW_COUNTER_AT = MAX_CHAT_LENGTH - 100;

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function Bubble({ message, own }: { message: PersonMessage; own: boolean }) {
  return (
    <li className={cn('flex', own ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
          // Not --secondary: that indigo tint is Zylo AI's (AnswerBubble).
          own ? 'bg-muted' : 'border border-border',
        )}
      >
        {!own && <p className="text-xs font-semibold">{message.name}</p>}
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
        <p className="mt-1 flex justify-end gap-2 text-[10px] text-muted-foreground tabular-nums">
          {message.toAi && <span>→ {AI_NAME}</span>}
          <span>{timeOf(message.ts)}</span>
        </p>
      </div>
    </li>
  );
}

// Plain text only, never Markdown or HTML, so an answer can't inject anything. Not a
// live region while it streams (a reader would hear every piece): the panel announces
// the finished answer once instead. A nudge is the same bubble, with why it spoke above
// the text.
function AnswerBubble({ answer }: { answer: AiAnswer }) {
  return (
    <li className="flex justify-start">
      <div className="max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">
        <p className="flex items-center gap-1 text-xs font-semibold">
          <Sparkles className="size-3" aria-hidden="true" />
          {AI_NAME}
        </p>
        {answer.nudge && <p className="text-[11px] opacity-70">{NUDGE_CAPTION[answer.nudge]}</p>}
        {answer.status === 'thinking' && (
          <p>
            Thinking<span className="animate-pulse motion-reduce:animate-none">…</span>
          </p>
        )}
        {(answer.status === 'streaming' || answer.status === 'done') && (
          <p className="whitespace-pre-wrap break-words">
            {answer.text}
            {answer.status === 'streaming' && (
              <span aria-hidden="true" className="ml-0.5 animate-pulse motion-reduce:animate-none">
                ▍
              </span>
            )}
          </p>
        )}
        {/* --destructive (#dc2626) is unreadable on the indigo bubble; these read as a muted red on it. */}
        {answer.status === 'failed' && <p className="text-red-800 dark:text-red-200">{AI_FAILED_TEXT}</p>}
        <p className="mt-1 text-right text-[10px] tabular-nums opacity-70">{timeOf(answer.ts)}</p>
      </div>
    </li>
  );
}

export function ChatPanel({
  messages,
  selfUserId,
  onSend,
  ai,
}: {
  messages: ChatItem[];
  selfUserId: string;
  onSend: (text: string) => void;
  // Absent in Translator Convo: no Ask AI there. blockedReason: why it's off, or null.
  ai?: { onAsk: (text: string) => void; blockedReason: string | null };
}) {
  const [draft, setDraft] = useState('');
  // Phones have no hover for the tooltip, so tapping a blocked Ask AI says why under the box.
  const [showWhy, setShowWhy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tail = messages.at(-1);

  // DOM write, not a setState — lint-clean under react-hooks/set-state-in-effect. Keyed
  // on the last item, so a streaming answer stays in view as it grows. "Near the bottom"
  // (within 120 px) is judged against the height before this item grew the list: a reader
  // who scrolled up isn't pulled back by a chunk, but a new message, a question or a fresh
  // "Thinking…" always scrolls. Instant, not smooth, while an answer is the tail.
  const lastHeight = useRef(0);
  useEffect(() => {
    const viewport = containerRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const wasNear = lastHeight.current - viewport.scrollTop - viewport.clientHeight <= 120;
    lastHeight.current = viewport.scrollHeight;
    if (tail?.kind === 'ai' && tail.status !== 'thinking' && !wasNear) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduceMotion || tail?.kind === 'ai' ? 'auto' : 'smooth' });
  }, [tail]);

  function send() {
    if (validateChatText(draft) === null) return;
    onSend(draft);
    setDraft('');
  }

  function ask() {
    if (!ai) return;
    if (ai.blockedReason) {
      setShowWhy(true);
      return;
    }
    if (validateChatText(draft) === null) return;
    ai.onAsk(draft);
    setDraft('');
  }

  const disabled = validateChatText(draft) === null;
  const blocked = ai?.blockedReason ?? null;
  // The newest finished answer, announced once by the live region below.
  const lastAnswer = messages.findLast(
    (m): m is AiAnswer => m.kind === 'ai' && (m.status === 'done' || m.status === 'failed'),
  );
  const announcement = !lastAnswer
    ? ''
    : lastAnswer.status === 'done'
      ? `${AI_NAME}${lastAnswer.nudge ? `, ${NUDGE_CAPTION[lastAnswer.nudge]}` : ''}: ${lastAnswer.text}`
      : AI_FAILED_TEXT;

  return (
    <div className="flex h-full flex-col gap-3">
      <div ref={containerRef} className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <p role="status" className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            No messages yet. {brand.chat} isn&apos;t saved, so messages disappear when the meeting ends.
          </p>
        ) : (
          <ScrollArea className="h-full">
            <ul className="space-y-2 pr-3">
              {messages.map((item, i) =>
                item.kind === 'ai' ? (
                  <AnswerBubble key={item.id} answer={item} />
                ) : (
                  <Bubble key={`${item.userId}-${item.ts}-${i}`} message={item} own={item.userId === selfUserId} />
                ),
              )}
            </ul>
          </ScrollArea>
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="flex flex-col gap-1.5">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          maxLength={MAX_CHAT_LENGTH}
          placeholder={`Message ${brand.chat}`}
          aria-label={brand.chat}
          className="max-h-32 resize-none"
        />
        <div className="flex items-center justify-end gap-2">
          {draft.length > SHOW_COUNTER_AT && (
            <span className="mr-auto text-xs tabular-nums text-muted-foreground">
              {draft.length}/{MAX_CHAT_LENGTH}
            </span>
          )}
          {/* aria-disabled, not disabled, while blocked: a disabled button gets no hover
              (no tooltip) and no tap (no reason line). */}
          {ai && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={ask}
                  aria-disabled={blocked ? true : undefined}
                  disabled={!blocked && disabled}
                  className={blocked ? 'opacity-50' : undefined}
                >
                  <Sparkles aria-hidden="true" />
                  Ask AI
                </Button>
              </TooltipTrigger>
              {blocked && <TooltipContent>{blocked}</TooltipContent>}
            </Tooltip>
          )}
          <Button type="button" size="sm" onClick={send} disabled={disabled}>
            Send
          </Button>
        </div>
        {blocked && showWhy && (
          <p role="status" className="text-xs text-muted-foreground">
            {blocked}
          </p>
        )}
      </div>
    </div>
  );
}
