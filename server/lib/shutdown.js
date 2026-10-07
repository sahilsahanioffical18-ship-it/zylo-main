const { log: defaultLog } = require('./log');

// The planned stop (spec §2): SIGTERM on a redeploy, or Ctrl-C. Everyone on this server
// moves to another one without losing their seat. It never exits the process: it
// resolves to the exit code (0 a clean stop, 1 if the whole stop overran watchdogMs), so
// tests and the load check can stop one of two servers in one process.
// handlers: registerRoomHandlers' result, or null when this server runs no rooms.
// redisClients: every Redis connection the server opened (the main one, the adapter's two).
async function shutdown(
  { httpServer, io, handlers, redisClients = [], db = null, log = defaultLog },
  { drainMs = 8_000, watchdogMs = 10_000 } = {},
) {
  const started = Date.now();

  async function stop() {
    log.info('shutting down');
    httpServer.close(); // no new connections; io.close() below resolves once the last one has gone
    // Heartbeat, sweep and grace timers stop and every AI call aborts. It resolves once
    // each answer it cut short has posted ai:failed, while its people here are still
    // connected to hear it.
    await handlers?.stop();
    log.info('shutdown: timers and AI stopped');
    // Closes every connection without a disconnect packet: each browser sees its
    // transport close and reconnects on its own, to whichever server takes it (an
    // "io server disconnect" would switch that off). Each socket's disconnect handler
    // stamps graceUntil on its seat in Redis, so the seat outlives this process.
    // ponytail: a connection whose far end has vanished holds io.close() until ws gives up
    // on it (30 s); the watchdog turns that into exit code 1 at 10 s, after the seats were
    // already held. Bound this wait on its own if that ever happens often.
    const closing = io.close();
    const handlersDone = await handlers?.drain(drainMs);
    await closing;
    log.info('shutdown: connections closed', { handlersDone });
    // Last, so the disconnect handlers above could still write. quit() lets pending
    // replies arrive; a connection that can't send it is cut instead.
    const quit = (client) => client.quit().catch(() => client.disconnect());
    await Promise.allSettled([...redisClients.map(quit), db?.close()]);
    log.info('shutdown: redis and postgres closed');
    log.info('shutdown complete', { ms: Date.now() - started });
    return 0;
  }

  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => {
      log.error('shutdown timed out', { ms: Date.now() - started });
      resolve(1);
    }, watchdogMs);
  });
  const stopped = stop().catch((err) => {
    log.error('shutdown failed', { err: err.message });
    return 1;
  });
  const code = await Promise.race([stopped, watchdog]);
  clearTimeout(timer);
  return code;
}

// Runs stop() on the first SIGTERM (a redeploy) or SIGINT (Ctrl-C), then exits with the
// code it resolves to. Handling the signals replaces Node's own exit, so a second
// signal while stopping is ignored: the watchdog already bounds the stop.
function onStopSignal(stop, { target = process, exit = (code) => process.exit(code) } = {}) {
  let stopping = false;
  const handle = () => {
    if (stopping) return;
    stopping = true;
    stop().then(exit);
  };
  target.on('SIGTERM', handle);
  target.on('SIGINT', handle);
}

module.exports = { shutdown, onStopSignal };
