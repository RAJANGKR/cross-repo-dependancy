from client import fetch_customer


def badge(customer_id):
    customer = fetch_customer(customer_id)["customer"]
    label = f"#{customer['legacy_id']}"
    print(label)
