const ANONYMOUS = Object.freeze({ userId: null, isBanned: false, roles: [] });

let store = new Map();

export function useSessionStore(nextStore) {
  store = nextStore;
}

export async function saveSession(id, data) {
  await store.set(id, data);
}

/** Session for the request's cookie, or an anonymous session. Reads the shared store. */
export async function getSession(req) {
  const id = req.cookies?.sid;
  if (!id) return ANONYMOUS;
  return (await store.get(id)) ?? ANONYMOUS;
}
