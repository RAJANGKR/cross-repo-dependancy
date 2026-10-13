import axios from 'axios'

axios.interceptors.request.use((config) => {
  config.data = { ...config.data, currency: 'EUR' }
  return config
})
