import os

import requests

BILLING_API = os.environ["BILLING_API"]


def create_invoice(amount, memo):
    payload = {"amount": amount, "memo": memo}
    response = requests.post(f"{BILLING_API}/invoices", json=payload, timeout=5)
    return response.status_code == 201
