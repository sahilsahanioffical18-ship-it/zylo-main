const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, POLICIES, SOCKET_POLICIES } = require('../lib/rateLimit');
const { limitConnections } = require('../lib/limitMiddleware');
const { startSocketServer, connectClient, fakeSocketAuth, waitForEvent, roomHarness, collect, settle } = require('./helpers');

test('connections: the burst from one IP connects, the next is refused with the wait', async (t) => {
  const server = await startSocketServer((io) => {
    io.use(limitConnections(createLimiter({ now: () => 1000 }), 0));
    io.use(fakeSocketAuth);
  });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
  });
  for (let i = 0; i < POLICIES.connect.burst; i++) {
    const client = connectClient(server.url, `u${i}`);
    clients.push(client);
    await waitForEvent(client, 'connect');
  }
  const refused = connectClient(server.url, 'one-too-many');
  clients.push(refused);
  const err = await waitForEvent(refused, 'connect_error');
  assert.equal(err.message, 'Too many connections. Try again shortly.');
  assert.equal(err.data.retryAfterMs, 1000); // one connection a second
});

test('chat: a flood delivers the burst and tells the sender about the rest', async (t) => {
  const { join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const delivered = collect(p1, 'chat:message');
  const refused = collect(host, 'rate-limited');
  const { burst } = SOCKET_POLICIES['chat:message'];
  for (let i = 0; i < burst + 4; i++) host.emit('chat:message', { text: `message ${i}` });
  await settle(150);
  assert.equal(delivered.length, burst);
  assert.deepEqual(refused, Array(4).fill({ event: 'chat:message' }));
});

test('host actions share one bucket', async (t) => {
  const { join, livekit } = await roomHarness(t);
  const host = await join('host');
  await join('p1');
  const refused = collect(host, 'rate-limited');
  const { burst } = SOCKET_POLICIES.host;
  for (let i = 0; i < burst + 2; i++) host.emit('host:mute', { userId: 'p1' });
  await settle(150);
  assert.equal(livekit.callsTo('muteMic').length, burst);
  assert.deepEqual(refused, Array(2).fill({ event: 'host' }));
});

test('join requests: the burst per socket, then rate-limited', async (t) => {
  const { connect, meetingId } = await roomHarness(t);
  const client = connect('host');
  await waitForEvent(client, 'connect');
  const refused = collect(client, 'rate-limited');
  const { burst } = SOCKET_POLICIES['meeting:join-request'];
  for (let i = 0; i < burst + 1; i++) client.emit('meeting:join-request', { meetingId });
  await settle(200);
  assert.deepEqual(refused, [{ event: 'meeting:join-request' }]);
});
