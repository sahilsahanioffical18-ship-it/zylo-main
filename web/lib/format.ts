const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(date: Date, timeZone?: string): number {
  const ymd = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(date);
  return Date.parse(`${ymd}T00:00:00Z`) / DAY_MS;
}

export function formatWhen(iso: string, now: Date = new Date(), locale?: string, timeZone?: string): string {
  const date = new Date(iso);
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
  const diff = dayNumber(date, timeZone) - dayNumber(now, timeZone);
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Tomorrow, ${time}`;
  if (diff === -1) return `Yesterday, ${time}`;
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone }).format(date);
  return `${day}, ${time}`;
}

export function formatDuration(startIso: string, endIso: string): string {
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000);
  if (minutes < 1) return 'Under 1 min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function normalizeCode(input: string): string | null {
  const segment = input.trim().toLowerCase().split(/[/?#]/).pop() ?? '';
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(segment) ? segment : null;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseInviteEmails(input: string): { emails: string[]; invalid: string[] } {
  const emails = [...new Set(input.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  return { emails, invalid: emails.filter((e) => !EMAIL_RE.test(e)) };
}
