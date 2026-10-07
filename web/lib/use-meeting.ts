'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import {
  AI_ERROR_TEXT,
  addMessage,
  applyAi,
  failStalled,
  shouldReportSpeech,
  type AiErrorReason,
  type AiEvent,
  type ChatItem,
  type NudgeReason,
  type PersonMessage,
} from '@/lib/ai-chat';
import { SERVER_URL } from '@/lib/api';
import { brand } from '@/lib/brand';
import { validateChatText } from '@/lib/chat-rules';
import { connectRetryDelay, joinRetryDelay, rateLimitMessage } from '@/lib/rate-limit';
import { screenDeniedMessage, type ScreenDenial } from '@/lib/screen-share';
import type { Admission, IncomingCaption, OutgoingCaption, ScreenSharePolicy } from '@/lib/types';

export type Person = { userId: string; name: string; imageUrl: string | null; isHost: boolean; lang: string | null };
export type LobbyEntry = { userId: string; name: string; imageUrl: string | null };
// 'full' is Translator Convo only: a 2-seat link that's already taken (server: room.js's
// meeting:join-request, "a translator convo is a 2-seat link, not a lobby"). 'unavailable':
// the server couldn't read its live room state (Redis), so it admitted nobody.
export type DeniedReason = 'not_found' | 'ended' | 'removed' | 'denied' | 'full' | 'unavailable';

// How often the stall rule (ai-chat.ts) is checked: a dead answer fails 45 to 50 s after
// its last piece.
const STALL_CHECK_MS = 5_000;

export type MeetingState =
  | { status: 'connecting' }
  | { status: 'offline' }
  | { status: 'waiting'; position: number; manual: boolean }
  | { status: 'admitted'; people: Person[] }
  | { status: 'denied'; reason: DeniedReason }
  | { status: 'replaced' };

type AdmitAck = { ok: boolean; reason?: 'full' | 'gone' };

/**
 * Joins a ZyloRoom over Socket.IO. Pass `null` while the user is still on the
 * pre-join screen: no socket opens, so nobody takes a seat before pressing Join.
 */
export function useMeeting(meetingId: string | null, opts?: { lang?: string | null; onCaption?: (c: IncomingCaption) => void }) {
  const { getToken } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<MeetingState>({ status: 'connecting' });
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [admission, setAdmission] = useState<Admission | null>(null);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [sharerUserId, setSharerUserId] = useState<string | null>(null);
  // Bumped once per screen:granted. A counter, not a flag — see use-livekit-room.ts's
  // capture effect for why.
  const [shareGrant, setShareGrant] = useState(0);
  const [screenPolicy, setScreenPolicy] = useState<ScreenSharePolicy | null>(null);
  // The host's "AI in chat" setting once it changes in this meeting; until then the card's.
  const [aiEnabled, setAiSetting] = useState<boolean | null>(null);
  // The host's "AI nudges" setting, the same way.
  const [aiNudges, setNudgesSetting] = useState<boolean | null>(null);
  // When this browser last told the server its person spoke (reportSpeech below).
  const lastSpeechRef = useRef(0);

  // Translator Convo only. Refs (not deps of the join effect below) so a language
  // change or a new onCaption closure never tears down and reopens the socket —
  // the connect handler reads langRef.current fresh on every 'connect', including
  // a reconnect, and convo:caption reads onCaptionRef.current the same way. Same
  // no-dependency-array idiom as use-livekit-room.ts's prefsRef.
  const langRef = useRef(opts?.lang ?? null);
  const onCaptionRef = useRef(opts?.onCaption);
  // Whether we are in the room right now, for the join effect's meeting:denied handler.
  const admittedRef = useRef(false);
  useEffect(() => {
    langRef.current = opts?.lang ?? null;
    onCaptionRef.current = opts?.onCaption;
    admittedRef.current = state.status === 'admitted';
  });

  useEffect(() => {
    if (!meetingId) return;
    // Deferred a tick so this reset isn't a synchronous setState-in-effect
    // (matches the async-callback pattern the rest of this codebase uses).
    Promise.resolve().then(() => {
      setState({ status: 'connecting' });
      setLobby([]);
      setMessages([]);
      setSharerUserId(null);
      setShareGrant(0);
    });

    const socket = io(SERVER_URL, {
      // WebSocket only, as on the server: no HTTP long-polling, so several API servers
      // need no sticky sessions. LiveKit's signalling needs WebSockets anyway.
      transports: ['websocket'],
      // The callback form runs again on every reconnect, so the server always
      // gets a fresh short-lived Clerk token instead of an expired one.
      auth: (cb) => {
        getToken().then((token) => cb({ token: token ?? '' }));
      },
    });
    socketRef.current = socket;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let joinTimer: ReturnType<typeof setTimeout> | undefined;
    let toasted = false; // one notice per outage, not one per retry

    // lang rides every join-request, including the one a reconnect re-emits, so a
    // language chosen after the socket already opened isn't lost on a network blip.
    const requestJoin = () => socket.emit('meeting:join-request', { meetingId, lang: langRef.current });
    socket.on('connect', requestJoin);
    // The server is down or the token was refused. Never dress this up as a
    // missing meeting — socket.io keeps retrying, and 'connect' recovers us.
    socket.on('connect_error', (err) => {
      setState({ status: 'offline' });
      // Refused by the server's connection limit: socket.io won't retry that one.
      const wait = connectRetryDelay(err);
      if (wait !== null) retryTimer = setTimeout(() => socket.connect(), wait);
    });
    socket.on('meeting:waiting', ({ position, manual }: { position: number; manual: boolean }) =>
      setState({ status: 'waiting', position, manual }),
    );
    // room:presence always follows meeting:admitted and carries the roster, so it
    // is what flips us into the room — admitted on its own would render empty.
    socket.on('room:presence', ({ people }: { people: Person[] }) => {
      toasted = false;
      setState({ status: 'admitted', people });
    });
    // Every terminal screen goes through here, so none of them can forget the
    // disconnect. Terminal screen: nothing to reconnect to. Calling disconnect() here is a
    // CLIENT-initiated disconnect, which is what turns off socket.io's automatic
    // reconnection (this is not a 'disconnect' event LISTENER — we still never
    // react to the server's own disconnect event, which the 30s seat grace
    // period depends on). Without this call, a later network blip would
    // reconnect this socket, re-emit meeting:join-request, and silently
    // re-queue someone the host just denied/removed/ended.
    const end = (reason: DeniedReason) => {
      setState({ status: 'denied', reason });
      socket.disconnect();
    };
    socket.on('meeting:denied', ({ reason }: { reason: DeniedReason }) => {
      // The server can't read its room state, but we are already in the call and the
      // media doesn't depend on it: stay put and ask again, instead of end().
      const wait = joinRetryDelay(reason, admittedRef.current);
      if (wait === null) return end(reason);
      if (!toasted) toast.error('Meeting server is unavailable for a moment. Your call continues; reconnecting…');
      toasted = true;
      clearTimeout(joinTimer);
      joinTimer = setTimeout(() => socket.connected && requestJoin(), wait);
    });
    // The spec's contract names: host:kick sends meeting:removed, End for all meeting:ended.
    socket.on('meeting:removed', () => end('removed'));
    socket.on('meeting:ended', () => end('ended'));
    socket.on('meeting:replaced', () => {
      setState({ status: 'replaced' });
      // Same fix as meeting:denied above. Without disconnecting here, a hidden
      // tab's socket that blips (laptop sleep, background-tab throttling) would
      // reconnect, re-send join-request, skip the lobby (the server lets a seat
      // holder back in without queueing), retake the seat from the tab the user
      // is actually watching, and flip back to 'admitted' — republishing camera
      // and mic from a tab nobody is looking at.
      socket.disconnect();
    });
    socket.on('lobby:update', ({ waiting }: { waiting: LobbyEntry[] }) => setLobby(waiting));
    socket.on(
      'meeting:settings',
      (s: { admission: Admission; screenSharePolicy: ScreenSharePolicy; aiEnabled: boolean; aiNudges: boolean }) => {
        setAdmission(s.admission);
        setScreenPolicy(s.screenSharePolicy);
        setAiSetting(s.aiEnabled);
        setNudgesSetting(s.aiNudges);
      },
    );
    socket.on('chat:message', (m: Omit<PersonMessage, 'kind'>) => setMessages((prev) => addMessage(prev, m)));
    // Zylo AI's answers, streamed to everyone; ai-chat.ts applies them to the same list.
    // The clock is read here, not inside the updater: React may run an updater twice.
    const applyEvent = (event: AiEvent) => {
      const now = Date.now();
      setMessages((prev) => applyAi(prev, event, now));
    };
    socket.on('ai:start', ({ id, askedBy, ts }: { id: string; askedBy: { userId: string; name: string }; ts: number }) =>
      applyEvent({ type: 'start', id, askedBy, ts }),
    );
    socket.on('ai:chunk', ({ id, delta }: { id: string; delta: string }) => applyEvent({ type: 'chunk', id, delta }));
    socket.on('ai:done', ({ id, text }: { id: string; text: string }) => applyEvent({ type: 'done', id, text }));
    socket.on('ai:failed', ({ id }: { id: string }) => applyEvent({ type: 'failed', id }));
    // Zylo AI speaking up unasked: it arrives whole, with why.
    socket.on('ai:nudge', ({ id, text, reason, ts }: { id: string; text: string; reason: NudgeReason; ts: number }) =>
      applyEvent({ type: 'nudge', id, text, reason, ts }),
    );
    // Only the asker hears this: AI is off for this meeting, or not set up on the server.
    socket.on('ai:error', ({ reason }: { reason: AiErrorReason }) => toast.error(AI_ERROR_TEXT[reason]));
    // If the asker's server dies mid-answer nothing more arrives: the stall rule fails it.
    const stallTimer = setInterval(() => {
      const now = Date.now();
      setMessages((prev) => failStalled(prev, now));
    }, STALL_CHECK_MS);
    socket.on('screen:granted', () => setShareGrant((n) => n + 1));
    socket.on('screen:denied', (denial: ScreenDenial) => toast.error(screenDeniedMessage(denial, brand.live)));
    socket.on('rate-limited', ({ event }: { event: string }) => toast.error(rateLimitMessage(event)));
    socket.on('screen:state', ({ sharerUserId: id }: { sharerUserId: string | null }) => setSharerUserId(id));
    // Translator Convo only; the server never echoes a caption back to its sender
    // (see room.js's convo:caption — it uses socket.to, not io.to).
    socket.on('convo:caption', (c: IncomingCaption) => onCaptionRef.current?.(c));

    return () => {
      clearTimeout(retryTimer);
      clearTimeout(joinTimer);
      clearInterval(stallTimer);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [meetingId, getToken]);

  const leave = useCallback(() => {
    socketRef.current?.emit('meeting:leave');
  }, []);

  const admitFromLobby = useCallback((userId: string) => {
    socketRef.current?.emit('lobby:admit', { userId }, (ack?: AdmitAck) => {
      if (!ack || ack.ok) return;
      toast.error(ack.reason === 'full' ? `${brand.room} is full.` : 'They already left the lobby.');
    });
  }, []);

  const denyFromLobby = useCallback((userId: string) => {
    socketRef.current?.emit('lobby:deny', { userId });
  }, []);

  const setAdmissionMode = useCallback((mode: Admission) => {
    socketRef.current?.emit('host:set-admission', { mode });
  }, []);

  // Validate client-side so a message the server would silently drop never leaves
  // the browser (the server takes the sender's name from the seat, so there is
  // nothing else for this call to pass). Sends what it validated, not the raw
  // text, so a message that only differs by leading/trailing whitespace can't
  // reach the server untrimmed.
  const sendChat = useCallback((text: string) => {
    const clean = validateChatText(text);
    if (clean === null) return;
    socketRef.current?.emit('chat:message', { text: clean });
  }, []);

  // Same rule as sendChat: the server posts the question as a chat message from the
  // seat, then streams the answer to everyone.
  const askAi = useCallback((text: string) => {
    const clean = validateChatText(text);
    if (clean === null) return;
    socketRef.current?.emit('ai:ask', { text: clean });
  }, []);

  const requestScreen = useCallback(() => {
    socketRef.current?.emit('screen:request');
  }, []);

  const stopScreen = useCallback(() => {
    socketRef.current?.emit('screen:stop');
  }, []);

  const kick = useCallback((userId: string) => {
    socketRef.current?.emit('host:kick', { userId });
  }, []);

  const mute = useCallback((userId: string) => {
    socketRef.current?.emit('host:mute', { userId });
  }, []);

  const stopShareOf = useCallback((userId: string) => {
    socketRef.current?.emit('host:stop-share', { userId });
  }, []);

  const setScreenPolicyMode = useCallback((policy: ScreenSharePolicy) => {
    socketRef.current?.emit('host:set-screen-policy', { policy });
  }, []);

  const setAiEnabled = useCallback((enabled: boolean) => {
    socketRef.current?.emit('host:set-ai', { enabled });
  }, []);

  const setAiNudges = useCallback((enabled: boolean) => {
    socketRef.current?.emit('host:set-nudges', { enabled });
  }, []);

  // "Our person spoke just now", for Zylo AI's quiet-room nudge: the fact only, at most
  // once every 10 s. meeting-room-flow.tsx hands this to LiveKit only while nudges are on.
  const reportSpeech = useCallback(() => {
    const now = Date.now();
    if (!shouldReportSpeech(lastSpeechRef.current, now)) return;
    lastSpeechRef.current = now;
    socketRef.current?.emit('voice:activity');
  }, []);

  const endMeeting = useCallback(() => {
    socketRef.current?.emit('host:end-meeting', {});
  }, []);

  // Translator Convo only. Identity (userId, name) is never sent — the server takes
  // it from the seat, same as sendChat above, so the payload is exactly OutgoingCaption.
  const sendCaption = useCallback((c: OutgoingCaption) => {
    socketRef.current?.emit('convo:caption', c);
  }, []);

  // Updates the ref immediately (not just on next render) so a reconnect that races
  // this call still re-joins with the language just chosen, then tells the server.
  const setConvoLang = useCallback((lang: string) => {
    langRef.current = lang;
    socketRef.current?.emit('convo:set-lang', { lang });
  }, []);

  return {
    state,
    lobby,
    admission,
    messages,
    leave,
    admitFromLobby,
    denyFromLobby,
    setAdmissionMode,
    sendChat,
    sharerUserId,
    shareGrant,
    requestScreen,
    stopScreen,
    screenPolicy,
    kick,
    mute,
    stopShareOf,
    setScreenPolicyMode,
    endMeeting,
    sendCaption,
    setConvoLang,
    aiEnabled,
    askAi,
    setAiEnabled,
    aiNudges,
    setAiNudges,
    reportSpeech,
  };
}
