import axios from 'axios'

const BILLING_URL = process.env.BILLING_URL
const api = axios.create({ baseURL: BILLING_URL, params: { status: 'open' } })

export const openInvoices = () => api.get(`${BILLING_URL}/invoices`).then((res) => res.status)
