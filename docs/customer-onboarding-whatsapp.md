# Customer Onboarding — WhatsApp Setup Guide

This guide walks you through connecting your WhatsApp number to the platform. Follow the steps in order — it takes about 30–60 minutes, plus additional time for Meta's business verification process if you haven't done it before.

---

## Before you start — Meta Business Verification is required

**Your business must be verified by Meta before you can use this platform.**

Meta Business Verification confirms your business identity and is required to:
- Publish your Meta App and receive real customer messages
- Increase your daily messaging limits
- Access the full WhatsApp Business API without restrictions

**How to verify your business:**

1. Go to **business.facebook.com → Settings → Security Center**
2. Click **Start Verification**
3. Submit your business details and supporting documents (business registration, address, phone number)
4. Wait for Meta's review — this typically takes **1–5 business days**

> Start this process first. You can complete the rest of the setup steps below while you wait, but your account won't go live until verification is approved.

---

## What you'll need before starting

- A personal Facebook account
- A verified Meta Business Portfolio (see above)
- A business phone number not already active on WhatsApp personal or WhatsApp Business App

---

## Step 1 — Create a Business Portfolio

> Skip this step if you already have one under the same Facebook account.

1. Go to **business.facebook.com**
2. Click **Create a Business Portfolio**
3. Enter your business name, your name, and your business email
4. Click **Create**

---

## Step 2 — Create a Developer App

1. Go to **developers.facebook.com**
2. Click **My Apps → Create App**
3. On the **Use Cases** step, select **Other**
4. On the **Business** step, select your Business Portfolio from the dropdown
5. Give the app a name (e.g. your company name) and click **Create**

---

## Step 3 — Add WhatsApp to your app

1. Inside the app dashboard, find **Add a product**
2. Click **Set up** next to **WhatsApp**
3. When prompted, create a new **WhatsApp Business Account (WABA)**

You will land on the **WhatsApp API Setup** page. Note these two values:

| Value | Where it is |
|---|---|
| **Phone Number ID** | WhatsApp → API Setup |
| **WhatsApp Business Account ID (WABA ID)** | WhatsApp → API Setup |

---

## Step 4 — Add and verify your business phone number

1. Under **WhatsApp → API Setup**, click **Add phone number**
2. Enter your business phone number
3. Verify it via SMS or voice call

> Your number must not be registered on WhatsApp personal or WhatsApp Business App. If it is, delete it from those apps first — you will lose existing chat history on that number.

---

## Step 5 — Get a permanent access token

The temporary token shown on the API Setup page expires in 24 hours. You need a permanent one:

1. Go to **business.facebook.com → Settings → System Users**
2. Click **Add**, name it (e.g. "Platform Bot"), set role to **Admin**
3. Click **Generate Token**
4. Select your Developer App
5. Enable these permissions:
   - `whatsapp_business_messaging` — **required** (sending)
   - `whatsapp_business_management` — **required** (templates, phone-number node)
   - `business_management` — **grant this too.** Meta lists it as *optional*,
     and it is, for sending. But it is what lets us read the **business
     portfolio** — and since 2025-10-07 the portfolio is what owns the 24-hour
     messaging limit (shared by every number under it) and the template limit
     (250 unverified, up to 6,000 verified). Without it the Channels →
     WhatsApp panel shows "Business portfolio not resolved", the shared 24h
     budget and template headroom are blank, and large broadcasts go out
     **ungated** — Meta still enforces the real limit, so the failure mode is a
     refused send rather than an overcharge, but you lose the warning that
     would have prevented it.

   You do **not** need `whatsapp_business_manage_events` (Marketing Messages
   Lite API + Conversions API only) or `email`.
6. Set expiration to **Never**
7. Copy and save the token — Meta only shows it once

---

## Step 6 — Get your App ID and App Secret

1. In your Developer App, go to **Settings → Basic**
2. Copy your **App ID**
3. Click **Show** next to App Secret, enter your password, and copy it

---

## Send these 5 values to your platform provider

| Field | Where to find it |
|---|---|
| **Phone Number ID** | WhatsApp → API Setup |
| **WABA ID** | WhatsApp → API Setup |
| **Permanent Access Token** | Business Manager → System Users |
| **App ID** | App → Settings → Basic |
| **App Secret** | App → Settings → Basic → Show |

Once you send these, your provider handles the rest — webhook configuration, verification, and connecting your number to the platform.

---

## Step 7 — Publish your app (go live)

Your Meta App starts in **Development mode**. In this mode, only phone numbers you explicitly add as test recipients can receive messages — real customers cannot contact you yet.

To go live:

1. Complete Meta Business Verification (see the top of this guide)
2. In your Meta App Dashboard, go to **App Review → Permissions and Features**
3. Request the `whatsapp_business_messaging` permission
4. Submit your app for review
5. Once approved, your app switches to **Live mode** and any customer can message you

Your provider will assist you through the App Review submission when you are ready.

---

## Things to know

- **24-hour window.** Once a customer messages you, you have 24 hours to reply freely. After that, only pre-approved Message Templates can be sent.
- **No past history.** The platform only receives messages from the moment your number is connected — past WhatsApp conversations are not imported.
- **One number per account.** Each business phone number belongs to one WhatsApp Business Account and cannot be shared across multiple platforms simultaneously.
- **Business verification is not optional.** Without it, your app stays in Development mode permanently and cannot receive messages from real customers.
