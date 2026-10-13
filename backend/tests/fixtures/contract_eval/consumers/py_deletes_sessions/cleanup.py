import os

import requests

BILLING_URL = os.environ["BILLING_URL"]


def sign_out_everywhere(customer_id):
    requests.delete(f"{BILLING_URL}/customers/{customer_id}/sessions")
