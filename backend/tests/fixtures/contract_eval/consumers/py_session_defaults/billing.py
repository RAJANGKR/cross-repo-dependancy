import os

import requests

BILLING_URL = os.environ["BILLING_URL"]
session = requests.Session()
session.params = {"status": "open"}


def open_invoice_count():
    response = session.get(f"{BILLING_URL}/invoices")
    print(response.status_code)
