import axios from 'axios'

const BILLING_URL = process.env.BILLING_URL

export class CustomerSync {
  constructor(cache) {
    this.cache = cache
  }

  // `this.cache` is injected; its store() is not the function in helpers/store.js.
  async run(id) {
    const res = await axios.get(`${BILLING_URL}/customers/${id}`)
    this.cache.store(res.data.customer)
  }
}
