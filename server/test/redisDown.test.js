const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRedis } = require('../lib/redis');
const { setupTestDb, seedMeeting, startRoomServer, connectClient, waitForEvent, quietLog } = require('./helpers');

// A room server whose Redis nothing listens behind, and one connected client.
async function deadRedisRoom(t) {
  t.mock.method(console, 'error', () => {}); // the failure these tests make on purpose
  const db = await setupTestDb();
  const deadRedis = createRedis('redis://127.0.0.1:6390', { log: quietLog }); // nothing listens here
  const meetingId = await seedMeeting(db);
  const room = await startRoomServer(db, deadRedis);
  const client = connectClient(room.url, 'host');
  t.after(async () => {
    client.disconnect();
    await room.close();
    deadRedis.disconnect();
    await db.close();
  });
  return { client, meetingId };
}

test('with Redis unreachable, a join is refused as unavailable and never admitted', async (t) => {
  const { client, meetingId } = await deadRedisRoom(t);
  const admitted = [];
  client.on('meeting:admitted', () => admitted.push(true));
  const denied = waitForEvent(client, 'meeting:denied');
  client.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'unavailable' });
  assert.deepEqual(admitted, []);
  assert.match(console.error.mock.calls[0].arguments[0], /join failed/);
});

// The client picks the text of meetingId, up to about 1 MB with newlines, so during an
// outage a failed join logs it only when it is a real meeting code.
test('a failed join logs the meeting code only when it is a valid code, never text the client chose', async (t) => {
  const { client, meetingId } = await deadRedisRoom(t);
  const failedJoinLine = async (code) => {
    const denied = waitForEvent(client, 'meeting:denied');
    client.emit('meeting:join-request', { meetingId: code });
    assert.deepEqual(await denied, { reason: 'unavailable' });
    return console.error.mock.calls.at(-1).arguments.join(' ');
  };

  const forged = await failedJoinLine('abc\n{"level":"error","msg":"forged line"}');
  assert.match(forged, /join failed/);
  assert.doesNotMatch(forged, /meetingId|forged/);
  assert.match(await failedJoinLine(meetingId), /meetingId=abc-defg-hij/);
});
