# Duka Debt

A simple digital debt-book for small shop owners: record what customers owe,
see the total at a glance, and send a WhatsApp reminder in one tap.

## What's in this folder

- `index.html` — the app page
- `styles.css` — all the design
- `app.js` — all the logic (auth, adding customers/debts, reminders)
- `config.js` — where you paste your own Supabase credentials
- `schema.sql` — the database setup, run once in Supabase

## Step 1 — Create your Supabase project

1. Go to https://supabase.com and sign up (free).
2. Click **New project**. Pick any name (e.g. "duka-debt"), set a database
   password (save it somewhere), and choose a region close to Kenya if offered.
3. Wait a minute or two for it to finish setting up.

## Step 2 — Set up the database

1. In your new project, open the **SQL Editor** (left sidebar).
2. Click **New query**, paste in the entire contents of `schema.sql`, and
   click **Run**.
3. You should see "Success. No rows returned." That means your `customers`
   and `debts` tables are ready, and locked down so each shop owner only
   ever sees their own data.

## Step 3 — Connect the app to your project

1. In Supabase, go to **Settings -> API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `config.js` in this folder and paste them in:
   ```js
   const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```

## Step 4 — Turn on email sign-up

1. In Supabase, go to **Authentication -> Providers**, confirm **Email** is enabled.
2. If you don't want new users to confirm their email before signing in
   (fine while testing), go to **Authentication -> Settings** and turn off
   "Confirm email."

## Step 5 — Put it on GitHub

1. Create a free GitHub account if you don't have one: https://github.com
2. Create a new repository (e.g. `duka-debt`).
3. Upload all the files in this folder to that repository (GitHub's
   "Add file -> Upload files" button works fine for this — no command line
   needed).

## Step 6 — Deploy on Cloudflare Pages

1. Go to https://pages.cloudflare.com and sign up (free).
2. Click **Create a project -> Connect to Git**, and choose your `duka-debt`
   repository.
3. Leave the build settings empty (this app has no build step — it's plain
   HTML/CSS/JS) and click **Save and Deploy**.
4. In a minute, you'll get a free link like `duka-debt.pages.dev` — that's
   your live app. Send it to a shopkeeper on WhatsApp and they can open it
   straight from their phone.

## Trying it yourself first

Open `index.html` directly in a browser (after filling in `config.js`) to
test everything before you deploy — sign up with your own email, add a test
customer, add a debt, and try the "Remind on WhatsApp" button.

## What to build next

- Let a shop owner edit/delete a customer or a debt they entered by mistake
- A simple stock list, so "what they owe" can link to "what they bought"
- Multiple staff logins for one shop (the "Business" tier from the pricing plan)
