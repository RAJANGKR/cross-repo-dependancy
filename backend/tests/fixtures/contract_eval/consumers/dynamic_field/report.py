import os

import requests

BILLING_URL = os.environ["BILLING_URL"]
FIELDS = ["legacy_id", "name"]


def export(customer_id):
    body = requests.get(f"{BILLING_URL}/customers/{customer_id}").json()
    return [body["customer"][name] for name in FIELDS]
