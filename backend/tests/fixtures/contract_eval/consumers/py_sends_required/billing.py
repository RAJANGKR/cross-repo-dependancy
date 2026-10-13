import os

import requests

BILLING_API = os.environ["BILLING_API"]


def create_invoice(amount, currency):
    payload = {"amount": amount}
    payload["currency"] = currency
    response = requests.post(f"{BILLING_API}/invoices", json=payload)
    invoice_id = response.json()["id"]
    print("created", invoice_id)
