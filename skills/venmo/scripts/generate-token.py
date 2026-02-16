#!/usr/bin/env python3
"""Generate a Venmo access token interactively.

Run locally (not in Docker) since it requires 2FA input:
    pip3 install venmo-api
    python3 generate-token.py

The token does not expire. Add it to your environment:
    export VENMO_ACCESS_TOKEN="<token>"
"""

import sys

try:
    from venmo_api import Client
except ImportError:
    print("venmo-api is not installed. Install it first:")
    print("  pip3 install venmo-api")
    sys.exit(1)


def main():
    print("=== Venmo Access Token Generator ===\n")
    username = input("Venmo email or phone: ").strip()
    password = input("Venmo password: ").strip()

    if not username or not password:
        print("Error: email/phone and password are required.")
        sys.exit(1)

    print("\nAuthenticating... Venmo will send a 2FA code via SMS or email.")
    try:
        access_token = Client.get_access_token(username=username, password=password)
        print("\n=== Your Access Token ===")
        print(access_token)
        print("\nAdd this to your .env file:")
        print(f"  VENMO_ACCESS_TOKEN={access_token}")
    except Exception as e:
        print(f"\nAuthentication failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
