import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostActionsFor } from './host-actions.ts';

test('a participant is offered no host actions for anyone', () => {
  const actions = hostActionsFor(
    { userId: 'u2', micMuted: false },
    { isHost: false, selfUserId: 'u1', sharerUserId: null },
  );
  assert.deepEqual(actions, []);
});

test('the host is offered nothing on their own row', () => {
  const actions = hostActionsFor(
    { userId: 'u1', micMuted: false },
    { isHost: true, selfUserId: 'u1', sharerUserId: null },
  );
  assert.deepEqual(actions, []);
});

test('the host can mute and kick an unmuted participant', () => {
  const actions = hostActionsFor(
    { userId: 'u2', micMuted: false },
    { isHost: true, selfUserId: 'u1', sharerUserId: null },
  );
  assert.deepEqual(actions, ['mute', 'kick']);
});

test('someone already muted is not offered Mute', () => {
  const actions = hostActionsFor(
    { userId: 'u2', micMuted: true },
    { isHost: true, selfUserId: 'u1', sharerUserId: null },
  );
  assert.deepEqual(actions, ['kick']);
});

test('Stop ZyloLive appears only on the current presenter', () => {
  const sharerRow = hostActionsFor(
    { userId: 'u2', micMuted: false },
    { isHost: true, selfUserId: 'u1', sharerUserId: 'u2' },
  );
  assert.deepEqual(sharerRow, ['mute', 'stop-share', 'kick']);

  const otherRow = hostActionsFor(
    { userId: 'u3', micMuted: false },
    { isHost: true, selfUserId: 'u1', sharerUserId: 'u2' },
  );
  assert.deepEqual(otherRow, ['mute', 'kick']);
});
