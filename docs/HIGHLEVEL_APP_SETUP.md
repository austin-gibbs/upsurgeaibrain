# HighLevel Marketplace App — Setup Guide (UpSurge OAuth)

_Last verified against HighLevel's developer docs: 2026-06-22._

This registers the Marketplace app that UpSurge uses to connect a HighLevel
sub-account, pull pipelines, and move opportunities between stages. The app code
(OAuth connect/callback routes, token refresh) is already built — this is the
one-time portal registration plus copying the credentials into your env.

The values below must match the code exactly: the redirect path is
`/api/oauth/crm/callback` and the scopes match what
`src/lib/crm/highlevel-oauth.ts` requests.

---

## 0. Before you start

- A HighLevel **Agency** login (developer accounts are created from an agency account).
- One **sub-account** (location) you can use to test the connect flow.
- Your production app URL: **`https://upsurgeprosai.com`** (this is what
  `NEXT_PUBLIC_APP_URL` is set to in production; the redirect URL must match it).

---

## 1. Create a developer account + app

1. Go to **https://marketplace.gohighlevel.com** and sign in with your HighLevel
   account. If prompted, create / activate your **Developer** account.
2. Open **My Apps → Create App**.
3. Fill the core details:
   - **App Name:** `UpSurge` (or `UpSurge AI Voice`)
   - **Distribution Type:** **Private** — keep it private while building/testing.
     Only switch to Public if you ever list it publicly; private is correct for
     your own internal integration.
   - **App Type / Access Level:** **Sub-Account (Location)**. UpSurge connects one
     location at a time and operates on that location's contacts + opportunities.
     (Do **not** pick Agency/Company — the code requests a Location-level token.)

---

## 2. Add the Redirect URLs

Under the app's **OAuth / Auth** settings, find the **Redirect URL** field. HighLevel
lets you add **multiple** redirect URLs — add both of these (type each, click **Add**):

| Purpose | Redirect URL |
| --- | --- |
| **Production** | `https://upsurgeprosai.com/api/oauth/crm/callback` |
| **Local testing** | `http://localhost:3000/api/oauth/crm/callback` |

The redirect that gets used at runtime is `${NEXT_PUBLIC_APP_URL}/api/oauth/crm/callback`,
so whatever `NEXT_PUBLIC_APP_URL` is in a given environment must **exactly** match one
of the URLs registered here (scheme, host, path — no trailing slash). A mismatch is the
#1 cause of "redirect_uri mismatch" errors.

> If HighLevel pre-fills a default localhost entry, you can leave it; just make sure
> the two URLs above are present.

---

## 3. Add the Scopes

In the **Scopes** section, add exactly these six (minimum needed for pipeline routing
+ contact/opportunity moves). Request no more than these:

```
contacts.readonly
contacts.write
opportunities.readonly
opportunities.write
locations.readonly
users.readonly
```

What each is for:
- `opportunities.readonly` / `opportunities.write` — find and move the contact's
  opportunity to the mapped pipeline stage (the core feature).
- `contacts.readonly` / `contacts.write` — read the contact and write tags/notes.
- `locations.readonly` — read pipeline + stage lists for the connected sub-account.
- `users.readonly` — resolve assignable users (task assignment).

---

## 4. Generate Client Keys (Client ID + Secret)

1. In the **Client Keys** section, click **Add**.
2. HighLevel generates a **Client ID** and **Client Secret**.
3. **Copy the Client Secret immediately and store it somewhere safe.** HighLevel will
   **not** show the secret again — if you lose it you have to generate a new key pair.

---

## 5. Put the credentials into your env

Add these to `.env.local` (local) **and** to both deploy targets — **Vercel** (the
Next.js app, which runs the OAuth routes) and **Railway** (the worker):

```bash
HIGHLEVEL_CLIENT_ID=<your client id>
HIGHLEVEL_CLIENT_SECRET=<your client secret>
```

(These keys are already listed in `.env.example`.) Make sure each environment's
`NEXT_PUBLIC_APP_URL` matches the redirect URL you registered for that environment
(prod → `https://upsurgeprosai.com`, local → `http://localhost:3000`).

Never commit `.env.local`.

---

## 6. Connect a sub-account and verify

1. Deploy / run the app with the env vars set.
2. Open a HighLevel agent's detail page in UpSurge → click **Connect via OAuth**.
3. Choose the sub-account → approve → you're redirected back with `?crm=connected`.
   Tokens (access + refresh + expiry) are stored encrypted on the agent and refresh
   automatically from then on.
4. Confirm the **Pipeline routing** editor on the agent page now populates pipelines
   and stages from that sub-account.

---

## Common errors

- **`redirect_uri mismatch`** — the runtime redirect (`NEXT_PUBLIC_APP_URL` +
  `/api/oauth/crm/callback`) isn't one of the URLs registered in Step 2. Fix the
  env value or add the URL.
- **`invalid_client`** — `HIGHLEVEL_CLIENT_ID` / `HIGHLEVEL_CLIENT_SECRET` are wrong,
  missing, or set in the wrong environment (remember: the **app** does the token
  exchange, so Vercel needs them; the **worker** refreshes tokens, so Railway needs
  them too).
- **`insufficient scope` / 403 on opportunities** — a scope from Step 3 is missing;
  add it, then re-connect the location so a new token is issued with the scope.
- **Token works then 401s after ~a day** — expected; the adapter auto-refreshes. If it
  doesn't recover, the refresh token wasn't stored — re-run Connect via OAuth.

---

## Quick reference

| Field | Value |
| --- | --- |
| Portal | https://marketplace.gohighlevel.com → My Apps → Create App |
| Distribution | Private |
| Access level | Sub-Account (Location) |
| Redirect (prod) | `https://upsurgeprosai.com/api/oauth/crm/callback` |
| Redirect (local) | `http://localhost:3000/api/oauth/crm/callback` |
| Scopes | `contacts.readonly contacts.write opportunities.readonly opportunities.write locations.readonly users.readonly` |
| Env vars | `HIGHLEVEL_CLIENT_ID`, `HIGHLEVEL_CLIENT_SECRET` (Vercel + Railway + `.env.local`) |
