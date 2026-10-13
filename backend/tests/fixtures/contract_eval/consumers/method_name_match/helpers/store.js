// A free function for shop records. Nothing calls it with a billing customer.
export function store(record) {
  return record.legacy_id
}
