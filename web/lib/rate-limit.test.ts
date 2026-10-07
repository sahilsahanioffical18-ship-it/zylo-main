import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectRetryDelay, joinRetryDelay, rateLimitMessage } from './rate-limit.ts';

test('each refused event gets its own wording', () => {
  assert.match(rateLimitMessage('chat:message'), /messages too fast/);
  assert.match(rateLimitMessage('meeting:join-request'), /join attempts/);
  assert.match(rateLimitMessage('screen:request'), /sharing your screen/);
  assert.match(rateLimitMessage('host'), /host action/);
  assert.equal(rateLimitMessage('ai:ask'), 'You’re asking the AI too often. Wait a moment.');
});

test('an event without its own wording gets the general one', () => {
  assert.match(rateLimitMessage('something-new'), /too fast/);
});

test('a refused connection is retried after the wait the server named, at least a second', () => {
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 3000 } }), 3000);
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 200 } }), 1000);
});

test('other connection errors are left to socket.io', () => {
  assert.equal(connectRetryDelay(new Error('Sign in required.')), null);
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 'soon' } }), null);
  assert.equal(connectRetryDelay(null), null);
});

test('someone already in the call keeps it and retries the join after 3 s when the server is unavailable', () => {
  assert.equal(joinRetryDelay('unavailable', true), 3000);
});

test('a join that was never admitted, or any other denial, is final', () => {
  assert.equal(joinRetryDelay('unavailable', false), null);
  for (const reason of ['not_found', 'ended', 'removed', 'denied', 'full']) {
    assert.equal(joinRetryDelay(reason, true), null);
    assert.equal(joinRetryDelay(reason, false), null);
  }
});
