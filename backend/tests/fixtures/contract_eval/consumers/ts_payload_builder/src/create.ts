const BILLING_URL: string = import.meta.env.VITE_BILLING_URL

function buildInvoice(amount: number, memo: string) {
  return { amount, memo }
}

export async function createInvoice(amount: number, memo: string): Promise<void> {
  const res = await fetch(`${BILLING_URL}/invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildInvoice(amount, memo)),
  })
  const created = await res.json()
  console.log(created.id)
}
