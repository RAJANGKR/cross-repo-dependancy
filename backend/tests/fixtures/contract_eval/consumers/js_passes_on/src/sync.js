import axios from 'axios'
import { saveCustomer } from './store'

const BILLING_URL = process.env.BILLING_URL

// The whole customer object is handed to another module, which is not followed.
export async function syncCustomer(id) {
  const res = await axios.get(`${BILLING_URL}/customers/${id}`)
  saveCustomer(res.data.customer)
}
