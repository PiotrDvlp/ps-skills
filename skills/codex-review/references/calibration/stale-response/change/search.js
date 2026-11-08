export function createSearch(api) {
  const state = { query: '', results: [], loading: false, error: null };

  async function search(query) {
    state.query = query;
    state.loading = true;
    state.error = null;
    try {
      state.results = await api.search(query);
    } catch (err) {
      state.error = err;
    } finally {
      state.loading = false;
    }
  }

  return { state, search };
}
