const BILLING_URL: string = import.meta.env.VITE_BILLING_URL

export async function loadCustomer(id: string): Promise<void> {
  const response = await fetch(`${BILLING_URL}/customers/${id}`)
  const { customer: { legacy_id }, status } = await response.json()
  if (status === 'active') {
    console.log(legacy_id + 1)
  }
}
