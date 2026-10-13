const BILLING_URL = process.env.BILLING_URL

export const getJson = (path) => fetch(`${BILLING_URL}${path}`).then((res) => res.json())

export const customerLegacyId = (id) => getJson(`/customers/${id}`).then((body) => body.customer.legacy_id)
