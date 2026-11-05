# Hair studio website

Public site with services, prices, online booking, reviews, hours and contact info, plus a password-protected booking portal for the stylist.

No dependencies. Needs Node.js 18 or newer.

## Run it

```bash
ADMIN_PASSWORD="pick-a-strong-password" SESSION_SECRET="any-long-random-string" npm start
```

- Website: http://localhost:3000
- Booking portal: http://localhost:3000/admin

If `ADMIN_PASSWORD` isn't set, a temporary one is printed in the terminal on startup.
Set `SESSION_SECRET` so staff stay logged in after a restart.

## Make it yours

Edit `config.js`: salon name, stylist name, about text, phone, email, address, Instagram,
time zone, opening hours, services (name, length, price) and policies. Restart after editing.

Don't change a service `id` once bookings exist. Change the name/price instead.

## How booking works

- Clients pick a service, a date and a free time. Times that would overlap an existing booking,
  fall outside opening hours, are in the past, or are inside the minimum notice window are never offered.
- The server re-checks availability at the moment of booking, so two people can't grab the same slot.
- New bookings come in as **Pending**. In the portal you can Confirm, Mark done, Cancel, Restore or Delete.
  Cancelling frees the slot.
- New reviews are hidden until you approve them in the portal's Reviews tab.

## Data

Stored in `data/db.json` (created automatically, not committed). Back this file up.
Set `DATA_DIR` to store it elsewhere.

## Deploying

Any host that runs a Node server with a persistent disk works (Render, Railway, Fly.io, a VPS).
Set `NODE_ENV=production` (marks the login cookie as HTTPS-only), `ADMIN_PASSWORD` and `SESSION_SECRET`,
and serve it over HTTPS. Serverless hosts without a persistent disk will lose bookings.

## Tests

```bash
npm test
```
