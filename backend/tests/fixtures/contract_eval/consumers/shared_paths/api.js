import axios from 'axios'

// Calls this application's own backend through relative paths.
export const createInvoice = (amount) =>
  fetch('/invoices', { method: 'POST', body: JSON.stringify({ amount }) })

export const legacyId = (id) => axios.get('/customers/' + id).then((r) => r.data.customer.legacy_id)
