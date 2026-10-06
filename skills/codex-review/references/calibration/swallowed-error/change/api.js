export async function fetchOrders(client) {
  try {
    const res = await client.get('/orders');
    if (!res.ok) throw new Error(`orders failed: ${res.status}`);
    return res.json();
  } catch (err) {
    console.error(err);
    return [];
  }
}
