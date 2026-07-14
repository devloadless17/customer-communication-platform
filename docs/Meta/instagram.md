# Getting Started



This document explains how to successfully call Messenger API support for Instagram (also known as Instagram Messaging API in our Developer Policies) with your app and get Instagram professional account messages.

**Note:** If your app users don't have a Facebook Page linked to their Instagram professional account, learn more about building an app with [the Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram/platform/instagram-api).


## Before you start

You will need access to the following:

* An Instagram [professional account](https://www.facebook.com/help/instagram/138925576505882)
* A Facebook Page connected to that [account](https://developers.facebook.com/docs/instagram-api/overview#pages)
* A Meta Developer account that can perform the [`MODERATE` task](https://developers.facebook.com/docs/instagram-api/overview#tasks) on that Page
* A [Meta App](https://developers.facebook.com/docs/apps#register) created with the Facebook Login Use Case and with Basic settings configured

If you are a developer who is new to the Messenger Platform:

- Follow the step-by-step guide detailed below on how to generate Page access token, webhooks setup.

- Learn about the various [platform features](https://developers.facebook.com/docs/messenger-platform/instagram/features) and adopt those that suit your needs.

Developers with prior experience on the Messenger Platform

* Access token and webhooks concepts are similar. Messenger API support for Instagram will require `instagram_manage_messages` in the Page access token and Instagram topic webhooks subscribed.
* Most of the features are similar to Messenger API. Review the details on feature list and adopt those that suit your needs.

### Login flow

You can use Facebook Login for Business or Business Login for Instagram to ask your app users for the needed permissions.

The
[Business Login for Instagram](https://developers.facebook.com/docs/instagram/business-login-for-instagram) flow allows a person to complete the following during the login flow:

- convert their Instagram account to an Instagram professional account

- create a Facebook Page for their business

- connect that Page to their Instagram professional account

To implement Business Login for Instagram, visit our
[Business Login for Instagram guide](https://developers.facebook.com/docs/instagram/business-login-for-instagram) then return to this guide.

## 1. Get a user access token

Make sure you are signed into your Facebook Developer account, then access your app and trigger the Facebook Login modal. Remember, your Facebook Developer account must be able to perform [Tasks](https://developers.facebook.com/docs/pages-api/overview#tasks) with at least "Moderate" level access on the [Facebook Page](https://developers.facebook.com/docs/pages-api/overview) connected to the Instagram account you want to query.

Once you have triggered the modal, click OK to grant your app the `instagram_basic`, `instagram_manage_messages`, and `pages_manage_metadata` permissions.

The API should return a User access token. Capture the token so your app can use it in the next few queries. If you are using the Graph API Explorer, it will be captured automatically and displayed in the Access Token field for reference:

## 2. Get the user's Pages

Query the `GET /me/accounts` endpoint (this translates to `GET /{user-id}/accounts`, which performs a GET on the Facebook [User](https://developers.facebook.com/docs/graph-api/reference/user) node, based on your access token).

```bash
curl -i -X GET \
 "https://graph.facebook.com/v9.0/me/accounts?access_token={access-token}"
```

This should return a collection of Facebook Pages that the current Facebook User can perform the `MANAGE`, `CREATE_CONTENT`, `MODERATE`, or `ADVERTISE` tasks on:  

```json
{
  "data": [
    {
      "access_token": "EAAJjmJ...",
      "category": "App Page",
      "category_list": [
        {
          "id": "2301",
          "name": "App Page"
        }
      ],
      "name": "Metricsaurus",
      "id": "134895793791914",  // capture the Page ID
      "tasks": [
        "ANALYZE",
        "ADVERTISE",
        "MODERATE",
        "CREATE_CONTENT",
        "MANAGE"
      ]
    }
  ]
}
```

Capture the ID of the Facebook Page that's connected to the Instagram account that you want to query. Keep in mind that your app users may be able to perform tasks on multiple pages, so you eventually will have to introduce logic that can determine the correct Page ID to capture (or devise a UI where your app users can identify the correct Page for you).  

## 3. Get the Page access token

In order to perform various Instagram Messaging API calls, you will need to use the associated Page access token (PAT) of the relevant Instagram professional account that has been previously granted via Facebook login flow.

Send a `GET` request to the `/{page-id}` endpoint using your User access token. For example:

```bash
curl -i -X GET "https://graph.facebook.com/{page-id}?
  fields=access_token&
  access_token={user-access-token}"
```

On success, your app gets this response:

```json
{
  "access_token":"{page-access-token}",
  "id":"{page-id}"
}
```

* If you used a short-lived User access token, the Page access token is valid for only 1 hour.
* If you used a long-lived User access token, the Page access token has no expiration date.

To generate a long-lived Page access token, you can follow the guide [here](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived#get-a-long-lived-page-access-token).

## 3a. Get the Page access token via the Instagram Developer Dashboard tool {#app-dashboard}

**Note:** Meta is rolling out this tool to all developers over the coming weeks. If you don't see the settings under the App Dashboard, you can leverage Step 1-5 above to generate Page Access Tokens.

Optionally, if you own the assets (Instagram account and Facebook Page) that you want to onboard to Messenger API support for Instagram, you can leverage the Instagram setup tool under the Developer App Dashboard to allow you to easily setup Page access tokens and Webhooks. You can find the tool under Developer app dashboard → Messenger → Instagram Settings. Existing way of configuring tokens and webhook will still work, but this tool will give you an easier way to setup your environment.

## 4. Enable message control connected tools settings {#connected-tools-toggle}

In order to manage Instagram messages via API, Instagram professional accounts will need to enable the connected tools toggle under message controls settings. This setting can be found by going to:

**Instagram Settings > Messages and story replies >Message controls > Connected Tools > toggle Allow Access to Messages**

## 5. Get the Instagram professional account's Inbox Objects

Use the Page ID you captured and the Page access token (PAT) to query the `GET /{page-id}/conversations?platform=instagram` endpoint:  

```bash
curl -i -X GET \
 "https://graph.facebook.com/v9.0/17841405822304914/conversations?platform=instagram&access_token={access-token}"
```

This should return the IDs of all the thread objects on the Instagram user:

```json
{
  "data": [
    {
      "id": "aWdfZAG06MTpJR01lc3NhZA2VUaHJlYWQ6OTAwMTAxNDYyOTkyODI6MzQwMjgyMzY2ODQxNzEwMzAwOTQ5MTI4MTM2MDk5MDc1MzYyOTgx"
    },
    {
      "id": "aWdfZAG06MTpJR01lc3NhZA2VUaHJlYWQ6OTAwMTAxNDYyOTkyODI6MzQwMjgyMzY2ODQxNzEwMzAwOTQ5MTI4MTYzMzQ2MzE5NjM1NDcy"
    },
    {
      "id": "aWdfZAG06MTpJR01lc3NhZA2VUaHJlYWQ6OTAwMTAxNDYyOTkyODI6MzQwMjgyMzY2ODQxNzEwMzAwOTQ5MTI4MTk3MTY0NjI2NzAyMjMw"
    },
    {
      "id": "aWdfZAG06MTpJR01lc3NhZA2VUaHJlYWQ6OTAwMTAxNDYyOTkyODI6MzQwMjgyMzY2ODQxNzEwMzAwOTQ5MTI4MzkzNDI5MDYzMzkyNjU0"
    }
}
```

If you can perform this final query successfully, you should be able to perform queries using any of the Messenger API support for Instagram endpoints - just refer to our various guides and references to learn what each endpoint can do and what permission they require.

## Next steps

* [Develop your app further](https://developers.facebook.com/docs/messenger-platform/instagram/features) so it can successfully use any other endpoints it needs, and keep track of the permissions each endpoint requires
* Complete the [webhook setup](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks) so it can receive real time notifications whenever a user sends a message to the Instagram professional account.
* Complete the [App Review](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/app-review) process and request approval for all permissions your app will need so your app users can grant them while your app is in production.

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.

# Sample Instagram Experience



Original Coast Clothing is a fictional clothing brand created to showcase the key features of the Instagram Platform. Using this demo as inspiration, anyone can create a Messenger API support for Instagram experience that leverages both automation and live customer support. [Open-source code](https://github.com/fbsamples/original-coast-clothing-ig) for the app and a guide on how to deploy the experience on your local environment or remote server are provided.

Try it now by messaging **[@originalcoastclothing](http://instagram.com/originalcoastclothing?ref=DEVDOCS)** or **[commenting on a post](https://www.instagram.com/p/CNaLh5xgppt/)**.

## Platform features {#platform_features}

This experience leverages the following platform features. If you decide to [deploy the experience](#deploy) on your Page, the code will use them all:

* [Messaging](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/send-message)
    * Text, Image, and link previews
    * Generic templates
* [Webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)
* [Quick Replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/quick-replies)
* [User Profiles](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/user-profile)
* [Private Replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies)
* [Ice Breakers](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/ice-breakers)

## Deploy this experience on Instagram {#deploy}

By the end of this guide, you'll have a full Instagram app running on your server, answering messages from your account.

The code that powers this experience is open-source. Anyone can get started with developing a messaging experience.

The code is released under the BSD License, allowing you to use it freely for your needs. The code is hosted on [GitHub](https://github.com/fbsamples/original-coast-clothing-ig) for further reference.

### Requirements to deploy an Instagram app {#requirements}

- An **[Instagram Professional Account](https://www.facebook.com/help/instagram/138925576505882)** (either Creator or Business account).
- A **Facebook Page** [connected to that Instagram account](https://developers.facebook.com/docs/instagram-api/overview#pages). Make sure that you have a Facebook Page that represents your Instagram Professional account identity when connecting with users. To create a new Page, visit [https://www.facebook.com/pages/create](https://www.facebook.com/pages/create), you can also set up a test Page to start.
- A **Developer Account** that can perform [Tasks](https://developers.facebook.com/docs/instagram-api/overview#tasks) on your Page. A Developer Account allows you to create new apps, which are the core of any Facebook integration. You can register as a developer by going to the [Facebook Developers website](https://developers.facebook.com/) and clicking the "Get Started" button.
- A **[Facebook app](https://developers.facebook.com/docs/development/create-an-app)** with Basic settings configured. To create a new app, visit [https://developers.facebook.com/](https://developers.facebook.com/) and click on **Add New App**.

#### Setup steps {#setup}

The objective of this section is to gather all the access tokens and ids necessary for the Instagram app to successfully send and receive messages. Before you begin, make sure you have completed all of the requirements listed above. At this point you should have a Page, a registered Facebook app, and an Instagram Professional account.

If you just created a new Facebook app, it is probably in **development mode**. Note that apps in this mode are only allowed to message people connected to the app (Admins, Developers, and Testers). You can continue with this guide in this mode, but once your app is ready to be public, the app needs to go through app review for the [`instagram_manage_messages`](https://developers.facebook.com/docs/permissions/reference/instagram_manage_messages) permission. For more info, see [App Review](https://developers.facebook.com/docs/apps/review)

1. Configure your Instagram integration by following the [Getting Started](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started) documentation.
2. Add some Instagram test accounts that you'll use to test the experience.

At this point you should have the following:

- App ID
- App Secret
- Page ID
- Page Access Token
- Instagram Account connected to Page
- Instagram Account(s) registered as test accounts

## Installation {#installation}

You will need:

- [Node](https://nodejs.org/en/) 10.x or higher
- A server for your code. Options include:
    - Local tunneling service such as [ngrok](https://ngrok.com/)
    - Remote server service such as [Heroku](https://www.heroku.com/) or [Glitch](http://glitch.com/)
    - Your own web server

### One-click deploy using Heroku or Glitch {#one-click}

The experience can be automatically deployed to Heroku or Glitch using the following buttons. You will be prompted to enter the needed environment variables to complete the setup.

[Deploy on Heroku](https://bit.ly/3vU744Q)

[Deploy on Glitch](https://bit.ly/3wB07G1)

### Deploy locally using ngrok {#ngrok}

A tunneling service exposes your local web server to an external URL that can be reached by Facebook webhooks. There are many such services. In this example, you will use ngrok.

**1. Clone the repo**

Clone the repository to your local machine:

```bash
git clone https://github.com/fbsamples/original-coast-clothing-ig.git
cd original-coast-clothing-ig
```

**2. Install tunneling service**

If not already installed, install ngrok via [download](https://ngrok.com/download) or via command line:

```bash
$ npm install -g ngrok
```

In the directory of this repo, request a tunnel to your local server with your preferred port
```bash
$ ngrok http 3000
```

The screen should show the ngrok status:

```bash
Session Status                online
Account                       Redacted (Plan:iuluufkccebegkhifrlgfhudrtbthgln Free)
Version                       2.3.35
Region                        United States (us)
Web Interface                 http://127.0.0.1:4040
Forwarding                    http://1c3b838deacb.ngrok.io -> http://localhost:3000
Forwarding                    https://1c3b838deacb.ngrok.io -> http://localhost:3000
```

Note the https URL of the external server that is forwarded to your local machine. In the above example, it is `https://1c3b838deacb.ngrok.io`.

**3. Install the dependencies**

Open a new terminal tab, also in the repo directory.

```bash
$ npm install
```

Alternatively, you can use [Yarn](https://yarnpkg.com/en/):

```bash
$ yarn install
```

**4. Set up .env file**

Copy the file `.sample.env` to `.env`

```bash
$ cp .sample.env .env
```

Edit the `.env` file to add all the values for your app and page.

**5. Run your app locally**

```bash
$ node app.js
```

You should now be able to access the default page of the application in your browser at [http://localhost:3000](http://localhost:3000)

Confirm that you can also access the application at the external URL from step 2.

### Deploy using Heroku {#heroku}

**1. Clone the repo**

Clone the repository to your local machine:

```bash
git clone https://github.com/fbsamples/original-coast-clothing-ig.git
cd original-coast-clothing-ig
```

**2. Install the Heroku CLI**

If the directory is not already a git repo, create one:

```bash
$ git init
Initialized empty Git repository in .git/
$ git add .
$ git commit -m "My first commit"
```

**3. Install the Heroku CLI**

If not already installed, download and install the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli)

**4. Create an app from the CLI**

```bash
$ heroku apps:create

Creating app... done, ⬢ mystic-wind-83
Created http://mystic-wind-83.herokuapp.com/ | git@heroku.com:mystic-wind-83.git
```

Note the name given to your app. In this example, it was `mystic-wind-83`.

**5. Set your environment variables**

On the [Heroku App Dashboard](https://dashboard.heroku.com/), find your app and set up the config vars following the comments in the file `.sample.env`

Alternatively, you can set env variables from the command line like this:

```bash
$ heroku config:set PAGE_ID=XXXX
```

**6. Deploy the code**

```bash
$ git push heroku master
```

**7. View log output**

```bash
$ heroku logs --tail
```

### Connect your webhook {#webhook}

Now that your server is running, your webhook endpoint is at the path `/webhook`. In the Heroku example above, this would be `http://mystic-wind-83.herokuapp.com/webhook`.

Set up your webhook by following the [Messenger Platform Webhooks guide](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks).

After the webhook subscription is validated, subscribe to the following events:

- comments
- messages
- `messaging_postbacks`

Test the webhooks by clicking the "Test" buttons next to the subscribed events. You should see the test events in the log output of your server.

### Test that your app setup is successful {#test}

While logged in to an account with the role of "Instagram Tester", try sending a message to the Instagram account connected to your Page, or leaving a comment on a post.

If you see a response to your message in Instagram, you have fully set up your app.

### Troubleshooting {#troubleshooting}

#### The app only replies to me, but not someone else {#app_in_dev_mode}
The Facebook app is likely still in Development Mode. You can add someone as a tester of the app, if they accept, the app will be able to message them. Once ready, you may request the `instagram_manage_messages` permission to be able to reply to anyone.

#### Other issues {#issues}

Is this guide wrong? [Let us know by filing an Issue](https://github.com/fbsamples/original-coast-clothing/issues)
# Send a Message



This document contains the requirements for sending freeform messages from your Instagram Professional account to your customers or people interested in your account using the Messenger Platform from Meta.

**Note:** If your app users don't have a Facebook Page linked to their Instagram professional account, learn more about building an app with [the Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram/platform/instagram-api).


You can send a freeform message that contains:

* one or more images, a video, or an audio file
* a reaction or sticker
* text, including a link

## Before you start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components such as a Facebook Page linked to your Instagram Professional account (or test Page), registered as a Meta developer, and created a Business App ID with the Messenger > Instagram Messaging product in the App Dashboard.

You may also want to check the [status of the Meta Developer Platform](https://metastatus.com/#developerplatform) to ensure there are no issues.

### Requirements

* The ID for the Facebook Page linked to your Instagram Professional account
* The Instagram-scoped ID for customer who sent your business a message
* A Page access token requested from a person who can perform the `MESSAGE` task on the Facebook Page linked to your Instagram Professional account
* The `instagram_manage_messages` permission

### Limitations

- Apps with Standard Access can only send messages to people that have a role on the app
- Text message must be less than 1000 characters
- Media attachments can be:

| Media Type | Supported Format | Supported Size Maximum |
| --- | --- | --- |
| Audio | aac, m4a, wav, mp4 | 25MB |
| Image | png, jpeg | 8MB |
| Video | mp4, ogg, avi, mov, webm | 25MB |
| File | pdf | 25MB |

For more information about media attachments, see [Upload Media for Instagram Messaging](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/attachment-upload).

## Send a basic message

To send a message that contains text or a link, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID) and the `message` parameter containing the text or link.

Message text must be UTF-8 and be 1,000 bytes or less. Links must be valid formatted URLs.

### Sample request

_Formatted for readability._

```curl
curl -i -X POST \
  "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
  --data 'recipient={"id":"IGSID"}&message={"text":"TEXT-OR-LINK"}'
```

**Sample API response**

Upon success, your app receives the following JSON response:

```json
{
  "recipient_id": "IGSID",
  "message_id": "MESSAGE-ID"
}
```

## Send an image

To send an image, send a `POST` request to the `/me/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (`<IGSID>`) and the `message` parameter containing up to ten `attachment` objects with `type` set to `image` and `payload` containing `url` set to the URL for the image.

### Sample request: Sending one image

_Formatted for readability._

```curl
curl -X POST "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "recipient":{
               "id":"<IGSID>"
           },
           "message":{
              "attachment": {
                 "type":"image",
                 "payload":{
                   "url":"<IMAGE_URL>"
                 }
              }
           }
         }'
```

### Sample request: Sending multiple images with image URL

_Formatted for readability._

```curl
curl -X POST "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "recipient":{
               "id":"<IGSID>"
           },
           "message":{
              "attachments":[
                 {
                   "type":"image",
                   "payload":{
                     "url":"<IMAGE_URL>"
                   }
                 },
                 {
                   "type":"image",
                   "payload":{
                     "url":"<IMAGE_URL>"
                   }
                 },
                 {
                    ...
                 }
              ]
           }
         }'
```

### Sample request: Sending multiple images with attachment ID

The same images can be uploaded using the [Attachment Upload API](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/attachment-upload) and sent to many different users to avoid the delays and timeouts of uploading multiple high-resolution images. You can also mix both `url` and `attachment_id` parameters in the `payload`.

_Formatted for readability._

```curl
curl -X POST "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "recipient":{
               "id":"<IGSID>"
           },
           "message":{
              "attachments":[
                 {
                   "type":"image",
                   "payload":{
                     "attachment_id":"<attachment_ID>"
                   }
                 },
                 {
                   "type":"image",
                   "payload":{
                     "attachment_id":"<attachment_ID>"
                   }
                 },
                 {
                    ...
                 }
              ]
           }
         }'
```

**Sample API responses**

Upon success, your app receives the following JSON response:

```json
{
  "recipient_id": "IGSID",
  "message_id": "MESSAGE-ID"
}
```

## Send a published post

To send a message that contains a post you published to Instagram, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID) and the `message` parameter containing an `attachment` object with the `type` set to `MEDIA_SHARE` and `payload` containing the Meta ID for the post.

Your business must own the media you send in the message.

### Sample request

_Formatted for readability._

```curl
curl -i -X POST \
  "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
  --data 'recipient={"id":"IGSID"}&message={
      "attachment":
        {
          "type":"MEDIA_SHARE",
          "payload":{"id":"POST-ID"}
        }
}'
```

**Sample API response**

Upon success, your app receives the following JSON response:

```json
{
  "recipient_id": "IGSID",
  "message_id": "MESSAGE-ID"
}
```

## Send a sticker

To send a heart sticker, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID) and the `message` parameter containing an `attachment` object with the `type` set to `like_heart`.

### Sample request

_Formatted for readability._

```curl
curl -i -X POST \
  "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
  --data 'recipient={"id":"IGSID"}&message={
      "attachment":
        {
          "type":"like_heart"
        }
}'
```

**Sample API response**

Upon success, your app receives the following JSON response:

```json
{
  "recipient_id": "IGSID",
  "message_id": "MESSAGE-ID"
}
```

## React to a message

To send a reaction, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID) and the `sender_action` parameter to `react` with the `payload` containing the `message_id` set to the ID for the message to apply the reaction to and `reaction` to `love`.

### Sample request

_Formatted for readability._

```curl
curl -i -X POST \
  "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
  --data 'recipient={"id":"IGSID"}&sender_action=react&payload={
      "message_id":"MESSAGE-ID",
      "reaction":"love"
}'
```

### Unreact to a message

To remove a reaction from a message, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID) and the `sender_action` parameter to `unreact` with the `payload` containing the `message_id` set to the ID for the message from which to remove the reaction.

### Sample request

_Formatted for readability._

```curl
curl -i -X POST \
  "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
  --data 'recipient={"id":"IGSID"}&sender_action="unreact"&payload={
      "message_id":"MESSAGE-ID"
}'
```

**Sample API response**

Upon success, your app receives the following JSON response for react and unreact requests:

```json
{
  "recipient_id": "IGSID"
}
```

## Send a reply

To send a reply to a specific past message within the chat, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID), your message details in the `message` parameter object, and the `reply_to` object with `mid` set to the message id of the specific message in the chat you want to reply to. The message can either be the message your business sent, or the user had sent.

You can send a text message, media message, template message as a reply to a message by using the `reply_to` object.

### Sample request

_Formatted for readability._

```curl
curl -X POST "https://graph.facebook.com/<API_VERSION>/me/messages?access_token=<PAGE_ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "recipient":{
               "id":"<IGSID>"
           },
           "message":{
              "text": "TEXT"
           },
           "reply_to": {
              "mid": "<MESSAGE_ID>"
           }
         }'
```

**Sample API response**

Upon success, your app receives the following JSON response with the recipient's ID and the message ID:

```json
{
  "recipient_id": "IGSID",
  "message_id": "MESSAGE-ID"
}
```

## Next steps

* [Upload media such as audio, or image](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/attachment-upload) to Meta servers to be used in multiple messages.

* Send a structured message such as a [generic template](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/generic-template), a [product template](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/product-template), or a [persistent menu](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/persistent-menu).

## See also

* [Error Codes](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)
* [Rate Limits for Instagram Messaging](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview)
* [Get the Media ID for your Media Assets](https://developers.facebook.com/docs/instagram-api/reference/ig-media)  

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.

# Generic Template



The generic template allows you to send a structured message that includes an image, text, and buttons. A generic template with multiple templates described in the [`elements`](#elements) array will send a horizontally scrollable carousel of items, each composed of an image, text, and buttons.

### Limitations
This feature is currently not available in the web version.

## Request URI {#request_uri}

```
https://graph.facebook.com/v25.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>
```

## Example request {#example_request}

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<IGSID>"
  },
  "message":{
    "attachment":{
      "type":"template",
      "payload":{
        "template_type":"generic",
        "elements":[
           {
            "title":"Welcome!",
            "image_url":"https://github.com/fbsamples/original-coast-clothing/blob/main/public/looks/male-work.jpg",
            "subtitle":"We have the right hat for everyone.",
            "default_action": {
              "type": "web_url",
              "url": "https://www.originalcoastclothing.com",
            },
            "buttons":[
              {
                "type":"web_url",
                "url":"https://www.originalcoastclothing.com",
                "title":"View Website"
              },{
                "type":"postback",
                "title":"Start Chatting",
                "payload":"DEVELOPER_DEFINED_PAYLOAD"
              }
            ]
          }
        ]
      }
    }
  }
}' "https://graph.facebook.com/v10.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

## Example response {#example_response}

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```


## Properties {#properties}

### `recipient` {#recipient}

Description of the message recipient. All requests must include one of the following properties to identify the recipient.

| Property | Type | Description |
| --- | --- | --- |
| `recipient.id` | String | IG Scoped User ID (IGSID) of the message recipient. |

### `message` {#message}

Description of the message to be sent.

| Property | Type | Description |
| --- | --- | --- |
| `message.attachment` | Object | An object describing attachments to the message. |

### `message.attachment` {#attachment}

| Property | Type | Description |
| --- | --- | --- |
| `type` | String | Value must be `template` |
| `payload` | Object | [`payload`](#payload) of the template. |

### `message.attachment.payload` {#payload}

| Property | Type | Description |
| --- | --- | --- |
| `template_type` | String | Value must be `generic` |
| `elements` | Array<[`element`](#elements)> | An array of [`element`](#elements) objects that describe instances of the generic template to be sent. Specifying multiple elements will send a horizontally scrollable carousel of templates. A maximum of 10 elements is supported. |

### `message.attachment.payload.elements` {#elements}

The generic template supports a maximum of 10 elements per message. At least one property must be set in addition to `title`.

| Property Name | Type | Description |
| --- | --- | --- |
| `title` | String | The title to display in the template. 80 character limit. |
| `subtitle` | String | ***Optional.*** The subtitle to display in the template. 80 character limit. |
| `image_url` | String | ***Optional.*** The URL of the image to display in the template. |
| `default_action` | Object | ***Optional.*** The default action executed when the template is tapped. Accepts the same properties as [URL button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons), except `title`. |
| `buttons` | Array<[`button`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/buttons)> | ***Optional.*** An array of [buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) to append to the template. A maximum of 3 buttons per element is supported. Only `postback` and `web_url` buttons are supported. |

## Learn more

Visit the [`message.attachment.data`](https://developers.facebook.com/docs/graph-api/reference/message) for GIFs and Stickers.
# Button Template



The button template sends a text message with up to three attached buttons. This template is useful for offering the message recipient options to choose from, such as predetermined responses to a question, or actions to take.

## Limitations

The button template is currently not available in the web version.

## Template payload {#payload}

For a complete list of template properties, refer to the [Properties](#properties) section below. Replace each `<BUTTON_OBJECT>` with a URL button or postback button object, as described in [Available buttons](#buttons).

```http
"payload": {
  "template_type":"button",
  "text":"<MESSAGE_TEXT>",
  "buttons":[
    <BUTTON_OBJECT>,
    <BUTTON_OBJECT>,
    ...
  ]
}
```

## Available buttons {#buttons}

### URL button {#url}

The URL button opens a web page in the in-app browser. The URL button lets you add a web-based view to the conversation. For example, you might display a product summary in-conversation, then use the URL button to open the full product page on your website.

#### Button format

```http
{
  "type": "web_url",
  "url": "<URL_TO_OPEN_IN_WEBVIEW>",
  "title": "<BUTTON_TEXT>",
}
```

### Postback button {#postback}

The postback button sends a [`messaging_postbacks`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_postbacks) event to your webhook with the string set in the `payload` property. This allows you to take arbitrary actions when the button is tapped. For example, you might display a list of products, then send the product ID in the postback to your webhook, where it can be used to query your database and return the product details as a structured message.

#### Button format

For a complete list of button properties, see the [postback button reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/buttons/postback).

```http
{
  "type": "postback",
  "title": "<BUTTON_TEXT>",
  "payload": "<STRING_SENT_TO_WEBHOOK>"
}
```

## Example request {#example_request}

For complete request details and properties, refer to the [Properties](#properties) section below.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<IGID>"
  },
  "message":{
    "attachment":{
      "type":"template",
      "payload":{
        "template_type":"button",
        "text":"What do you want to do next?",
        "buttons":[
          {
            "type":"web_url",
            "url":"https://www.messenger.com",
            "title":"Visit Messenger"
          },
          {
            ...
          },
          {...}
        ]
      }
    }
  }
}' "https://graph.facebook.com/v13.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

## Example response {#example_response}

A successful request returns a JSON response containing the recipient ID and the message ID, as shown in the following example:

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```


## Properties {#properties}

### `recipient`

Description of the message recipient. All requests must include one of the following properties to identify the recipient.

| Property | Type | Description |
| --- | --- | --- |
| `recipient.id` | String | IG Scoped User ID (IGSID) of the message recipient. |

### `message`

Description of the message to be sent.

| Property | Type | Description |
| --- | --- | --- |
| `message.attachment` | Object | An object describing attachments to the message. |

### `message.attachment`

| Property | Type | Description |
| --- | --- | --- |
| `type` | String | Value must be `template`. |
| `payload` | Object | `payload` of the template. |

### `message.attachment.payload`

| Property | Type | Description |
| --- | --- | --- |
| `template_type` | String | Value must be `button`. |
| `text` | String | UTF-8-encoded text of up to 640 characters. The text appears above the buttons. |
| `buttons` | Array<button> | Set of 1-3 buttons that appear as call-to-actions. |
# Product Template for Instagram Messaging



Send Instagram messages with product information that you have uploaded to [your product catalog](https://www.facebook.com/business/help/1275400645914358) using the product template. The product template automatically pulls product details (image, title, price) from the product catalog.

You can create messages that have one product or a horizontally scrollable carousel of products using the product template.

## Before you start

You will need:

* The ID, or IDs, for the product from your Facebook catalog – You can get IDs from [Catalog API](https://developers.facebook.com/documentation/ads-commerce/catalog) or [Commerce Manager](https://www.facebook.com/business/help/2371372636254534).
* A Page Access Token from the Page that owns the products in the catalog
* [Meta Webhooks for Instagram Messaging subscriptions](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks)
* The ID for your Instagram Professional account
* The ID for the Page linked to your Instagram Professional account
* The Instagram Scoped ID for the person to whom you are sending the message

## Send a product message

To send a product message to a person, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient.id` property set to the Instagram-scoped ID of the person receiving the message. Include the `type` and `payload` properties in the `message.attachment` object. Set `type` to `template` and set the `payload.template_type` property to `product` and `payload.elements` to a list of product ID key-value pairs.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"INSTAGRAM-SCOPED-ID"
  },
  "message":{
    "attachment":{
      "type":"template",
      "payload": {
        "template_type": "product",
        "elements": [
          {
            "id": "PRODUCT-ID"
          }
        ]
      }
    }
  }
}' "https://graph.facebook.com/LATEST-GRAPH-API-VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS-TOKEN"
```

### Send a carousel

To send a product carousel, add more product key-value pairs to the `payload.elements` property. You can include up to 10 products in your request.

```json
...
      "payload": {
        "template_type": "product",
        "elements": [
          {
            "id": "PRODUCT-ID-1"
          },
          {
            "id": "PRODUCT-ID-2"
          },
          {
            "id": "PRODUCT-ID-3"
          }
        ]
      }
...
```

On success your app will receive the following JSON object with the recipient ID and the message ID.

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```


## Send an opt-in request

To send an opt-in request to a person to receive recurring marketing messages, send a `POST` request to `/PAGE-ID/messages` endpoint with the `recipient.id` property set to the Instagram-scoped ID of the person receiving the message. In the `message` `attachment.payload` property set `template_type` to `notification_messages`. In the `payload.elements` property include the `image_url`, `title`, `payload`, `notification_messages_frequency`, and `notification_messages_cta_text`.

```curl
curl -X POST -H "Content-Type:application/json" -d '{
  "recipient": {
    "id": "INSTAGRAM-SCOPED-ID"
  },
  "message": {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "notification_messages",
        "elements": [
          {
            "image_url": "IMAGE-URL",
            "title": "TEXT-TO-DISPLAY",
            "payload": "INFORMATION-ABOUT-THIS-MESSAGE",
            "notification_messages_frequency": "DAILY",
            "notification_messages_cta_text": "GET_UPDATES"
          }
        ]
      }
    }
  }
}' "https://graph.intern.facebook.com/LATEST-GRAPH-API-VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS-TOKEN"
```

### Properties

| Property | Value |
| --- | --- |
| `image_url`  <br>*string* | The URL for the image to display in the template |
| `notification_messages_cta_text`  <br>*enum {<br>`ALLOW`,<br>`FREQUENCY`,<br>`GET`,<br>`GET_UPDATES`,<br>`OPT_IN`,<br>`SIGN_UP` }<br>* | Set the call-to-action button text using one of the following values:<br><br>* `ALLOW` – set opt-in message button text to **Allow messages**<br>* `FREQUENCY` – set opt-in message button text to **Get daily messages**<br>* `GET` – set opt-in message button text to **Get messages**<br>* `GET_UPDATES` – set opt-in message button text to **Get updates**, this is also default if `notification_messages_cta_text` is not set<br>* `OPT_IN` – set opt-in message button text to **Opt in to messages**<br>* `SIGN_UP` – set opt-in message button text to **Sign up for messages** |
| `notification_messages_frequency`  <br>*enum {<br>`DAILY`,<br>`WEEKLY`,<br>`MONTHLY` }<br>* | Message frequency for this recurring notification opt-in request.<br><br>* `DAILY` – Opt in to receive one notification per 24 hour period for 6 months<br>* `WEEKLY` – Opt in to receive one notification per 7 day period for 9 months<br>* `MONTHLY` – Opt in to receive one notification per 1 month period for 12 months |
| `payload`  <br>*string* | The type of recurring notification, such as promotional messaging or product release messaging, for this recurring notification opt-in request |
| `title`  <br>*string* | The title to display in the template, cannot exceed 65 characters. If no value is assigned, the value defaults to "Updates and promotions" |

## Next steps

Now that people have opted in to receive recurring marketing messages, learn how to [send your marketing messages](https://developers.facebook.com/docs/messenger-platform/instagram/features/recurring-notifications#message-attachment-payload).

## See also

* [Common Error Codes Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)
* [Message Attachment Payload Reference](https://developers.facebook.com/docs/messenger-platform/instagram/features/recurring-notifications#message-attachment-payload)

# Quick Replies



Quick replies provide a way to present a set of buttons in-conversation for users to reply with. A maximum of 13 quick replies are supported and each quick reply allows up to 20 characters before being truncated. Quick replies only support plain text.

When a quick reply is tapped, Instagram dismisses the buttons and posts the tapped button's title to the conversation as a message. Instagram then sends a messages event to your webhook that contains the button title and an optional payload.

**Note:** This feature is currently not available on desktop.

## Sending quick replies

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<IGSID>"
  },
  "messaging_type": "RESPONSE",
  "message":{
    "text": "<SOME_TEXT>",
    "quick_replies":[
      {
        "content_type":"text",
        "title":"<TITLE_1>",
        "payload":"<POSTBACK_PAYLOAD_1>"
      },
      {
        "content_type":"text",
        "title":"<TITLE_2>",
        "payload":"<POSTBACK_PAYLOAD_2>"
      }
    ]
  }
}' "https://graph.facebook.com/<API_VERSON>/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

## Webhook event

When a quick reply is tapped, Instagram sends a text message to your webhook.

The text property of the event will correspond to the title of the quick reply. The message object will also contain a field named `quick_reply` containing the payload data on the quick reply.

```curl
{
  "object": "instagram",
  "entry": [
    {
      "id": "<IGID>",
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "<IGSID>"
          },
          "recipient": {
            "id": "<IGID>"
          },
          "timestamp": 1502905976377,
          "message": {
            "quick_reply": {
              "payload": "<PAYLOAD>"
            },
            "mid": "<MID>",
            "text": "<SOME_TEXT>"
          }
        }
      ]
    }
  ]
}
```

## User phone number quick reply {#phone}

The user phone number quick reply allows you to ask a user for their phone number. When the phone number quick reply is sent, the Instagram Direct Platform will automatically pre-fill the displayed quick reply with the phone number from the user's profile information.

If the user's profile does not have a phone number, Instagram does not show the quick reply.

The bot will not receive the phone number until the user clicks the quick reply.

Choosing the quick reply transmits the information once and does not constitute permission to access the information in the future.

### Syntax

```
{
  "content_type":"user_phone_number"
}
```

### Webhook event

When the user taps the quick reply, the email address will be passed in the `payload` attribute of the `messages` webhook event.

```http
{
  "object": "page",
  "entry": [
    {
      "id": "<PAGE_ID>",
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "<IGSID>"
          },
          "recipient": {
            "id": "<IGID>"
          },
          "timestamp": 1502905976377,
          "message": {
            "quick_reply": {
              "payload": "<PHONE_NUMBER>"
            },
            "mid": "<MESSAGE_ID>",
            "text": "<PHONE_NUMBER>"
          }
        }
      ]
    }
  ]
}
```

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.

# Sender Actions



This guide explains how to display sender actions in a conversation so that message recipients know you have seen and are processing their message.

## Display a sender action {#example}

### Typing indicator

To display the `typing_on` or `typing_off` action for a sender in the conversation, send a POST request to the [`/PAGE-ID/messages` endpoint](https://developers.facebook.com/docs/graph-api/reference/page/messages) with the `sender_action` parameter set to `typing_on` or `typing_off`.

For the best conversational experience, send the `typing_on` indicator when your bot receives a message it will respond to. Do not allow an unnatural amount of time (too long or too short) to pass between `typing_on` and `typing_off` sender actions. Ideally, the user should feel that a real person was typing the message in the elapsed time.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<IGSID>"
  },
  "sender_action":"typing_on"
}' "https://graph.facebook.com/VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS_TOKEN"
```

### Mark messages as seen

To send the `mark_seen` indicator to the most recent message, send a POST request to the [`/PAGE-ID/messages` endpoint](https://developers.facebook.com/docs/graph-api/reference/page/messages) with the `sender_action` parameter set to `mark_seen`.

For the best conversational experience, send the `mark_seen` indicator when your bot receives a message so that the user does not feel ignored.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<IGSID>"
  },
  "sender_action":"mark_seen"
}' "https://graph.facebook.com/VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS_TOKEN"
```

### Limitations

* Requests to display sender actions for typing indicators and `mark_seen` indicators should only include the `sender_action` parameter and the `recipient` object. All other Send API properties, such as text and templates, should be sent in a separate request.
* The recipient must be signed in for sender actions to be displayed.

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.

# Upload Media for Instagram Messaging



This document shows you how to upload media to the Meta servers using the Attachment Upload API. This media can then be used in Instagram messages.

**Note:** You can upload and send an attachment in a single API call.

## Before you start

You need the following:

* The **Page ID** for the Facebook Page linked to the Instagram account your business uses to own the media to be uploaded
* A **Page access token** requested by a person who can perform the `MESSAGING` task on the Page
* Approval from the person uploading the media via Business Login for Instagram or Facebook Login for the following permissions:
    * `instagram_basic`
    * `instagram_manage_comments`
    * `instagram_manage_messages`
    * `pages_messaging`
* Your app will need **Advanced Access** for the required permissions to upload media for Pages you do not own or administer
* Either the **URL** for the media, if uploading from a URL, or the **file path** to the media, if uploading from your server
    * Media types can be `image` (which include GIFs), `video`, `audio`, or `file`
    * Media formats can be:

| Media Type | Supported Format | Supported Size Maximum |
| --- | --- | --- |
| Audio | acc, m4a, wav, mp4 | 25MB |
| Image | png, jpeg, gif | 8MB |
| Video | mp4, ogg, avi, mov, webm | 25MB |
| File | pdf | 25MB |

### Limitations

* If your app only has Standard Access to any of the required permissions, your app can only upload media for Pages you own or administer.
* These permissions allow your app to upload media but not to send messages.
* Media file names containing non-ASCII characters (such as Chinese characters) are not supported for attachment uploads.

## Upload media

You can upload media from a URL or from a server.

### From a URL

To upload media from a URL, send a `POST` request to the `/<PAGE_ID>/message_attachments` endpoint with the platform set as Instagram and the message attachment type set to the type of media you are uploading, `audio`, `image`, `video` or `file`. Add the URL and `is_reusable` in the payload. Set `is_reusable` to true so that the media can be used in multiple messages.

**Note:** All keys within the `message` object, such as `attachment`, `type`, and `payload` are strings.

#### Sample request
*Formatted for readability.*

```bash
curl "https://graph.facebook.com/<LATEST-API-VERSION>/<PAGE_ID>/message_attachments"
    -H "Content-Type: application/json"
    -H "Authorization: Bearer <PAGE_ACCESS_TOKEN>"
    -d '{
          "platform":"instagram",
          "message":
            {
              "attachment":
                {
                  "type": "<MEDIA_TYPE>",
                  "payload":
                    {
                      "url": "<MEDIA_URL>",
                      "is_reusable": "true",
                    },
                }
            }
       }'
```

### From a server

To upload media from a server, send a `POST` request to the `/<PAGE_ID>/message_attachments` endpoint with the message attachment payload containing the URL and the platform set to `instagram`. If you want to use the media in multiple messages, include the `is_reusable` set to true in the payload.

#### Sample request
*Formatted for readability. *

```bash
curl "https://graph.facebook.com/<LATEST-API-VERSION>/<PAGE_ID>/message_attachments"
    -H "Content-Type: application/json"
    -H "Authorization: Bearer <PAGE_ACCESS_TOKEN>"
    -d '{
          "platform":"instagram",
          "filedata":"<FILE_PATH>;type=<PATH_TYPE>",
          "message":
            {
              "attachment":
                {
                  "type": "<MEDIA_TYPE>",
                  "is_reusable": "true",
                }
            }
       }'
```

### Sample response

Upon success, the API returns an attachment ID. You can now include this ID in your messages.

```json
{
    "attachment_id": "<ATTACHMENT_ID>"
}
```

## Send the media

Now that you have uploaded media, you can send it in a message.

To send a message that contains the media you uploaded, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID) and the `message` parameter containing an `attachment` object with the `type` set to `MEDIA_SHARE` and `payload.id` set to the attachment ID.

Your business must own the media to be used in the message.

#### Sample request
*Formatted for readability. *

```bash
curl "https://graph.facebook.com/<LATEST-API-VERSION>/<PAGE_ID>/messages"
    -H "Content-Type: application/json"
    -H "Authorization: Bearer <PAGE_ACCESS_TOKEN>"
    -d '{
          "recipient":
            {
              "id":"<IGSID>"
            },
          "message":
            {
              "attachment":
                {
                  "type": "MEDIA_SHARE",
                  "payload":
                    {
                      "attachment_id":"<ATTACHMENT_ID>"
                    }
                }
            }
       }'
```

#### Sample API response {#send-api-response}

Upon success, the API returns a JSON response with the recipient's ID and the message's ID.

```json
{
  "recipient_id": "<IGSID>",
  "message_id": "<MESSAGE_ID>"
}
```

## Upload and send

You can upload media and send it in a single API request.

### From a URL

To upload and send media in one request, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID) and the `message` parameter containing an `attachment` object with the `type` set to `audio`, `image`, `video` or `file` and `payload` containing the URL and `is_reusable` set to true.

#### Sample request

_Formatted for readability._

```bash
curl "https://graph.facebook.com/<LATEST-API-VERSION>/<PAGE_ID>/messages"
    -H "Content-Type: application/json"
    -H "Authorization: Bearer <PAGE_ACCESS_TOKEN>"
    -d '{
          "recipient":
            {
              "id":"<IGSID>"
            },
          "message":
            {
              "attachment":
                {
                  "type":"<MEDIA_TYPE>",
                  "payload":
                    {
                      "url":"<URL_TO_MEDIA>"
                    },
                  "is_reusable": "true",
                }
            }
       }'
```

### From a server

To upload and send an image, audio, file, or video from your server, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the `recipient` parameter containing the Instagram-scoped ID (IGSID) and the `message` parameter containing an `attachment` object with the `type` set to `AUDIO`, `IMAGE`, `VIDEO` or `FILE` and `filedata` parameter the file's location and type. The format for `filedata` values looks like `@/path_on_my_server/video.mp4;type=video/mp4`.

#### Sample request

_Formatted for readability._

```bash
curl "https://graph.facebook.com/<LATEST-API-VERSION>/<PAGE_ID>/messages"
    -H "Content-Type: application/json"
    -H "Authorization: Bearer <PAGE_ACCESS_TOKEN>"
    -d '{
          "recipient":
            {
              "id":"<IGSID>"
            },
          "filedata":"<FILE_PATH>;type=<PATH_TYPE>"
          "message":{
            "attachment":
              {
                "type":"<MEDIA_TYPE>",
                "is_reusable": "true",
              }
          }
       }'
```

### Sample API response {#upload-send-api-response}

Upon success, the API returns a JSON response with the recipient ID, message ID, and attachment ID.

```json
{
  "recipient_id": "<IGSID>",
  "message_id": "<MESSAGE_ID>",
  "attachment_id": "<ATTACHMENT_ID>"
}
```
# Conversation Routing for Instagram



**Warning:** Meta no longer supports the Handover Protocol for Instagram. All businesses have been migrated to Conversation Routing. Conversation Routing is backwards compatible with most Handover Protocol APIs and functionalities, and is expected to function without interruption.

## Overview
Conversation Routing enables businesses to utilize multiple connected applications to respond to user messages in a coordinated manner, designating which application should take responsibility for responding. This allows both businesses and users to have a rich conversation experience without having to manage complex business logic within each individual application when responding to user queries.

Businesses can connect various types of applications, each serving different roles, such as:

1. **Marketing Applications:** Send product marketing messages.
2. **Sales Applications:** Handle customer orders, shipments, and schedule service appointments.
3. **Customer Care Applications:** Provide human agent-based support.
4. **Messaging Automation/Bot Applications:** Include AI agent bots for automated responses.

In some cases, a single application may fulfill multiple roles.

### When to use Conversation Routing
Use Conversation Routing when you have multiple messaging applications connected to your Instagram account and want Meta to automatically route messages to the appropriate application, based on how customers initiate conversations.

Some basic message routing features are available even without enabling Conversation Routing. For more details, see [Default Message Routing Behavior](#default-message-routing-behavior--zero-config-behavior-).

## Conversation Routing for Instagram ads

To set up Conversation Routing for Instagram Ads, you'll need to configure a message template as part of your ad creation process. For detailed steps, refer to the official [Facebook Business Help article](https://www.facebook.com/business/help/198088077975174?id=371525583593535).

### Defining message templates

When creating your Instagram Ad, you'll be prompted to select a Message template. You can either create a new template or use an existing one.

Within the message template, you can specify parameters such as the `receiving_app_id` and the thread window. This allows you to control which app receives the conversation and for how long it maintains control.

### Sample template

```json
{
    "message": {
        "attachment": {
            "type": "template",
            "payload": {
                "template_type": "button",
                "text": "Hi! Please let us know how we can help you",
                "buttons": [
                    {
                        "title": "Show me the product!",
                        "type": "web_url",
                        "url": "http://www.facebook.com/"
                    },
                    {
                        "title": "Tell me more",
                        "type": "postback",
                        "payload": "USER_DEFINED_PAYLOAD"
                    }
                ]
            }
        },
        "receiving_app_id": 1278416343931139,
        "receiving_app_control_expiration": 4
    }
}
```

- `receiving_app_id`: The ID of the app that will receive the conversation.

- `receiving_app_control_expiration`: The duration (in days) for which the app will maintain control of the thread. Valid values are from 1 to 30.

## Thread control window

- When a conversation starts from an Instagram Ad, the designated app will have control of the thread for 1 day (24 hours) from the last user message by default.

- Businesses with longer lead or sales cycles can extend thread control for up to 30 days by setting `receiving_app_control_expiration` to a value between 1 and 30.

- If you set an invalid value for `receiving_app_control_expiration`, the thread control window will default to 1 day.

- Any
Conversation Control
actions (such as handover protocol events) will also reset the thread control window to 1 day.

## Configure Conversation Routing

This section explains how to enable Conversation Routing, configure entry point routing, manage thread ownership, and use conversation control flows for Instagram messaging integrations.

### Enable Conversation Routing

To use Conversation Routing for Instagram, you need:

- An Instagram Business account linked to a Facebook Page using the New Pages Experience.
- The Facebook Page must have messaging enabled and at least one connected app (with PAGES_MESSAGING permissions and webhook subscriptions).
- You must be interacting as the owner for the Facebook Page.
- You must set up a default application.

### Default application

The default application is the primary app allowed to respond to a conversation when no other app is currently assigned or configured to do so.

#### How to assign a default application

- Log in as the Page connected to your Instagram account.

- Go to your
[Facebook Page settings](https://www.facebook.com/settings).

- Go to Page Setup → Instagram Conversation Routing.

- Assign the desired app as the default application.

## Entry point routing

Entry point routing lets you direct conversations to specific apps based on how users initiate contact. Configure these routes in the Conversation Routing tab of your Facebook Page settings.

There are three types of entry point routing:

### 1. Link routing

- Configure multiple
[ig.me links](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/ig-me-links) on third-party sites.

- Assign a routing app to each link.

### 2. Campaign routing

- Route conversations from
[Click-to-Direct (CTD) ads.](https://www.facebook.com/business/help/198088077975174?id=371525583593535)

- Set up in Ads Manager.

- See **Conversation routing for Instagram Ads** for more details.

### 3. Default/organic routing

- Applies to any other entry point within the Meta ecosystem.

## Meta Business Suite Inbox support

- You can use Meta Business Suite Inbox as a connected application to continue conversations with users.
- The Inbox can also be assigned as a default application.

## Conversation control and thread ownership

The application responsible for responding to a user-business conversation is said to have Conversation Control or be the Thread Owner.

### Thread owner states

#### Idle

No active conversation between user and business(no user-to-business message in the last 24 hours), or after the current thread owner releases control. Only the default application can send messages in this state (within the messaging window).

#### Active

There is an ongoing conversation between the user and a business application.

## Conversation control flows

Conversation control flows allow applications to change message routing for subsequent customer messages. There are five types of control flows:

### 1. Pass thread control

The current thread owner passes control to another application, making it the new thread owner.

**Examples:**

Marketing app passes control to Sales app to complete a transaction. AI support bot passes control to a human customer care agent.

### 2. Release thread control

The current thread owner releases control, setting the thread to idle once they are done with the conversation.

**Examples:**

The marketing app finishes answering queries and does not expect any further marketing queries from the customer, so it can release control for future queries. App cannot respond due to technical issues or unrelated queries and releases control to allow the default app to respond.

### 3. Take thread control

Applications which are allowed to **Take control of conversations** by the business are allowed to take thread control, which allows the application to set itself as the thread owner.
**Warning:** Apps with the Human Agent feature cannot take control via the Send API (with HA tag) unless allowed to **Take control of conversations** (configured in Page Settings → Page Setup → Advanced Messaging).

**Example:**
Customer Care agent sees there is an issue with the Marketing bot application sending some invalid responses and can take thread control to continue conversation.

### 4. Extend thread control

Thread control usually expires after 24 hours of inactivity, but in some cases businesses might not have enough time to respond to the user, so they can use this API to extend thread control up to 7 days.

**Example:**

In a non-default customer sales application, customer sales agents answering the customer queries may require more time to find the product details requested by the users. In such a case, agents need to extend the thread control time period until they find the details, which they can use to extend thread control.

### 5. Request thread control

Use this flow to request thread control from another application that already has thread control. In certain scenarios, instead of taking thread control directly, ask the application in control to pass control to your application. If the current thread owner is done with the conversation, they can pass thread control to your application.

## Default message routing behavior (zero config behavior) {#default-message-routing-behavior--zero-config-behavior-}

Default behavior, also known as zero config behavior, allows applications to use certain conversation controls even without configuring a Conversation Routing default application. However, there are some limitations to be aware of.

### When to use default behavior

- You have only a single application connected to your business, which is solely responsible for receiving and responding to user messages.

- You may use the Page Inbox to respond to users in addition to the application connected, but you are responsible for coordinating responses between your app and the Inbox to avoid sending multiple responses to the same user message.

### Key differences from Conversation Routing (primary behavior)

- **Multiple Apps Receive Webhooks:** If more than one application is connected, all applications will receive messaging webhooks.

- **No Coordination Between Apps:** All connected applications can respond to the same user message without restrictions or coordination, increasing the risk of duplicate responses.

- **Take Thread Control API Blocked:** The Take Thread Control API is not available. This feature is only enabled when a default application is set.

- **Pass Thread Control API Available:** The Pass Thread Control API is enabled. Any application can pass thread control to any other application (including itself) when the thread is in the idle state.

- **Request Thread Control API Available:** The Request Thread Control API is enabled. Any application can request thread control, but only the first application to invoke the API will receive control.

- **Limited Entry Point Routing:** Only **campaign routing** is available as an entry point routing option. Link routing and default/organic routing are not available for configuration.
# Conversation Control APIs



Instagram Platform Conversation Routing provides Conversation Control APIs, allowing you to:

1. Pass control to another app
2. Release thread control from the current app
3. Take thread control from another app (primary behavior only)
4. Extend thread control for your app
5. Request control of a conversation from another app (default behavior only)
6. Determine which app currently controls a conversation
7. Check whether conversation routing is configured for your account

This document outlines the specifics of conversation control invocations to change or retrieve thread control details.

## Send API: Message send with thread controls

**Warning:** Thread control support within the Send API is only available when conversation routing is enabled.

### Pass thread control

You can pass thread control to a specific app by setting the `app_id` and `control_type` fields in the `thread_control` parameter.

If `app_id` is not specified, thread control will be passed to the default application.

#### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "messaging_type": "RESPONSE",
  "thread_control": {
  "app_id": "<APPLICATION_ID>",
  "control_type": "pass"
  },
  "recipient": {
  "id": "<IGSID>"
  },
  "message": {
  "text" : "Let me transfer you to our live agent"
  }
}' "https://graph.facebook.com/v12.0/me/messages?access_token=<ACCESS_TOKEN>"
```

#### Sample response

```json
{
  "recipient_id":"<IGSID>",
  "message_id":"MESSAGE-ID"
}
```

### Release thread control

Release thread control by setting the `control_type` field in the `thread_control` parameter.

#### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "messaging_type": "RESPONSE",
  "thread_control": {
    "control_type": "release"
  },
  "recipient": {
    "id": "<IGSID>"
  },
  "message": {
    "text" : "Let me transfer you to our live agent"
  }
}' "https://graph.facebook.com/v12.0/me/messages?access_token=<ACCESS_TOKEN>"
```

#### Sample response

```json
{
  "recipient_id":"<IGSID>",
  "message_id":"MESSAGE-ID"
}
```

| Parameter | Description |
| --- | --- |
| `thread_control` | Specifies which Conversation Routing control flow to invoke after sending the message. |
| `control_type` | Indicates whether to pass or release thread control.<br><br>- `pass`: Passes thread control to the specified app (or the default app) and sends a webhook to the app telling it to continue the conversation.<br>- `release`: Releases thread control to idle. No webhook is sent. Should be used when the app in control determines that no further action is needed on the conversation. |
| `app_id` (optional) | Used in the pass thread control flow to define the application ID that should become the thread owner. |

## Thread control APIs

### Pass thread control
When your app needs to hand over the conversation to another application, send a POST request to the `/PAGE_ID/pass_thread_control` endpoint.

- Set the `recipient` parameter to the IGSID of the customer.

- Set the `target_app_id` parameter to the ID of the app that should get control.

- Optionally, set the `metadata` parameter with information about the conversation.

**Notes:**

- To pass control to an Inbox, use `263902037430900` for the Page Inbox and `1217981644879628` for the Instagram Inbox.

- This API can only be invoked if:

- You are the current thread owner, or

- The thread is in idle state

- If the target app is not specified, control will be passed to the default application (if conversation routing is enabled).

- The target app cannot be itself to extend thread control if you are the current owner.

#### Sample request

```curl
curl -X POST "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/pass_thread_control
  ?recipient={id:IGSID}
  &target_app_id=APP-GETTING-CONTROL
  &metadata=Information about the conversation
  &access_token=PAGE-ACCESS-TOKEN"
```

#### Sample response

```json
{
  "success" : true
}
```

#### Webhook notification example

```json
{
  "sender":{
     "id":"IGSID" // The Instagram-scoped ID for the person who sent the message to the business
  },
  "recipient":{
     "id":"BusinessId"
  },
  "timestamp":UNIX-TIMESTAMP,
  "pass_thread_control":{
     "previous_owner_app_id":"APP-RELEASING-CONTROL",
      "new_owner_app_id": "APP-GETTING-CONTROL",
      "metadata":"Information about the conversation"
  }
}
```

### Release thread control

Release control of the conversation (returning it to idle) as soon as your app is finished, rather than waiting for the response window to expire.

To release thread control, send a POST request to `/PAGE-ID/release_thread_control`.

- Set the `recipient` parameter to the ID of the person who sent the message.

- Optionally, set the `metadata` parameter.

**Notes:**

- Only the current thread owner can invoke this API.

#### Sample request

```curl
curl -X POST "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/release_thread_control
  ?recipient={id:IGSID}
  &metadata=Information about the conversation
  &access_token=PAGE-ACCESS-TOKEN"
```

#### Sample response

```json
{
  "success" : true
}
```

After a successful request, the conversation status changes to idle.

### Take thread control

To take control of a conversation, send a POST request to `/PAGE-ID/take_thread_control`.

- Set the `recipient` parameter to the ID of the person who sent the message.

- Optionally, set the `metadata` parameter.

**Notes:**

- Only supported when conversation routing is enabled.

- The thread control takeover setting must be enabled for the app in Page Settings → Page Setup → Advanced Messaging.

- You cannot invoke this API to extend thread control if you are already the thread owner.

#### Sample request

```curl
curl -X POST "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/take_thread_control
  ?recipient={id:ID}
  &metadata=Information about the conversation
  &access_token=PAGE_ACCESS_TOKEN"
```

#### Sample response

```json
{
  "success" : true
}
```

#### Webhook notification example

The thread owner from whom the control was taken will receive a notification with the IGSID for the person who sent the message, the ID for the Instagram Professional account that received the message, the ID for the previous app that controlled the conversation, the ID for the app that now controls the conversation, and any metadata about the conversation that was sent in the API request that triggered the webhook. If the thread was taken from idle state, no webhooks would be sent.

```json
{
  "sender":{
    "id":"IGSID"
  },
  "recipient":{
    "id":"BusinessId"
  },
  "timestamp":UNIX-TIMESTAMP,
  "take_thread_control":{
    "previous_owner_app_id":"PREVIOUS-OWNER-APP-ID",
    "new_owner_app_id": "NEW-OWNER-APP-ID",
    "metadata":"Information about the conversation"
  }
}
```

### Extend thread control

To give your app more time to respond to a message, you can extend control past the 24-hour response time frame. You can extend the time up to 7 days.

To extend control of a conversation, send a POST request to `/PAGE-ID/extend_thread_control`.

- Set the `recipient` parameter to the ID of the person who sent the message.

- Set `duration` to the length of time in seconds.

**Notes:**

- Only the current thread owner can invoke this API.

#### Sample request

```curl
curl -X POST "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/extend_thread_control
  ?recipient={id:IGSID}
  &duration=86400   //Length of time, in seconds
  &access_token=PAGE-ACCESS-TOKEN"
```

#### Sample response

```json
{
  "success" : true
}
```

### Request thread control

**Warning:** Request Thread control is only available when conversation routing is not enabled (Default message routing behavior).

To request control of a conversation from another app, send a POST request to `/PAGE-ID/request_thread_control`.

- Set the `recipient` parameter to the PSID of the customer.

- Optionally, set the `metadata` parameter.

**Notes:**

- You cannot request thread control if you are already the thread owner.

- If the thread is idle, control will be passed to you and a pass thread control webhook will be sent.

#### Sample request

```curl
curl -X POST "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/request_thread_control
  ?recipient={id:PSID}
  &metadata=Information about the conversation
  &access_token=PAGE-ACCESS-TOKEN"
```

#### Sample response

```json
{
  "success" : true
}
```

#### Webhook notification example

The following webhook notification will be received by the current thread owner.

```json
{
  "sender":{
     "id":"IGSID" // The Instagram-scoped ID for the person who sent the message to the business
  },
  "recipient":{
     "id":"BusinessId"
  },
  "timestamp":UNIX-TIMESTAMP,
  "request_thread_control":{
     "requested_owner_app_id":"APP-ASKING-FOR-THREAD-CONTROL",
     "metadata":"Information about the conversation"
  }
}
```

### Find the app in control

To find which app currently controls a conversation, send a GET request to `/PAGE-ID/thread_owner` with the `recipient` parameter set to the Instagram-scoped ID.

- Set the `recipient` parameter to the IGSID.

- Set the `access_token` parameter to your page access token.

#### Sample request

```curl
curl -X GET "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/thread_owner
  ?recipient=IGSID
  &access_token=PAGE-ACCESS-TOKEN"
```

#### Sample response

- If your app is the current thread owner or the default app, you'll receive the `app_id` and expiration timestamp.

- Otherwise, if the thread is not idle, you'll receive the expiration timestamp only.

- Otherwise, you'll receive an empty response.

```json
{
  "data": [
    {
      "thread_owner": {
        "app_id": APP-ID,
        "expiration": UNIX-TIMESTAMP
      }
    }
  ]
}
```

### Messaging feature status API

Check the Conversation Routing status of a Facebook Page for Messenger or a business ID for Instagram Direct (IGD) messaging.

- Send a GET request to `/v12.0/me` with the `fields=messaging_feature_status` and your `access_token`.

#### Sample request

```curl
curl -X GET "https://graph.facebook.com/v12.0/me?fields=messaging_feature_status&access_token=<ACCESS_TOKEN>"
```

#### Sample response

```json
{
  "messaging_feature_status": {
    "hop_v2": false,
    "msgr_multi_app": true,
    "ig_multi_app": false
  },
  "id": "<page_id>"
}
```
# Human Agent Escalation



Your app can implement an escalation path to a human agent using a custom inbox only or using an automated experience.

## Custom inbox only (no automation) {#custom-inbox-only}

With the custom inbox only solution (no automation), end users interact with the human agent directly rather than initiating the conversation with a keyword or intent. If your app uses this path to escalate to a human agent, ensure it can:

* Receive messages sent by end users and render them correctly in the custom inbox using the [Conversation API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversations) with the given app ID
* Reply to messages via the custom inbox and confirm that end users receive them, using the [Send API](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/send-message#send-api) with the given app ID

## Automated experiences {#automated-experiences}

If your app has an automated experience, it can escalate to a human agent using a fallback intent, keyword, or quick replies when a certain scenario or flow is met.

As soon as the scenario or flow is met the escalation to a human agent can be done in the following ways:

* **Custom Inbox** - The ability to receive or reply to messages to end users from the custom inbox, which is powered by the same app ID
* **Conversation Routing API** - Use [this API](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/conversation-routing) to pass thread control to either Instagram Inbox (first-party) or a custom third-party inbox solution (using another FB app ID). For the app review process, demonstrate that when escalation to a human agent happens, thread ownership transfers to the inbox and the agent can use the inbox to reply to end users.
# Ice Breakers



Ice Breakers provide a way for users to start a conversation with a business with a list of frequently asked questions. Use the Ice Breaker API to set a maximum of 4 questions.

## Limitations

Ice Breakers are currently not available on desktop.

## Setting ice breakers

```curl
    curl -X POST -H "Content-Type: application/json" -d '{
     "platform": "instagram",
     "ice_breakers":[
       {
          "call_to_actions":[
             {
                "question":"<QUESTION>",
                "payload":"<PAYLOAD>"
             },
             {
                "question":"<QUESTION>",
                "payload":"<PAYLOAD>"
             }
          ],
          "locale":"default" // default locale is REQUIRED
       },
       {
          "call_to_actions":[
             {
                "question":"<QUESTION>",
                "payload":"<PAYLOAD>"
             },
             {
                "question":"<QUESTION>",
                "payload":"<PAYLOAD>"
             }
          ],
          "locale":"en_GB"
       }
    ]
}' "https://graph.facebook.com/v11.0/me/messenger_profile?platform=instagram&access_token=<PAGE_ACCESS_TOKEN>"
```

## Getting ice breakers

```curl
curl -X GET "https://graph.facebook.com/v11.0/me/messenger_profile?fields=ice_breakers&platform=instagram&access_token=<PAGE_ACCESS_TOKEN>"
```

```curl
{
   "data": [
        {
          "call_to_actions" : [
               {
                "question": "<QUESTION>",
                "payload": "<PAYLOAD>",

               },
               {
                "question": "<QUESTION>",
                "payload": "<PAYLOAD>",

               },
          ],
          "locale": "<LOCALE>",
      },
      {
          "call_to_actions" : [
               {
                "question": "<QUESTION>",
                "payload": "<PAYLOAD>",

               },
               {
                "question": "<QUESTION>",
                "payload": "<PAYLOAD>",

               },
          ],
          "locale": "<LOCALE>",
      }
   ]
}
```

## Deleting ice breakers

```curl
curl -X DELETE -H "Content-Type: application/json" -d '{
  "fields": [
    "ice_breakers",
  ]
}' "https://graph.facebook.com/v11.0/me/messenger_profile?platform=instagram&access_token=%lt;PAGE_ACCESS_TOKEN>"
```

## Webhook event

To receive postback webhooks from Ice Breakers, subscribe your app to the `messaging_postbacks` webhook under the Instagram topic in your app settings.

The webhook will receive a JSON payload similar to the example below.

```
{
  "object": "instagram",
  "entry": [
    {
      "id": "<IGID>",
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "<IGSID>"
          },
          "recipient": {
            "id": "<IGID>"
          },
          "timestamp": 1502905976377,
          "postback": {
            "title": "<SELECTED_ICEBREAKER_QUESTION>",
            "payload": "<USER_DEFINED_PAYLOAD>",
          }
        }
      ]
    }
  ]
}
```

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Using ig.me Links



`ig.me` is a shortened URL service operated by Meta that redirects users to a conversation in Instagram. You can use ig.me links on your website, email newsletters, and more.

When a user opens an ig.me link to start or continue a conversation with your Instagram account, the user is redirected to a new or existing thread, based on whether the user had previously messaged your Instagram account.

### Contents

- [Link Format](#format)
- [Referral Parameters](#refparams)
- [Examples](#examples)
- [User Experience](#userexperience)
- [Limitations](#limitations)

## Link format {#format}

The format of the link is as follows:

```http
https://ig.me/m/<USERNAME>
```

`USERNAME` is the Instagram handle of the Instagram account.

## Referral parameters {#refparams}

You can pass a referral parameter using these links.

Referral parameters can serve the following purposes:

- Track different links in different channels
- Tie an Instagram user to a session or account in an external app
- Direct the user to specific content or features available within your Instagram account

This is an ig.me link with an added parameter:

```http
https://ig.me/m/<USERNAME>?ref=<REF_PARAM>
```

`REF_PARAM` is passed to the server via a webhook.

### Requirements {#ref_requirements}

To properly use ig.me links, you must meet the following requirements:

* Your Instagram experience must have [Icebreakers](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/ice-breakers) set to receive the referral parameter for new conversations
* The referral parameter must be a string up to 2,083 characters in length
* The Instagram account that the app is connected to must be published to receive the referral parameter for all users, except those that have the developer, tester, or admin role for your bot
* You are using iOS and Android versions 235 and above

### Reading the passed parameter

The referral portion always follows this format:

```http
  "referral": {
     "ref": "ref_data_in_ig_dot_me_param"
     "source": "SHORTLINKS"
     "type":  "OPEN_THREAD"
}
```

| Field Value | Description |
| --- | --- |
| `ref` | The arbitrary data that was originally passed in the `ref` param added to the ig.me link. Only alphanumeric characters, and -, _, = are supported |
| `source` | The source of this referral. For ig.me links, the value of source is `"SHORTLINK"` |
| `type` | The identifier for the referral. For a referral from ig.me links, it is always `"OPEN_THREAD"` |

When an ig.me link with a `ref` parameter opens the Instagram app, there are three possible scenarios:

#### 1. New thread + icebreaker

If you have configured Icebreakers for your Instagram Account and the user taps on an Icebreaker, your app receives the `messaging_postback` webhook event which includes the passed referral parameter.

The `messaging_postback` webhook event follows this format:

```http
{
  "object": "instagram",
  "entry": [
    {
      "id": "<IGSID>",
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "<IGSID>"
          },
          "recipient": {
            "id": "<IGID>"
          },
          "timestamp": 1502905976377,
          "postback": {
            "mid":"<MESSAGE_ID>",
            "title": "<SELECTED_ICEBREAKER_QUESTION>",
            "payload": "<USER_DEFINED_PAYLOAD>,
            "referral": {
                   "ref": "ref_data_in_ig_dot_me_param"
                   "source": "SHORTLINKS"
                   "type":  "OPEN_THREAD"
             }
          }
        }
      ]
    }
  ]
}
```

`USER_DEFINED_PAYLOAD` refers to the payload you previously configured to be sent in the postback.

#### 2. New thread + message send
If you have configured Icebreakers for your Instagram Account and the user doesn't tap on an Icebreaker, and chooses to send a message via the composer, your app receives the `messages` webhook event which includes the passed referral parameter.

The `messages` webhook event follows this format:

```http
{
  "object": "instagram",
  "entry": [
    {
      "id": "<IGSID>",
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "<IGSID>"
          },
          "recipient": {
            "id": "<IGID>"
          },
          "timestamp": 1502905976377,
          "message": {
              "mid":"<MESSAGE_ID>",
              "referral": {
                   "ref": "ref_data_in_ig_dot_me_param"
                   "source": "SHORTLINKS"
                   "type":  "OPEN_THREAD"
              }
           }
        }
      ]
    }
  ]
}
```

#### 3. Existing thread
If the user has an existing thread with your Instagram Business, when the user follows your ig.me link, Instagram just opens that respective thread. To be notified of the referral, your webhook must be subscribed to the `messaging_referral` event.

This action resets the [24-hour window for standard messaging](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy#standard_messaging), allowing the app to reply after getting the webhook event with the `ref` parameter.

The `messaging_referral` webhook event follows this format:

```http
{
  "object": "instagram",
  "entry": [
    {
      "id": "<IGSID>",
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "<IGSID>"
          },
          "recipient": {
            "id": "<IGID>"
          },
          "timestamp": 1502905976377,
          "referral": {
                 "ref": "ref_data_in_ig_dot_me_param"
                 "source": "SHORTLINKS"
                 "type":  "OPEN_THREAD"
          }
        }
      ]
    }
  ]
}
```

## Examples {#examples}
Here are some ways you can use ig.me links:

1. Use ig.me links + QR code on product packaging to allow people to reach out to you for support or get a coupon towards the next purchase.
2. Use ig.me + QR code on out of home advertising such as billboards, TV ads, physical stores to sign up for loyalty/membership accounts.
3. Use ig.me links on the Contact Us page on a website to allow people to contact you via messaging instead of relying on calling.
4. Provide callers an option to message you on Instagram by sending an ig.me link with [referral param](#refparams) via SMS.

## User experience {#userexperience}

| New threads | Existing threads |
| --- | --- |
| **Note:** Instagram shows the user the following disclosure:  <br>You opened this conversation from a link. `<Ig Business Handle>` will see that you used their link once you send a message. | **Note:** Instagram shows the user the following disclosure:<br>You opened this conversation from a link. `<Ig Business Handle>` can see that you used their link. If you wish to stop receiving messages from them, you can turn off messages. |

## Limitations {#limitations}

ig.me links are currently not supported on Instagram Web.

# The Persistent Menu



This document shows you how to programmatically add the Persistent Menu to your Instagram messaging experience.

## How it works

The Persistent Menu allows you to create and send a menu of the main features of your business, such as hours of operation, store locations, and products, is always visible in a person's Messenger conversation with your business.

When a person clicks an item in the menu, Meta sends a `postback` webhook notification to your server with information about which item the person selected and by whom, and the standard messaging window opens. You have 24 hours to respond to the person after the CTA.

## Limitations

* A menu is not updated in real time
    * Existing conversations will not see an updated menu unless a person refreshes their inbox; new conversations will see updated menus. Be sure your app can handle deprecated menu items.
* The `composer_input_disabled` parameter is not available
* The `webview_height_ratio` parameter is not available
* You cannot customize a menu based on the recipient's Page-scoped ID (PSID)

## Requirements {#requirements}

For the persistent menu to appear, the following criteria must be satisfied:

- You are running Messenger API support for Instagram v226 or above on iOS or Android.
- You have set up your Instagram professional account, Page, Developer account, and app to [successfully call Messenger API support for Instagram](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started).

## Supported buttons {#supported_buttons}

The persistent menu is composed of an array of [buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons). The following button types are supported in the persistent menu:

- `web_url`: Specifies the item is a [URL button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons).
- `postback`: Specifies the item is a [postback button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons).

## Setting the persistent menu {#set_menu}

To set the persistent menu, send a `POST` request to the [Messenger Profile API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api) to set the `persistent_menu` property.

**Note:** To view recent changes to the persistent menu within the Instagram app, go to the messages inbox and swipe down to refresh.

```curl
curl -X POST -H "Content-Type: application/json" -d
'{
    "persistent_menu": [
        {
            "locale": "default",
            "call_to_actions": [
                {
                    "type": "postback",
                    "title": "Talk to an agent",
                    "payload": "CARE_HELP"
                },
                {access_token=<ACCESS_TOKEN>
                    "type": "postback",
                    "title": "Outfit suggestions",
                    "payload": "CURATION"
                },
                {
                    "type": "web_url",
                    "title": "Shop now",
                    "url": "https://www.originalcoastclothing.com/"

                }
            ]
        }
    ]
}' "https://graph.facebook.com/v25.0/me/messenger_profile?platform=instagram&access_token=<ACCESS_TOKEN>"
```

## Localization {#localization}

You may provide default and localized button text for the persistent menu that will be displayed based on a person's locale.

To do this, specify separate objects in the `persistent_menu` array for each locale by setting the `locale` property to a [supported locale](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales):

```http
{
  "locale":"default",
  "call_to_actions":[...]
},
{
  "locale: "zh_CN",
  "call_to_actions":[...]
}
```

## Request examples

### GET request

```
curl -X GET "https://graph.facebook.com/v12.0/me/messenger_profile?fields=persistent_menu&platform=instagram"
```

Result

```
{
    "data": [
      {
        "persistent_menu": [
            {
              "locale": "default",
              "call_to_actions": [
                  {
                      "type": "postback",
                      "title": "Talk to an agent",
                      "payload": "CARE_HELP"
                  },
                  {
                      "type": "postback",
                      "title": "Outfit suggestions",
                      "payload": "CURATION"
                  },
                  {
                      "type": "web_url",
                      "title": "Shop now",
                      "url": "https://www.originalcoastclothing.com/"

                  }
              ]
            }
        ]
      }
  ]
}
```

### DELETE request

```
curl -X DELETE "https://graph.facebook.com/v12.0/me/messenger_profile?fields=["persistent_menu"]&platform=instagram"
```

## Best practices {#best_practices}

Just like with buttons, menu items can produce a webview or postback.

✅ Use the menu as entry points for your Page's main features.

✅ Be descriptive: your menu lets people know what your Page's features are. The menu instantly lets users know how they can interact with your Page.

✅ Be selective: limit menu items to 5 for best user experience.

❌ Don't expect the menu to contain user-specific data. The menu can be localized, but will not contain user-specific data.

❌ Don't put a "Menu" button in the menu that sends the user a message containing a menu. Just put that content directly in the menu — that's what it's for!

❌ Don't put generic actions like "Restart" in the menu.

❌ Don't use the most prominent menu positions for secondary information like *about*, *terms of service*, *privacy policy*, or *powered by*. These take focus away from the core features of your Page.

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Private Replies



This document shows you how to programmatically add Private Replies to your messaging experience.

## How it works

Private Replies allows your app user to send a single message to an Instagram user who commented on the app user's Instagram professional account post, ads post, reel, or live story.

When your webhook server receives a `comments` or `live_comments` event notification, you can use the comment ID to send a private reply directly to the Instagram user who published the comment. This reply will be delivered to the Instagram user's **Inbox** folder, if the Instagram user follows the Instagram professional account, or to the Instagram user's **Request** folder, if the Instagram user does not follow the account.

Private replies can be sent within 7 days of when the comment was created, excepting Instagram Live for which you a private reply can only be sent during the live broadcast. The message will contain a link to the post that the Instagram user commented on.

### Webhooks {#webhooks}

- When hosting an Instagram Live story, make sure your server can handle the increased load of notifications triggered by

[`live_comments` webhooks events, via the Instagram API,](https://developers.facebook.com/docs/instagram-api/guides/webhooks)
and that your system can differentiate between `live_comments` and `comments` notifications.

- Instagram Graph API `comments` webhooks notifications for ads posts will include the ID and title for the ad. You may need to update your webhooks server to handle these new fields.

**Success:** The `ad_id` and `ad_title` will be returned in the media object when an Instagram user comments on a boosted Instagram post or Instagram ads post. Commenting on a boosted or ads post may result in duplicate webhook notifications.

### Limitations

* Only one message can be sent to the Instagram user who commented.
* The message must be sent within 7 days from when the comment was created for comments on a post, ads post, or reel.
* Due to the transient nature of Instagram Live Stories, private replies on Instagram Live Story comments can only be sent during the live broadcast. As soon as the live broadcast has ended, private replies can no longer be sent.
* Only when the Instagram user responds to the private message can you continue the conversation within the 24-hour messaging window.
* Standard Access apps can only access data for people who have a role on the app.

### Before you start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and the [Instagram Messaging Overview](https://developers.facebook.com/docs/messenger-platform/instagram/overview) and implemented the needed components.

You will need:

* The ID for the Facebook Page linked to your Instagram professional account
* The ID for the comment made by the person to whom you are sending the private reply. The ID can be obtained from the Instagram `comments` webhooks, for posts, ads posts, and reels, and Instagram `live_comments` webhooks for live stories (recommended to avoid rate limiting) or an API call to the `/page/feed` endpoint
* The `instagram_manage_comments` and `pages_messaging` permissions, obtained via Facebook Login
* A Page access token requested by an Instagram user who can perform the `MESSAGING` task on the Facebook Page linked to your Instagram professional account
* The Human Agent feature
* Advanced Access

## Send a private reply

To send a private reply to an Instagram user who commented on your post, reel, or live story, send a `POST` request to the `/<PAGE_ID>/messages` endpoint where the `recipient` parameter contains the comment ID and the `message` parameter contains the text you wish to send.

*Formatted for readability.*

### cURL
```
curl -i -X POST "https://graph.facebook.com/<PAGE_ID>/messages
  ?recipient: { comment_id: <COMMENT_ID> }
  &message: { "text": "Thanks for reaching out, how can I help?" }
  &access_token=<PAGE_ACCESS_TOKEN>"
```

### Android SDK
```
GraphRequest request = GraphRequest.newPostRequest(
  accessToken,
  "/1353269864728879/messages",
  new JSONObject("{\"recipient\":\"{comment_id: 18000158536435933}\",\"message\":\"{\\\"text\\\": \\\"It is cool\\\"}\"}"),
  new GraphRequest.Callback() {
    @Override
    public void onCompleted(GraphResponse response) {
      // Insert your code here
    }
});
request.executeAsync();
```

### Objective-C
```
FBSDKGraphRequest *request = [[FBSDKGraphRequest alloc]
    initWithGraphPath:@"/1353269864728879/messages"
           parameters:@{ @"recipient": @"{comment_id: 18000158536435933}",@"message": @"{"text": "It is cool"}",}
           HTTPMethod:@"POST"];
[request startWithCompletionHandler:^(FBSDKGraphRequestConnection *connection, id result, NSError *error) {
    // Insert your code here
}];
```

### Java SDK
```
FB.api(
  '/1353269864728879/messages',
  'POST',
  {"recipient":"{comment_id: 18000158536435933}","message":"{\"text\": \"It is cool\"}"},
  function(response) {
      // Insert your code here
  }
);
```

On success, your app will receive the following response:

```json
{
  "recipient_id": "526...",   // The Instagram-scoped ID
  "message_id": "aWdfZ..."    // The message ID for your private reply
}
```

## See also

- [Access Levels](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview#advanced---standard-access) – Learn about the access levels and data available for each.

- [Instagram Live Media and Comments](https://developers.facebook.com/docs/instagram-api/reference/ig-user/live_media) – Visit the Instagram Graph API Reference for more information about live media.

- [Instagram Media and Comments](https://developers.facebook.com/docs/instagram-api/reference/ig-media) – Visit the Instagram Graph API Reference for more information about Instagram media.

- [Rate limits for Instagram Messaging API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview#rate-limiting) – Learn more about the rate limits that affect Instagram Messaging.

- [Tasks on Facebook Pages](https://developers.facebook.com/docs/pages/overview/permissions-features#tasks) – Learn about the tasks people can perform on the Page.

- [Webhooks for Messenger Platform](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks) – Learn about the webhooks available for Instagram Messaging

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Story Mention



Instagram notifies an Instagram Professional account when a user mentions it in a story. When this happens, the IG Professional account gets a message in the inbox referencing the story that the user posted. Because a story is temporary (it disappears after 24 hours or when deleted by the user), you must meet specific requirements and implementation guidelines to comply and respect user privacy for ephemeral content.

## Important points

* A story mention webhook will only flow in if the user mentioning the account has their account set up as public. Story mentions from a private account will only flow in if the account follows the said account.
* You must not store or cache the media content on your server.

## Developer implementation flow
* You get a webhook for every story mention received with the story CDN URL. You can store the CDN URL on your system to avoid repeated calls to conversation API. You must not store the media content on your server.
* When the agent clicks on the content or opens the thread, it will trigger a call to your server.
* The agent's browser renders the content using the CDN URL obtained via webhooks/Conversation API.
* Once the user deletes the story or it expires, the URL will stop rendering and you should show a placeholder message indicating that the story content is no longer available.

## Rendering story in agent's inbox/client view

There are several options where you can choose to render the story content in the agent's inbox:

* *In-thread rendering* - For this scenario/behavior, when the agent clicks a particular thread, you will load the CDN URL and render it on the client's side.
* *User action rendering* - For this scenario/behavior, the client renders story content with a placeholder, and when the user clicks the display/view button, you will load the CDN URL and render it on the client's side.

## Example webhook

```json
  {
  "object": "instagram",
  "entry": [
    {
      "id": "<IGID>",
      "time": 1569262486134,
      "messaging": [
        {
          "sender": {
            "id": "<IGSID>"
          },
          "recipient": {
            "id": "<IGID>"
          },
          "timestamp": 1569262485349,
          "message": {
            "mid": "<MESSAGE_ID>",
            "attachments":[
              {
                  "type":"story_mention",
                  "payload":{
                     "url":"<CDN_URL>"
                  }
              }
            ]
          }
        }
      ]
    }
  ],
}
```

## Example request to retrieve story mention via Conversation API

```json
GET <MESSAGE_ID>?fields=story

{
  "story": {
    "mention": {
      "link": "<CDN_URL>",
      "id": "<STORY_ID>"
    }
  },
  "id": "<MESSAGE_ID>"
}
```

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Moderate Conversations API for Instagram



This guide explains how to use the Moderate Conversations API to:

- Block a user
- Unblock a user
- Move a conversation to spam in the Meta Business Suite Inbox

## Before you start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components for sending and receiving messages and notifications.

You will need:

- The ID for the Facebook Page linked to your Instagram Professional account
- The Instagram-scoped ID for the customer you want to apply the action to
- A Page access token requested from a person who can perform the MESSAGE task on the Facebook Page linked to your Instagram Professional account
- `instagram_manage_messages`, `instagram_basic`, and `business_management` permissions. **Advanced Access** is required to use this API for conversations involving your business and people who **do not** have a role on your messaging app, your Facebook page, or your business
- A conversation must exist between the user and Instagram business before any of the actions provided by this API can be used

### Limitations

- Up to 10 IDs can be provided in each request
- Up to 2 actions can be specified in each request. `unblock_user` cannot be included in the same request as `block_user`
- You cannot block an Instagram user that is linked, through accounts center, to your Instagram business account

### Request parameters

#### `user_ids`

| Property | Description |
| --- | --- |
| `id` *string<br>* | Instagram-scoped ID for the person you want to apply the action to |

#### Actions

| Action | Description |
| --- | --- |
| `block_user` | Blocks user and Instagram business interactions on Instagram.<br><br>Prevents a user from messaging the Instagram business and prevents the business from messaging the user. The user will not be able to find the business's profile, posts, or stories on Instagram. |
| `unblock_user` | Unblocks user and Instagram business interactions on Instagram.<br><br>Allows the user and business to message each other again. The user will be able to view and interact with the business's content on Instagram. |
| `move_to_spam` | Marks the conversation as spam and moves the conversation to the spam folder in Meta Business Suite inbox. |

## Block a user

To block messaging with a user, send a `POST` request to the `/<PAGE_ID>/moderate_conversations` endpoint with the Instagram-scoped ID for the user and the `block_user` action.

#### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "user_ids":[
    {
        "id": "<IGSID>"
    }
  ],
  "actions": [
    "block_user"
  ]
}' "https://graph.facebook.com/v22.0/<PAGE_ID>/moderate_conversations?access_token=<PAGE_ACCESS_TOKEN>"
```

On success, your app will receive the following JSON response with the `success` field set to `true`. On failure, the `success` field will be set to `false`.

```curl
"success": "true"
```

## Unblock a user

To unblock a user, send a `POST` request to the `/<PAGE_ID>/moderate_conversations` endpoint with the Instagram-scoped ID for the user and the `unblock_user` action.

#### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "user_ids":[
    {
        "id":"<IGSID>"
    }
  ],
  "actions": [
    "unblock_user"
  ]
}' "https://graph.facebook.com/v22.0/<PAGE_ID>/moderate_conversations?access_token=<PAGE_ACCESS_TOKEN>"
```

On success, your app will receive the following JSON response with the `success` field set to `true`. On failure, the `success` field will be set to `false`.

```curl
"success": "true"
```

## Move conversation to spam

To mark a conversation as spam and move it to the spam folder in the Meta Business Suite inbox, send a `POST` request to `/<PAGE_ID>/moderate_conversations` with the Instagram-scoped ID for the user and the `move_to_spam` action.

#### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "user_ids":[
    {
        "id":"<IGSID>"
    }
  ],
  "actions": [
    "move_to_spam"
  ]
}' "https://graph.facebook.com/v22.0/<PAGE_ID>/moderate_conversations?access_token=<PAGE_ACCESS_TOKEN>"
```

On success, your app will receive the following JSON response with the `success` field set to `true`. On failure, the `success` field will be set to `false`.

```curl
"success": "true"
```

## Perform multiple actions for multiple users

If you would like to perform multiple actions at once for a set of users, send a `POST` request to `/<PAGE_ID>/moderate_conversations` with the Instagram-scoped IDs for the users and a list of the actions that should be applied to the users.

#### Sample request

Block two users and move the conversations to spam.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "user_ids":[
    {
        "id":"<IGSID>"
    },
    {
        "id":"<IGSID>"
    }
  ],
  "actions": [
    "block_user",
    "move_to_spam"
  ]
}' "https://graph.facebook.com/v22.0/<PAGE_ID>/moderate_conversations?access_token=<PAGE_ACCESS_TOKEN>"
```

On success, your app will receive the following JSON response with the `success` field set to `true`. On failure, the `success` field will be set to `false`.

```curl
"success": "true"
```

## Error codes
If you encounter any of the following errors while trying to complete the request for multiple users, you can retry the request with one user at a time.

| Error Code | Message |
| --- | --- |
| `100` | Invalid parameter<br><br>The provided user ids or actions may be invalid<br><br>The user ID is not a valid PSID or IGSID<br><br>Invalid actions |
| `1` | Failed to block Instagram user<br><br>Failed to unblock Instagram user<br><br>Instagram Direct thread not found between business and consumer<br><br>Unexpected error: Failed to move Instagram thread to spam folder |
# User Profile API



The User Profile API allows you to use an Instagram Scoped ID (IGSID) to retrieve customer profile information. You can use this information to create a personalized experience for people interacting with your business.

## User consent

**User consent is required to access the user profile.** A person sets user consent only when they send a message to your business, or click icebreakers or persistent menu. If a person comments on a post or comment but has not sent a message to a business, your app receives an error, **User consent is required to access the user profile.**

### Requirements

You need:

* The `instagram_basic` permission
* The `instagram_manage_messages` permission
* The `pages_manage_metadata` permission
* The `pages_read_engagement` permission
* The `pages_show_list` permission
* A Page access token requested by a person who can perform the `MODERATE` task on the Page

### Limitations

If a customer has blocked your business, you can't view their information.

## User profile fields

The following profile fields are available for all Graph API versions.

| Field Name | Description |
| --- | --- |
| `name`<br><br>_string_ | The customer's name (can be null if name not set) |
| `profile_pic`<br><br>_url_ | The URL for the customer's profile picture (can be null if profile pic not set). The URL expires after a few days. |
| `is_verified_user`<br><br>_boolean_ | Verification status for the customer |
| `follower_count`<br><br>_int_ | Follower count for the customer |
| `is_user_follow_business`<br><br>_boolean_ | Indicates whether the customer follows the business or not |
| `is_business_follow_user`<br><br>_boolean_ | Indicates whether the business follows the customer or not |
| `username`<br><br>_string_ | The username for the customer's Instagram account |

### Sample request

To get a customer's profile information, send a `GET` request to the Instagram Scoped ID node for the customer and include the fields you want to view.

_Formatted for readability._

```curl
curl -X GET "https://graph.facebook.com/v25.0/<INSTAGRAM_SCOPED_USER_ID>
  ?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user
  &access_token=<PAGE_ACCESS_TOKEN>"
```

On success, your app receives the following JSON response:

```json
{
  "name": "Peter Chang",
  "username": "peter_chang_live",
  "profile_pic": "https://fbcdn-profile-...",
  "follower_count": 1234
  "is_user_follow_business": false,
  "is_business_follow_user": true,
}
```

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.

# Webhooks for Instagram Messaging



Webhooks allows you to receive real-time HTTP notifications of changes to specific objects in the Meta social graph. For example, Meta can send you a notification when a customer sends your Instagram Professional account a message. Webhooks notifications allow you to track messaging changes and avoid rate limits that would occur if you were querying the Messenger Platform endpoints to track changes.

### Requirements {#requirements}

You will need to implement the following requirements to receive Webhooks notifications for Instagram Messaging.

* The `instagram_basic`, `instagram_manage_messages`, and `pages_manage_metadata` permissions
* To get webhooks notification that include data owned or managed by people who do not have a role on your app, your app must have been approved in App Review. Your app user must have granted your app the prerequisite permissions.
    * If your app has not been approved, pending, or review is not needed, Webhooks will only be sent if the person using your app has a role on the app. You can only access data you own or administer.
* Your app must be published, regardless of app review status, to receive webhooks.

**Note:** You will need to subscribe all messaging apps for your business to the messaging webhooks.

Learn more about
[access levels](https://developers.facebook.com/docs/graph-api/overview/access-levels),
[app modes](https://developers.facebook.com/docs/development/build-and-test/app-modes)
and
[app roles.](https://developers.facebook.com/docs/development/build-and-test/app-roles)

### Limitations

- When a customer reacts to or forwards an image from a carousel in an Instagram Post, the notification will include the first image in the carousel which may not be the image the customer reacted to or forwarded.

- Only the URL for the shared media or post is included in the notification when a customer sends a message with a share.

- Messages with gifs and stickers are not supported. If a person sends a message with a gif or sticker a webhook will not be triggered and a webhook notification will not be sent.

- [Disappearing media](https://help.instagram.com/1310346208996329/?cms_platform=iphone-app) (view once, allow replay) is not supported on Instagram media webhooks.

## Webhook events {#webhook-events}

| Webhook Field | Description |
| --- | --- |
| `message_reactions` | Meta sends a notification when a customer reacts or unreacts to a message<br><br>Graph API v12.0 and later supports `angry`, `sad`, `wow`, `love`,  `like`, `laugh`, and `other` reactions. |
| `messages` | A notification is sent when a customer sends your business:<br><br>* a message with text or media (image/video/file/audio)<br>* a share (media/post shares)<br>* a story reply or mention. Only story mentions will trigger a webhook. Tagging on regular posts will not trigger a webhook. Story Replies webhook currently doesn't support GIF or sticker.<br>* an inline message reply or sticker<br>* a quick reply or Icebreaker option or Generic Template button is selected<br>* a customer deletes a message<br>* a message from a customer is unsupported<br>* a customer sends a message from an Instagram Shops product detail page<br>* a customer clicks an ad that goes to an Instagram Messaging conversation [(Click To Direct, CTD)](https://www.facebook.com/business/help/198088077975174)<br><br>A notification is also sent when your business sends a message to a customer. A notification will not be sent when your business reacts or unreacts to a customer message.<br><br>This callback will occur when a message has been sent by your Instagram account. `is_echo` flag will be present to indicate that the message is sent from the Instagram account itself. `message_reactions` event will not have an echo webhook delivered |
| `messaging_postbacks` | A notification is sent when a customer clicked an Icebreaker option or Generic Template button<br><br>Requires v8.0 or later. Requires v11.0 or later for inclusion of the `mid` field. |
| `messaging_seen` | A notification is sent when a message has been read by the recipient |
| `messaging_referral` | A notification is sent when an `ig.me` link with a referral parameter is clicked by a customer in an existing conversation |
| `standby` | When the messaging flow has multiple apps, a notification is sent when a customer sends your business a message but the app is not in control of the conversation at the time the message was sent. |

## Example notifications

The following are examples for the types of webhooks notifications you can receive.

### Messages

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "IGID",  // ID of your Instagram Professional account
      "time": 1569262486134,
      "messaging": [
        {
          "sender": { "id": "IGSID" },    // Instagram-scoped ID for the customer who sent the message
          "recipient": { "id": "IGID" },  // ID of your Instagram Professional account
          "timestamp": 1569262485349,
          "message": {
            "mid": "MESSAGE-ID",   // ID of the message sent to your business

            "text": "MESSAGE-TEXT"     // Included when a customer sends a message containing text

            "attachments": [           // Included when a customer sends multiple media attachments or a URL for a story mention or share
              {
                "type":"image",             // Can be audio, file, image (image or sticker), share, story_mention, video, ig_reel or reel
                "payload":{ "url":"LINK" }
              },
              {
                "type":"video",
                "payload":{ "url":"LINK" }
              }
            ]

            "is_deleted": true         // Included when a customer deletes a message

            "is_echo": true            // Included when your business sends a message to the customer

            "is_unsupported": true,    // Included when a customer sends a message with unsupported media

            "quick_reply": {           // Included when a customer clicks a quick reply
              "payload": "CUSTOMER-RESPONSE-PAYLOAD"   // The payload with the option selected by the customer
            },

            "referral": {              // Included when a customer clicks an Instagram Shop product
              "product": {
                "id": "PRODUCT-ID"
            }

            "referral": {                   // Included when a customer clicks an CTD ad
              "ref": "REF-DATA-IN-AD-IF-SPECIFIED"
              "ad_id": AD-ID,
              "source": "ADS",
              "type": "OPEN_THREAD",
              "ads_context_data": {
                "ad_title": TITLE-FOR-THE-AD,
                "photo_url": IMAGE-URL-THAT-WAS-CLICKED,
                "video_url": THUMBNAIL-URL-FOR-THE-AD-VIDEO,<!-- "post_id": ID-OF-THE-POST, -->
              }
            }

            "reply_to":{               // Included when a customer sends an inline reply
              "mid":"MESSAGE-ID"
            }

            "reply_to": {               // Included when a customer replies to a story
              "story": {
                "url":"CDN-URL",
                "id":"STORY-ID"
              }
            }
          }
        }
      ]
    }
  ]
}
```

### Message reactions

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "IGID",  // ID for your Instagram Professional account
      "time": 1569262486134,
      "messaging": [
        {
          "sender": {
            "id": "IGSID"  // Instagram-scoped ID for the customer who sent the message
          },
          "recipient": {
            "id": "IGID"  // ID for your Instagram Professional account
          },
          "timestamp": 1569262485349,
          "reaction" :{
            "mid" : "MESSAGE-ID",
            "action": "react",    // or unreact
            "reaction": "love", // optional, to unreact if there is no reaction field
            "emoji": "\u{2764}\u{FE0F}" // optional, to unreact if there is no emoji field
          }
        }
      ]
    }
  ]
}
```

### Messaging postbacks

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "IGSID",  // ID of your Instagram Professional account
      "time": 1502905976963,
      "messaging": [
        {
          "sender": { "id": "IGSID" },    // Instagram-scoped ID for the customer who sent the message
          "recipient": { "id": "IGID" },  // ID of your Instagram Professional account
          "timestamp": 1502905976377,
          "postback": {
            "mid":"MESSAGE-ID",           // ID for the message sent to your business
            "title": "SELECTED-ICEBREAKER-REPLY-OR-CTA-BUTTON",
            "payload": "CUSTOMER-RESPONSE-PAYLOAD",  // The payload with the option selected by the customer
          }
        }
      ]
    }
  ]
}
```

### Messaging referral {#igme}

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "IGSID",  // ID of your Instagram Professional account
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "IGSID"  // Instagram-scoped ID for the customer who sent the message
          },
          "recipient": {
            "id": "IGID"  // ID of your Instagram Professional account
          },
          "timestamp": 1502905976377,
          "referral": {
                 "ref": "INFORMATION-INCLUDED-IN-REF-PARAMETER-OF-IGME-LINK"
                 "source": "IGME-SOURCE-LINK"
                 "type":  "OPEN_THREAD"  // Only supported for existing conversations
          }
        }
      ]
    }
  ]
}
```

### Messaging seen

```json
{
   "object":"instagram",
   "entry":[
      {
         "id":"IGID",  // ID for your Instagram Professional account
         "time":1569262486134,
         "messaging":[
            {
               "sender":{
                  "id":"IGSID"  // Instagram-scoped ID for the customer who sent the message
               },
               "recipient":{
                  "id":"IGID"  // ID for your Instagram Professional account
               },
               "timestamp":1569262485349,
               "read":{
                  "mid":"MESSAGE-ID"
               }
            }
         ]
      }
   ]
}
```

### Disappearing media

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "IGID",  // ID of your Instagram Professional account
      "time": 1569262486134,
      "messaging": [
        {
          "sender": { "id": "IGSID" },    // Instagram-scoped ID for the customer who sent the message
          "recipient": { "id": "IGID" },  // ID of your Instagram Professional account
          "timestamp": 1569262485349,
          "message": {
            "mid": "MESSAGE-ID",   // ID of the message sent to your business
            "attachments": [
              {
                "type":"ephemeral" // no URL is included for ephemeral media
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## See also

- [Messenger Handover Protocol](https://developers.facebook.com/docs/messenger-platform/handover-protocol)  – If you have more than one app handling messages, for example, one app handles automated responses and one app handles escalations to a human agent, then you will need to implement the Handover Protocol to pass the conversation from one app to another.

- [Click To Direct, CTD](https://www.facebook.com/business/help/198088077975174)  – Visit the Business Help Center to learn more about creating ads that click to Instagram Direct.

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.






