// npm run load-check (spec §5.2): Zylo's own server under one 20-person meeting. Not part
// of npm test. It reuses the test harness: two API servers in this one process, sharing
// the local Redis (database 1) and the test Postgres database, with the harness's fake
// sign-in and a fake streaming AI. Never Redis database 0 or the dev database. It empties
// both test databases first (as the tests do) and leaves its data in place afterwards, so
// never run it while npm test runs.
// Prints the numbers, then PASS or FAIL for each mark, and exits 1 on any FAIL. A stop that
// hangs is a FAIL too: every wait is bounded, and a 3-minute backstop ends the run.
const os = require('node:os');
const { createAi } = require('../lib/ai');
const { GRACE_MS } = require('../lib/roomStore');
const { shutdown } = require('../lib/shutdown');
const {
  setupTestDb,
  connectTestRedis,
  insertUser,
  insertMeeting,
  startOwnRoomServer,
  connectClient,
  waitForEvent,
  startFakeAi,
  aiAnswer,
  settle,
} = require('../test/helpers');

// The helpers empty whatever they are pointed at, so refuse anything but the test data.
// (The values may hold passwords: never printed.)
const dbName = (url) => {
  try {
    return new URL(url).pathname.slice(1);
  } catch {
    return '';
  }
};
const unsafe = [
  process.env.TEST_REDIS_URL && !process.env.TEST_REDIS_URL.endsWith('/1') && 'TEST_REDIS_URL must end in /1 (Redis database 1)',
  process.env.TEST_DATABASE_URL && !dbName(process.env.TEST_DATABASE_URL).endsWith('_test') && 'TEST_DATABASE_URL must name a database ending in _test',
].filter(Boolean);
if (unsafe.length > 0) {
  console.error(`load-check refuses to run: ${unsafe.join('; ')}. It empties both databases first.`);
  process.exit(1);
}
setTimeout(() => {
  console.error('load-check overran');
  process.exit(1);
}, 180_000).unref(); // a normal run takes about 70 s

const MEETING_ID = 'lod-chek-run';
const PEOPLE = 20; // the host and 19 others: a full room
const CHAT_MS = 60_000;
const SPEECH_EVERY_MS = 10_000;
const WAIT_MS = 10_000; // the longest anyone waits to connect or be seated
const REJOIN_MS = 15_000; // the longest the stop waits for its people to be seated again

const percentile = (values, p) => [...values].sort((x, y) => x - y)[Math.max(0, Math.ceil((p / 100) * values.length) - 1)];
const ms = (n) => `${Math.round(n)} ms`;
const spread = (values) => `p50 ${ms(percentile(values, 50))}, p95 ${ms(percentile(values, 95))}, max ${ms(Math.max(...values))}`;

// Calls of every command since Redis started, from INFO commandstats (the `:calls=` field,
// not rejected_calls or failed_calls).
async function redisCalls(redis) {
  const info = await redis.info('commandstats');
  return [...info.matchAll(/:calls=(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

// True once the client gets `event`, false if it hasn't within limitMs.
const heardWithin = (client, event, limitMs) =>
  Promise.race([waitForEvent(client, event).then(() => true), settle(limitMs).then(() => false)]);

async function main() {
  const db = await setupTestDb();
  const redis = await connectTestRedis();
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) }; // startFakeAi only needs t.after
  const ids = Array.from({ length: PEOPLE }, (_, i) => `u${String(i).padStart(2, '0')}`);
  for (const id of ids) await insertUser(db, { id, email: `${id}@zylo.test`, name: `Person ${id}` });
  await insertMeeting(db, { id: MEETING_ID, hostId: ids[0], maxParticipants: PEOPLE });
  const provider = await startFakeAi(t, aiAnswer(['The launch ', 'moves ', 'to ', 'Friday.'], { gapMs: 100 }));
  const ai = createAi({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model' });
  const a = await startOwnRoomServer({ serverId: 'load-a', ai, graceMs: GRACE_MS });
  const b = await startOwnRoomServer({ serverId: 'load-b', ai, graceMs: GRACE_MS });
  await settle(200); // let both adapters' subscriptions land

  const wallStart = Date.now();
  const cpuStart = process.cpuUsage();
  const callsStart = await redisCalls(redis);
  let rssPeak = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 1_000);

  // Each person keeps what they heard: chat lines by text with the time, and ai:done count.
  const people = ids.map((id, i) => ({ id, onA: i % 2 === 0, heard: new Map(), done: 0 }));
  const listen = (person, client) => {
    person.client = client;
    client.on('chat:message', ({ text }) => person.heard.set(text, Date.now()));
    client.on('ai:done', () => {
      person.done += 1;
    });
  };
  const join = async (person, url) => {
    const client = connectClient(url, person.id);
    listen(person, client);
    if (!(await heardWithin(client, 'connect', WAIT_MS))) return { admitted: false, ms: 0 };
    const asked = Date.now();
    const admitted = heardWithin(client, 'meeting:admitted', WAIT_MS);
    client.emit('meeting:join-request', { meetingId: MEETING_ID });
    return { admitted: await admitted, ms: Date.now() - asked };
  };

  // 1. Join: all 20 at once, 10 on each server.
  const joins = await Promise.all(people.map((person) => join(person, (person.onA ? a : b).url)));
  const seated = joins.filter((j) => j.admitted).length;
  const seatsHeld = (await b.store.listSeats(MEETING_ID)).length;

  // 2. Speech reports from everyone every 10 s, from here through the planned stop.
  let speechReports = 0;
  const speech = setInterval(() => {
    for (const person of people) person.client.emit('voice:activity');
    speechReports += people.length;
  }, SPEECH_EVERY_MS);

  // 3. Chat for 60 s: everyone sends a line every 5–10 s, and halfway everyone at once.
  const sent = new Map(); // text -> when it was sent
  const send = (person) => {
    const text = `${person.id} says line ${sent.size + 1}`;
    sent.set(text, Date.now());
    person.client.emit('chat:message', { text });
  };
  const chatEnds = Date.now() + CHAT_MS;
  await Promise.all([
    ...people.map(async (person) => {
      for (;;) {
        await settle(5_000 + Math.random() * 5_000);
        if (Date.now() >= chatEnds) return;
        send(person);
      }
    }),
    settle(CHAT_MS / 2).then(() => people.forEach(send)),
  ]);
  await settle(1_000); // the last lines land
  const delivery = [];
  let lost = 0;
  for (const [text, at] of sent) {
    for (const person of people) {
      const heardAt = person.heard.get(text);
      if (heardAt === undefined) lost += 1;
      else delivery.push(heardAt - at);
    }
  }

  // 4. Ask AI: one person asks, the fake AI streams, and everyone hears ai:done once.
  const allDone = Promise.all(people.map((person) => waitForEvent(person.client, 'ai:done')));
  const askedAt = Date.now();
  people[1].client.emit('ai:ask', { text: 'When does the launch move to?' });
  await Promise.race([allDone, settle(10_000)]);
  const answerMs = Date.now() - askedAt;
  await settle(500); // a second ai:done would have arrived by now
  const doneOnce = people.filter((person) => person.done === 1).length;

  // 5. Planned stop: server A stops as it would on SIGTERM. Its people's connections close;
  // a load balancer would send their browsers to B, so each reconnects to B at once (a
  // real browser first waits socket.io's reconnection delay, 0.5–1.5 s by default: not
  // simulated here, so the re-seat time below is shorter than a browser's by that much).
  const moving = people.filter((person) => person.onA);
  const seqBefore = new Map();
  for (const person of moving) seqBefore.set(person.id, (await b.store.seatFor(MEETING_ID, person.id)).seq);
  const reasons = [];
  const back = []; // each person's second join, as it finishes
  const rejoined = Promise.all(
    moving.map(
      (person) =>
        new Promise((resolve) => {
          person.client.once('disconnect', async (reason) => {
            reasons.push(reason);
            person.client.disconnect(); // its own retries would go to A, which is gone
            back.push({ ...(await join(person, b.url)), at: Date.now() });
            resolve();
          });
        }),
    ),
  );
  const stopAt = Date.now();
  const exitCode = await shutdown({
    httpServer: a.httpServer,
    io: a.io,
    handlers: a.handlers,
    redisClients: [a.redis, ...a.pubsub],
    db: a.db,
  });
  // A stop that never closes its connections leaves nobody to reseat: wait a while, then
  // count whoever made it (the marks below FAIL).
  await Promise.race([rejoined, settle(REJOIN_MS)]);
  clearInterval(speech);
  const seatedAgain = back.filter((r) => r.admitted);
  const reseatMs = seatedAgain.length > 0 ? Math.max(...seatedAgain.map((r) => r.at)) - stopAt : Infinity;
  const lastOne = seatedAgain.length > 0 ? `${ms(reseatMs)} after the stop` : 'never';
  let kept = 0;
  for (const person of moving) if ((await b.store.seatFor(MEETING_ID, person.id))?.seq === seqBefore.get(person.id)) kept += 1;

  // 6. Cost. Both servers and all 20 clients share this one process, so its memory and
  // CPU time are the two servers' together, plus the clients'.
  clearInterval(rssTimer);
  const wallMs = Date.now() - wallStart;
  const calls = (await redisCalls(redis)) - callsStart;
  const cpu = process.cpuUsage(cpuStart);

  console.log(`\nZylo load check: ${PEOPLE} people, 2 API servers, one process. Node ${process.version}, ${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`);
  console.log(`Join     ${seated}/${PEOPLE} admitted, ${seatsHeld} seats held; join-request → admitted ${spread(joins.filter((j) => j.admitted).map((j) => j.ms))}`);
  console.log(`Chat     ${sent.size} lines × ${PEOPLE} people, ${lost} lost; send → receive ${spread(delivery)}`);
  console.log(`Ask AI   ai:done exactly once for ${doneOnce}/${PEOPLE}; question → last ai:done ${ms(answerMs)}`);
  console.log(`Speech   ${speechReports} voice:activity reports`);
  console.log(`Stop     shutdown() → ${exitCode}; disconnect reasons: ${[...new Set(reasons)].join(', ')}; ${seatedAgain.length}/${moving.length} seated again, ${kept} in the same seat; last one seated ${lastOne} (simulated: each reconnects to B at once, with no browser back-off of 0.5–1.5 s)`);
  console.log(`Cost     Redis ${calls} commands in ${(wallMs / 1000).toFixed(0)} s = ${Math.round(calls / (wallMs / 60_000))}/min (whole Redis server); process RSS peak ${Math.round(rssPeak / 2 ** 20)} MB; CPU ${(cpu.user / 1e6).toFixed(1)} s user + ${(cpu.system / 1e6).toFixed(1)} s system\n`);

  const p95 = percentile(delivery, 95);
  const marks = [
    [`all ${PEOPLE} seated`, seated === PEOPLE && seatsHeld === PEOPLE],
    ['no chat line lost', lost === 0 && delivery.length > 0],
    [`95th-percentile chat delivery ${ms(p95)} < 200 ms`, p95 < 200],
    ['everyone heard ai:done exactly once', doneOnce === PEOPLE],
    ['shutdown() returned 0', exitCode === 0],
    // a browser that saw any other reason would not retry
    [`every disconnect reason was "transport close" (${reasons.length}/${moving.length} heard)`, reasons.length === moving.length && reasons.every((reason) => reason === 'transport close')],
    [`the stopped server's ${moving.length} people seated again (${seatedAgain.length}/${moving.length})`, seatedAgain.length === moving.length],
    [`all in the same seats (${kept}/${moving.length})`, kept === moving.length],
    [`the last one seated again within 10 s (${lastOne})`, reseatMs < 10_000],
  ];
  for (const [name, ok] of marks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);

  for (const person of people) person.client.off('disconnect').disconnect(); // no late rejoin if the stop timed out
  await a.cleanup();
  await b.cleanup();
  for (const fn of cleanups) await fn();
  await redis.quit();
  await db.close();
  return marks.every(([, ok]) => ok);
}

main().then(
  (passed) => process.exit(passed ? 0 : 1),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
