#!/usr/bin/env python3
"""Venmo CLI — self-contained script using only stdlib.

Commands:
    pending   List pending payment requests (charges TO me)
    request   Create a payment request (charge someone)
    search    Search for Venmo users by name/username
    me        Get my profile info
    friends   List my Venmo friends
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

BASE_URL = "https://api.venmo.com/v1"


def get_token():
    token = os.environ.get("VENMO_ACCESS_TOKEN")
    if not token:
        print(json.dumps({"error": "VENMO_ACCESS_TOKEN environment variable is not set"}))
        sys.exit(1)
    return token


def api_request(method, path, token, data=None, params=None):
    """Make an authenticated request to the Venmo API."""
    url = BASE_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params)

    headers = {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": "venmo-cli/1.0",
    }

    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        try:
            error_json = json.loads(error_body)
        except (json.JSONDecodeError, ValueError):
            error_json = {"raw": error_body}
        print(json.dumps({"error": f"HTTP {e.code}", "details": error_json}))
        sys.exit(1)
    except urllib.error.URLError as e:
        print(json.dumps({"error": str(e.reason)}))
        sys.exit(1)


def cmd_pending(args, token):
    """List pending payment requests (charges TO me)."""
    resp = api_request("GET", "/payments", token, params={
        "status": "pending",
        "action": "charge",
        "limit": str(args.limit),
    })
    payments = resp.get("data", [])
    results = []
    for p in payments:
        actor = p.get("actor", {})
        target = p.get("target", {})
        target_user = target.get("user", {})
        results.append({
            "id": p.get("id"),
            "amount": p.get("amount"),
            "note": p.get("note"),
            "date_created": p.get("date_created"),
            "from": {
                "display_name": actor.get("display_name"),
                "username": actor.get("username"),
            },
            "to": {
                "display_name": target_user.get("display_name"),
                "username": target_user.get("username"),
            },
        })
    print(json.dumps({"pending_requests": results, "count": len(results)}, indent=2))


def cmd_request(args, token):
    """Create a payment request (charge someone)."""
    amount = float(args.amount)
    if amount <= 0:
        print(json.dumps({"error": "Amount must be positive. The script negates it to create a request."}))
        sys.exit(1)

    resp = api_request("POST", "/payments", token, data={
        "user_id": args.user_id,
        "amount": -amount,  # negative = request money FROM user
        "note": args.note,
        "audience": args.audience,
    })
    payment = resp.get("data", {})
    print(json.dumps({
        "success": True,
        "payment_id": payment.get("id"),
        "amount": payment.get("amount"),
        "note": payment.get("note"),
        "target": payment.get("target", {}).get("user", {}).get("display_name"),
        "status": payment.get("status"),
    }, indent=2))


def cmd_search(args, token):
    """Search for Venmo users by name or username."""
    resp = api_request("GET", "/users", token, params={
        "query": args.query,
        "limit": str(args.limit),
    })
    users = resp.get("data", [])
    results = []
    for u in users:
        results.append({
            "id": u.get("id"),
            "username": u.get("username"),
            "display_name": u.get("display_name"),
            "profile_picture_url": u.get("profile_picture_url"),
        })
    print(json.dumps({"users": results, "count": len(results)}, indent=2))


def cmd_me(args, token):
    """Get my profile info."""
    resp = api_request("GET", "/me", token)
    data = resp.get("data", {})
    user = data.get("user", {})
    print(json.dumps({
        "id": user.get("id"),
        "username": user.get("username"),
        "display_name": user.get("display_name"),
        "email": user.get("email"),
        "phone": user.get("phone"),
        "profile_picture_url": user.get("profile_picture_url"),
        "balance": data.get("balance"),
    }, indent=2))


def cmd_friends(args, token):
    """List my Venmo friends."""
    # First get my user ID
    me_resp = api_request("GET", "/me", token)
    my_id = me_resp.get("data", {}).get("user", {}).get("id")
    if not my_id:
        print(json.dumps({"error": "Could not determine user ID"}))
        sys.exit(1)

    resp = api_request("GET", f"/users/{my_id}/friends", token, params={
        "limit": str(args.limit),
    })
    friends = resp.get("data", [])
    results = []
    for f in friends:
        results.append({
            "id": f.get("id"),
            "username": f.get("username"),
            "display_name": f.get("display_name"),
            "profile_picture_url": f.get("profile_picture_url"),
        })
    print(json.dumps({"friends": results, "count": len(results)}, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Venmo CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    # pending
    p_pending = sub.add_parser("pending", help="List pending payment requests")
    p_pending.add_argument("--limit", type=int, default=25, help="Max results")

    # request
    p_request = sub.add_parser("request", help="Create a payment request")
    p_request.add_argument("--user-id", required=True, help="Target user ID")
    p_request.add_argument("--amount", required=True, help="Amount to request (positive number)")
    p_request.add_argument("--note", required=True, help="Payment note/description")
    p_request.add_argument("--audience", default="private", choices=["private", "friends", "public"],
                           help="Visibility (default: private)")

    # search
    p_search = sub.add_parser("search", help="Search for Venmo users")
    p_search.add_argument("--query", required=True, help="Search query (name or username)")
    p_search.add_argument("--limit", type=int, default=10, help="Max results")

    # me
    sub.add_parser("me", help="Get my profile info")

    # friends
    p_friends = sub.add_parser("friends", help="List my Venmo friends")
    p_friends.add_argument("--limit", type=int, default=50, help="Max results")

    args = parser.parse_args()
    token = get_token()

    commands = {
        "pending": cmd_pending,
        "request": cmd_request,
        "search": cmd_search,
        "me": cmd_me,
        "friends": cmd_friends,
    }
    commands[args.command](args, token)


if __name__ == "__main__":
    main()
