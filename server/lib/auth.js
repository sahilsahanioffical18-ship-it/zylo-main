const { clerkMiddleware, getAuth, clerkClient, verifyToken } = require('@clerk/express');

function clerkConfigured() {
  return Boolean(process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY);
}

// ponytail: per-process cache of synced users; profile edits made in Clerk later are
// picked up on the next server restart. Add a Clerk webhook if that ever matters.
const syncedUsers = new Set();

async function ensureUser(db, userId) {
  if (syncedUsers.has(userId)) return;
  const user = await clerkClient.users.getUser(userId);
  const email = user.primaryEmailAddress?.emailAddress?.toLowerCase();
  // The Clerk app only allows Email and Google sign-in, so every user has an email.
  if (!email) throw new Error(`Clerk user ${userId} has no primary email`);
  const name = user.fullName || user.firstName || email.split('@')[0];
  await db.query(
    `INSERT INTO users (id, email, name, image_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, image_url = EXCLUDED.image_url`,
    [userId, email, name, user.imageUrl || null],
  );
  syncedUsers.add(userId);
}

function clerkAuth({ db }) {
  if (!clerkConfigured()) {
    return (_req, res) =>
      res.status(503).json({ error: 'Auth is not configured on the server (CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY).' });
  }
  const verifySession = clerkMiddleware({
    authorizedParties: [process.env.CLIENT_ORIGIN || 'http://localhost:3000'],
  });
  const requireUser = async (req, res, next) => {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Sign in required.' });
    await ensureUser(db, userId);
    req.userId = userId;
    next();
  };
  return [verifySession, requireUser];
}

// The socket twin of clerkAuth. Socket.IO has no Express req, so the client puts
// a fresh short-lived Clerk token in the handshake and we verify it by hand.
function clerkSocketAuth({ db }) {
  if (!clerkConfigured()) {
    return (_socket, next) =>
      next(new Error('Auth is not configured on the server (CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY).'));
  }
  return async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Sign in required.'));
    try {
      const { sub: userId } = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
        authorizedParties: [process.env.CLIENT_ORIGIN || 'http://localhost:3000'],
      });
      await ensureUser(db, userId);
      socket.data.userId = userId;
      next();
    } catch {
      next(new Error('Sign in required.'));
    }
  };
}

module.exports = { clerkAuth, clerkSocketAuth, ensureUser };
