import os

import requests

BILLING_URL = os.environ["BILLING_URL"]


def get_json(path):
    return requests.get(BILLING_URL + path).json()


def legacy_id(customer_id):
    print(get_json("/customers/" + customer_id)["customer"]["legacy_id"])
