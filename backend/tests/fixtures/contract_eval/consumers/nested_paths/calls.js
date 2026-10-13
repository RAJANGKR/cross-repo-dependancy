import axios from 'axios'

const BILLING_URL = process.env.BILLING_URL

// None of these three is an operation of the Billing API specification.
export const sessionEvents = (id, sid) => axios.delete(`${BILLING_URL}/customers/${id}/sessions/${sid}`)
export const notes = (id) => axios.get(BILLING_URL + "/customers/" + id + "/notes")
export const adminLegacyId = (id) =>
  axios.get(`${BILLING_URL}/admin/customers/${id}`).then((res) => res.data.customer.legacy_id)

// This one is.
export const items = () => axios.get(`${BILLING_URL}/items`).then((res) => res.data.length)
