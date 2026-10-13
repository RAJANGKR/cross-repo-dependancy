import os

import requests

BILLING_API = os.environ["BILLING_API"]


def create_invoice(amount, currency=None):
    payload = {"amount": amount}
    if currency:
        payload["currency"] = currency
    requests.post(f"{BILLING_API}/invoices", json=payload)
