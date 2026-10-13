const BILLING_URL = process.env.BILLING_URL

export async function listSessions(id) {
  const res = await fetch(`${BILLING_URL}/customers/${id}/sessions`)
  await fetch(`${BILLING_URL}/audit/${id}`, { method: 'DELETE' })
  const sessions = await res.json()
  return sessions.length
}
