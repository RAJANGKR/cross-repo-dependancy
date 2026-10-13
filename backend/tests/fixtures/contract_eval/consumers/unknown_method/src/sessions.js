const BILLING_URL = process.env.BILLING_URL

// The transport decides the HTTP method (it sends a GET). This function does not state one.
export function listSessions(transport, id) {
  const url = `${BILLING_URL}/customers/${id}/sessions`
  return transport.send(url)
}
