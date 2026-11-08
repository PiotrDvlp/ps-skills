export function createSearch(api) {
  const state = { query: '', results: [], loading: false, error: null };
  let generation = 0;

  async function search(query) {
    const id = ++generation;
    state.query = query;
    state.loading = true;
    state.error = null;
    try {
      const results = await api.search(query);
      if (id !== generation) return;
      state.results = results;
    } catch (err) {
      if (id !== generation) return;
      state.error = err;
    } finally {
      if (id === generation) state.loading = false;
    }
  }

  return { state, search };
}
