import { useEffect, useState } from 'react'

const BILLING_URL = import.meta.env.VITE_BILLING_URL

export function Customer({ id }) {
  const [customer, setCustomer] = useState(null)
  useEffect(() => {
    fetch(`${BILLING_URL}/customers/${id}`)
      .then((response) => response.json())
      .then((body) => setCustomer(body.customer))
  }, [id])
  return <span>{customer?.legacy_id}</span>
}
