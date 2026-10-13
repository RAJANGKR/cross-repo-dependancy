const rows = new Map()

export function saveCustomer(customer) {
  rows.set(customer.legacy_id, customer.name)
}
