const sessions = new Map();

export function saveSession(id, data) {
  sessions.set(id, data);
}

/** Session for the request's cookie, or an anonymous session. */
export function getSession(req) {
  const id = req.cookies?.sid;
  return sessions.get(id) ?? { userId: null, isBanned: false, roles: [] };
}
