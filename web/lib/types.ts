export type MeetingStatus = 'scheduled' | 'live' | 'ended';
export type Admission = 'auto' | 'manual';
export type ScreenSharePolicy = 'anyone' | 'host_only';

export interface MeetingCard {
  id: string;
  title: string;
  status: MeetingStatus;
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
  admission: Admission;
  screenSharePolicy: ScreenSharePolicy;
  maxParticipants: number;
  mode: 'standard' | 'translator';
  aiEnabled: boolean; // the host's "AI in chat" setting
  aiNudges: boolean; // the host's "AI nudges" setting
  aiAvailable: boolean; // the server has an AI key and model
  host: { name: string };
  isHost: boolean;
  participants: { name: string; imageUrl: string | null }[];
}

// Zylo Translator Convo caption payloads — the shapes carried over convo:caption.
// Twin of server/lib/captionRules.js's validateCaption/validateTranslation.
export type OutgoingCaption = {
  id: string;
  text: string;
  lang: string;
  final: boolean;
  translation?: { lang: string; text: string };
};

export type IncomingCaption = OutgoingCaption & { userId: string; name: string; ts: number };

export interface Dashboard {
  live: MeetingCard[];
  upcoming: MeetingCard[];
  previous: MeetingCard[];
}

export interface CreateMeetingInput {
  title?: string;
  scheduledFor?: string;
  admission?: Admission;
  screenSharePolicy?: ScreenSharePolicy;
  maxParticipants?: number;
  inviteEmails?: string[];
}
