// The server's one way to log. JSON mode (production): one line per call,
// {"time","level","msg",...base,...fields}, for the host's log search. Text mode
// (anywhere else): what the server has always printed, msg, an error as "msg: message",
// then the other fields as key=value. Both write through console (info: console.log,
// so stdout; warn and error: stderr), looked up on every call, so a test that mocks
// console.error still sees the line. Fields left null or undefined are dropped.
// base: fields on every JSON line (server.js adds serverId once it has one). Text mode
// leaves it out: a local run is one server.
// ponytail: no level filter and no redaction. Callers pass ids and error messages, never
// chat text, questions, answers, tokens or keys (spec §4).
const PRINT = { info: 'log', warn: 'warn', error: 'error' };

function createLog({ json = false, base = {} } = {}) {
  const at = (level) => (msg, fields = {}) => {
    const kept = Object.entries(fields).filter(([, value]) => value != null);
    const print = PRINT[level];
    if (json) {
      console[print](JSON.stringify({ time: new Date().toISOString(), level, msg, ...base, ...Object.fromEntries(kept) }));
      return;
    }
    const rest = kept.filter(([key]) => key !== 'err').map(([key, value]) => `${key}=${value}`);
    if (fields.err != null) console[print](`${msg}:`, fields.err, ...rest);
    else console[print](msg, ...rest);
  };
  return { base, info: at('info'), warn: at('warn'), error: at('error') };
}

const log = createLog({ json: process.env.NODE_ENV === 'production' });

module.exports = { createLog, log };
