import axios from 'axios'

const BILLING_URL = process.env.BILLING_URL

export async function pageTotal(page) {
  const res = await axios.get(`${BILLING_URL}/invoices`, { params: { page } })
  const amounts = res.data.map((invoice) => invoice.amount)
  document.title = String(amounts.length)
}
