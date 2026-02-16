---
name: airbnb-booking
description: Search listings, compare options, and book stays on Airbnb using secure browser actions. Always requires user approval before booking. Triggers: book airbnb, airbnb reservation, find airbnb.
metadata: {"openclaw":{"emoji":"🏠","requires":{"plugins":["secure-browser"],"env":["OP_SERVICE_ACCOUNT_TOKEN"]}}}
---

# Airbnb Booking (via Secure Browser)

Goal: search for Airbnb listings, compare options, and complete a booking — with secure vault login and mandatory booking approval.

## Hard safety rules

- **NEVER** complete a booking without calling `confirm_action` and receiving approval.
- **NEVER** type or expose passwords — always use `vault_login` for authentication.
- **NEVER** type payment details manually — use `vault_fill` if payment info needs entry.
- Always show the user listing details, dates, and total price before requesting booking approval.
- If the user says "stop" or "cancel", abandon the workflow immediately.

## Step 1: Log in

```
vault_login({ site: "airbnb.com" })
```

## Step 2: Search for listings

Build a search URL with the user's criteria:

```
browser({
  action: "navigate",
  targetUrl: "https://www.airbnb.com/s/[location]/homes?checkin=[YYYY-MM-DD]&checkout=[YYYY-MM-DD]&adults=[N]",
  profile: "openclaw"
})
```

Parameters to ask the user for:

- **Location** (city, neighborhood, or address)
- **Check-in / check-out dates**
- **Number of guests** (adults, children)
- **Budget range** (optional — use price filters on the page)
- **Preferences** (entire place vs. private room, amenities, etc.)

## Step 3: Browse and compare listings

1. Take a snapshot of search results
2. Present the top 3–5 options to the user with: name, price/night, total price, rating, key amenities
3. Let the user pick which listing(s) to explore further
4. Click into the selected listing
5. Take a screenshot of the listing detail page
6. Summarize: nightly rate, total cost, cancellation policy, house rules, host rating

## Step 4: Reserve the listing

1. Click "Reserve" on the chosen listing
2. Wait for the reservation summary page to load
3. Take a screenshot showing the full price breakdown
4. **Call `confirm_action` with booking details**

```
confirm_action({
  action: "Book Airbnb stay",
  details: "Listing: [Name]\nHost: [Host Name] (★[rating])\nDates: [check-in] → [check-out] ([N] nights)\nGuests: [N]\n\nPrice breakdown:\n- Nightly rate: $XX × [N] nights = $XXX\n- Cleaning fee: $XX\n- Service fee: $XX\n- Total: $XXX",
  screenshot: true
})
```

5. **Only proceed if `approved: true`**. If denied, stop and inform the user.

## Step 5: Complete booking

1. Click "Confirm and pay" / complete the booking
2. If payment details are needed, use `vault_fill` for credit card fields
3. Take a screenshot of the booking confirmation
4. Report the confirmation number, check-in instructions, and host contact info

## Troubleshooting

- **Login fails**: User may need to add/update Airbnb credentials in 1Password
- **Listing unavailable for selected dates**: Go back to search results and suggest alternatives
- **Price changed**: Re-take screenshot and re-request approval with updated price
- **Airbnb asks for phone verification**: Inform the user — this requires manual intervention
