import { getSession } from '../auth/session.js';

export function accountRoute(req, res) {
  const session = getSession(req);
  if (!session.userId) {
    res.status(401).send('Sign in first');
    return;
  }
  res.json({ userId: session.userId, roles: session.roles });
}
