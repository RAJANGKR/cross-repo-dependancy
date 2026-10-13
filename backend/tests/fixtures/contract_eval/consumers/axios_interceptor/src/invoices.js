import axios from 'axios'

const BILLING_URL = process.env.BILLING_URL

export const createInvoice = (amount) => axios.post(`${BILLING_URL}/invoices`, { amount }).then((res) => res.status)
