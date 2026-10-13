import os

import requests

BILLING_URL = os.environ["BILLING_URL"]


def legacy_id(customer_id):
    response = requests.get(f"{BILLING_URL}/customers/{customer_id}")
    response.raise_for_status()
    status = response.json().get("status")
    return response.json()["customer"]["legacy_id"], status
