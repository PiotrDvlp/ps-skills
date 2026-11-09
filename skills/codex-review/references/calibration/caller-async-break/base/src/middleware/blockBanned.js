import { getSession } from '../auth/session.js';

/** Rejects requests from banned accounts before any route handler runs. */
export function blockBanned(req, res, next) {
  if (getSession(req).isBanned) {
    res.status(403).send('Account suspended');
    return;
  }
  next();
}
