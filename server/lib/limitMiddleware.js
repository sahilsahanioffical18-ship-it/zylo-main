// The HTTP side of rateLimit.js, plus the client-IP rule sockets share with it.

// A refusal: 429, Retry-After in whole seconds (at least 1), and the same wait in
// milliseconds in the body, so the client can say "try again in 3 s".
function sendTooMany(res, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: `Too many requests. Try again in ${seconds} s.`, retryAfterMs });
}

// Spends one token from `policy` for keyOf(req). Every response it lets through
// says how many calls are left.
function limitRequests(limiter, policy, keyOf) {
  return async (req, res, next) => {
    const { allowed, remaining, retryAfterMs } = await limiter.take(policy, keyOf(req));
    res.set('RateLimit-Remaining', String(remaining));
    if (!allowed) return sendTooMany(res, retryAfterMs);
    next();
  };
}

// The client's address behind our own proxies: the X-Forwarded-For entry `hops`
// from the right, the one Express's req.ip picks for `trust proxy` = hops. Anything
// further left was written by the client and proves nothing.
function forwardedIp(forwardedFor, remoteAddress, hops) {
  if (!hops || !forwardedFor) return remoteAddress;
  const chain = String(forwardedFor).split(',').map((s) => s.trim()).filter(Boolean);
  if (chain.length === 0) return remoteAddress;
  return chain[Math.max(0, chain.length - hops)];
}

// Socket.IO middleware, run before auth so a reconnect storm never reaches token
// verification. socket.io does not retry a connection a middleware refused, so the
// refusal carries retryAfterMs for the client to retry on its own.
function limitConnections(limiter, hops) {
  return async (socket, next) => {
    const ip = forwardedIp(socket.handshake.headers['x-forwarded-for'], socket.handshake.address, hops);
    const { allowed, retryAfterMs } = await limiter.take('connect', ip);
    if (allowed) return next();
    const err = new Error('Too many connections. Try again shortly.');
    err.data = { retryAfterMs };
    next(err);
  };
}

module.exports = { limitRequests, sendTooMany, forwardedIp, limitConnections };
