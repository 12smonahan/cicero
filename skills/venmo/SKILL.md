---
name: venmo
description: Read pending Venmo requests and send payment requests via the Venmo API.
metadata:
  {
    "openclaw":
      {
        "emoji": "💸",
        "requires": { "bins": ["python3"], "env": ["VENMO_ACCESS_TOKEN"] },
        "primaryEnv": "VENMO_ACCESS_TOKEN",
      },
  }
---

# Venmo

Manage Venmo payment requests. Check what you owe, request money from friends, and look up users.

## Commands

### Check pending requests (charges TO me)

```bash
python3 {baseDir}/scripts/venmo-cli.py pending
```

### Request money from someone

```bash
python3 {baseDir}/scripts/venmo-cli.py request --user-id USER_ID --amount 25.00 --note "Dinner split"
```

### Search for a Venmo user (to find their user ID)

```bash
python3 {baseDir}/scripts/venmo-cli.py search --query "John Smith"
```

### Get my profile info

```bash
python3 {baseDir}/scripts/venmo-cli.py me
```

### List my Venmo friends

```bash
python3 {baseDir}/scripts/venmo-cli.py friends
```

## Safety Rules

- **NEVER send or pay money.** This skill only supports _requesting_ money. The script has no `send` or `pay` command.
- **Always confirm with the user** before creating a request. Show the recipient name, amount, and note, and wait for explicit approval.
- **Never expose the access token** in messages or responses.

## Output

All commands return JSON. Present results to the user in natural language:

- For `pending`: summarize who is requesting money, the amount, and the note.
- For `request`: confirm the request was created successfully.
- For `search`: list matching users with their display name and username.
- For `friends`: list friends by display name and username.

## Token Setup

To generate a Venmo access token, run locally (not in Docker):

```bash
pip3 install venmo-api && python3 {baseDir}/scripts/generate-token.py
```

Add the resulting token to your environment as `VENMO_ACCESS_TOKEN`.
