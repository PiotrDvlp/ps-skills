export async function fetchOrders(client) {
  const res = await client.get('/orders');
  if (!res.ok) throw new Error(`orders failed: ${res.status}`);
  return res.json();
}
