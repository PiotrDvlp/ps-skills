export function createSearch(api) {
  const state = { query: '', results: [], loading: false, error: null };
  let generation = 0;

  async function search(query) {
    const id = ++generation;
    const isCurrent = () => id === generation;
    state.query = query;
    state.loading = true;
    state.error = null;
    try {
      const results = await api.search(query);
      if (!isCurrent()) return;
      state.results = results;
    } catch (err) {
      if (!isCurrent()) return;
      state.error = err;
    } finally {
      if (isCurrent()) state.loading = false;
    }
  }

  return { state, search };
}
