// Zylo Translator Convo: how loud the partner's real voice should play, given the
// viewer's own "Partner's voice" setting and whether translated speech is currently
// speaking. Zero imports, so node --test can run it alone.

export type PartnerVoiceSetting = 'low' | 'full' | 'off';

const LOW_VOLUME = 0.25;
const FULL_VOLUME = 1;

/**
 * The partner's real voice always ducks to muted while this browser's translated
 * speech is playing (`speaking`), whatever the setting — the translation has to be
 * heard clearly. iOS ignores `HTMLMediaElement.volume` (see AudioSink's ponytail
 * note in video-stage.tsx), so *Low* only actually does anything there via this
 * during-speech mute.
 */
export function partnerVolume(setting: PartnerVoiceSetting, speaking: boolean): { volume: number; muted: boolean } {
  return { volume: setting === 'full' ? FULL_VOLUME : LOW_VOLUME, muted: setting === 'off' || speaking };
}
