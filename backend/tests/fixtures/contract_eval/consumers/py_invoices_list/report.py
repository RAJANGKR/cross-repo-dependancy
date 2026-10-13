import os

import requests

BILLING_URL = os.environ["BILLING_URL"]


def open_total():
    response = requests.get(f"{BILLING_URL}/invoices", params={"status": "open"})
    total = 0
    for invoice in response.json():
        total += invoice["amount"]
    print(total)
