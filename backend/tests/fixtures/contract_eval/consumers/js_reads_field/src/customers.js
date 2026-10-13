import axios from 'axios'

const BILLING_API_URL = process.env.BILLING_API_URL

export async function showCustomer(id) {
  const res = await axios.get(`${BILLING_API_URL}/customers/${id}`)
  const legacy = res.data.customer.legacy_id
  console.log(res.data['customer']['name'])
  document.title = `Customer ${legacy}`
}
