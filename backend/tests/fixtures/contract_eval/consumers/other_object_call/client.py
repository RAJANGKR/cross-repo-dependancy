import os

import requests

BILLING_URL = os.environ["BILLING_URL"]


def fetch_customer(customer_id):
    return requests.get(f"{BILLING_URL}/customers/{customer_id}").json()
