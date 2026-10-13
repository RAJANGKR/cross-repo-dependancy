# `crm` is a client for a different system that also has a fetch_customer().
def report(crm, customer_id):
    return crm.fetch_customer(customer_id)["customer"]["legacy_id"]
