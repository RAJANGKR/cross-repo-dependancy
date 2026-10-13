// A different service (the shop backend) that happens to expose the same paths.
const SHOP_API = process.env.SHOP_API

export async function shopCustomer(id) {
  const res = await fetch(`${SHOP_API}/customers/${id}`)
  const body = await res.json()
  return body.customer.legacy_id
}

export const createShopInvoice = (amount) =>
  fetch(`${SHOP_API}/invoices`, { method: 'POST', body: JSON.stringify({ amount }) })
