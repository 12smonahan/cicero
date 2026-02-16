---
name: amazon-purchase
description: Search, add to cart, and purchase items on Amazon using secure browser actions. Always requires user approval before checkout. Triggers: buy on amazon, amazon order, amazon purchase.
metadata: {"openclaw":{"emoji":"📦","requires":{"plugins":["secure-browser"],"env":["OP_SERVICE_ACCOUNT_TOKEN"]}}}
---

# Amazon Purchase (via Secure Browser)

Goal: search for products on Amazon, add them to cart, and complete checkout — with secure vault login and mandatory purchase approval.

## Hard safety rules

- **NEVER** complete a checkout without calling `confirm_action` and receiving approval.
- **NEVER** type or expose passwords — always use `vault_login` for authentication.
- **NEVER** type credit card numbers — use `vault_fill` if payment info needs entry.
- Always show the user what's in the cart before requesting checkout approval.
- If the user says "stop" or "cancel" at any point, abandon the workflow immediately.

## Step 1: Log in

```
vault_login({ site: "amazon.com" })
```

If this fails, ask the user to ensure their Amazon credentials are in 1Password with the item name "amazon" (or specify a custom `vaultItem`).

## Step 2: Search for the product

```
browser({ action: "navigate", targetUrl: "https://www.amazon.com", profile: "openclaw" })
```

Then use the search bar:

1. Take a snapshot to find the search input ref
2. Type the search query into the search box
3. Submit the search form
4. Take a snapshot of results to find product listings

## Step 3: Select the product

1. Take a snapshot of search results
2. Click the desired product link
3. Take a snapshot/screenshot of the product page
4. Confirm with the user: show them the product name, price, and any options (size, color, quantity)

## Step 4: Add to cart

1. Find and click "Add to Cart" button
2. Wait for cart confirmation
3. Take a snapshot to verify the item was added

## Step 5: Proceed to checkout

1. Navigate to cart: `browser({ action: "navigate", targetUrl: "https://www.amazon.com/gp/cart/view.html", profile: "openclaw" })`
2. Take a screenshot of the cart
3. **Call `confirm_action` with a summary of the cart contents and total price**

```
confirm_action({
  action: "Purchase on Amazon",
  details: "Items:\n- [Product Name] x1 — $XX.XX\n\nSubtotal: $XX.XX\nShipping: $X.XX\nTotal: $XX.XX",
  screenshot: true
})
```

4. **Only proceed if `approved: true`**. If denied, stop and inform the user.

## Step 6: Complete purchase

1. Click "Place your order" / "Buy now"
2. Take a screenshot of the order confirmation
3. Report the order number and expected delivery date to the user

## Troubleshooting

- **Login fails**: User may need to add/update Amazon credentials in 1Password
- **2FA prompt not recognized**: Ask user to check their 1Password item has a TOTP field configured
- **Cart page looks different**: Amazon frequently changes layouts. Take a snapshot and adapt to the current page structure
- **Payment method needs updating**: Use `vault_fill` to enter card details if prompted
