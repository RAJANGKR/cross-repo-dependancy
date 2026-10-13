const BILLING_URL = process.env.BILLING_URL

// The resource is chosen by the caller, so the path is only known at runtime.
export async function load(resource, id) {
  const res = await fetch(`${BILLING_URL}/${resource}/${id}`)
  return res.json()
}

export const customerLegacyId = async (id) => (await load('customers', id)).customer.legacy_id
