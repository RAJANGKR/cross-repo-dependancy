import axios from 'axios'

const BILLING_API = process.env.BILLING_API

// Uses the customer endpoint, but only for the display name.
export async function customerName(id) {
  const { data } = await axios.get(`${BILLING_API}/customers/${id}`)
  return data.customer.name
}
