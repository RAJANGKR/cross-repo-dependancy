import axios from 'axios'
import { save } from 'record-archive'

const BILLING_URL = process.env.BILLING_URL

// `save` comes from an external package. The save() in tools/disk.js is unrelated.
export async function syncCustomer(id) {
  const res = await axios.get(`${BILLING_URL}/customers/${id}`)
  save(res.data.customer)
}
