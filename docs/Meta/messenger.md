# Get Started – Send a Message with Messenger Platform



Learn how your business can send a message to a customer using the Messenger Platform.

You can use this tutorial to send a message from **your app** or, if you don't have a fully functional app or just want to explore, you can use our **Graph API Explorer**.

## Before You Start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components for sending and receiving messages and notifications.

### Requirements

To make a successful call to the Meta social graph to send a message, your app will need:

- The **`pages_show_list`** permission and a **User access token**, requested by you. This allows your app, or the Graph API Explorer, to get your **Page ID**.

- The **`pages_messaging`** permission and a **Page access token**, requested by a person who can perform the `MESSAGING` task on your Page, allows your app to get the  **conversation ID** and your **Page-scoped ID (PSID)**

You can get access tokens 3 different ways:

- [Facebook Login](https://developers.facebook.com/documentation/facebook-login/overview) in your app

- The
[App Dashboard](https://developers.facebook.com/apps) in **Messenger > Settings**

- The Graph API Explorer, [(shown below)](#gx-tool)

### Start a Conversation

Log in to your Facebook account and send a message to your test Page to create a **PSID** for the customer (you) that is specific for the Page and a **conversation ID** representing the conversation between the customer (you) and the Page.

## Use Your App

If you have already subscribed to the messaging Webhooks, you can get the PSID, the conversation ID, and the message text from the Webhook notification, and move to [**Step 2**](#step-2-send-the-customer-a-message).

### Step 1. Get the IDs

You will need the ID for your Page, the PSID for the person who sent the message (you) and the conversation ID.

#### Get the Page ID & Page Access Token

To obtain your Page ID, send a `GET` request to the `/<USER_ID>/accounts` endpoint, replacing `<USER_ID>` with your actual ID. You can also use `me` in place of your User ID.

The `me` endpoint is a special endpoint that represents the ID for the User, Page, or App that is requesting the access token. In the following example, you will use a User access token in the request so `me` will represent your User ID.

#### Sample Request

```curl
curl -i -X GET "https://graph.facebook.com/<API_VERSION>/me/accounts
    ?access_token=<USER_ACCESS_TOKEN>"
```

#### Example Response

On success, your app will receive a JSON object with the Page ID as well as a Page access token that you can use in subsequent requests.

```json
{
  "data": [
    {
      "access_token": "EAABkWcj...",    // PAGE-ACCESS-TOKEN
      "category": "Pet Service",
      "category_list": [
        {
          "id": "144982405562750",
          "name": "Pet Service"
        }
      ],
      "name": "Cisco Dog Page",
      "id": "4225...",                   // PAGE-ID
      "tasks": [
        "ADVERTISE",
        "ANALYZE",
        "CREATE_CONTENT",
        "MESSAGING",
        "MODERATE",
        "MANAGE"
      ]
    }
  ]
}
```

#### Get the PSID & Message ID

To obtain the PSID and message ID, send a `GET` request to the `/<PAGE_ID>/conversations` endpoint with the `participants` and `messages{id,message}` fields.

#### Sample Request

```curl
curl -i -X GET "https://graph.facebook.com/<API_VERSION>/<PAGE_ID>/conversations?fields=participants,messages{id,message}&access_token=<PAGE_ACCESS_TOKEN>"
```

#### Example Response

On success, your app will receive the following JSON response:

```json
{
  "data": [
    {
      "participants": {
        "data": [
          {
            "name": "CUSTOMER-NAME",
            "email": "PSID@facebook.com",
            "id": "PSID"
          },
          {
            "name": "PAGE-NAME",
            "email": "PAGE-ID@facebook.com",
            "id": "PAGE-ID"
          }
        ]
      },
      "messages": {
        "data": [
          {
            "id": "m_MeS2...",   // Message ID
            "message": "hello"
          },
          {
            "id": "m_Nl1...",    // Message ID
            "message": "CUSTOMER-NAME"
          }
        ]
      },
      "id": "t_10224..."        // Conversation ID
    }
  ]
}
```

### Step 2. Send the Customer a Message {#step-2-send-the-customer-a-message}

To respond to the message a customer sent to your Page, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the `recipient` parameter set to the customer's PSID, `messaging_type` parameter set to `RESPONSE`, and the `message` parameter set to your response. **Note** that this must be sent within 24 hours of your Page receiving the customer's message.

#### Sample Request

```curl
curl -X POST "https://graph.facebook.com/<API_VERSION>/<PAGE_ID>/messages" \
    -d "recipient={'id':'<PSID>'}" \
    -d "messaging_type=RESPONSE" \
    -d "message={'text':'You did it!'}" \
    -d "access_token=<PAGE_ACCESS_TOKEN>"
```

On success, your app will receive the following JSON response:

```json
{
  "recipient_id": "1008...",    // The customer's PSID
  "message_id": "m_AG5Hz2..."}  // The message ID
```

## Use the Graph API Explorer Tool {#gx-tool}

If you have already subscribed to the messaging Webhooks, you can get the PSID, the conversation ID, and the message text from the Webhook notification, and move to [**Step 2**](#step-2-send-the-customer-a-message-2).

### Step 1. Get the IDs

You will need the ID for your Page, the Page-scoped ID (PSID) for the person who sent the message (you) and the message ID.

[**Open the Graph API Explorer **](https://developers.facebook.com/tools/explorer/) in a new browser tab or window.

The explorer loads with a default query with the `GET` method, the lastest version of the Graph API, the `/me` node and the `id` and `name` fields in the Query String Field, and your Facebook App. If you would like to run this default query, you can click **Generate Access Token** then **Submit**. This query will create a User access token and return your name and User ID.

The `me` endpoint is a special endpoint that represents the ID for the User, Page, or App that is requesting the access token. In the following example, you will use a User access token in the request so me will represent your User ID. In Step 4, `me` will represent your Page since are using a Page access token.

To get the Page ID for your Page:

- Replace the Query String Field string with either `me/accounts` or `/<USER_ID>/accounts`. If you ran the default query, you can click the ID in the response and it will automatically be moved to the Query String Field.

- Go the **Add a permission** dropdown menu in the right side panel and select the `pages_show_list` permission then click **Generate Access Token**.

- The popup window allows you to agree that the app can access the list of your Pages.

- Click **Submit** to run the query.

To get the Message ID and the PSID:

- Click the Page ID in the response to move it to the Query String Field and add `**/conversations?fields=participants,messages{id,message}**` to the query.

- Go to the **Add a Permission** dropdown menu and select the `**pages_messaging**` permission then click **Generate Access Token**.

- Another popup window will ask you to agree that the app can access the conversations of your Pages.

- Click **Submit** to run the query.

- Copy the Page ID and PSID for Step 3.

### Step 2. Send the Customer a Message {#step-2-send-the-customer-a-message-2}

To respond to the message the customer sent to your Page:

- In the Response Window, click the message ID for the message you want to reply to.

- In the upper left, switch the method from `GET` to `POST`.

- In the Node Field Viewer to the left of the Response Window, click the  **+ Add parameter** under the **Params** tab. Add the following:

- `recipient` set to `{id:<PSID>}`

- `messaging_type` set to `RESPONSE`

- `message` set to `{text:'Hello, new customer!'}`

- Click **Submit**.

**Note** that when using the `RESPONSE` message type, the message must be sent within 24 hours of your Page receiving the customer's message or an error will occur.

## Next Steps

* [Attach Media Assets to your Message](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/saving-assets)
* [Send a customer a message after the 24-hour messaging window](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api)
* [Create a Message Template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates)

## Learn More

* [Graph API](https://developers.facebook.com/docs/graph-api)
* [Graph API Explorer Tool](https://developers.facebook.com/docs/graph-api/guides/explorer)
* [Page Access Tokens](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens)
* [Page Permissions and Tasks](https://developers.facebook.com/docs/pages/overview/permissions-features)
* [Page/Messages Reference](https://developers.facebook.com/docs/graph-api/reference/page/messages)

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Quick start tutorial


This tutorial guides you through everything you need to know to build your first Messenger experience. Before you begin, choose one of the options under [Starter Projects](#starter) to get the code you need to start, then follow the steps under [Getting Started](#getting_started) to get set up.

To run the finished code, [fork it on GitHub](https://github.com/fbsamples/messenger-platform-samples/tree/master/quick-start).

### Contents

- [Starter Project](#starter)
- [Get Started](#getting_started)
- [Build the Experience](#build)

## Starter project {#starter}

Before you begin this quick start, make sure you have completed one of the following to ensure you have the starter code you need. The starter code provides a basic webhook that you will use as the foundation of the Messenger experience.

### Option 1: Build it yourself

The [webhook setup guide](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks) walks you through building your first webhook that you can use with this quick start from start to finish.

[Build Your Webhook](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)

### Option 2: Download it from GitHub

Download the webhook starter code from GitHub, and deploy it to a server of your choice.

[Download the Code](https://github.com/fbsamples/messenger-platform-samples/tree/master/quick-start)

## Get started {#getting_started}

Before you build your first Messenger experience, start by setting up the credentials for your app.

### Set up your Facebook app

If you have not already, follow the [app setup guide](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks) to set up your Facebook app for use with the Messenger Platform.

**Note:** #### Standard access

Until your app has been submitted and approved for public use on Messenger through Meta's App Review, Page tokens only allow your Page to interact with Facebook accounts that have been granted the Administrator, Developer, or Tester role for your app.

To grant these roles to other Facebook accounts, go to the 'Roles' tab of your app settings.

### Generate a Page access token

Authenticate all requests to Messenger Platform APIs by including a page-level access token in the `access_token` parameter of the query string.

If you did not already do so when you [set up your Facebook app](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks), generate a Page access token, by doing the following:

1. In the **Token Generation** section of your app's Messenger settings, select the Facebook Page you want to generate a token for from the **Page** dropdown. An access token will appear in the **Page Access Token** field.
1. Click the **Page Access Token** field to copy the token to your clipboard.

The generated token is not saved in this UI. Each time you select a Page from the dropdown, a new token will be generated. If a new token is generated, previously created tokens will continue to function.

### Save your Page token as an environment variable

Keep sensitive information like your Page access token secure by not hard-coding it into your webhook.

To store the token securely, add the following to your environment variables, where `<PAGE_ACCESS_TOKEN>` is the access token you generated and `<VERIFY_TOKEN>` is a random string that you set to verify your webhook:

```bash
PAGE_ACCESS_TOKEN="<PAGE_ACCESS_TOKEN>"
VERIFY_TOKEN="<VERIFY_TOKEN>"
```

### Add your Page and verify tokens to your webhook

Now add your Page access token and verify token at the top of your `app.js` file to use in your webhook logic:

```javascript
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
```

Your setup is now complete.

## Build the experience {#build}

In this tutorial, you build a simple Messenger experience that does the following:

1. Parses the message and sender's page-scoped ID from an incoming webhook event.
1. Handles `messages` and `messaging_postbacks` webhook events.
1. Sends messages via the Send API.
1. Responds to text messages with a text message.
1. Responds to an image attachment with a generic template that uses the received image.
1. Responds conditionally to a postback payload.

### Stub out handler functions

To start, stub out three functions that handle the incoming webhook event types you want to support, as well as responding via the Send API. Append the following to your `app.js` file:

```javascript
// Handles messages events
function handleMessage(sender_psid, received_message) {
  ...
}

// Handles messaging_postbacks events
function handlePostback(sender_psid, received_postback) {
  ...
}

// Sends response messages via the Send API
function callSendAPI(sender_psid, response) {
  ...
}
```

### Get the sender's page-scoped ID

To respond to people on Messenger, you first need to know who they are. In Messenger, this is accomplished by getting the message sender's page-scoped ID (PSID) from the incoming webhook event.

### What is a PSID?

A person is assigned a unique page-scoped ID (PSID) for each Facebook Page they start a conversation with. The PSID is used to identify a person when sending messages.

If you completed one of the options in the [Starter Project](#starter) section above, you should have a basic `/webhook` endpoint that accepts `POST` requests and logs the body of received webhook events that looks like this:

```javascript
app.post('/webhook', (req, res) => {

  // Parse the request body from the POST
  let body = req.body;

  // Check the webhook event is from a Page subscription
  if (body.object === 'page') {

    // Iterate over each entry - there may be multiple if batched
    body.entry.forEach(function(entry) {

      // Get the webhook event. entry.messaging is an array, but
      // will only ever contain one event, so we get index 0
      let webhook_event = entry.messaging[0];
      console.log(webhook_event);

    });

    // Return a '200 OK' response to all events
    res.status(200).send('EVENT_RECEIVED');

  } else {
    // Return a '404 Not Found' if event is not from a page subscription
    res.sendStatus(404);
  }

});
```

To get the sender's PSID, update the `body.entry.forEach` block with the following code to extract the PSID from the `sender.id` property of the event:

```javascript
body.entry.forEach(function(entry) {

  // Gets the body of the webhook event
  let webhook_event = entry.messaging[0];
  console.log(webhook_event);

  // Get the sender PSID
  let sender_psid = webhook_event.sender.id;
  console.log('Sender PSID: ' + sender_psid);

});
```

#### Test it
Open Messenger and send a message to the Facebook Page associated with your Messenger experience. You will not receive a response in Messenger, but you should see a message with your PSID logged to the console where your webhook is running:

```
Sender PSID: 1254938275682919
```

### Parse the webhook event type

Your experience needs to handle two types of webhook events: `messages` and `messaging_postback`. The name of the event type is not included in the event body, but you can determine it by checking for certain object properties.

#### What are webhook events?

The Messenger Platform sends webhook events to notify you of actions that occur in Messenger. Events are sent in JSON format as `POST` requests to your [webhook](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks). For more information, see [Webhook Events](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks).

To do this, update the `body.entry.forEach` block of your webhook with a conditional that checks whether the received event contains a `message` or `postback` property. This also adds calls to the `handleMessage()` and `handlePostback()` functions that you stubbed out earlier:

```javascript
body.entry.forEach(function(entry) {

  // Gets the body of the webhook event
  let webhook_event = entry.messaging[0];
  console.log(webhook_event);

  // Get the sender PSID
  let sender_psid = webhook_event.sender.id;
  console.log('Sender PSID: ' + sender_psid);

  // Check if the event is a message or postback and
  // pass the event to the appropriate handler function
  if (webhook_event.message) {
    handleMessage(sender_psid, webhook_event.message);
  } else if (webhook_event.postback) {
    handlePostback(sender_psid, webhook_event.postback);
  }

});
```

### Handle text messages

Now that incoming messages are routed to the appropriate handler function, update `handleMessage()` to handle and respond to basic text messages. Define the message payload of the response, then pass that payload to `callSendAPI()`. To respond with a basic text message, define a JSON object with a `"text"` property:

```javascript
function handleMessage(sender_psid, received_message) {

  let response;

  // Check if the message contains text
  if (received_message.text) {

    // Create the payload for a basic text message
    response = {
      "text": `You sent the message: "${received_message.text}". Now send me an image!`
    }
  }

  // Sends the response message
  callSendAPI(sender_psid, response);
}
```

### Send a message with the Send API

Send your first message with the Messenger Platform's Send API.

In `handleMessage()`, you are calling `callSendAPI()`, so now you need to update it to construct the full request body and send it to the Messenger Platform. A request to the Send API has two properties:

- `recipient`: Sets the intended message recipient. In this case, you identify the person by their PSID.
- `message`: Sets the details of the message to be sent. Here, you set it to the message object passed in from your `handleMessage()` function.

To construct the request body, update the stub for `callSendAPI()` to the following:

```javascript
function callSendAPI(sender_psid, response) {
  // Construct the message body
  let request_body = {
    "recipient": {
      "id": sender_psid
    },
    "message": response
  }
}
```

Now send the message by submitting a `POST` request to the Send API at `https://graph.facebook.com/v21.0/me/messages`.

Note that you must append your `PAGE_ACCESS_TOKEN` in the `access_token` parameter of the URL query string.

**Note:** #### Making HTTP Requests
This quick start uses the Node.js `request` module for sending HTTP requests back to the Messenger Platform, but you can use any HTTP client you like.

To install the request module, run `npm install request --save` from the command line, then import it by adding the following to the top of `app.js`:

```javascript
const request = require('request');
```

```javascript
function callSendAPI(sender_psid, response) {
  // Construct the message body
  let request_body = {
    "recipient": {
      "id": sender_psid
    },
    "message": response
  }

  // Send the HTTP request to the Messenger Platform
  request({
    "uri": "https://graph.facebook.com/v21.0/me/messages",
    "qs": { "access_token": process.env.PAGE_ACCESS_TOKEN },
    "method": "POST",
    "json": request_body
  }, (err, res, body) => {
    if (!err) {
      console.log('message sent!')
    } else {
      console.error("Unable to send message:" + err);
    }
  });
}
```

#### Test it

In Messenger, send another text message to your Facebook Page. You should receive an automated response from your Messenger experience that echoes back your message and prompts you to send an image.

### Handle attachments

Since the response prompts the message recipient to send an image, the next step is to update your code to handle an attachment. Sent attachments are automatically saved by the Messenger Platform and made available via a URL in the `payload.url` property of each index in the `attachments` array, so you also extract this from the event.

#### What attachment types are supported?

Your Messenger experience can send and receive most asset types, including images, audio, video, and files. Media is displayed and is even playable in the conversation, allowing you to create media-rich experiences.

To determine if the message is an attachment, update the conditional in your `handleMessage()` function to check the `received_message` for an `attachments` property, then extract the URL for it. In a real-world bot you would iterate the array to check for multiple attachments, but for the purpose of this quick start, you get the first attachment only.

```javascript
function handleMessage(sender_psid, received_message) {

  let response;

  // Checks if the message contains text
  if (received_message.text) {

    // Creates the payload for a basic text message, which
    // will be added to the body of our request to the Send API
    response = {
      "text": `You sent the message: "${received_message.text}". Now send me an attachment!`
    }

  } else if (received_message.attachments) {

    // Gets the URL of the message attachment
    let attachment_url = received_message.attachments[0].payload.url;

  }

  // Sends the response message
  callSendAPI(sender_psid, response);
}
```

### Send a structured message

Next, respond to the image with a generic template message. The generic template is the most commonly used structured message type, and allows you to send an image, text, and buttons in one message.

#### Are other message templates available?

The Messenger Platform provides a set of message templates, each designed to support a different, common message structure, including lists, receipts, buttons, and more. For complete details, see [Templates](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates).

Message templates are defined in the `attachment` property of the message, which contains `type` and `payload` properties. The `payload` is where you set the details of the generic template in the following properties:

* `template_type`: Sets the type of template used for the message. This example uses the generic template, so the value is `generic`.
* `elements`: Sets the custom properties of the template. For the generic template, you specify a title, subtitle, image, and two postback buttons.

For the structured message, use the `attachment_url` that was sent as the `image_url` to display in the template, and include a couple of postback buttons to allow the message recipient to respond. To construct the message payload and send the generic template, update `handleMessage()` to the following:

```javascript
function handleMessage(sender_psid, received_message) {
  let response;

  // Checks if the message contains text
  if (received_message.text) {
    // Create the payload for a basic text message, which
    // will be added to the body of our request to the Send API
    response = {
      "text": `You sent the message: "${received_message.text}". Now send me an attachment!`
    }
  } else if (received_message.attachments) {
    // Get the URL of the message attachment
    let attachment_url = received_message.attachments[0].payload.url;
    response = {
      "attachment": {
        "type": "template",
        "payload": {
          "template_type": "generic",
          "elements": [{
            "title": "Is this the right picture?",
            "subtitle": "Tap a button to answer.",
            "image_url": attachment_url,
            "buttons": [
              {
                "type": "postback",
                "title": "Yes!",
                "payload": "yes",
              },
              {
                "type": "postback",
                "title": "No!",
                "payload": "no",
              }
            ],
          }]
        }
      }
    }
  }

  // Send the response message
  callSendAPI(sender_psid, response);
}
```

#### Test it

In Messenger, send an image to your Facebook Page. Your Messenger experience should respond with a generic template.

### Handle postbacks

The last step is to handle the `messaging_postbacks` webhook event that is sent when the message recipient taps one of the postback buttons in the generic template.

#### What can I do with postbacks?

The [postback button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/postback) sends a [`messaging_postbacks`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_postbacks) webhook event to your webhook that includes a custom string of up to 1,000 characters in the `payload` property. This allows you to easily implement different postback payloads that you can parse and respond to with specific behaviors.

Since the generic template allows the message recipient to choose from two postback buttons, you respond based on the value of the `payload` property of the postback event. To do this, update your `handlePostback()` stub to the following:

```javascript
function handlePostback(sender_psid, received_postback) {
  let response;

  // Get the payload for the postback
  let payload = received_postback.payload;

  // Set the response based on the postback payload
  if (payload === 'yes') {
    response = { "text": "Thanks!" }
  } else if (payload === 'no') {
    response = { "text": "Oops, try sending another image." }
  }
  // Send the message to acknowledge the postback
  callSendAPI(sender_psid, response);
}
```

#### Test it

In Messenger, tap each of the postback buttons on the generic template. You should receive a different text response for each button.

You have built your first Messenger experience.

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Sample Messenger Experience with Original Coast Clothing



Original Coast Clothing (OCC) is a fictional clothing brand that we created to showcase the key features of the Messenger Platform. This guide shows you how to download the code for this sample app on your local environment or remote server to learn more about the features Messenger has to offer.

In order to showcase the full Messenger experience with multiple entry points, our fictional business has the following features:

* An [automated Messenger experience](https://m.me/OriginalCoastClothing?ref=DEVDOCS) for organic reach outs
* Lead Generation in Messenger with API enabled follow ups. [Inject this lead generation ad](https://www.facebook.com/ads/experience/confirmation/?experience_id=2170497373124589) to demo it.
* A [QR code](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/m-me-links) that triggers a promotional discount for [the summer collection](https://www.originalcoastclothing.com/collections/summer),
* A [Facebook Page](https://www.facebook.com/OriginalCoastClothing/) with a [Click to Messenger Ad](https://developers.facebook.com/docs/messenger-platform/discovery/ads) displayed as a [Page post](https://www.facebook.com/permalink.php?story_fbid=567094500360701&id=542998526103632)
* An [Instagram experience](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/sample-experience)

[View the Messenger Experience with OCC](https://m.me/OriginalCoastClothing?ref=DEVDOCS)

### Platform Features {#platform_features}

This sample app leverages the following features:

* [Click To Messenger Lead Ads](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/lead-generation-ads-in-messenger)
* [Buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons)
* [Get Started Button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen)
* [Persistent Menu](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/persistent-menu)
* [Personas](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/personas)

* [Quick Replies](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/quick-replies)
* [Templates](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates)
* [User Profile API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/user-profile)
* [Webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)
* [Welcome Page](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/greeting)

## Deploy this experience on Messenger {#deploy}

By the end of this guide, you'll have a full Messenger app running on your server, answering messages from your test Page.

### Before You Start {#requirements}

You will need:

- A [Facebook Page ID](https://developers.facebook.com/docs/pages) – This is the ID for your live Facebook Page or a test Page.
- A [Meta Developer Account](https://developers.facebook.com/docs/development/register)
- [Meta App ID](https://developers.facebook.com/docs/development/create-an-app)  
- [Meta App Secret](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings#app-secret)  
- A [Page Access Token](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens) requested from a person who can [`CREATE_CONTENT` task](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens#pagetokens) on the Page  
- The [`pages_messaging`, `pages_show_list`, and `pages_manage_metadata` permissions](https://developers.facebook.com/docs/pages/overview/permissions-features#permissions)  
- The [sample code](https://github.com/fbsamples/original-coast-clothing) located on GitHub

If you have separate development, staging, and production environments, each environment will need its own Meta App and Facebook Page.

## Local Environment Setup {#local_install}

To run the sample app on your local environment you will need [NodeJS](https://nodejs.org) 10.x or later.

### Step 1. Clone the Sample App Repository

Clone the `original-coast-clothing` repository on your local machine.

```
git clone https://github.com/fbsamples/original-coast-clothing.git
cd original-coast-clothing
```

### Step 2. Install the Code Dependencies

```
yarn install
```

### Step 3. Get an External Address {#ngrok}

In order to receive messages, you need to be able to get incoming webhooks from our Servers.

If you need an external address, use [`ngrok`](https://ngrok.com/download) since it will provide an external https address that will tunnel into your NodeJS app.

**Install `ngrok`**

```bash
npm install -g ngrok
```
**Request a tunnel to your local server with your preferred port**

```bash
ngrok http 3000
```

The screen should show the `ngrok` status:

```
Session Status                online
Account                       Redacted (Plan: Free)
Version                       2.3.35
Region                        United States (us)
Web Interface                 http://127.0.0.1:4040
Forwarding                    http://1c3b838deacb.ngrok.io -> http://localhost:3000
Forwarding                    https://1c3b838deacb.ngrok.io -> http://localhost:3000

Connections                   ttl     opn     rt1     rt5     p50     p90
                              0       0       0.00    0.00    0.00    0.00
```

Take note of the `https` URL of the external server that is fowarding to your local machine. In the above example, it is `https://1c3b838deacb.ngrok.io`.

### Step 4. Set Webhooks and Messenger Profile {#local_configure}

**Copy the sample environment template in your app**

```
mv .sample.env .env
```

**Add your environmental values**

Edit the `.env` file to add the values for your Facebook App ID, your Facebook Page ID, your Page access token, and your App Secret. Set the value of `VERIFY_TOKEN` to a random string. Your app will use it to validate API calls.

### Step 5. Run Your App

```
node app.js
```

You should now be able to access the application in your browser at `http://localhost:3000`

### Step 6. Configure Your App

Run the following command to configure the webhooks subscription settings for your app and the Page Messenger Profile. Note that you need to use the value for `VERIFY_TOKEN` added in `.env` file.

`http://localhost:3000/profile?mode=all&verify_token=<VERIFY_TOKEN>`

### Step 7. Test Your App Setup {#local_test}

Send a message to your Page from Facebook or in Messenger, if your webhook receives an event, you have fully set up your app!

### Make a Code Change {#change_something}

Let's edit the file **locales/en_US.json**, replacing the message under get_started.welcome and change it from "Hi {{userFirstName}}! Welcome to Original Coast Clothing..." to something else.

Back on the first terminal, every time you change the code, you'll need to restart the NodeJS server. Let's stop the server with Ctrl-C and run it again, to reload the new code.

```
node app.js
```

Open your Messenger and message your Page the word "Hi", you should get the new message.

## Heroku Setup {#heroku}

A [Heroku instance](https://devcenter.heroku.com/articles/heroku-cli) can be useful to host the production or staging environment for your business app or website.

### Step 1. Create a Heroku App {#create_heroku_app}

```
git init
heroku apps:create
# Creating app... done, ⬢ YOUR-APP-NAME
# Created http://YOUR-APP-NAME.herokuapp.com/ | git@heroku.com:YOUR-APP-NAME.git
```

### Step 2. Deploy the Code to Heroku

```
heroku git:remote -a YOUR-APP-NAME
git push heroku master
```

### Step 3. Set Environment Variables {#heroku_config_vars}

Find the **Config Vars** of your app, in the your Heroku app dashboard under Settings. Add the values for your Facebook App ID, your Facebook Page ID, your Page access token, your App Secret, and create a `VERIFY_TOKEN`.

### Step 4. Set webhooks and Messenger Profile {#heroku_configure}

You should now be able to access your app. Use the `VERIFY_TOKEN` that you created as config vars and call the **/profile** endpoint.

`https://YOUR-APP-NAME.herokuapp.com/profile?mode=all&verify_token=<VERIFY_TOKEN>`

***Optional***
The above URL will return the ids of personas uploaded. Since they are held in memory, you need to add those returned IDs as Config Vars, so they can persist after a reload.

```
heroku config:set PERSONA_BILLING=<PERSONA_ID> -a YOUR-APP-NAME
heroku config:set PERSONA_ORDER=<PERSONA_ID> -a YOUR-APP-NAME
heroku config:set PERSONA_SALES=<PERSONA_ID> -a YOUR-APP-NAME
```

### Step 5. Test Your App {#heroku_test}

Send a message to your Page from Facebook or in Messenger. If your webhook receives an event, you have fully set up your app!

## Troubleshooting {#troubleshooting}

### Rerun app locally {#run_after_closing}
After running ngrok, a new external address will be provided. Update the `APP_URL` address on the `.env` file, then run the NodeJS server.

```
node app.js
```

Update the webhook address on the Facebook App Settings by visiting `http://localhost:3000/profile?mode=webhook&verify_token=<VERIFY_TOKEN>`

### My Page only replies to me, but not someone else {#app_in_dev_mode}
The Facebook app is likely still in Development Mode. You can add someone as a tester of the app, if they accept, the app will be able to message them. Once ready, you may request the `pages_messaging` permission to be able to reply to anyone.

## Learn More

* [Webhooks Guide](https://developers.facebook.com/docs/graph-api/webhooks)
* [Facebook Pages API](https://developers.facebook.com/docs/pages)
# Meta Webhooks for Messenger Platform



Meta Webhooks allows you to receive real-time HTTP notifications of changes to specific objects in the Meta social graph. For example, a notification can be sent when a person sends your Facebook Page or Instagram Professional account a message. Webhooks notifications allow you to **track incoming messages and message status updates**. Webhooks notifications also allow you to **avoid rate limits** that would occur if you were querying the Messenger Platform endpoints to track these changes.

To successfully implement Webhooks for Messenger or Instagram conversations, you will need to:

1. Create an endpoint on your server to receive and process your Webhooks notifications, JSON objects
2. Configure the Meta Webhooks product in your App Dashboard
3. Subscribe to the Meta Webhooks notifications you want to receive
4. Install your messaging app on the Facebook Page linked to your business or your Instagram Professional account

## Prerequisites

Before you start:

* Read and implemented the components needed for developing with Meta in the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview)
* Publish your Meta app
* [Access requirements](https://developers.facebook.com/docs/graph-api/overview/access-levels)
    * **Standard Access** to receive notifications from people who have a role on your app, such as your app admins, developers or testers; or
    * **Advanced Access** to receive notifications from your customers, people who do not have a role on your app. Requires App Review.

## Configure Your Node.JS Server

Your server must be able to process two types of HTTPS requests: [Verification Requests](#verification-requests) and [Event Notifications](#event-notifications). Since both requests use HTTPs, your server must have a valid TLS or SSL certificate correctly configured and installed. Self-signed certificates are not supported.

The sections below explain what will be in each type of request and how to respond to them.

The code samples shown here are taken from our [sample app located on GitHub](https://github.com/fbsamples/original-coast-clothing/blob/main/app.js). Visit GitHub to see the complete example and more information about setting up your webhooks server.

### Create an Endpoint {#create-endpoint}

To create an endpoint to receive webhooks notifications from the Messenger Platform, the `app.js` file may look like the following:

```js
// Create the endpoint for your webhook

app.post("/webhook", (req, res) => {
  let body = req.body;

  console.log(`\u{1F7EA} Received webhook:`);
  console.dir(body, { depth: null });

...
```

This code creates a `/webhook` endpoint that accepts `POST` requests and checks that the request is a webhook notification.

### Return a `200 OK` response

The endpoint must return a `200 OK` response, which tells the Messenger Platform the event has been received and does not need to be resent. Normally, you will not send this response until you have completed processing the notification.

#### Respond to Event Notifications

Your endpoint should respond to all notifications:

* with a `200 OK HTTPS` response
* within 5 or less seconds

The following code will be in the `app.post` in your `app.js` file and may look like the following:

```js
...
  // Send a 200 OK response if this is a page webhook

  if (body.object === "page") {
    // Returns a '200 OK' response to all requests
    res.status(200).send("EVENT_RECEIVED");
...
    // Determine which webhooks were triggered and get sender PSIDs and locale, message content and more.
...
  } else {
    // Return a '404 Not Found' if event is not from a page subscription
    res.sendStatus(404);
  }
});
```

### Verification Requests

Anytime you configure the Webhooks product in your App Dashboard, we'll send a `GET` request to your endpoint URL.  Verification requests include the following query string parameters, appended to the end of your endpoint URL. They will look something like this:

#### Sample Verification Request

```html
GET https://www.your-clever-domain-name.com/webhooks?
  hub.mode=subscribe&
  hub.verify_token=mytoken&
  hub.challenge=1158201444
```

#### Validating Verification Requests

Whenever your endpoint receives a verification request, it must:

* Verify that the `hub.verify_token` value matches the string you set in the **Verify Token** field when you [configure the Webhooks product](#subscribe-to-meta-webhooks) in your App Dashboard (you haven't set up this token string yet).
* Respond with the `hub.challenge` value.

Your `app.js` file may look like the following:

```js
// Add support for GET requests to your webhook
app.get("/webhook", (req, res) => {

// Parse the query params
  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  // Check if a token and mode is in the query string of the request
  if (mode && token) {
    // Check the mode and token sent is correct
    if (mode === "subscribe" && token === config.verifyToken) {
      // Respond with the challenge token from the request
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      // Respond with '403 Forbidden' if verify tokens do not match
      res.sendStatus(403);
    }
  }
});
```

| Parameter | Sample Value | Description |
| --- | --- | --- |
| `hub.mode` | `subscribe` | This value will always be set to `subscribe`. |
| `hub.challenge` | `1158201444` | An `int` you must pass back to us. |
| `hub.verify_token` | `mytoken` | A string that we grab from the **Verify Token** field in your app's App Dashboard. You will set this string when you complete the Webhooks configuration settings steps. |

**Note:** [PHP converts periods (.) to underscores (_) in parameter names](http://www.php.net/manual/en/language.variables.external.php).

If you are in your App Dashboard and configuring your Webhooks product (and thus, triggering a Verification Request), the dashboard will indicate if your endpoint validated the request correctly. If you are using the Graph API's `/app/subscriptions` endpoint to configure the Webhooks product, the API will respond with success or failure.

### Event Notifications

When you configure your Webhooks product, you will subscribe to specific `fields` on an `object` type (for example, the `messages` field on the `page` object). Whenever there's a change to one of these fields, we will send your endpoint a `POST` request with a JSON payload describing the change.

For example, if you subscribed to the `page` object's `message_reactions` field and a customer reacted to a message your app sent, we would send you a `POST` request that would look something like this:

```json
{
  "object":"page",
  "entry":[
    {
      "id":"<PAGE_ID>",
      "time":1458692752478,
      "messaging":[
        {
          "sender":{
          "id":"<PSID>"
          },
          "recipient":{
            "id":"<PAGE_ID>"
          },
          ...
        }
      ]
    }
  ]
}
```

#### Payload Contents

Payloads will contain an object describing the change. When you [configure the webhooks product](#subscribe-to-meta-webhooks), you can indicate if payloads should only contain the names of changed fields, or if payloads should include the new values as well.

We format all payloads with JSON, so you can parse the payload using common JSON parsing methods or packages.

**Note:** You will not be able to query historical webhook event notification data, so be sure to capture and store any webhook payload content that you want to keep.

#### Common payload structures

All webhook event payloads follow the same top-level structure. The `entry` array contains one or more event objects, each with a `messaging` array of individual events:

```json
{
  "object": "page",
  "entry": [
    {
      "id": "<PAGE_ID>",
      "time": 1458692752478,
      "messaging": [
        {
          "sender": {
            "id": "<PSID>"
          },
          "recipient": {
            "id": "<PAGE_ID>"
          },
          "timestamp": 1458692752478,
          ...
        }
      ]
    }
  ]
}
```

Every event in the `messaging` array includes `sender`, `recipient`, and `timestamp` fields. The remaining fields depend on the event type.

##### Text message received

When a customer sends a text message to your Page, the event includes a `message` object with `mid` (message ID) and `text` fields:

```json
{
  "sender": {
    "id": "<PSID>"
  },
  "recipient": {
    "id": "<PAGE_ID>"
  },
  "timestamp": 1458692752478,
  "message": {
    "mid": "mid.1457764197618:41d102a3e1ae206a38",
    "text": "hello, world!"
  }
}
```

##### Message with attachment

When a customer sends an image, video, audio, or file, the event includes an `attachments` array instead of `text`:

```json
{
  "sender": {
    "id": "<PSID>"
  },
  "recipient": {
    "id": "<PAGE_ID>"
  },
  "timestamp": 1518479195308,
  "message": {
    "mid": "mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c",
    "attachments": [
      {
        "type": "image",
        "payload": {
          "url": "<IMAGE_URL>"
        }
      }
    ]
  }
}
```

Supported attachment types: `image`, `audio`, `video`, `file`, `reel`, `ig_reel`.

##### Postback received

When a customer clicks a postback button, Get Started button, or persistent menu item:

```json
{
  "sender": {
    "id": "<PSID>"
  },
  "recipient": {
    "id": "<PAGE_ID>"
  },
  "timestamp": 1458692752478,
  "postback": {
    "title": "<BUTTON_TITLE>",
    "payload": "<DEVELOPER_DEFINED_PAYLOAD>"
  }
}
```

For complete payload schemas for all event types, see the individual [webhook event reference pages](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages).

### Validate Payloads

We sign all Event Notification payloads with a **SHA256** signature and include the signature in the request's 'X-Hub-Signature-256' header, preceded with 'sha256='.    You don't have to validate the payload, but you should and we strongly recommend that you do.

To validate the payload:

1. Generate a **SHA256** signature using the payload and your app's **App Secret**.
1. Compare your signature to the signature in the `X-Hub-Signature-256` header (everything after `sha256=`). If the signatures match, the payload is genuine.

**Note:** Please note that we generate the signature using an *escaped unicode* version of the payload, with lowercase hex digits. If you just calculate against the decoded bytes, you will end up with a different signature. For example, the string `äöå` should be escaped to `\u00e4\u00f6\u00e5`.

The `app.js` file may look like the following:

```js
// Import dependencies and set up http server
const express = require("express"),
  bodyParser = require("body-parser"),
  { urlencoded, json } = require("body-parser"),
  app = express().use(bodyParser.json());

    ...

// Verify that the callback came from Facebook.
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature-256"];

  if (!signature) {
    console.warn(`Couldn't find "x-hub-signature-256" in headers.`);
  } else {
    var elements = signature.split("=");
    var signatureHash = elements[1];
    var expectedHash = crypto
      .createHmac("sha256", config.appSecret)
      .update(buf)
      .digest("hex");
    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}
```

#### Webhooks Delivery Retry

If a notification sent to your server fails, we will immediately try a few more times. Your server should handle deduplication in these cases. If, after 15 minutes, we are still unable to deliver notifications, an alert is sent to your developer account.

If delivery of a notification continues to fail for 1 hour, you will receive a **Webhooks Disabled** alert, and your app will be unsubscribed from the webhooks for the Page or Instagram Professional account. Once you have fixed the issues you will need to subscribe to the Webhooks again.

**Note:** If multiple messages are sent by the user when the application fails, they may not be delivered in the order they were sent. To ensure chronological order of message delivery, applications should always use the webhook **timestamp** field included in the webhook.

### Test Your Webhooks

To test your webhook verification run the following cURL request with your verify token:

```curl
curl -X GET "localhost:1337/webhook?hub.verify_token=YOUR-VERIFY-TOKEN&hub.challenge=CHALLENGE_ACCEPTED&hub.mode=subscribe"
```

If your webhook verification is working as expected, you should see the following:

* `WEBHOOK_VERIFIED` logged to the command line where your node process is running.
* `CHALLENGE_ACCEPTED` logged to the command line where you sent the cURL request.

To test your webhook send the following cURL request:

```curl
curl -H "Content-Type: application/json" -X POST "localhost:1337/webhook" -d '{"object": "page", "entry": [{"messaging": [{"message": "TEST_MESSAGE"}]}]}'
```

If your webhook is working as expected, you should see the following:

* `TEST_MESSAGE` logged to the command line where your node process is running.
* `EVENT RECEIVED` logged to the command line where you sent the cURL request.

## Subscribe to Meta Webhooks

Once your webhooks server endpoint, or sample app is ready, go to your app's [Meta App Dashboard](https://developers.facebook.com/apps) to subscribe to Meta Webhooks.

In this example we will use the dashboard to configure a Webhook and subscribe to the `messages` field. Any time a customer sends your app a message, a notification will be sent to your webhooks endpoint.

1. In the App Dashboard, go to **Products > Messenger > Settings**.
    * Some Messenger Platform webhooks are not available for Instagram messaging. If you are only implementing webhooks for Instagram and know the webhooks available for Instagram messaging, you can subscribe to webhooks here. To only view and subscribe to webhooks for Instagram messaging, you can go to **Instagram settings**.
1. Enter your endpoint's URL in the **Callback URL** field and add your verification token to the **Verify Token** field. We will include this string in all [Verification Requests](#verification-requests). If you are using one of our sample apps, this should be the same string you used for your app's `TOKEN` config variable.
1. Subscribe to fields for which you would like to be send notifications and click **Save**.
1. The last step is to subscribe to individual fields. Subscribe to the `messages` field and send a test Event Notification.
    * If your endpoint is set up correctly, it should [validate the payload](#validate-payloads) and execute whatever code you have set it up to do upon successful validation. If you are using our [sample app](https://developers.facebook.com/docs/graph-api/webhooks/sample-apps), load the app's URL in your web browser. It should display the payload's contents.

You can change your Webhooks subscriptions, verify token, or API version at any time using the App Dashboard.

**Note:** It is recommended that you use the latest API version to receive all information available for each webhook.

You can also do this programmatically by using the [`/app/subscriptions` endpoint](https://developers.facebook.com/docs/graph-api/reference/application/subscriptions).

#### Available Messenger Platform Fields

| Messaging Webhooks Field | Description |
| --- | --- |
| `message_deliveries` | A notification is sent when a message that was sent by your business has been [delivered to a customer](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-deliveries). Only available for Messenger conversations. |
| `message_echoes` | A notification is sent when [your business has sent a message](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-echoes). This separate webhook field is available only for Messenger conversations. For Instagram Messaging conversations, the message echo notifications are included with the `message` webhook field subscription. |
| `message_edits` | A notification is sent when [a customer edits a previously-sent message](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-edits). Only available for Messenger conversations. |
| `message_reactions` | A notification is sent when [a customer reacts to a message sent by your business.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-reactions) |
| `message_reads` | A notification is sent when [a customer reads a message sent by your business, for Messenger conversations.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-reads) See `messaging_seen` for Instagram Messaging conversations. |
| `messages` | A notification is sent when your business has [received a message from a customer](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messages) from any conversation entry point. For Instagram Messaging, this subscription will also include notifications when your Instagram Professional account has sent a message since there is no separate `message_echoes` subscription field for Instagram Messaging. |
| `messaging_account_linking` | A notification is sent when a [customer links or unlinks their Messenger account from their account with your business.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_account_linking) Only available for Messenger conversations. |
| `messaging_feedback` | A notification is sent when a person has [submitted feedback for your business.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates/customer-feedback-template) Only available for Messenger conversations. |
| `messaging_game_plays` | A notification is sent when a person has played [a round of an Instant Game.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_game_plays) Only available for Messenger conversations. |
| `messaging_handovers` | A notification is sent when [a change has occurred during the Handover Protocol](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_handovers) |
| `messaging_optins` | A notification is sent when a customer has [clicked a Messenger plugin, accepted a message request using customer matching, or has opted in to receive messages via the checkbox plugin.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_optins) Only available for Messenger conversations. |
| `messaging_policy_enforcement` | A notification is sent when [a policy enforcement warning has been sent or a policy enforcement action has been taken on the app associated with the Page.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_policy_enforcement) |
| `messaging_postbacks` | A notification is sent when [a customer clicks a postback button, Get Started button, or persistent menu item for Messenger conversations or an Icebreaker option or Generic Template button for Instagram Messaging conversations.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_postbacks) |
| `messaging_referrals` | A notification is sent when [a customer resumes a conversation with the Page by clicking an ig.me or m.me link, or an ad.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_referrals) |
| `messaging_seen` | A notification is sent when [a customer reads a message sent by your business, for Instagram Messaging conversations.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-reads) See `messaging_reads` for Messenger conversations. |
| `messenger_template_status_update` | A notification is sent when [a utility message template's review status has changed](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/utility-messages). |
| `response_feedback` | A notification is sent [when a customer provides feedback on a message sent by your business by clicking the feedback buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/response_feedback). |
| `send_cart` | A notification is sent when your business has received a message from a customer, when the message contains cart/order information. Only available for Messenger conversations. |
| `standby` | A notification is sent when [a conversation is idle for an app during the Handover Protocol](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/standby) |

## Connect Your App

You will need to connect your Webhooks app to your Page and subscribe your Page to the Webhooks notifications you want to receive.

### Add the App

You can connect an app to a Page in the [Meta Business Suite > All Tools > Business Apps](https://business.facebook.com/).

**Note:** You will need to subscribe all messaging apps for your business to the messaging webhooks.

### Subscribe your Page

You will need to subscribe your Page to the Webhooks notifications you want to receive.

#### Requirements

* A Page access token requested from a person who can perform the [`MODERATE` task](https://developers.facebook.com/docs/pages/overview#tasks) on the Page being queried
* The [`pages_messaging` and `pages_manage_metadata` permissions](https://developers.facebook.com/docs/pages/overview/permissions-features#permission-dependencies)

To subscribe to a Webhooks field, send a `POST` request to the Page's [subscribed_apps](https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps) edge using the Page's acccess token.

```curl
curl -i -X POST "https://graph.facebook.com/<PAGE_ID>/subscribed_apps?subscribed_fields=messages&access_token=<PAGE_ACCESS_TOKEN>"
```

#### Sample Response

```json
{
  "success": "true"
}
```

To see which app's your Page has installed, send a `GET` request instead:

#### Sample Request

```curl
curl -i -X GET "https://graph.facebook.com/<PAGE_ID>/subscribed_apps?access_token=<PAGE_ACCESS_TOKEN>"
```

#### Sample Response

```json
{
  "data": [
    {
      "category": "Business",
      "link": "https://my-clever-domain-name.com/app",
      "name": "My Sample App",
      "id": "<APP_ID>",
      "subscribed_fields": [
        "messages"
      ]
    }
  ]
}
```

If your Page has not installed any apps, the API will return an empty data set.

#### Graph API Explorer

You can also use the [Graph API Explorer](https://developers.facebook.com/tools/explorer) to send the request to subscribe your Page to a Webhooks field.

1. Select your app in the **Application** dropdown menu.
1. Click the **Get Token** dropdown and select **Get User Access Token**, then choose the `pages_manage_metadata` permission. This will exchange your app token for a User access token with the `pages_manage_metadata` permission granted.
1. Click **Get Token** again and select your Page. This will exchange your User access token for a Page access token.
1. Change the operation method by clicking the `GET` dropdown menu and selecting `POST`.
1. Replace the default `me?fields=id,name` query with the Page's **id** followed by `/subscribed_apps`, then submit the query.  

## Next Steps

* [Send a test message ](https://developers.facebook.com/documentation/business-messaging/messenger-platform/get-started) – Learn how to use the platform to send a message.
* [Tour our sample app ](https://developers.facebook.com/documentation/business-messaging/messenger-platform/getting-started/sample-experience) – Download code for our sample app to learn more about the features Messenger Platform has to offer.

## See Also

- Learn how to get notifications when a conversation is passed from one app to another using the [Conversation Routing API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing)
- Learn more about [Meta Webhooks for the Graph API](https://developers.facebook.com/docs/graph-api/webhooks)
# Webhook Events Reference


Webhook events are how the Messenger Platform notifies your bot when a variety of interactions or events happen, including when a person sends a message. Webhook events are sent by the Messenger Platform as POST requests to your webhook.

**Note:** You will need to subscribe all messaging apps for your business to the messaging webhooks.

## List of Webhook Events {#event_list}

Below is a list of the events that can be sent to your webhook from the Messenger Platform.

**Note:** It is recommended that you use the latest API version to receive all information available for each webhook.

| Messaging Webhooks Field | Description |
| --- | --- |
| `message_deliveries` | A notification is sent when a message that was sent by your business has been [delivered to a customer](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-deliveries). Only available for Messenger conversations. |
| `message_echoes` | A notification is sent when [your business has sent a message](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-echoes). This separate webhook field is available only for Messenger conversations. For Instagram Messaging conversations, the message echo notifications are included with the `message` webhook field subscription. |
| `message_edits` | A notification is sent when [a customer edits a previously-sent message](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-edits). Only available for Messenger conversations. |
| `message_reactions` | A notification is sent when [a customer reacts to a message sent by your business.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-reactions) |
| `message_reads` | A notification is sent when [a customer reads a message sent by your business, for Messenger conversations.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-reads) See `messaging_seen` for Instagram Messaging conversations. |
| `messages` | A notification is sent when your business has [received a message from a customer](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messages) from any conversation entry point. For Instagram Messaging, this subscription will also include notifications when your Instagram Professional account has sent a message since there is no separate `message_echoes` subscription field for Instagram Messaging. |
| `messaging_account_linking` | A notification is sent when a [customer links or unlinks their Messenger account from their account with your business.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_account_linking) Only available for Messenger conversations. |
| `messaging_feedback` | A notification is sent when a person has [submitted feedback for your business.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates/customer-feedback-template) Only available for Messenger conversations. |
| `messaging_game_plays` | A notification is sent when a person has played [a round of an Instant Game.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_game_plays) Only available for Messenger conversations. |
| `messaging_handovers` | A notification is sent when [a change has occurred during the Handover Protocol](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_handovers) |
| `messaging_optins` | A notification is sent when a customer has [clicked a Messenger plugin, accepted a message request using customer matching, or has opted in to receive messages via the checkbox plugin.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_optins) Only available for Messenger conversations. |
| `messaging_policy_enforcement` | A notification is sent when [a policy enforcement warning has been sent or a policy enforcement action has been taken on the app associated with the Page.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_policy_enforcement) |
| `messaging_postbacks` | A notification is sent when [a customer clicks a postback button, Get Started button, or persistent menu item for Messenger conversations or an Icebreaker option or Generic Template button for Instagram Messaging conversations.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_postbacks) |
| `messaging_referrals` | A notification is sent when [a customer resumes a conversation with the Page by clicking an ig.me or m.me link, or an ad.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_referrals) |
| `messaging_seen` | A notification is sent when [a customer reads a message sent by your business, for Instagram Messaging conversations.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/message-reads) See `messaging_reads` for Messenger conversations. |
| `messenger_template_status_update` | A notification is sent when [a utility message template's review status has changed](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/utility-messages). |
| `response_feedback` | A notification is sent [when a customer provides feedback on a message sent by your business by clicking the feedback buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/response_feedback). |
| `send_cart` | A notification is sent when your business has received a message from a customer, when the message contains cart/order information. Only available for Messenger conversations. |
| `standby` | A notification is sent when [a conversation is idle for an app during the Handover Protocol](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/standby) |

## Event Format {#format}

All callbacks for the Messenger Platform have a common set of properties that provide information you will need to process and respond to input from people using your bot. In addition to the properties below, each event also has a set of specific properties that detail the event.

```json
{
  "object":"page",
  "entry":[
    {
      "id":"<PAGE_ID>",
      "time":1458692752478,
      "messaging":[
        {
          "sender":{
          "id":"<PSID>"
          },
          "recipient":{
            "id":"<PAGE_ID>"
          },
          ...
        }
      ]
    }
  ]
}
```


### Properties {#payload}

| Property | Type | Description |
| --- | --- | --- |
| `object` | String | Value will be `page` |
| `entry` | Array of [`entry`](#entry) | Array containing event data |

### `entry` {#entry}

| Property | Type | Description |
| --- | --- | --- |
| `id` | String | Page ID of page |
| `time` | Number | Time of update (epoch time in milliseconds) |
| `messaging` | Array<[`messaging`](#messaging)> | Array containing one [`messaging`](#messaging) object. Note that even though this is an array, it will only contain one `messaging` object. |

### `entry.messaging` {#messaging}

| Property | Type | Description |
| --- | --- | --- |
| `sender.id` | String | Sender user ID |
| `recipient.id` | String | Recipient user ID |
# messages Webhook Event Reference



This callback will occur when a message has been sent to your Page. Messages are always sent in order. You may receive text messages or messages with attachments.

Attachment types `image`, `audio`, `video`, `file`, `sticker`, `reel`, `ig_reel`, `post`, `ig_post` and `appointment_booking` are the main supported types. You may also receive `fallback` attachments. A common example of a 'fallback' is when a user shares a URL with a Page, an attachment is created based on [link sharing](https://developers.facebook.com/docs/sharing/web). For unsupported shares made by users to your Page a `fallback` with no payload might be sent.

> **Sticker attachment type transition (until August 30, 2026):** Sticker messages in webhooks now include a new `sticker` attachment type with `sticker_id` metadata. During the 90-day transition period, both the `sticker` and `image` attachment types are present in the payload. After August 30, 2026, only the `sticker` attachment type will be sent. Update your webhook handlers to recognize the `sticker` attachment type before this date. The same change applies to [message echoes](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-echoes).

You can subscribe to this callback by selecting `message` when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.

## Examples {#example}

### Text message

```
{
  "sender":{
    "id":"<PSID>"
  },
  "recipient":{
    "id":"<PAGE_ID>"
  },
  "timestamp":1458692752478,
  "message":{
    "mid":"mid.1457764197618:41d102a3e1ae206a38",
    "text":"hello, world!",
    "quick_reply": {
      "payload": "<DEVELOPER_DEFINED_PAYLOAD>"
    }
  }
}
```

### Reply message

```
{
  "sender":{
    "id":"<PSID>"
  },
  "recipient":{
    "id":"<PAGE_ID>"
  },
  "timestamp":1458692752478,
  "message":{
    "mid":"m_1457764197618:41d102a3e1ae206a38",
    "text":"hello, world!",
    "reply_to": {
      "mid":"m_1fTq8oLumEyIp3Q2MR-aY7IfLZDamVrALniheU",
      "is_self_reply": false
    }
  }
}
```

### Message with attachment

```http
{
  "id": "682498302938465",
  "time": 1518479195594,
  "messaging": [
    {
      "sender": {
        "id": "<PSID>"
      },
      "recipient": {
        "id": "<PAGE_ID>"
      },
      "timestamp": 1518479195308,
      "message": {
        "mid": "mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c",
        "attachments": [
          {
  "type": "<image|video|audio|file|sticker|reel|ig_reel>",
            "payload": {
              "url": "<ATTACHMENT_URL>"
            }
          }
        ]
      }
    }
  ]
}
```

### Message with sticker attachment

```http
{
  "id": "682498302938465",
  "time": 1518479195594,
  "messaging": [
    {
      "sender": {
        "id": "<PSID>"
      },
      "recipient": {
        "id": "<PAGE_ID>"
      },
      "timestamp": 1518479195308,
      "message": {
        "mid": "mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c",
        "attachments": [
          {
            "type": "sticker",
            "payload": {
              "url": "<STICKER_URL>",
              "sticker_id": 369239263222822
            }
          }
        ]
      }
    }
  ]
}
```

### Message with appointment booking

```http
{
  "id": "682498302938465",
  "time": 1518479195594,
  "messaging": [
    {
      "sender": {
        "id": "<PSID>"
      },
      "recipient": {
        "id": "<PAGE_ID>"
      },
      "timestamp": 1518479195308,
      "message": {
        "mid": "mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c",
        "attachments": [
          {
            "type": "appointment_booking",
            "payload": {
              "booking_id": "<BOOKING_ID>"
              "status": ""<requested|confirmed|declined|cancelled>",
              "start_time": 1739612400,
              "end_time": 1739616000,
              "timezone": "America/Los_Angeles"
            }
          }
        ]
      }
    }
  ]
}
```

### Message with post attachment

```http
{
  "id": "682498302938465",
  "time": 1518479195594,
  "messaging": [
    {
      "sender": {
        "id": "<PSID>"
      },
      "recipient": {
        "id": "<PAGE_ID>"
      },
      "timestamp": 1518479195308,
      "message": {
        "mid": "mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c",
        "attachments": [
          {
            "type": "<post|ig_post>",
            "payload": {
              "url": "<ATTACHMENT_URL>",
              "title": "<ATTACHMENT_TITLE>",
              "id": <ATTACHMENT_ID>
            }
          }
        ]
      }
    }
  ]
}
```

### Message with product template

This webhook applies to the scenario when user shares products from other threads or sharing flow to the page. This webhook is limited to only products that are owned by the page. App will need to have [`catalog_management`](https://developers.facebook.com/docs/permissions/reference/catalog_management) permission approved to receive product details in webhooks.

```http
{
  "id": "682498302938465",
  "time": 1518479195594,
  "messaging": [
    {
      "sender": {
        "id": "<PSID>"
      },
      "recipient": {
        "id": "<PAGE_ID>"
      },
      "timestamp": 1518479195308,
      "message": {
        "mid": "mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c",
        "attachments": [
          {
            "type": "template",
            "payload": {
              "product":{
               "elements":[ // multiple elements for Hscroll
                 {
                   "id":"<PRODUCT_ID>",
                   "retailer_id":"<EXTERNAL_ID>",
                   "image_url":"https://fb.cdn.com/sdsd",
                   "title":"Some product title",
                   "subtitle": "$40",
                 },
                 {...},
               ]
            }
          }
        ]
      }
    }
  ]
}
```

### Message with fallback attachment
Example applicable to `messages` on version +v6.0

```
{
    "object": "page",
    "entry": [
        {
            "id": "<PAGE_ID>",
            "time": 1583173667623,
            "messaging": [
                {
                    "sender": {
                        "id": "<PSID>"
                    },
                    "recipient": {
                        "id": "<PAGE_ID>"
                    },
                    "timestamp": 1583173666767,
                    "message": {
                        "mid": "m_toDnmD...",
                        "text": "This is where I want to go: https:\/\/youtu.be\/bbo_fZAjIhg",
                        "attachments": [
                            {
                                "type": "fallback",
                                "payload": {
                                    "url": "<ATTACHMENT_URL >",
                                    "title": "TAHITI - Heaven on Earth"
                                }
                            }
                        ]
                    }
                }
            ]
        }
    ]
}
```

### Message from Shops product detail page

```
{
  "sender":{
    "id":"<PSID>"
  },
  "recipient":{
    "id":"<PAGE_ID>"
  },
  "timestamp":1458692752478,
  "message":{
    "mid":"mid.1457764197618:41d102a3e1ae206a38",
    "text":"hello, world!",
    "referral": {
      "product": {
        "id":"<PRODUCT_ID>"
      }
    }
  }
}
```

### Message with Ads referral information

This webhook applies to the scenario when a user clicks on a CTM (Click-to-Messenger) advertisement and sends a message to a Facebook page. In addition to the message details included, the application will receive ads referral information.

#### Requirements
Message with Ads Referral Information requires the application to have page subscriptions to both the `messages` and the `messaging_referrals` fields.

```json
{
  "sender":{
    "id":"<PSID>"
  },
  "recipient":{
    "id":"<PAGE_ID>"
  },
  "timestamp":1458692752478,
  "message":{
    "mid":"mid.1457764197618:41d102a3e1ae206a38",
    "text":"hello, world!",
    "referral": {
      "ref": "<REF_DATA_IF_SPECIFIED_IN_THE_AD>",
      "ad_id": "<ID_OF_THE_AD>",
      "source": "ADS",
      "type": "OPEN_THREAD",
      "ads_context_data": {
        "ad_title": "<TITLE_OF_THE_AD>",
        "photo_url": "<URL_OF_THE_IMAGE_FROM_AD_THE_USER_IS_INTERESTED_IN>",
        "video_url": "<THUMBNAIL_URL_OF_THE_VIDEO_FROM_THE_AD>",
        "post_id": "<ID_OF_THE_POST>",
        "product_id": "<PRODUCT_ID>",
        "flow_id": "<ID_OF_THE_PARTNER_APP_WELCOME_MESSAGE_FLOW>"
      }
    }
  }
}
```

For more information about the flow ID, please refer to [Welcome Message Flows](https://developers.facebook.com/documentation/business-messaging/messenger-platform/ads/ads-welcome-message-flows).

### Message with commands

```json
{
  "object": "page",
  "entry": [
    {
      "id": "<PAGE_ID>",
      "time": 1697643211842,
      "messaging": [
        {
          "sender": {
            "id": "<PSID>"
          },
          "recipient": {
            "id": "<PAGE_ID>"
          },
          "timestamp": 1697643027400,
          "message": {
            "mid": "m_3vs...",
            "text": "find flights from SFO to LAX next Thursday",
            "commands": [
              {
                "name": "flights"
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Properties {#fields}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `message` {#messaging}

| Property | Type | Description |
| --- | --- | --- |
| `mid` | String | Message ID |
| `text` | String | Text of message |
| `quick_reply` | Object | Optional custom data provided by the sending app |
| `reply_to` | Object | Reference to the message id (mid) that this message is replying to |
| `attachments` | Array<[`attachments`](#attachments)> | Array containing attachment data |
| `referral` | Object | Referral of the message from Shops product details page. |

### `message.quick_reply` {#quick_reply}

A `quick_reply` payload is only provided with a text message when the user taps a [Quick Replies](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/quick-replies) button.

| Property | Type | Description |
| --- | --- | --- |
| `payload` | String | Custom data provided by the app |

### `message.reply_to` {#reply_to}

| Property | Type | Description |
| --- | --- | --- |
| `mid` | String | Reference to the message ID that this message is replying to |
| `is_self_reply` | Boolean | Indicates whether the message is a self-reply. |

### `message.attachments` {#attachments}

| Property | Type | Description |
| --- | --- | --- |
| `type` | String | `audio`, `file`, `image` (including gif), `sticker`, `video`, `fallback`, `reel`, `ig_reel`, `post`, `ig_post` or `appointment_booking` |
| `payload` | String | [`message.attachments.payload`](#payload) |

### `message.attachments.payload` {#payload}

| Property | Type | Description |
| --- | --- | --- |
| `url` | String | URL of the attachment type. Applicable to attachment type: `audio`, `file`, `image`, `video`, `fallback`, `reel`, `ig_reel`, `post`, `ig_post` |
| `title` | String | Title of the attachment. Applicable to attachment type: `fallback`, `reel`, `ig_reel`, `post` and `ig_post` |
| `sticker_id` | Number | Persistent id of this sticker, for example `369239263222822` references the Like sticker. Applicable to attachment type: `sticker`. During the transition period (until August 30, 2026), also present in attachment type: `image` when a sticker is sent. |
| `reel_video_id` | Number | ID of the video associated with the attached reel. Applicable to attachment type: `reel` and `ig_reel` |
| `id` | Number | ID of the shared post. Applicable to attachment type: `post` and `ig_post` |
| `booking_id` | String | ID of the booking associated with the appointment. Applicable to attachment type: `appointment_booking` |
| `status` | String | Current status of the appointment. Can be `requested`, `confirmed`, `declined`, `cancelled`. Applicable to attachment type: `appointment_booking` |
| `start_time` | Integer | Appointment start time as a Unix timestamp (seconds). Applicable to attachment type: `appointment_booking` |
| `end_time` | Integer | Appointment end time as a Unix timestamp (seconds). Applicable to attachment type: `appointment_booking` |
| `timezone` | String | IANA timezone identifier (e.g., `America/Los_Angeles`). Applicable to attachment type: `appointment_booking` |

### `message.attachments.payload.product.elements`

| Property | Type | Description |
| --- | --- | --- |
| `id` | String | Product ID from [Facebook product catalog](https://developers.facebook.com/documentation/ads-commerce/catalog/overview) |
| `retailer_id` | String | External ID that is associated with the Product. (ex: SKU/ Content ID) |
| `image_url` | String | URL of product |
| `title` | String | Title of product |
| `subtitle` | String | Subtitle of product |

### `message.referral` {#referral}

`referral` payload is only provided when the user sends a message from the Shops product detail page.

| Property | Type | Description |
| --- | --- | --- |
| `product` | Object | Product information |
| `source` | String | The source of the referral. Supported values: `ADS` (only ads referral supported). |
| `type` | String | The referral type. Currently supports `OPEN_THREAD`. |
| `ref` | String | The optional `ref` attribute set in the referrer. Only alphanumeric characters and `-`, `_`, and `=` are supported. |
| `ad_id` | String | Advertisement ID from Ads Manager. |
| `ads_context_data` | Object | Advertisement context data from Ads Manager. |

### `message.referral.product`

| Property | Type | Description |
| --- | --- | --- |
| `id` | String | Product ID |

### `message.referral.ads_context_data`

| Property | Type | Description |
| --- | --- | --- |
| `ad_title` | String | Title of the ad in Ads Manager. |
| `photo_url` | String | [Optional] URL of the image from the ad. |
| `video_url` | String | [Optional] Thumbnail URL of the video from the ad. |
| `post_id` | String | ID of the ad post in Ads manager. |
| `product_id` | String | [Optional] Product ID from the ad. |

### `message.commands`

| Property | Type | Description |
| --- | --- | --- |
| `name` | String | The name of the command |
# messaging_account_linking Webhook Event Reference



When using [Account Linking](https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/account-linking), this callback will occur when the [Link Account](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) or [Unlink Account](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) button have been tapped.

The `status` parameter tells you whether the user linked or unlinked their account. The `authorization_code` is a pass-through parameter. allowing you to match the business user entity to the page-scoped ID (PSID) of the `sender`.

### Example {#example}

```
{
  "sender":{
    "id":"USER_ID"
  },
  "recipient":{
    "id":"PAGE_ID"
  },
  "timestamp":1234567890,
  "account_linking":{
    "status":"linked",
    "authorization_code":"PASS_THROUGH_AUTHORIZATION_CODE"
  }
}
```

```
{
  "sender":{
    "id":"USER_ID"
  },
  "recipient":{
    "id":"PAGE_ID"
  },
  "timestamp":1234567890,
  "account_linking":{
    "status":"unlinked"
  }
}
```

## Properties {#fields}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `account_linking` {#account_linking}

| Property | Description | Type |
| --- | --- | --- |
| `status` | `linked` or `unlinked` | String |
| `authorization_code` | Value of pass-through `authorization_code` provided in the [Account Linking](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) flow | String |

Note: `authorization_code` is only available when `status` is `linked`
# message_deliveries Webhook Event Reference



This callback will occur when a message a Page has sent has been delivered. You can subscribe to this callback by selecting the `message_deliveries` field when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.  

## Example {#example}

```
{
  "sender":{
    "id":"<PSID>"
  },
  "recipient":{
    "id":"<PAGE_ID>"
  },
   "delivery":{
      "mids":[
         "mid.1458668856218:ed81099e15d3f4f233"
      ],
      "watermark":1458668856253
   }
}
```

## Properties {#properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `delivery` {#delivery}

| Property | Type | Description |
| --- | --- | --- |
| `mids` | Array<String> | Array containing message IDs of messages that were delivered. Field may not be present. |
| `watermark ` | Number | All messages that were sent before this timestamp were delivered |

Both `mids` and `watermark` fields are used to determine which messages were delivered. `watermark` is always present and `mids` is sometimes present. `mids` provides delivery receipts on a per-message basis but may not be present (due to backward compatibility reasons with older Messenger clients). `watermark` is always present and is a timestamp indicating that all messages with a timestamp before `watermark` were delivered.
# message_echoes Webhook Event Reference



This callback occurs when your page sends a message. You may receive `text` messages or messages with attachments (`image`, `video`, `audio`, `sticker`, `template` or `fallback`). The payload will also include an optional custom `metadata` sent by the sender, and the corresponding `app_id`.  
You can subscribe to this callback by selecting the `message_echoes` field when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.

Multiple types of messages are supported:

* [Text message](#text)
* [Message with image, audio, video, file, or sticker attachment](#binary)
* [Message with appointment booking](#appointment)
* [Message with template attachment](#template)
* [Message with fallback attachment](#fallback)
* [Message with products](#products)
* [Message which is a reply to another message](#reply)

## Common format {#format}

### Example 1

```json
{
  "sender":{
    "id":"<PAGE_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1457764197627,
  "message":{
    "is_echo":true,
    "app_id":1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid":"mid.1457764197618:41d102a3e1ae206a38",
    ...
  }
}
```

### Example 2 {#example_2}

```json
{
    "object": "page",
    "entry": [
        {
            "id": "<PAGE_ID>",
            "time": 1570053170926,
            "standby": [
                {
                    "sender": {
                        "id": "<PAGE_ID>"
                    },
                    "recipient": {
                        "id": "<PSID>"
                    },
                    "timestamp": 1570053170673,
                    "message": {
                        "mid": "qT7ywaKpO9kkQR7Gv-nM8LIfLZDamVrALniheUYEDdHJXjDXEAyaS1xxONzb2Iv-DFzmTihfWJV012P5pK0AhQ",
                        "is_echo": true,
                        "app_id": <APPID>,
                        "attachments": [
                            {
                                "title": "",
                                "url": "https:\/\/www.facebook.com\/commerce\/update\/",
                                "type": "template",
                                "payload": {
                                    "template_type": "media",
                                    "elements": [
                                        {
                                            "media_type": "image",
                                            "attachment_id": 2457235337685388
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                }
            ]
        }
    ]
}
```

### Properties {#properties}

### `sender`
| `sender` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who received a message from your business |

### `message`

| Field Name | Type | Description |
| --- | --- | --- |
| `is_echo` | Boolean | Indicates the message sent from the page itself |
| `app_id` | String | ID of the app from which the message was sent. Starting Graph API `v12.0`+, `app_id` field will return Facebook Page inbox app id (`26390203743090`) whenever the message is sent via Facebook Page inbox. |
| `metadata` | String | Custom string passed to the [Send API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api#request) as the `metadata` field. Only present if the `metadata` property was set in the original message. |
| `mid` | String | Message ID |

## Text message {#text}

### Example

```json
{
  "sender":{
    "id":"<PAGE_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1457764197627,
  "message":{
    "is_echo":true,
    "app_id":1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid":"mid.1457764197618:41d102a3e1ae206a38",
    "text":"hello, world!"
  }
}
```

### Properties

### `message`

| Property | Type | Description |
| --- | --- | --- |
| `text` | String | Text of message |

## Message with image, audio, video, file, or sticker attachment {#binary}

### Example

```json
{
  "sender":{
    "id":"<PAGE_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1458696618268,
  "message":{
    "is_echo":true,
    "app_id":1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid":"mid.1458696618141:b4ef9d19ec21086067",
    "attachments":[
      {
        "type":"image",
        "payload":{
          "url":"<IMAGE_URL>"
        }
      }
    ]
  }
}
```

### Properties

### `message.attachments`

| Properties | Type | Description |
| --- | --- | --- |
| `type` | String | Type of attachment: `image`, `audio`, `video`, `file` or `sticker` |
| `payload.url` | String | URL of attachment |

## Message with appointment booking {#appointment}

### Example

```json
{
  "sender":{
    "id":"<PAGE_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1458696618268,
  "message":{
    "is_echo":true,
    "app_id":1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid":"mid.1458696618141:b4ef9d19ec21086067",
    "attachments":[
      {
        "type":"appointment_booking",
        "payload": {
           "booking_id": "<BOOKING_ID>"
           "status": "<requested|confirmed|declined|cancelled>",
           "start_time": 1739612400,
           "end_time": 1739616000,
           "timezone": "America/Los_Angeles"
        }
      }
    ]
  }
}
```

### Properties

### `message.attachments`

| Properties | Type | Description |
| --- | --- | --- |
| `type` | String | Type of attachment: `appointment_booking` |
| `payload.booking_id` | String | ID of the booking associated with the appointment |
| `payload.status` | String | Current status of the appointment. Can be `requested`, `confirmed`, `declined`, `cancelled` |
| `payload.start_time` | Integer | Appointment start time as a Unix timestamp (seconds). |
| `payload.end_time` | Integer | Appointment end time as a Unix timestamp (seconds). |
| `payload.timezone` | String | IANA timezone identifier (e.g., `America/Los_Angeles`) |

## Message with template attachment {#template}

### Example

```json
{
  "sender":{
    "id":"<PAGE_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1458696618268,
  "message":{
    "is_echo":true,
    "app_id":1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid":"mid.1458696618141:b4ef9d19ec21086067",
    "attachments":[
      {
        "type":"template",
        "payload":{
          "template_type":"button",
          "buttons":[
            {
              "type":"web_url",
              "url":"https:\/\/www.messenger.com\/",
              "title":"Visit Messenger"
            }
          ]
        }
      }
    ]
  }
}
```

### Properties

### `message.attachments`

| Property | Type | Description |
| --- | --- | --- |
| `type` | String | `template` |
| `payload` | String | Template payload as described in the [Send API Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api#request) |

**Note:** Note that in the case of a `payload` with attachments, the attachment id sent is a number not a string. See [example 2](#example_2)

This does not match the format of [Send API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api#request) that needs the attachment id to be sent as a string.

## Message with fallback attachment {#fallback}

A fallback attachment is any attachment not currently recognized or supported by the Message Echo feature.

### Example

```json
{
  "sender":{
    "id":"<PAGE_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1458696618268,
  "message":{
    "is_echo":true,
    "app_id":1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid":"mid.1458696618141:b4ef9d19ec21086067",
    "attachments":[
      {
        "title":"Legacy Attachment",
        "url":"https:\/\/www.messenger.com\/",
        "type":"fallback",
        "payload":null
      }
    ]
  }
}
```

### Properties

### `message.attachments`

| Property | Type | Description |
| --- | --- | --- |
| `type` | String | `fallback` |
| `title` | String | Title of attachment (optional) |
| `url` | String | URL of attachment (optional) |
| `payload` | String | Payload of attachment (optional) |

## Message with products {#products}

**Warning:** Message with products echo webhook is only available on Graph API v8.0+

App will need to have [`catalog_management`](https://developers.facebook.com/docs/permissions/reference/catalog_management) permission approved to receive product details in webhooks.

### Example

```json
{
  "sender":{
    "id":"<PAGE_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1458696618268,
  "message":{
    "is_echo":true,
    "app_id":1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid":"mid.1458696618141:b4ef9d19ec21086067",
    "attachments":[
      {
        "type":"template",
        "payload":{
          "product":{
             "elements":[ // multiple elements for Hscroll
               {
                 "id":"<PRODUCT_ID>",
                 "retailer_id":"<EXTERNAL_ID>",
                 "image_url":"https://fb.cdn.com/sdsd",
                 "title":"Some product title",
                 "subtitle": "40",
               },
               {...},
             ]
            }

          ]
        }
      }
    ]
  }
}
```

### Properties

### `product.elements`

| Property | Type | Description |
| --- | --- | --- |
| `id` | String | Product ID from [product catalog](https://developers.facebook.com/documentation/ads-commerce/catalog/overview) |
| `retailer_id` | String | External ID that is associated with the Product. (ex: SKU/ Content ID) |
| `image_url` | String | URL of product image |
| `title` | String | Title of product |
| `subtitle` | String | Subtitle of product |

## Message which is a reply to another message {#reply}

A fallback attachment is any attachment not currently recognized or supported by the Message Echo feature.

### Example

```json
{
  "sender":{
    "id":"<PAGE_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1458696618268,
  "message":{
    "is_echo":true,
    "app_id":1517776481860111,
    "metadata": "<DEVELOPER_DEFINED_METADATA_STRING>",
    "mid":"mid.1458696618141:b4ef9d19ec21086067",
    "reply_to": {
      "mid": "QUOTED-MESSAGE-ID",
      "is_self_reply" : false
     }
   }
}
```

### Properties

### `message.reply_to`

| Property | Type | Description |
| --- | --- | --- |
| `mid` | String | Reference to the message id that this message is replying to |
| `is_self_reply` | Boolean | Indicates whether the message is a self reply or not. |
# message_edits Webhook Event Reference



This event will be sent to your webhook when a user edits a previously-sent message.  
You can subscribe to this callback by selecting the `message_edits` field when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.

## Example {#example}

```
{
  "sender": {
    "id": "<PSID>"
  },
  "recipient": {
    "id": "<PAGE_ID>"
  },
  "timestamp": 1458668856463,
  "message_edit": {
    "mid": "<MESSAGE_ID>",
    "text": "<TEXT>",
    "num_edit": "<INT>",
  }
}
```

## Properties {#properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `message_edit` {#message_edit}

| Property | Type | Description |
| --- | --- | --- |
| `mid ` | string | The Message ID of the message that the user edited. |
| `text` | string | The new message content, after the user's edit. |
| `num_edit` | integer | The number of times the user has edited the message. (The user cannot edit a message more than five times. This constraint is on the Messenger client side.) |
# messaging_handovers Webhook Event Reference



The `messaging_handovers` webhook event is used to notify your webhook when certain actions are taken using the Messenger Platform's [handover protocol](https://developers.facebook.com/docs/messenger-platform/handover-protocol), including [pass thread control](https://developers.facebook.com/docs/messenger-platform/handover-protocol#pass_thread_control), [take thread control](https://developers.facebook.com/docs/messenger-platform/handover-protocol#take_thread_control), and [role change](https://developers.facebook.com/docs/messenger-platform/handover-protocol#app_roles) events.

For more information on the handover protocol, see [Handover Protocol](https://developers.facebook.com/docs/messenger-platform/handover-protocol).

### Contents
- [pass_thread_control](#pass_thread_control)
- [take_thread_control](#take_thread_control)
- [app_roles](#app_roles)
- [request_thread_control](#request_thread_control)

## `pass_thread_control` {#pass_thread_control}
This callback will occur when thread ownership for a user has been passed to your application.

For details on implementing pass thread control, see [Pass Thread Control](https://developers.facebook.com/docs/messenger-platform/handover-protocol/pass-thread-control).

```
{
   "sender":{
      "id":"<PSID>"
   },
   "recipient":{
      "id":"<PAGE_ID>"
   },
   "timestamp":1458692752478,
   "pass_thread_control":{
      "previous_owner_app_id":"<previous_app_id or null (idle_mode)>",
      "new_owner_app_id":"123456789",
      "metadata":"Additional content that the caller wants to set"
   }
}
```

### Properties {#pass_thread_control_properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `pass_thread_control`

| Property | Type | Description |
| --- | --- | --- |
| `new_owner_app_id` | String | App ID that thread control is passed to. |
| `previous_owner_app_id` | String | App ID that thread control is passed from. |
| `metadata` | String | Custom string specified in the API request. |

## `take_thread_control` {#take_thread_control}
This callback will occur when thread ownership for a user has been taken away from your application.

For details on implementing take thread control, see [Take Thread Control](https://developers.facebook.com/docs/messenger-platform/handover-protocol/take-thread-control).

```
{
  "sender":{
    "id":"<PSID>"
  },
  "recipient":{
    "id":"<PAGE_ID>"
  },
  "timestamp":1458692752478,
  "take_thread_control":{
    "previous_owner_app_id":"123456789", //could be null if thread was in idle mode
    "new_owner_app_id": <new_app_id>,
    "metadata":"additional content that the caller wants to set"
  }
}
```

### Properties {#take_thread_control_properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `take_thread_control`

| Property | Type | Description |
| --- | --- | --- |
| `previous_owner_app_id ` | String | App ID that thread control was taken from. |
| `new_owner_app_id ` | String | App ID that thread control was given to. |
| `metadata` | String | Custom string specified in the API request. |

## `request_thread_control` {#request_thread_control}
This callback will be sent to the Primary Receiver app when a Secondary Receiver app calls the [Request Thread Control API](https://developers.facebook.com/docs/messenger-platform/handover-protocol/request-thread-control). The Primary Receiver may then choose to honor the request and pass thread control, or ignore the request.

For details on implementing take thread control, see [Take Thread Control](https://developers.facebook.com/docs/messenger-platform/handover-protocol/request-thread-control).

```http
{
  "sender":{
    "id":"<USER_ID>"
  },
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1458692752478,
  "request_thread_control":{
    "requested_owner_app_id":123456789,
    "metadata":"additional content that the caller wants to set"
  }
}
```


### Properties {#request_thread_control_properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `request_thread_control`

| Property | Type | Description |
| --- | --- | --- |
| `requested_owner_app_id` | String | App ID of the Secondary Receiver that is requesting thread control. |
| `metadata` | String | Custom string specified in the API request. |

## `app_roles` {#app_roles}

This callback will occur when a page admin changes the role of your application. An app can be assigned the roles of `primary_receiver` or `secondary_receiver`.

For information on assigning app roles, see [Assign App Roles](https://developers.facebook.com/docs/messenger-platform/handover-protocol/assign-app-roles).

```
{
  "recipient":{
    "id":"<PSID>"
  },
  "timestamp":1458692752478,
  "app_roles":{
    "123456789":["primary_receiver"]
  }
}
```

### Properties {#app_rolesproperties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `app_roles`

| Property | Type | Description |
| --- | --- | --- |
| `id` | String | Your Page ID. |

# messaging_optins Webhook Event Reference



A Messaging Opt In Webhook Event is triggered when a person opts in to receiving Marketing Messages or taps on a Send to Messenger plugin.

When using the Send to Messenger plugin, the `optin.ref` parameter is set by the `data-ref` field on the "Send to Messenger" plugin. This field can be used by the developer to associate a click event on the plugin with a callback.  

## Message Opt In Webhook Notification

Your app will receive opt in webhook notification when the following occurs:

* A person opts-in
* A person re-opts in by clicking the **Continue messages** button shown before the notification message token expires
* A person changes their opt in status, stopping notifications or resuming notifications

```json
{
  "sender": {
    "id": "PSID",
  },
  "recipient": {
    "id": "PAGE-ID",
  },
  "timestamp": "TIMESTAMP",
  "optin": {
    "type": "notification_messages",
    "payload": "ADDITIONAL-INFORMATION",
    "notification_messages_token": "NOTIFICATION-MESSAGES-TOKEN",
    "notification_messages_frequency": "FREQUENCY",
    "notification_messages_timezone": "TIMEZONE-ID",
    "token_expiry_timestamp": "TIMESTAMP",
    "user_token_status": "TOKEN-STATUS",
    "notification_messages_status": "NOTIFICATION-STATUS",
    "title": "TITLE"
    }
}
```

### `optin`

| Property | Description |
| --- | --- |
| `payload`*string* | Additional information that you want to include in the webhooks notification |
| `title` *string* | The title displayed in the template |
| `notification_messages_token`*string* | The token that represents the person who opted in, with the specific topic and message frequency, that is used to send Marketing Messages |
| `notification_messages_frequency` *enum { `DAILY, WEEKLY, MONTHLY` } * | The value can be one of the following:<br>• **DAILY** - send 1 notification per 24 hour period for 6 months from opt in date<br>• **WEEKLY** - send 1 notification per week for 9 months from the opt in date<br>• **MONTHLY ** - send 1 notification per month for 12 months from the opt in date<br><br><br>(Removed in API v16) |
| `notification_messages_timezone` *string * | Timezone for the person receiving the message |
| `notification_messages_status` *enum { `STOP NOTIFICATIONS, RESUME NOTIFICATIONS` } * | **This field is present only when the user stops or resumes Marketing Messages.**<br>The value can be one of the following:<br>• **STOP NOTIFICATIONS** - User has clicked "Stop these messages"<br>• **RESUME NOTIFICATIONS** - User has clicked "Resume these messages"<br> |
| `token_expiry_timestamp`*unix timestamp* | Date when the the notification message token expires |
| `type` *string* | Value must be `notification_messages` |
| `user_token_status` *enum { `REFRESHED, NOT_REFRESHED` } * | The value can be one of the following:<br>• **REFRESHED** - This is set when the user chooses to re opt-in to  receiving Marketing Messages after the token has expired<br>• **NOT_REFRESHED** - Default value and is set when the user does not re opt-in to receiving Marketing Messages after the token has expired<br> |
# messaging_policy_enforcement Webhook Event Reference



An app will receive this callback when a policy enforcement action will be oris taken on the page it manages. You can subscribe to this callback by selecting the `messaging_policy_enforcement` field when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.

A policy enforcement will be taken on a page if it does not conform to Messenger Platform [policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/app-review), fails to meet  [community standards](https://www.facebook.com/communitystandards) or violates Facebook Pages [guidelines](https://www.facebook.com/page_guidelines.php). Common issues include spams, sending inappropriate messages (porn, suicide, etc), abusing [tags](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api), etc.

## Example {#example}

```
{
  "recipient": {
    "id": "PAGE_ID"
  },
  "timestamp": 1458692752478,
  "policy_enforcement": {
    "action": "block",
    "reason": "The bot violated our Platform Policies (https://developers.facebook.com/devpolicy/#messengerplatform). Common violations include sending out excessive spammy messages or being non-functional."
  }
}
```

## Properties {#fields}

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `policy_enforcement` object {#messaging}

| Field Name | Description | Type |
| --- | --- | --- |
| `action` | `action` will be either `warning`, `block` or `unblock` | String |
| `reason` | The reason for being warned or blocked. This field is absent if `action` is `unblock` | String |
# messaging_postbacks Webhooks Reference



This document explains the JSON payload your webhooks server will receive when a messaging postback webhook event is triggered. A postback webhook event is triggered when a person clicks a postback button, Get Started button, or persistent menu item.

## Example Notification {#example}

The following is an example of the JSON payload that will be sent to your webhooks server.

```json
{
  "field": "messaging_postbacks",
  "value": {
    "sender": {
      "user_ref": "USER-REF-ID"
    },
    "recipient": {
      "id": "PAGE-ID"
    },
    "timestamp": "1527459824",
    "postback": {
      "mid": "m_MESSAGE-ID",
      "title": "TITLE-FOR-THE-CTA",
      "payload": "USER-DEFINED-PAYLOAD",
      "referral": {
        "ref": "USER-DEFINED-REFERRAL-PARAM",
        "source": "SHORT-URL",
        "type": "OPEN_THREAD"
      }
    }
  }
}
```

### JSON Properties {#properties}

All JSON properties in a webhook notification are strings.

| Property | Description |
| --- | --- |
| `postback.mid` | The ID for the message |
| `postback.payload` | Information defined in the CTA `payload` parameter. This is only included in the webhook notification sent to the app that sent the message to the person. |
| `postback.referral` | Information about the action the person took to enter a conversation.<br><br>The `referral` property information is included in the webhook notification only when a person starts a conversation using one of the following then clicking a CTA such as a Get Started button:<br><br>* An m.me Link<br>* A Click to Messenger Ad<br>* A Messenger QR Code<br>* A Welcome Screen |
| `postback.referral.ref` | The arbitrary data that was originally passed in the `ref` param added to the m.me link. Only alphanumeric characters as well as -, _, and = are supported |
| `postback.referral.source` | The URL for this referral. For m.me links, the value of  source is `"SHORTLINK"`. For referrals from Messenger Conversation Ads, the value of source is `"ADS"` |
| `postback.referral.type` | The identifier for the referral. For referrals coming from m.me links, it will always be `"OPEN_THREAD"`. |
| `postback.title` | The title for the Call To Action (CTA) that a person clicked |
| `recipient.id` | The ID for your Facebook Page |
| `sender.user_ref` | The ID for the reference for a person who took an action, such as clicked a Get Started, or Persistent Menu item, that sent a message |
| `timestamp` | The Unix timestamp for date when the webhook notification was sent to your server |

## See Also

Additional developer documentation to further your understanding of concepts mentioned in this Messaging Postbacks Webhooks guide.

* [Get Started Button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen)
* [Handover Protocol - Standby Webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/standby)
* [`m.me` Links](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/m-me-links)
* [Messenger QR Code](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery)
* [Persistent Menu Item](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/persistent-menu)
* [Postback Button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons)
# message_reactions Webhook Event Reference



This event will be sent to your webhook when a user reacts to a message on Messenger.  
You can subscribe to this callback by selecting the `message_reactions` field when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.

## Example {#example}

```
{
   "sender":{
      "id":"<PSID>"
   },
   "recipient":{
      "id":"<PAGE_ID>"
   },
   "timestamp":1458668856463,
   "reaction":{
         "reaction": "smile|angry|sad|wow|love|like|dislike|other",
         "emoji": "\u{2764}\u{FE0F}",
         "action": "react|unreact",
         "mid": "<MID_OF_ReactedTo_Message>",
   }
}
```

## Properties {#properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `reaction` {#reaction}

| Property | Type | Description |
| --- | --- | --- |
| `reaction ` | string | Text description of the reaction. Possible values: `smile`, `angry`, `sad`, `wow`, `love`, `like`, `dislike`.<br><br>`other` could also be returned in case the emoji based reaction does not match the ones above. |
| `emoji ` | UTF-8 Emoji | Reference to the emoji corresponding to the reaction. |
| `action ` | string | Action performed by the user. Possible values: `react`, `unreact` |
| `mid ` | string | Reference to the Message ID that the user reacted performed the reaction on. |

# message_reads Webhook Event Reference



This event will be sent to your webhook when a message a Page has sent has been read by the user.  
You can subscribe to this callback by selecting the `message_reads` field when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.

## Example {#example}

```
{
   "sender":{
      "id":"<PSID>"
   },
   "recipient":{
      "id":"<PAGE_ID>"
   },
   "timestamp":1458668856463,
   "read":{
      "watermark":1458668856253
   }
}
```

## Properties {#properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `read` {#read}

| Property | Type | Description |
| --- | --- | --- |
| `watermark ` | Number | All messages that were sent before or at this timestamp were read |

The `watermark` field is used to determine which messages were read. It represents a timestamp indicating that all messages with a timestamp before `watermark` were read by the recipient.
# messaging_referrals Webhook Event Reference



This callback will occur when the user already has a thread with the bot and user comes to the thread from:

- Following an [m.me link with a referral parameter](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/m-me-links)
- Clicking on a [Messenger Conversation Ad](https://developers.facebook.com/docs/messenger-platform/guides/ads)

For tracking referrals in new threads, refer to [Postback Event](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_postbacks).

To start receiving these events you need to subscribe to `messaging_referrals` in the webhook settings for your app.

### Contents
- [Examples](#examples)
    - [m.me Links](#m-me)
    - [Ad Referral](#ads)
- [Properties](#properties)

## Examples {#examples}
### m.me Link {#m-me}

```
{
  "sender": {
    "id": "<PSID>"
  },
  "recipient": {
    "id": "<PAGE_ID>"
  },
  "timestamp": 1458692752478,
  "referral": {
    "ref": <REF_DATA_PASSED_IN_M.ME_PARAM>,
    "source": "SHORTLINK",
    "type": "OPEN_THREAD",
  }
}
```

### Ad Referral {#ads}

```
{
  "sender": {
    "id": "<PSID>"
  },
  "recipient": {
    "id": "<PAGE_ID>"
  },
  "timestamp": 1458692752478,
  "referral": {
    "ref": <REF_DATA_IF_SPECIFIED_IN_THE_AD>,
    "ad_id": <ID_OF_THE_AD>,
    "source": "ADS",
    "type": "OPEN_THREAD",
    "ads_context_data": {
      "ad_title": <TITLE_OF_THE_AD>,
      "photo_url": <URL_OF_THE_IMAGE_FROM_AD_THE_USER_IS_INTERESTED_IN>,
      "video_url": <THUMBNAIL_URL_OF_THE_VIDEO_FROM_THE_AD>,
      "post_id": <ID_OF_THE_POST>,
      "product_id": <PRODUCT_ID>,
      "flow_id": <ID_OF_THE_PARTNER_APP_WELCOME_MESSAGE_FLOW>
    }
  }
}
```

For more information about the flow ID, please refer to [Welcome Message Flows](https://developers.facebook.com/documentation/business-messaging/messenger-platform/ads/ads-welcome-message-flows).

## Properties {#properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `referral`

| Property | Type | Description |
| --- | --- | --- |
| `source` | String | The source of the referral. Supported values:<br><br>- `ADS`<br>- `SHORTLINK` |
| `type` | String | The referral type. Currently supports `OPEN_THREAD`. |
| `ref` | String | The optional `ref` attribute set in the referrer.  Only alphanumeric characters as well as -, _, and = are supported. |
| `referer_uri` | String | The URI of the site where the message was sent. |
| `ads_context_data` | Object | The data contaning information about the CTM ad, the user initiated the thread from. |

### `ads_context_data`

| Property | Type | Description |
| --- | --- | --- |
| `ad_title` | String | Title of the Ad. |
| `photo_url` | String | [Optional] Url of the image from the Ad the user is interested. |
| `video_url` | String | [Optional] Thumbnail url of the the video from the ad. |
| `post_id` | String | ID of the post. |
| `product_id` | String | [Optional] Product ID from the Ad the user is interested. |
# response_feedback Webhook Event Reference



This event will be sent to your webhook when a user provides feedback on a message on Messenger. Users provide feedback by clicking the "thumbs up"/"thumbs down" buttons or by pressing the "Good response"/"Bad response" buttons. You can subscribe to this callback by selecting the `response_feedback` field when setting up your webhook.

By subscribing to the `response_feedback` field for a particular page, all messages sent by your app on behalf of that page will have the response feedback options in the message thread. If you do not want those options in the thread, you can unsubscribe from the webhook field.

## User Experience {#UserExperience}
Once you subscribe to the response_feedback webhook event, users will see the feedback options in thread in the two following ways:

Thumbs up and thumbs down buttons

Good response and bad response buttons in long press menu

Once the user successfully submits the feedback, they will see the following submission confirmation:

## Example {#example}

```
{
   "sender":{
      "id":"<PSID>"
   },
   "recipient":{
      "id":"<PAGE_ID>"
   },
   "timestamp":1458668856463,
   "response_feedback":{
         "feedback": "Good response | Bad response",
         "mid": "<Message-id>",
   }
}
```

## Properties {#properties}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `response_feedback` {#response_feedback}

| Property | Type | Description |
| --- | --- | --- |
| `feedback ` | string | Feedback, provided by the user, on the business message.<br><br>Possible values: `Good response`, `Bad response` |
| `mid` | string | Reference to the |
# send_cart Webhook Event Reference



This callback will occur when a message containing cart information has been sent to your Page. Messages are always sent in order.

You can subscribe to this callback by selecting `send_cart` when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.

## Example {#example}

```
{
  "sender": {
    "id": "<PSID>"
  },
  "recipient": {
    "id": "<PAGE_ID>"
  },
  "timestamp": 1458692752478,
  "order": {
    "products": [
      {
        "id": 123,
        "retailer_id": "retailer_id_1",
        "name": "name1",
        "unit_price": 11,
        "currency": "THB",
        "quantity": 1,
      },
      {
        "id": 456,
        "retailer_id": "retailer_id_2",
        "name": "name2",
        "unit_price": 22,
        "currency": "THB",
        "quantity": 2,
      },
    ],
    "note": "foobar",
  }
}
```

## Properties {#fields}

### `sender`

| `sender` Field | Description |
| --- | --- |
| `id` *string* | The Page-scoped ID for the person who sent a message to your business |

### `recipient`

| `recipient` Field | Description |
| --- | --- |
| `id` *string* | The ID for your Facebook Page |

### `order` {#order}

| Property | Type | Description |
| --- | --- | --- |
| `products` | Array<`product`> | Array containing product data |
| `note` | String | Optional note about the order |

### `order.products` {#order_products}

| Property | Type | Description |
| --- | --- | --- |
| `id` | String | Product ID from [Facebook product catalog](https://developers.facebook.com/documentation/ads-commerce/catalog/overview) |
| `retailer_id` | String | External ID that is associated with the Product (for example, SKU/Content ID) |
| `name` | String | Product name |
| `unit_price` | Float | Numeric price per unit |
| `currency` | String | Currency short string (for example, USD) |
| `quantity` | Int | The count of this product in the order |
# standby Webhook Event Reference



For bots using the [handover protocol](https://developers.facebook.com/docs/messenger-platform/handover-protocol) and [conversation routing](https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing), this callback will occur when a message has been sent to your page, but your application is not the current thread owner.

Instead of delivering the callback through the normal `messaging` channel, the events will be delivered to `standby` channel. You can receive [message](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages), [read](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-reads), and [delivery](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-deliveries) events through history messages.

You can subscribe to this callback by selecting the `standby` field when [setting up](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks#setup) your webhook.

### Contents
- [Supported Events](#events)
- [Example Event](#example)
- [Properties](#properties)

## Supported Events {#events}
The following events are delivered to the standby channel:

- [`message_reads`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-reads)
- [`message_deliveries`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-deliveries)
- [`messages`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages)
- [`messaging_postbacks`](https://developers.facebook.com/docs/messenger-platform/webhooks/webhook-events/messaging-postbacks)

Note that `messaging_postback` events delivered via the Standby channel will not include the postback payload. The app that originally sent the [postback button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/postback) will receive the normal [`messaging_postbacks`](https://developers.facebook.com/docs/messenger-platform/webhooks/webhook-events/messaging-postbacks) webhook event that includes the postback payload.

## Example Event {#example}

```http
{
  "object":"page",
  "entry":[
    {
      "id":"<PAGE_ID>",
      "time":1458692752478,
      "standby":[
        {
          "sender":{
            "id":"<USER_ID>"
          },
          "recipient":{
            "id":"<PAGE_ID>"
          },

          ...
        }
      ]
    }
  ]
}
```

## Properties {#properties}

| Property | Type | Description |
| --- | --- | --- |
| `id` | String | The PSID of the user that triggered the webhook event. |
| `time` | Timestamp | Timestamp of the message send. |
| `standby` | Array | Array of messages received in the standby channel. |
# Discovery & Engagement



This guide lists different ways that you can use the Messenger Platform from Meta to drive business discovery and engagement.

## On Apps from Meta

### [Ads that Click to Messenger](https://developers.facebook.com/documentation/business-messaging/messenger-platform/ads) {#ads}

Ads that Click to Messenger allows your business to display ads on Facebook, Instagram, or Messenger that send people to Messenger to start a conversation with your business.

### [Lead Generation Ads in Messenger](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/lead-generation-ads-in-messenger) {#lead_ads}

Lead Generation Ads in Messenger allows your business to display ads on Facebook, Instagram, or Messenger that are optimized for finding potential clients over Messenger and allow for follow ups over Messenger.

### [Facebook Page](https://www.facebook.com/business/help/1626883224209011)

The Send Message button on your business' Facebook Page allows people to send your business a message while visiting your Page.

### [Private Replies](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/private-replies) {#private_replies}

Private Replies allows your business to send a message on Messenger to a person who has published a visitor post or comment on your business' Facebook Page.

### Search on Messenger  

The Search on Messenger allows people on Messenger to search for your business.

### Share from Messenger

Users can share your messaging experience from the business profile page on Messenger. This helps drive word of mouth discovery to your profile.

## On Your Website

### [Checkbox Plugin](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery) {#checkbox}

The Checkbox Plugin renders a checkbox in forms on your website to allow people to opt-in to receive follow-up messages, such as confirmations and updates, from your business on Messenger.

### [Message Us Plugin](https://developers.facebook.com/docs/messenger-platform/discovery/message-us-plugin) {#message_us}

The Message Us Plugin renders a button on your business' website that opens a conversation with your business on Messenger.

### [Send to Messenger Plugin](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery) {#send_to_messenger}

The Send to Messenger Plugin renders a button on your website that allows a person to opt-in to receive follow-up messages, such as confirmations and updates, from your business on Messenger.

## Anywhere

### [m.me Links](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/m-me-links) {#me}

`m.me` Links is a URL service operated by Meta that redirects people to Messenger where they can start conversations with your business' Facebook Page. You can use them on your business' website, email newsletters, QR codes, and more.

### [Login Connect with Messenger](https://developers.facebook.com/documentation/facebook-login/login-connect)

Login Connect with Messenger allows people to opt in to receive messages from your business through Messenger Platform during the Facebook Login flow on your mobile app or website. If a person opts in, your business can send messages to the person within the standard 24-hour messaging window.
# Lead Generation Ads in Messenger



Apart from [Click To Messenger Ads](https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-messenger), there are ads that help you ask automated questions to generate leads or potential clients. These ads can be displayed on Facebook and Instagram to find customers who are interested in your business's products or services.

-  [Customer Experience](#userexperience)
-  [Follow up on Leads using Messenger Platform](#follow_on_leads_with_apps)
-  [Creating a Lead Generation Ad](#create_lead_ad)
-  [Connect an App to a Lead Generation Ad](#connnect_an_app)
-  [Using Keywords to end automated questions](#stop_keywords)
-  [Expected App Webhooks](#webhooks)
    - [Referral Webhook](#referral)
    - [Summary Message](#summary)
    - [Handover Protocol Events (HOP)](#handover)
- [FAQ](#faq)

## Customer Experience {#userexperience}

When a customer clicks a lead generation ad, a Messenger conversation will be created between your business and the customer. The messages will contain a set of questions specified during ad creation. People qualified according to your questions will be marked as completed leads.

To test by injecting a demo ad into your feed:
[Demo Lead Generation Ad](https://www.facebook.com/ads/experience/confirmation/?experience_id=1638275386654488)

Both complete and incomplete leads will show up on the Page Inbox tool. You can then follow up on those leads in different ways:

* For Messenger Platform Integrations. After the lead flow is completed, thread control is passed to the selected App. See [Lead Generation Ad to app handover](https://developers.facebook.com/docs/messenger-platform/handover-protocol/messenger-lead-ads-hop)
* On **Page Inbox**: Lead conversations will be available in a dedicated folder
* In **Ads Manager** leads are available for download. Leads can be downloaded as either an *xlsx* or *csv* file.

Your business will only be able to view the conversation once the potential customer does the first reply after clicking on the ad. If the customer takes no action, no webhooks notifications are sent.

## Follow up on Leads using Messenger Platform {#follow_on_leads_with_apps}

The use case for this feature is when a Business drive leads into Messenger but wants to use an app to follow up on collected leads. For the specific use case of leads, the ad delivery model can optimize for lead completion as objective while providing handover functionality for Apps to then handle the follow up for completed leads.

Advertisers may select a specific app to receive messages from a Messenger Lead Ads campaign. More info on [Messenger Lead Ads app handover](https://developers.facebook.com/docs/messenger-platform/handover-protocol/messenger-lead-ads-hop)

## Creating a Lead Generation Ad {#create_lead_ad}

Create a Click To Messenger: Lead Generation Ads using Ads Manager. For more details see [instructions to create a lead generation ad that clicks to Messenger.](https://www.facebook.com/business/help/2398917563501477). Once the ad is created you can use the Message Template to define qualification questions.

### Create a Message Template
The **Message Template** defines the questions used to qualify a person as a lead. This flow defines the meaning of each answer. It will result in either, a *complete* lead or a *disqualified* lead.

### Connect an App to a Lead Generation Ad {#connnect_an_app}

In the **Advanced** Tab of the **Message Template** select *Connect An App*. This toggle is only available to Pages with authorized app in the Advanced Messaging page setting. Once active you can select the desired app. You can now Save and Finish and expect the target app will get thread control after the lead flow finishes.

#### Optional settings
***Allow connected app to interrupt:*** This checkbox setting allows the selected app to get *message webhooks* during the lead generation process as well as use Send API to interrupt the lead generation flow. Note that when an app interrupts the lead generation flow, the action is treated as a takeover. When the ad is interrupted it will be prevented from recording the complete lead signal that is used for ad delivery optimization.

***Send lead summary to connected app:*** This checkbox setting allows the selected app to get a *message webhook* with the information collected during lead submission process. This feature is meant for apps that can't process the referal webhook that already contains this information and that is sent by default.

### Using Keywords to end automated questions {#stop_keywords}

This optional advanced feature is intended for businesses that support customer care over Messenger. It can assist customers who want to stop the lead generation flow to get customer support.

Stop keywords like 'agent', 'support', 'stop', 'customer care' can be set on the ad. If the potential customer messages any of those keywords or phrases (case insensitive). The lead generation flow will be interrupted, and the thread control will be released back to the business.

If an App is connected to the Page, the stop message will be sent to the App as a message webhook. This allows the App to respond to the user's request.

The **Confirmation message** will be triggered if a keyword to end the lead generation flow is detected. This message will not be sent to apps as a message webhook although the trigger keyword will trigger as a message webhook event.

## Expected App Webhooks {#webhooks}

### Referral Webhook {#referral}

The Lead Referral webhook is always sent to apps subscribed to [`messaging_referrals`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/webhook-events/messaging_referrals) webhook events after the Click-To-Messenger Ad ends. This event can be used as trigger to follow up messages or assign the lead to an agent for lead nurturing. The webhook contains all the lead collected information along with the type of ending; `LEAD_COMPLETE` if the person succefully finished the lead generation flow or `LEAD_INCOMPLETE` if the person did not finished the lead generation flow or selected a disqualifiying choice.

Since the standard messaging window is open when this event is triggered. Apps can use Send API to send follow ups in Messenger.

```
{
    "object": "page",
    "entry": [
        {
            "time": 1665424582475,
            "id": "542998526103632",
            "messaging": [
                {
                    "sender": {
                        "id": "5794982867201265"
                    },
                    "recipient": {
                        "id": "542998526103632"
                    },
                    "timestamp": 1665424533,
                    "referral": {
                        "source": "ADS",
                        "type": "LEAD_COMPLETE",
                        "ad_id": "6302572858686",
                        "ads_context_data": {
                            "ad_title": "Find Wholesalers Ad",
                            "post_id": "559217392549680",
                            "photo_url": "https://scontent.xx.fbcdn.net/..."
                        }
                    },
                    "lead": {
                        "data": [
                            {
                                "question": "Are you interested in becoming a reseller?",
                                "answer": "Yes"
                            },
                            {
                                "question": "What city is your store located?",
                                "answer": "Menlo Park"
                            }
                        ]
                    }
                }
            ]
        }
    ]
}
```

### Summary Message Webhook {#summary}
This message is only sent for Lead Ads with the summary message enabled at the ad level (*Send lead summary to connected app* checkbox) when the lead is completed. The structure of the webhook mocks a message sent by the person to the Page and contains all info shared during the lead flow.

Note that this summary message will not appear in the thread for either the person or the Page. The goal of this message is to help apps that are not listening to the new `messaging_referrals` and get an initial message to trigger them with context to get started.  

```
{
    "object": "page",
    "entry": [
        {
            "time": 1661209504608,
            "id": "542998526103632",
            "messaging": [
                {
                    "sender": {
                        "id": "5794982867201265"
                    },
                    "recipient": {
                        "id": "542998526103632"
                    },
                    "timestamp": 1661209328,
                    "message": {
                        "mid": "m_2OF0H5fb2HNRyjM0rt2FVBAaDQp_p5DQlffdEXNVyOrraxQCt0tFwWXwq3QctcvbpjSX1rSY8BX9Y2IXwPirWA",
                        "text": "Lead summary:
Are you interested in becoming a reseller?: Yes
What city is your store located?: Menlo Park"
                    },
                    "hop_context": {
                        "app_id": 498721317747541,
                        "metadata": "messenger_lead_gen_complete"
                    }
                }
            ]
        }
    ]
}
```

### Handover Protocol Events (HOP) {#handover}

The change in thread control will trigger webhooks to apps subscribed to the `messaging_handover` field. More details on [Handover Protocol Webhook Event for Click To Messenger, Lead Generation Ads](https://developers.facebook.com/docs/messenger-platform/handover-protocol/messenger-lead-ads-hop)

### FAQ {#faq}

**How do I install a Messenger App?**

Apps are installed from the app website using [Facebook Login](https://developers.facebook.com/documentation/facebook-login) and granting pages_messaging permission to a particular Page. Authorized Apps will show up in **Page settings** inside **Advanced messaging**.

**I can’t see my app in the connect app drop down**

Only Authorized Apps for the Page will show up. You can see Authorized apps in **Page settings** inside **Advanced messaging**.Apps are installed from the app website using [Facebook Login](https://developers.facebook.com/documentation/facebook-login) and granting pages_messaging permission to a particular Page.

**Can I have more than one bot connected to a page?**

Yes, more than one app can be subscribed to a page. When multiple apps handle the same conversation is best to use the [Handover Protocol](https://developers.facebook.com/docs/messenger-platform/handover-protocol) to handle which bot owns the thread at any given time.

**What happens if the user sends more messages after lead submission?**

After the lead submission ends Apps will get webhooks on user messages and can reply to them. If an app was selected as part of the App then only that selected app will be allowed to reply and will get webhooks on the messaging channel. The messaging window is open and the App can reply using Send API

**What happens to Send API while a Lead Generation Ad is in progress?**

By Default Send API and Webhooks are blocked while a Lead Generation Ad is in progress. App Id: 413038776280800 for Messenger Lead Gen App will have thread control. This behavior can be disabled using the Block Send API toggle on the Create Template dialog inside the Ad

**My app is not getting the Summary message webhook**

Send Summary is enabled by default only when an App is selected, in the Create Template dialog inside the Ad. Note the summary can be disabled on the ad after selected the  connected App. Even when an app is not selected the Lead Gen Ad will pass thread control to the Handover primary reciver, when set, or just release thread control.
Any follow up message after the lead is submitted will be sent to subscribed Apps. Apps can query Conversation API to retrieve the message history and get the information shared during the lead generation.

**What happens if the person clicks on the Ad but does not complete the lead or is disqualified?**

As long as the user replies to the first question the messaging window will be open. If the anwers provided disqualify thre user or the user does not reply, then the ad experience will end and the ad will pass thread control to the target app and provide the metadata "messenger_lead_gen_incomplete" this allows business to have a fallback experience to convert non leads into customers. See [HOP webhook after Lead Ad](https://developers.facebook.com/docs/messenger-platform/handover-protocol/messenger-lead-ads-hop) for more info
# m.me Links



This document shows you how to create m.me links for your Messenger experience.

`m.me` is a URL service provided by Meta that redirects people to a person, page, or conversation in Messenger. You can use them on your website, email newsletters, and more.

## How It Works

The format for an `m.me` link is as follows where `PAGE-NAME` is the Facebook Page linked to your messaging app.

```
http://m.me/PAGE-NAME
```

When a person click an `m.me` link, they will be redirected to either a new conversation with your business or an exist conversation if the person has messaged your business in the past. A default message will appear in the conversation stating: "You have entered this conversation by following a link. We've let PAGE-NAME know you're here."

When a person clicks the Get Started button to **start a conversation** with your business, a `messaging_postbacks` webhook notification will be sent to your webhooks server. As part of this webhook notification the `postback` object will contain a `referral` object with the `ref` parameter.

When a person clicks an `m.me` link and a conversation already exists between your business and the person, the link will take them to the existing conversation. This action will reset the 24-hour standard messaging window, allowing your messaging app to reply to the person and a `messaging_referrals` webhook notification will be sent to your webhooks server. As part of this webhook notification a `ref` parameter from the `m.me` link will be included.

### Referral Parameters {#parameters}
**Note:** **Limitation on referral parameters**

Referrals on m.me links might not work for some Messenger for Android customers or [Pages with georestriction](https://www.facebook.com/help/778445532225441/). We do not make guarantees that referrals will always work, and they may be restricted in some instances. However, the m.me link still works to direct customers to send messages. We recommend that you do not use this feature if these limitations impact your business.

An m.me link can contain a `ref` parameter that, when a person clicks on the link, provides your business with more context about the conversation such as a link on your website versus a link in a store. These types of links can also direct the person to specific content or features available within your Messenger experience.

```
http://m.me/PAGE-NAME?ref=REF-PARAMETER-INFORMATION
```

### QR Codes

`m.me` links with `ref` parameters can be embedded into QR Codes. QR compatible codes can be scanned with a phone's native camera. When scanned they will open the Messenger app and the message conversation with your business.

#### QR Code Example

The example QR code has `http://m.me/OriginalCoastClothing?ref=summer_coupon` encoded that will trigger an example flow about a discount coupon on Messenger.

### Webhook Notification {#reading_parameter}

When you receive a webhook notification it will contain information from a person who is starting a conversation with your business or from a person who has an existing conversation with your business.

#### Start a Conversation

When a person clicks the Get Started button to start a conversation with your business, we will deliver the `ref` param as part of the `messaging_postbacks` webhook notification.  

```http
{
  "sender":{
    "id":"PSID"
  },
  "recipient":{
    "id":"PAGE-ID"
  },
  "timestamp":1458692752478,
  "postback":{
    "payload":"POSTBACK-PAYLOAD-YOU-CONFIGURED",
    "referral": {
      "ref": "REF-PARAMETER-INFORMATION",
      "source": "SHORTLINK",
      "type": "OPEN_THREAD",
    }
  }
}
```

#### Continue in an Existing Conversation

If a conversation already exists between your business and the person who clicked the m.me link, the link the `messaging_referrals` webhook notification will be sent.

```http
{
  "sender":{
    "id":"PSID"
  },
  "recipient":{
    "id":"PAGE-ID"
  },
  "timestamp":1458692752478,
  "referral": {
    "ref": "REF-PARAMETER-INFORMATION",
    "source": "SHORTLINK",
    "type": "OPEN_THREAD",
  }
}
```

## Before You Start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components for sending and receiving messages and notifications.

You will need:

* Advanced Access for the app that is linked to your business' Facebook Page
* A [Get Started Button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen) for your Messenger experience for new conversations
* The app linked to your business' Facebook Page must be subscribed to the `messaging_postbacks` and `messaging_referrals` webhooks fields

### Limitations

*  Apps with Standard Access can only get information from people who have a developer, tester, or admin role on your messaging app

## Marketing Messages Opt In Requests  {#notifications}

The `m.me/rn` URL allows you to create a recurring notification opt in request with an `m.me` link. The format for an `m.me/rn` link must include the topic for the recurring notification. You can set the cadence for the recurring notification otherwise it will default to daily.

```
http://m.me/rn/PAGE-NAME?topic=TOPIC&cadence=MESSAGE-FREQUENCY
```

#### Limitations

*  iOS version 383 is required for `m.me/rn` links to work properly. The person who clicked on your link will be redirect to your base `m.me` URL, `http://m.me/PAGE-NAME` URL

#### Marketing Messages Example Link

```
https://m.me/rn/OriginalCoastClothing?topic=weekly%20deals&cadence=weekly
```

### Register Your Topic

Before you can use your `m.me/rn` URL with a new topic, you must first register the new topic.

If you are using a topic you have used in a previous `m.me/rn` URL and people have opted in to receive recurring notifications, you do not need to register the topic again.

You can register a new topic by following these steps:

**Step 1.** Send yourself a recurring notification opt in request with the topic to a person who has a role on your app. We recommend adding the payload to indicate this is to register your topic.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"PSID"
  },
  "message":{
    "attachment":{
      "type":"template",
      "payload":{
         "template_type":"notification_messages",
          "title":"TITLE",
          "payload": "Registering a new topic: TOPIC-NAME",
          "notification_messages_frequency": MESSAGE-FREQUENCY,
      }
    }
  }
}' "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS-TOKEN"
```

On success, your app receives the following JSON response:

```json
{
        "recipient": {
          "id":"PSID",
          "message_id":"MESSAGE-ID",
}
```

**Step 2.** Make sure to click the opt in button in the conversation. We will send you an optin webhook notification. Your topic is now registered and ready for public use.

**Note:** A person who clicks on an `m.me/rn` link with a topic that has not been registered will be redirected to your base recurring notification URL, `http://m.me/rn/PAGE-NAME` URL.

When registering a topic, if you send yourself an optin request but do not click the opt in button, your topic will not be registered.

#### Sample Request

*Formatted for readability.*

```curl
curl -X POST "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/notification_messages_dev_support
    ?recipient={
        "notification_messages_token": "NOTIFICATION-MESSAGES-TOKEN"
    }
    &developer_action=ENABLE_FOLLOWUP_MESSAGE
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, your app will receive the following JSON response:

```json
{ "success": true }
```

### `messaging_optins` Webhook Notification

When you receive a webhook notification it will contain information from a person who is starting a conversation with your business or from a person who has an existing conversation with your business.

```json
{
  "sender": {
    "id": "PSID",
  },
  "recipient": {
    "id": "PAGE-ID",
  },
  "timestamp": "TIMESTAMP",
  "optin": {
    "type": "notification_messages",
    "title": "TITLE-FOR-NOTIFICATION-MESSAGE",
    "ref": "REF-PARAMETER-INFORMATION",
    "payload": "",
    "source":"SHORTLINK"
    "notification_messages_token": "NOTIFICATION-MESSAGES-TOKEN",
    "notification_messages_topic": "RECURRING-NOTIFICATION-TOPIC",
    "notification_messages_frequency": "MESSAGE-FREQUENCY",
    "notification_messages_timezone": "TIMEZONE-ID",
    "token_expiry_timestamp": "TIMESTAMP",
    "user_token_status": "TOKEN-STATUS"
    }
}
```

## `m.me` Reference

| Parameter Name | Descripion |
| --- | --- |
| `cadence`<br><br>_enum { `daily`, `monthly`, `weekly` }_ | The message frequency for the `m.me/rn` link opt-in request. Defaults to `daily`. |
| `ref` *string* | Context about the conversation, such as a link on your website versus a link in a store, that is delivered in a `messaging_referrals` webhook notification. This parameter must be URL-encoded when used on m.me links. Length for this value can not exceeed 2,083 characters |
| `topic`*string * | **Required.** The topic for the `m.me/rn` link opt in request, such as weekly promotions or upcoming releases.  This parameter must be URL-encoded when used on m.me links. Alphanumeric, no special characters, URL encoded. |

## Next Steps

* [Send a Reply](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages)
* [Send a Recurring Notification](https://developers.facebook.com/docs/messenger-platform/send-messages/recurring-notifications)

## See Also

* See the [Referral Parameters page](https://www.originalcoastclothing.com/referral-parameters) on [Original Coast Clothing Sample Guide](https://developers.facebook.com/docs/messenger-platform/getting-started/sample-apps/original-coast-clothing)
* Visit the [`messaging_optins` reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_optins)
* Visit the [`messaging_postbacks` reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_postbacks) for more information about this webhook's fields
* Visit the [`messaging_referrals` reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_referrals) for more information about this webhook's fields
# Private Replies



Private Replies allows a business to send a single message to a person who published a post on your business' Facebook Page or who commented on a post or comment on the business' Facebook Page or Group. The message will contain a link to the post or comment that the person published.

### Limitations

* Only one message can be sent to the person who commented
* The message must be sent within 7 days from when the post or comment was created
* Only when a person responds to the private message can you continue the conversation within the 24-hour messaging window.
* Standard Access apps can only access data for people who have a role on the app
* Cannot send private reply message to another facebook page

### Before You Start

You will need:

* A Page access token requested by a person who can perform the `MESSAGING` task on the Page
* The `pages_messaging` permission
* The ID for your business' Facebook Page
* The ID for the post or comment made by the person to whom you are sending the private reply. The ID can be obtained from the `pages_feed` webhooks (recommended to avoid rate limiting) or an API call to the `/page/feed` endpoint

Optional, but recommended:

* Subscribe to your app to the messaging webhooks fields
* Subscribe your app to the `groups_feed` webhooks field, if your business has a Facebook group.

To receive webhooks for private replies, the group settings for private replies must be on.  Private replies are **On** by default. To confirm this setting, the admin of the Facebook Page can go to the Facebook Group, tap **Manage** in the left panel and scroll down to **Settings**. Tap **Group settings**, scroll down to **Manage discussion** and look for **On** under **Private replies**.

### Message Types

All messaging types available for using the Send API are available for private replies.

## Send a Private Reply

To send a private reply to a post or comment, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient` parameter with `post_id` or `comment_id` set to the ID for the post or comment and the `message` parameter set to the message you wish to send.

### Example Request {#example_request}

The following example shows a reply to a post published on your Page by a customer:

_Hi, I want to buy a gift for my nephew. Do you have any suggestions?_

```
curl -X POST -H "Content-Type: application/json" -d '{
    "recipient": {
        "post_id": "PAGE-POST-ID"
    },

    "message": {
      "attachment":{
        "type":"template",
        "payload":{
          "template_type":"button",
          "text":"Of course, what is your budget for the gift?",
          "buttons":[
              {
                  "type": "postback",
                  "title": "LESS THAN $20",
                  "payload": "GIFT_BUDGET_20_PAYLOAD"
              },
              {
                  "type": "postback",
                  "title": "$20 TO $50",
                  "payload": "GIFT_BUDGET_20_TO_50_PAYLOAD"
              },
              {
                  "type": "postback",
                  "title": "MORE THAN $50",
                  "payload": "GIFT_BUDGET_50_PAYLOAD"
              }
          ]
        }
      }
    }
}' "https://graph.facebook.com/v25.0/PAGE-ID/messages?access_token=<PAGE-ACCESS-TOKEN>"
```

## See also

- [Groups Feed Webhooks Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/group-feed)

- [Messenger Platform – Message Types](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages)

- [Messenger Platform – Rate Limits](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview#rate-limits)

- [Meta Webhooks for Facebook Pages](https://developers.facebook.com/docs/pages/webhooks)

- [Page Feed Reference](https://developers.facebook.com/docs/graph-api/reference/page/feed)

# The Welcome Screen



This document shows you how to create a welcome screen for your Messenger experience. The welcome screen displays the name for your business' Facebook Page, the profile picture and cover photo from your Facebook Page, the time it usually takes for your business to respond to messages, and a **Get Started** button. When a person clicks the Get Started button, a message Get Started will be posted into the conversation, and your app can send the person messages.

## How It Works

When a person clicks the Get Started button in your Messenger experience, a webhook notification will be sent to you. You can use this notification to send an initial welcome message such as a text or set of quick replies.

### Before You Start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components such as a Facebook Page for your business (or test Page), registered as a Meta developer, and created a Meta business app ID with the Messenger product.

You will need:

* A Page access token requested from a person who can perform the `MESSAGING` task on the Page
* The `pages_messaging` permission
* To subscribe to the `messaging_postbacks` webhook event

### Limitations

For apps with Standard Access, the welcome screen will only be visible to people with role on the app.

## Commands

If your Page uses [Commands](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/commands), the welcome screen shows the list of commands supported by the messaging experience, making it easy for people to understand what actions the Messenger experience can be asked to perform.

## Implement the Get Started Button {#set_postback}

To set the postback payload, send a `POST` request to the [Messenger Profile API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api):

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "get_started": {"payload": "<postback_payload>"}
}' "https://graph.facebook.com/v2.6/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>"
```

For complete details, see the [`get_started` property reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen).

**Warning:** The Get Started Button feature is not supported when Messenger is accessed via the Facebook Mobile Browser (the in-app browser within the Facebook app).

### Best Practices

* **Do** communicate next steps to encourage a response in your welcome message. You can use buttons to add structure to your message and call out specific actions people can take.
*  **Do** share basic commands in your welcome message. Communicate which keywords or terms people can use to ask for help, get updates, etc., so they find what they want more quickly.
* **Do** change your onboarding experience when your bot experience changes. Revisit your welcome message as you update your capabilities to make sure they're still relevant.
* **Don't** be too generic. Try addressing people by name to make the message feel personal and treating it as an opportunity to teach them how to use and control the experience.

## See Also

* [Messenger Profile API](https://developers.facebook.com/docs/graph-api/reference/page/messenger_profile)
# Messenger Profile API



The Messenger Profile for your Page is where you set properties that define various aspects of the following Messenger Platform features. For more information, see the [Messenger Profile Properties](#profile_properties) table below.

* [Get Started Button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen)
* [Welcome Page](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/greeting)
* [Ice Breakers](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/ice-breakers)
* [Persistent Menu](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/persistent-menu)
* [Domain allowlist](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/domain-whitelisting)
* [Account Linking](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/account-linking-url)
* [Commands](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/commands)

The Messenger Profile API allows you to set, update, retrieve, and delete properties from the Page Messenger Profile.

## Permissions {#permissions}

A page access token with `pages_messaging` permission is required to interact with this endpoint.

Apps in Development Mode, the Messenger Profile settings will only be visible to people with role on the app.

## Request URI

```
https://graph.facebook.com/v25.0/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>
```

## Messenger Profile Properties {#profile_properties}

The following properties may be included in the Messenger profile for your Page. See descriptions in the table below for the type and purpose of each property.

| Property | Type | Description |
| --- | --- | --- |
| `get_started` | Object | The payload that will be sent as a `messaging_postbacks` event when someone taps the 'get started' button on your Page Messenger welcome screen.<br><br>For more, see [Get Started Button Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen). |
| `greeting` | Array<Object><br> | An array of locale-specific greeting messages to display on your Page Messenger welcome screen.<br><br>For more, see [Greeting Text Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/greeting). |
| `ice_breakers` | Array<Object><br> | An array with an ice breaker object.<br><br>For more, see [Ice Breakers Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/ice-breakers). |
| `persistent_menu` | Array<Object><br> | An array of call-to-action buttons to include in the persistent menu.<br><br>For more, see [Persistent Menu Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/persistent-menu). |
| `whitelisted_domains` | Array<String><br> | A list of allowlisted domains. Required for Pages that use the [Messenger Extensions SDK](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webview/extensions) and the [checkbox plugin](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery).<br><br>For more, see [Domain Allowlist Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/domain-whitelisting). |
| `account_linking_url` | String | Authentication callback URL. Must use https protocol.<br><br>For more, see [Account Linking URL Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/account-linking-url). |
| `commands` | Array<Object><br> | Optional argument. If provided, it cannot be null.<br><br>For more, see [Commands Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/commands). |
| `subject_to_new_eu_privacy_rules` | Boolean | A boolean flag that determines whether the page is impacted by the [Messenger API Updates for Europe](https://developers.facebook.com/documentation/business-messaging/messenger-platform/europe-japan-updates). This property is only available for `GET` request. |

## Retrieve Properties {#get}
Retrieves the current value of one or more [Messenger Profile properties](#profile_properties) by name.

### Request Parameters
The following parameters are included in the query string of the request:
| Parameter | Description |
| --- | --- |
| fields | A comma-separated list of [Messenger Profile properties](#profile_properties) to retrieve. |

### Example Request

```
curl -X GET "https://graph.facebook.com/v25.0/me/messenger_profile?fields=whitelisted_domains,greeting&access_token=<PAGE_ACCESS_TOKEN>"
```

### Example Response
The current value of the requested properties will be returned in the `data` array:

```curl
{
   "data": [
        {
          "whitelisted_domains": [
            "https://facebook.com/"
          ],
          "greeting": [
            {
               "locale": "default",
               "text": "Hello!"
            },
            {
               "locale": "en_US",
               "text": "Timeless apparel for the masses."
            }
         ]
      }
   ]
}
```

## Set/Update Properties {#post}
Sets the values of one or more [Messenger Profile properties](#profile_properties). Only properties set in the request body will be overwritten.

### Example Request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "<PROPERTY_NAME>": "<NEW_PROPERTY_VALUE>",
  "<PROPERTY_NAME>": "<NEW_PROPERTY_VALUE>",
  ...
}' "https://graph.facebook.com/v25.0/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>"
```

### Example Response

```json
{
    "result": "success"
}
```

## Delete Properties {#delete}
Deletes one or more [Messenger Profile properties](#profile_properties). Only properties specified in the `fields` array will be deleted.

### Example Request

```
curl -X DELETE -H "Content-Type: application/json" -d '{
  "fields": [
    "<PROPERTY_NAME>",
    "<PROPERTY_NAME>",
    "<PROPERTY_NAME>",
    ...
  ]
}' "https://graph.facebook.com/v25.0/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>"
```

### Example Response

```json
{
    "result": "success"
}
```

## Rate Limit {#rate_limit}
Calls to the Messenger Profile API are limited to 10 API calls per 10 minute interval. This rate limit is enforced per Page.
# ice_breakers Reference



Ice Breakers provide a way for users to start a conversation with a business with a list of frequently asked questions. A maximum of 4 questions can be set via the Ice Breaker API.

Starting April 19th, 2022, Ice Breakers supports localization allowing businesses to set custom questions based on the user locale. The API will have a new format and we encourage developers to leverage the new format to set and retrieve Ice Breakers information. The list of supported locales can be found [here](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales).

## Page Profile Priority {#page_profile_priority}
Some profile elements, like Ice Breakers and the Get Started button, are incompatible with each other. When both are set, one will take precedence over the other. This is the order of precendence for the profile elements:

1. [API Ice Breakers](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/ice-breakers)
2. [Get Started button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen)
3. Custom Questions set via the Page Inbox UI
 - Editing Custom Questions from the Page Inbox UI is disabled when Ice Breakers are set via API. This is to prevent breaking the experience set by the installed app.

## POST request {#post_request}

To set an Ice Breaker configuration, there are two formats for the POST request, existing and new.

One POST request can have the existing format **OR** the new format but not both.

### New format (recommended)

```
curl -X POST -H "Content-Type: application/json" -d '{

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
}' "https://graph.facebook.com/v25.0/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>"
```

### Existing format

```
curl -X POST -H "Content-Type: application/json" -d '{

  "ice_breakers":[
     {
        "question": "<QUESTION>",
        "payload": "<PAYLOAD>"
     },
     {
        "question": "<QUESTION>",
        "payload": "<PAYLOAD>"
     },
     ...

  ]
}' "https://graph.facebook.com/v25.0/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>"
```

## GET request {#get_request}

Depending on how the Ice Breaker is setup, GET request will return a different format:

- If the Ice Breaker is setup using the existing format, GET request will return the existing format response.
- If the Ice Breaker is setup using the new format, GET request will return the new format response.

Developers should migrate to the new format as we will be deprecating the old format.

```
curl -X GET "https://graph.facebook.com/v25.0/me/messenger_profile?fields=ice_breakers&access_token=<PAGE_ACCESS_TOKEN>"
```

### New Format Response

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
        ...
      }
   ]
}
```

### Existing Format Response

```
{
   "data": [
        {
          "ice_breakers": [
            {
                "question": "<QUESTION>",
                "payload": "<PAYLOAD>"
            },
            {
                "question": "<QUESTION>",
                "payload": "<PAYLOAD>"
            },
            ...
        ]
      }
   ]
}
```

## DELETE Request {#delete_request}

This will delete ALL the ice breakers. Deletion of locale specific Ice Breakers will be enabled in the future.

```
curl -X DELETE -H "Content-Type: application/json" -d '{
  "fields": [
    "ice_breakers",
  ]
}' "https://graph.facebook.com/v25.0/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>"
```

Response

```
{
   "success": "true"
}
```

## Properties {#properties}

| Property | Type | Description |
| --- | --- | --- |
| `question` | String | Text that will be posted on the thread as the user asking the question. |
| `payload` | String | Payload the will be returned as a [postback webhook event](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_postbacks) |

## Example API Call {#example}
API POST call to set up Ice Breakers in the New format

```
curl -X POST -H "Content-Type: application/json" -d '{
"ice_breakers":[
       {
          "call_to_actions":[
             {
                "question":"Where are you located?",
                "payload":"LOCATION_POSTBACK_PAYLOAD"
             },
             {
                "question":"What are your hours?",
                "payload":"HOURS_POSTBACK_PAYLOAD"
             }
          ],
          "locale":"default"
       },
       {
          "call_to_actions":[
             {
                "question":"What are your hours?",
                "payload": "HOURS_POSTBACK_PAYLOAD"
             },
             {
                "question":"Can you tell me more about your business?",
                "payload": "MORE_POSTBACK_PAYLOAD"
             },
             {
                "question":"What services do you offer?",
                "payload": "SERVICES_POSTBACK_PAYLOAD"
             }

          ],
          "locale":"en_GB"
       }
    ]
}' "https://graph.facebook.com/v25.0/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>"
```

## Rate Limit {#rate_limit}
Calls to the Messenger Profile API are limited to 10 API calls per 10 minute interval. This rate limit is enforced per Page.
# commands Reference



Commands are tappable keywords that a user can invoke at any time to perform specific actions within the Messenger experience. Users can invoke multiple commands in a single message. For example, if your travel assistant supports commands such as **flights** and **hotels**, a message from a user might be, "Help me book **flights** and **hotels** to Mexico for the last week of December." Messenger automatically highlights the commands in the composer as the user taps them. These commands then trigger a [webhook](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages) to send the list of commands invoked by the user. Only the command name(s) will be sent to your app via webhook. Your app can then use the webhook as confirmation of the user's intent to run a command, and parse the message text appropriately.

Users can invoke commands in three ways, as seen in the screenshots above:

1. From the Commands menu, which is a static menu accessed by tapping a hamburger menu icon next to the composer
1. By typing a forward slash or @ in the composer
1. From a "popover" above the composer, which is a bubble with a single command that will show up when the user types a word that is also a command supported by your Messenger experience

The Commands menu appears automatically when you set up Commands. No further action is needed on your part.

**Warning:** A key difference between Commands and the Persistent Menu is that tapping a Persistent Menu item sends the keyword to the thread, whereas tapping a Command sends the command to the composer, allowing the user to add additional context.

## `commands` Format {#format}

```json
"commands": [
  {
    "locale": "default",
    "commands": [
      {
        "name": "flights",
        "description": "Find real-time flights and fares"
      },
      {
        "name": "hotels",
        "description": "Find real-time hotel rooms and rates"
      },
      {
        "name": "currency",
        "description": "Find real-time currency exchange rates"
      },
      {
        "name": "weather",
        "description": "Find real-time weather reports and forecasts"
      }
    ]
  }
]
```

## Localization {#localization}

You may provide default and localized commands, to be displayed based on the user's locale. To do this, specify a separate object in the `commands` array for each locale. To specify the locale for each object, set the `locale` property to a [supported locale](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales):

```json
"commands": [
  {
    "locale": "default",
    "commands": [...]
  },
  {
    "locale": "zh_CN",
    "commands": [...]
  }
]
```

## Properties {#properties}

| Property | Type | Description |
| --- | --- | --- |
| `locale` | String | Locale of the `commands` array. The corresponding array of commands will be displayed when the user's locale matches the provided locale.<br><br>You must at least specify commands for the default locale, which will be displayed if no provided locale matches the user's locale.<br><br>See the [list of supported locales](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales) |
| `commands` | Array<`command`> | An array of commands to display to users in the provided locale.<br><br>The array should contain a minimum of 1 and a maximum of 100 commands. |

### `command` object

| Property | Type | Description |
| --- | --- | --- |
| `name` | String | The name of the command. Keep it short and easy for users to remember. The command should not begin with a `/` (slash character).<br><br>Minimum of 1 and maximum of 32 characters. |
| `description` | String | Description of the command. Use the description to educate users about what the command does and how to use it.<br><br>Minimum of 1 and maximum of 64 characters. |

## Example API calls

### Example GET request

```curl
curl -X GET "https://graph.facebook.com/v25.0/me/messenger_profile?fields=commands&access_token=<PAGE_ACCESS_TOKEN>"
```

### Example response

```json
{
  "data": [
    {
      "commands": [
        {
          "locale": "default",
          "commands": [
            {
              "name": "flights",
              "description": "Find real-time flights and fares"
            },
            {
              "name": "hotels",
              "description": "Find real-time hotel rooms and rates"
            },
            {
              "name": "currency",
              "description": "Find real-time currency exchange rates"
            },
            {
              "name": "weather",
              "description": "Find real-time weather reports and forecasts"
            }
          ]
        }
      ]
    }
  ]
}
```

### Example POST request

The following POST request could be used to set or update commands.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
    "commands": [
        {
            "locale": "default",
            "commands": [
                {
                    "name": "flights",
                    "description": "Find real-time flights and fares"
                },
                {
                    "name": "hotels",
                    "description": "Find real-time hotel rooms and rates"
                },
                {
                    "name": "currency",
                    "description": "Find real-time currency exchange rates"
                },
                {
                    "name": "weather",
                    "description": "Find real-time weather reports and forecasts"
                }
            ]
        }
    ]
}' "https://graph.facebook.com/v25.0/me/messenger_profile?access_token=<PAGE_ACCESS_TOKEN>"
```

### Example response

```json
{
    "result": "success"
}
```

## Rate Limit

Calls to the Messenger Profile API are limited to 10 API calls per 10 minutes interval. This rate limit is enforced per Page.
# Send a Message



To send messages to a person on Messenger or Instagram, the conversation must be initiated by that person. The Messenger Platform has several different types of messages you can send. Each message type has different policies and guidelines for what types of content and under what conditions they can be sent.

**Note:** If your app users don't have a Facebook Page linked to their Instagram professional account, learn more about building an app with [the Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram/platform/instagram-api).

#### Informing Users About Your Automated Experience

When required by applicable law, automated chat experiences must disclose that a person is interacting with an automated service:

* at the beginning of any conversation or message thread,
* after a significant lapse of time, or
* when a chat moves from human interaction to automated experience.

Automated chat experiences that serve the following groups should pay special attention to this requirement:

* California market or California users
* German market or German users

Disclosures may include but are not limited to: “I’m the [Page Name] bot,”“You are interacting with an automated experience,” “You are talking to a bot,” or “I am an automated chatbot.”

Even where not legally required, we recommend informing users when they’re interacting with an automated chat as best practice, as this helps manage user expectations about their interaction with your messaging experience.

Visit our
[Developer Policies](https://developers.facebook.com/devpolicy/#messengerplatform)
for more information.

## Message components {#send_api_basics}

All Send API requests from your app to send a message must include the following:

* The Page ID for the Facebook Page, or the Facebook Page linked to the Instagram Professional account, sending the message
* The [ID for the person](#recipient_ids) receiving the message
* A Page access token requested from the Page sending the message
* Permission from the person receiving the message
* The [message type](#messaging_types)
* The [message content](#content_types)

For more information about message components, visit the
[Send API Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api).

### Standard messaging window

The **Standard Messaging Window** is the 24 hour time period in which you are allowed to send a message to a person. When a person sends your Page or Instagram Professional account a message or starts a conversation via a web plug-in, your app has up to 24 hours to send a message.

Messages sent within the 24 hour window may contain promotional content.

**User Actions that Open the Standard Messaging Window**

The following user actions open the 24 hour standard messaging window:

* A person sends a message to your Page or Instagram Professional account
* A person clicks a call-to-action button like Get Started within a conversation
* A person clicks on a Click-to-Messenger ad and then sends a message to your Page or Instagram Professional account
* A person sends a message to a Page via a plugin, such as the Send to Messenger or Checkbox plugin
* A person clicks on an m.me link that takes them to an existing conversation between the person and the Page
* A person clicks on an ig.me link that takes them to an existing conversation between the person and the Instagram Professional account
* A person reacts to a message, such as a marketing message
* A person comments on a post on your Page or Instagram Professional account
* A person publishes a visitor post on your Page

People expect a prompt response, so respond as soon as possible within this 24 hour window. People have the option to block or mute a conversation at any time.

### Recipient IDs {#recipient_ids}

Set the ID for a person receiving the message in the `recipient` object parameter. The ID can be one of the following types:

- **Page-scoped ID (PSID)** – An ID assigned to a person the first time the person sends a message to your Page. This unique ID represents interactions between your Page and the person.

- **User Ref** – An ID assigned to a person who used a plugin or postback button to send a message to your Page.

- **Post or Comment ID**: An ID assigned to a person who published a post on your Page or commented on a post. Used to send a Private Reply to the person.

User IDs from [Facebook Login](https://developers.facebook.com/documentation/facebook-login) integrations are app-scoped and will not work with the Messenger platform.

### Messaging types {#messaging_types}

The type of message you are sending is set in the `messaging_type` parameter. This parameter is a more explicit way to ensure your messaging complies with messaging policies and the recipient's preferences.

The following types of messages are supported:

* **Response** – The message you are sending is a response to a received message. The message can contain promotional and non-promotional content and must be sent during the standard messaging window.

* **Updates** – The message you are sending is being sent proactively and is not in response to a received message. The message can contain promotional and non-promotional content and must be sent during the standard messaging window.

* **Tagged Message** – The message you are sending is being sent outside the standard messaging window. This message must include a message tag that matches the allowed use case for the tag and contains non-promotional content.

### Message tags

**Warning:** Effective April 27th, 2026, all API requests containing the Message Tags CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE, and POST_PURCHASE_UPDATE will receive error code 100.

Message Tags allow you to send a message outside the standard messaging window. These messages are personally relevant updates for a person. For example, you may send updates about shipping and delivery, an upcoming reservation or flight, or alerts about a customer's account.  For messaging flows that require an escalation path, the Human Agent tag allows a business representative to manually respond to a person's messages within a 7-day period.

Message Tags may not be used to send promotional content, including but not limited to: deals, offers, coupons, and discounts. Use of Message Tags outside the [approved use cases](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api#parameters) may result in restrictions on the Page or Instagram account's ability to send messages. See the [Messenger Platform and Instagram Messaging API Policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy) for details.

Businesses using Messenger Platform who want to send promotional messages outside the 24 hour standard messaging window should use [Sponsored Messages]( /documentation/business-messaging/messenger-platform/discovery) or [One-Time Notifications](https://developers.facebook.com/docs/messenger-platform/send-messages/one-time-notification).

### Content types {#content_types}

The message you send may contain the following types of content:

* Audio
* Buttons
* Files

* Menus
* GIFs
* Images

* [Stickers](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/sticker-api)
* Templates
* Text
* Videos

## Send a basic text {#sending_text}

To send a basic text message to a person who sent your Page a message, send a `POST` request to the `/<PAGE_ID>/messages` endpoint, with the `recipient` object literal key `id` set to the person's Page-scoped ID (PSID), the `messaging_type` parameter set to `RESPONSE`, and the `message` parameter object `text` set to the message text.

#### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<PSID>"
  },
  "messaging_type": "RESPONSE",
  "message":{
    "text":"Hello, world!"
  }
}' "https://graph.facebook.com/v25.0/{PAGE-ID}/messages?access_token={PAGE-ACCESS-TOKEN}"
```

On success, your app will receive the following JSON response with the recipient's ID and the message ID.

```json
{
  "recipient_id": "PAGE-SCOPED-ID",
  "message_id": "AG5Hz2U..."
}
```

## Send a media attachment {#sending_attachments}

To send a message with media, such as a GIF or image, or a template, you add the content to the API request in a JSON message attachment object.

To send a message with an image to a person who sent your Page a message, send a `POST` request to the `/<PAGE_ID>/messages` endpoint, with the `recipient` object literal key `id` set to the person's Page-scoped ID (PSID), the `messaging_type` parameter set to `RESPONSE`, and the `message` parameter `attachment` object `type` key set to `image` and the `payload` object `url` key set to the URL for the image.

#### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"1254459154682919"
  },
  "message":{
    "attachment":{
      "type":"image",
      "payload":{
        "url":"http://www.messenger-rocks.com/image.jpg",
        "is_reusable":true
      }
    }
  }
}' "https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}"
```


On success, your app will receive the following JSON response with the recipient's ID and the message ID.

```json
{
  "recipient_id": "PAGE-SCOPED-ID",
  "message_id": "AG5Hz2U..."
}
```

Sending audio, video, or a file from a URL will use the same format.

You can also send media from your server or from content you have previously uploaded to a Meta server. Learn more about uploading files using the
[Attachment Upload API.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/attachment-upload-api)

## Send a reply to a message

To send a reply to a specific past message within the chat, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the following:

* `recipient` object literal key `id` set to the person's Page-scoped ID (PSID)
* `messaging_type` set to `RESPONSE`
* your message details in the message parameter object
* `reply_to` object literal key `mid` set to the message id of the specific message in the chat you want to reply to

The message can either be the message your Page or the user sent.

#### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "<PSID>"
  },
  "messaging_type": "RESPONSE",
  "message": {
    "text": "Hello, world!"
  },
  "reply_to": {
    "mid": "<MESSAGE_ID>"
  }
}' "https://graph.facebook.com/<API_VERSION>/<PAGE_ID>/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

On success, your app will receive the following JSON response with the recipient's ID and the message ID.

```json
{
  "recipient_id": "PAGE-SCOPED-ID",
  "message_id": "AG5Hz2U…"
}
```

## Sending messages on Instagram {#instagram_messaging}

You can also use the Send API to send messages to people on Instagram. The API and message format is the same, but the setup and requirements differ depending on whether your Instagram Professional account is linked to a Facebook Page.

### Instagram accounts linked to a Facebook Page

If your Instagram Professional account is linked to a Facebook Page, use the [Instagram Messaging API](https://developers.facebook.com/docs/instagram-messaging). You send messages using the same `/<PAGE_ID>/messages` endpoint as Messenger, using the Instagram-scoped ID (IGSID) as the recipient. Subscribe to the `messages` webhook field to receive incoming Instagram messages alongside Messenger messages.

### Instagram accounts not linked to a Facebook Page

If your Instagram Professional account is not linked to a Facebook Page, use the [Instagram API with Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login) instead. You can send [private replies](https://developers.facebook.com/docs/instagram-platform/private-replies) in response to comments, mentions, or story replies on your account.

## Message delivery and read status {#delivery_status}

To track whether your messages are delivered and read, subscribe to the following webhook fields:

- **`message_deliveries`** — notifies you when a message you sent has been delivered to the recipient. Only available for Messenger conversations.
- **`message_reads`** — notifies you when a person reads a message you sent. Only available for Messenger conversations.
- **`messaging_seen`** — notifies you when a person reads a message you sent. Only available for Instagram Messaging conversations.

For more information, see [webhook event references](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks).

## Error handling {#error_handling}

When a Send API request fails, the response includes an error object with a code, subcode, and message. Common errors include:

| Error Code | Description | Resolution |
|------------|-------------|------------|
| 10 | Permissions error | Verify your app has the `pages_messaging` permission and a valid Page access token. |
| 100 | Invalid parameter | Check that the recipient ID, message format, and required fields are correct. |
| 190 | Access token expired | Generate a new Page access token. |
| 551 | Person is not available | The person may have blocked your Page, deactivated their account, or is otherwise unreachable. |
| 613 | Rate limit exceeded | Reduce the frequency of your API calls. See [rate limits](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview#rate-limiting). |
| 1545041 | Messaging window closed | The 24-hour standard messaging window has expired. Use a [message tag](#message-tags) for eligible follow-ups, or request a [one-time notification](https://developers.facebook.com/docs/messenger-platform/send-messages/one-time-notification). |

For the complete list of error codes, see the [Send API Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api).

## Best practices {#best_practices}

#### Text messages {#text_messages}

* Keep it short. Consider screen size and scrolling behavior; compact messages are easier for people to follow. Try sending a few separate messages instead of one long one.
* Don't use text as a substitute for images, tables, charts, and images. Structured messages or even a webview might suit your needs better.
* Don't write lengthy exchanges. If you need to communicate multiple things, try sending a few separate messages instead of one long one.

#### Attachments {#attachments}

* Pay attention to quality. Use colorful, high-resolution images so they display clearly in the conversation.
* Consider aspect ratio. Review how your image may get cropped when it appears in the message bubble.
* Don't put large amounts of text in your image. Use a text message instead, or combine images and text with a generic template.

## More message types

### Marketing messages

[Marketing Messages](https://developers.facebook.com/docs/messenger-platform/marketing-messages) allows you to ask a person for permission to send multiple, marketing messages after the standard messaging window has ended. If the person accepts this request to receive these notifications, you will be able to send the person automated, recurring promotional messages with information about your upcoming sales or product releases and updates.

### News messaging (under development)

[News Messaging](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy#news_messaging) is only available for registered news publishers that are registered with the Facebook News Page Index (NPI).  News Messaging allows news publishers to send non-promotional, news messages to people who have subscribed to receive these messages.

News messaging is not available for Instagram Messaging API.

### One-time notifications

[One-time Notification](https://developers.facebook.com/docs/messenger-platform/send-messages/one-time-notification) allows you to ask a person for permission to send one follow-up message after the standard messaging window has ended. If the person accepts this request to receive a one time notification, you will be able to send a one message that is time-sensitive and personally relevant, such as an appointment reminder or back in stock alert.

One-Time Notifications are not available for Instagram Messaging API.

### Private replies

[Private Replies](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/private-replies) allows you to send a message to a person when the person publishes a comment on one of your posts or ads, or publishes a visitor post on your Page or Instagram Professional account. The private reply can only be a single message, which will automatically include a link to the post or comment, and must be sent within seven days of the person publishing the post or comment.

### Sponsored messages

[Sponsored Messages](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery) allow you to send promotional  or non-promotional content, after the standard messaging window has expired, to a person who has previously sent a message to your Page or Instagram Professional account. Sponsored Messages appear like normal messages in the conversation but are annotated with the word Sponsored above the message. Sponsored message content must comply with [advertising policies](https://transparency.fb.com/policies/ad-standards).

Sponsored Messages are not available for Instagram Messaging API.

### Utility messages
[Utility Messages](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/utility-messages) allow you to send a pre-approved template message that include orders, account updates, and appointments. These messages are highly personalized with account numbers, order IDs, shipment tracking numbers, appointment date and time and can have call-to-actions that allow the user to cancel an order, reschedule an appointment, and other actions that make it easier to interact with a business.

## Next steps

Learn about the [components you can add to messages in your conversations](https://developers.facebook.com/documentation/business-messaging/messenger-platform/introduction/conversation-components).

## Learn more

Learn more about sending messages using the Messenger Platform.

- [Attachment Upload API Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/attachment-upload-api) – Learn more about uploading and sending media.

- [Send API Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api) – Learn more about all the tags, content, and attachments you can send.

- [Rate Limits](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview#rate-limiting) – Learn about the rate limits for sending messages using the Messenger Platform.

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Conversation Components



Conversations are a lot more than simple text messages when you are building a bot on the Messenger Platform. In addition to text, the Platform allows you to send rich-media, like audio, video, and images, and provides a set of structured messaging options in the form of message templates, quick replies, buttons and more. This is intended to be an overview of the components that are available for you to create your Messenger experience in-conversation.

In addition to these conversation components, the Messenger Platform supports a full webview that allows you to enrich your in-conversation Messenger experience by extending it to the web. For more information on using the webview, see [Webview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webview).

### Available Conversation Components

- [Text Messages](#text_messages)
- [Assets & Attachments](#attachments)
- [Message Templates](#templates)
- [Quick Replies](#quick_replies)
- [Sender Actions](#sender_actions)
- [Welcome Screen](#welcome_screen)
- [Persistent Menu](#persistent_menu)  

## Text Messages {#text_messages}

Simple text is the foundation of any experience on Messenger, and is one of the most important tools at your disposal if you goal is to create a conversational experience. Try processing text messages with the Messenger Platform's [built-in natural language processing (NLP)](https://developers.facebook.com/documentation/business-messaging/messenger-platform/built-in-nlp) feature to handle all kinds of interactions with simple text.

[Sending Text →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages#sending_text)

## Assets & Attachments {#attachments}

In addition to text, the Messenger Platform allows you to send rich media assets as standalone messages or attached to structured [message templates](#templates). Supported asset types included the following:

- Audio
- Video
- Images
- Files

Assets may be sent from a URL or your file system. For assets you intend to send multiple times, you may upload them in advance with the [Attachment Upload API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/attachment-upload-api) or upload them the first time they are sent with the [Send API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/saving-assets#send_api) to eliminate the time and bandwidth overhead of uploading with each send. Saved assets are sent with an `attachment_id` that is assigned when they are uploaded.

[Saving Assets →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/saving-assets)
[Sending Attachments →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages#sending_attachments)

## Message Templates {#templates}

Message templates are structured message types intended to support different use cases, and are useful for presenting information in-conversation that would be difficult to render or sloppy-looking with simple text. Templates also support [buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) that extend their functionality.

The following message templates are available:

- [Generic template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates#generic)
- [Button template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates#button)
- [Receipt template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates#receipt)
- [Airline templates](https://developers.facebook.com/docs/messenger-platform/send-messages/template/airline)
- [Media Template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates#media)

Message templates also support a set of buttons that add functionality, such as opening the webview, sending a postback to your webhook, sharing content, and more.

[Sending Message Templates →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates)
[Using Buttons →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons)

## Quick Replies {#quick_replies}

Quick Replies allow you present a preset set of options to the message recipient, which appear prominently above the composer. When a quick reply is tapped, the set is replaced with a single text message that is sent to your webhook. You may also add an image to a Quick Reply.

[Sending Quick Replies →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/quick-replies)

## Sender Actions {#sender_actions}

An important aspect of creating a Messenger bot is setting expectations. Sender actions are an important tool for accomplishing this that gives you the ability to programmatically control the standard Messenger typing, and read receipt indicators in-conversation. For example, when you begin processing a message, you might set the read receipt indicator so the person interacting with your bot knows their message has been seen, then you might set the typing indicator to show them that a response is in-progress.

[Using Sender Actions →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/sender-actions)

## Welcome Screen {#welcome_screen}

The welcome screen is the first thing people see when they start a new conversation with your Messenger bot, and includes the name, description, profile picture and cover photo from your Facebook Page. You may also set optional [greeting text](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/greeting) for the welcome screen, which can be used to introduce the purpose of your bot.

A conversation with your bot begins when the [get started button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen) is tapped.

[Configuring the Welcome Screen →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen)

## Persistent Menu {#persistent_menu}

The persistent menu is an always-on user interface element that helps people discover and more easily access your bot's functionality throughout the conversation. This menu should contain top-level actions that a person can enact at any point. You may also optionally make the persistent menu the only way to interact with your bot by disabling the composer.

[Setting the Persistent Menu →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/persistent-menu)
# Personas


The Personas API allows you to create and manage personas for your business messaging experience. A persona may be backed by a human agent or a bot. When you introduce a persona into a conversation, the persona's profile picture is shown and all messages sent by the persona are accompanied by an annotation above the message that states the persona name and the business it represents.

## Best practices

- The `name` of a persona is freeform with a maximum of 50 characters. A first name and last name or initial, such as "John Z.", is recommended.
- The Page name is still shown at the top of the conversation when using a persona. It is not necessary to include the company name in the `name` field.
- The persona should not be overly generic.
- The persona should be clearly distinguished from the Page or bot itself.
- The persona should not attempt to deceive the recipient.
- You can create a persona quickly. It is not necessary to sync your entire database of agents in advance.

## Before you start

You will need the following:

- A Page access token requested by someone who can perform the `MESSAGING` task on the Page
- The `pages_messaging` permission
- Your `<PAGE_ID>`
- A profile picture URL for your persona. The API downloads the image and re-uploads it to Meta servers. The image size may not exceed 8 MB.

## Create a persona

To create a persona, send a `POST` request to the `/<PAGE_ID>/personas` endpoint with the `name` and `profile_picture_url` parameters.

### Request parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | String | The display name of the persona. Maximum 50 characters. |
| `profile_picture_url` | String | The URL of the profile picture for the persona. The API downloads the image and re-uploads it to Meta servers. |

### Sample request

```
curl -X POST "https://graph.facebook.com/<LATEST_API_VERSION>/<PAGE_ID>/personas?access_token=<PAGE_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Adam",
    "profile_picture_url": "https://example.com/adam-image.jpg"
  }'
```

### Sample response

```json
{
  "id": "<PERSONA_ID>"
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | String | The unique ID of the persona. |

## Get all personas

To get a list of all personas associated with your Page, send a `GET` request to the `/<PAGE_ID>/personas` endpoint. Results are paginated using cursor-based pagination.

You can use the `fields` parameter to select which fields to return. You can also use the `limit`, `after`, and `before` parameters to paginate large result sets.

### Sample request

```
curl -X GET "https://graph.facebook.com/<LATEST_API_VERSION>/<PAGE_ID>/personas?access_token=<PAGE_ACCESS_TOKEN>"
```

### Sample response

```json
{
  "data": [
    {
      "name": "Adam",
      "profile_picture_url": "https://facebook.com/adam-image.jpg",
      "id": "<PERSONA_A_ID>"
    },
    {
      "name": "David Mark",
      "profile_picture_url": "https://facebook.com/david-image.jpg",
      "id": "<PERSONA_B_ID>"
    }
  ],
  "paging": {
    "cursors": {
      "before": "QVFIUlMtR2ZATQlRtVUZALUlloV1",
      "after": "QVFIUkpnMGx0aTNvUjJNVmJUT0Yw"
    }
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `data` | Array | An array of persona objects. |
| `paging` | Object | Contains `before` and `after` cursors for paginating large result sets. |

## Get a specific persona

To get the details of a specific persona, send a `GET` request to the `/<PERSONA_ID>` endpoint.

### Sample request

```
curl -X GET "https://graph.facebook.com/<LATEST_API_VERSION>/<PERSONA_ID>?access_token=<PAGE_ACCESS_TOKEN>"
```

### Sample response

```json
{
  "name": "Adam",
  "profile_picture_url": "https://facebook.com/adam-image.jpg",
  "id": "<PERSONA_ID>"
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | String | The display name of the persona. |
| `profile_picture_url` | String | The URL of the profile picture for the persona. |
| `id` | String | The unique ID of the persona. |

## Send a message as a persona

To send a message as a persona, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the `persona_id` parameter along with the `recipient` and `message` parameters. If you do not include `persona_id`, the message is sent using the Page's identity.

### Sample request

```
curl -X POST "https://graph.facebook.com/<LATEST_API_VERSION>/<PAGE_ID>/messages?access_token=<PAGE_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": { "id": "<PSID>" },
    "message": { "text": "Hello world!" },
    "persona_id": "<PERSONA_ID>"
  }'
```

## Delete a persona

To delete a persona, send a `DELETE` request to the `/<PERSONA_ID>` endpoint. Deleting a persona is a soft delete — messages previously sent by this persona continue to appear in the conversation history, but the persona can no longer send new messages.

### Sample request

```
curl -X DELETE "https://graph.facebook.com/<LATEST_API_VERSION>/<PERSONA_ID>?access_token=<PAGE_ACCESS_TOKEN>"
```

### Sample response

```json
{
  "success": true
}
```

| Property | Type | Description |
|----------|------|-------------|
| `success` | Boolean | Whether the delete operation succeeded. |

## Learn more

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Sender Actions



This guide explains how to display your actions in a conversation to let message recipients know that you have seen and are processing their message.

## Display a Sender Action {#example}

To display the action for a sender in the conversation, send a `POST` request to the [`/PAGE-ID/messages` endpoint](https://developers.facebook.com/docs/graph-api/reference/page/messages) with the `sender_action` parameter set to `typing_on`.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<PSID>"
  },
  "sender_action":"typing_on"
}' "https://graph.facebook.com/VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS_TOKEN;"
```

## React or unreact to a message

To send a reaction, send a `POST` request to `/PAGE-ID/messages` with  `recipient`  containing the Page-scoped ID (`<PSID>`); `sender_action` set to `react`; `payload` containing the `message_id` set to the message ID to react to; and `reaction` set to any emoji reaction(`<😊/🎉/etc>`) or a valid UTF-8 representation of an emoji.

To edit a sent reaction, repeat this request with the reaction set to the new emoji reaction.

To remove a reaction, repeat this request with `sender_action` set to unreact with the payload containing `message_id` only.

#### Sample Request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
    "recipient": {
      "id": "{PSID}"
    },
    "sender_action": "react",  // Or set to unreact to remove the reaction
    "payload": {
      "message_id": "<MESSAGE_ID>",
      "reaction":"😊/ 🎉/ \ud83d\udc4b" // Omit if removing a reaction
    }
  }' "https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}"
```

On success, your app will receive the following JSON response with the recipient's ID and the message ID.

```json
{ "recipient_id": "PAGE-SCOPED-ID" }
```

### Limitations

* Requests to display sender action should only include the `sender_action` parameter and the `recipient` object. All other Send API properties, such as text and templates, should be sent in a separate request.
* The recipient must be signed in for sender actions to be displayed.

Visit the [Page Messages reference](https://developers.facebook.com/docs/graph-api/reference/page/messages#parameters) for a complete list of sender actions.

### Best Practices

* Send the `mark_seen` indicator when your bot receives a message so that the user does not feel ignored.

* Send the `typing_on` indicator when your bot receives a message it will respond to. This helps create a conversational experience.

* Send `typing_on` and `typing_off` actions in the [separate batch requests](https://developers.facebook.com/docs/graph-api/making-multiple-requests). Batched requests are executed in order very quickly. This quick execution may result in the `typing_on` indicator being displayed for a fraction of a second if both actions are sent in the same batch.

* Do not allow an unnatural amount of time (too long or too short) to pass between `typing_on` and `typing_off` sender actions. Ideally, the user should feel that a real person was typing the message in the elapsed time.

## See Also

- For a complete list of API calls and request properties, see the [Send API Reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api).

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Saving assets


**Warning:** **Attachment IDs expire after 90 days.** After an attachment ID expires, you need to re-upload your media to get a new attachment ID. Attachments in message threads never expire and are visible until a user deletes the message from the thread. If your use case allows, you can [upload and send in one step](#upload-and-send) to avoid this expiration.

To optimize sending assets, you may optionally have the Messenger Platform save an asset when it is sent. Saving an asset is useful if you plan on sending the same attachments repeatedly, since it eliminates the need to upload an asset with each request.

The Messenger Platform offers two APIs that allow you to save assets for later use: the [Send API](#send-api) and the [Attachment Upload API](#attachment-upload-api). Both APIs support saving assets from URL and from your local file system.

## Supported asset types

The Messenger Platform supports saving the following asset types, up to 25 MB in size:

- `image` — 8 MB max for URL uploads
- `audio` — `Content-Type` header must use type `audio` (for example, `audio/mp3`)
- `video` — 75-second fetch timeout for URL uploads
- `file`

## Save with the Send API {#send-api}

The Send API allows you to save an asset that is sent with a message, as an alternative to uploading it in advance with the Attachment Upload API. Send a `POST` request with `payload.is_reusable` set to `true` to the `/<PAGE_ID>/messages` endpoint.

### Save from URL

```json
{
  "recipient": {
    "id": "<PSID>"
  },
  "message": {
    "attachment": {
      "type": "<ASSET_TYPE>",
      "payload": {
        "url": "<ASSET_URL>",
        "is_reusable": true
      }
    }
  }
}
```

### Save from file

Submit your message request as form data, and specify the file location in the `filedata` field:

```
curl  \
  -F 'recipient={"id":"<PSID>"}' \
  -F 'message={"attachment":{"type":"<ASSET_TYPE>", "payload":{"is_reusable":true}}}' \
  -F 'filedata=@/tmp/shirt.png;type=image/png' \
  "https://graph.facebook.com/v25.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```


### Response

Use the returned `attachment_id` to attach the asset to future messages. This ID is private and only the Page that originally sent the attachment can reuse it.

```curl
{
  "recipient_id": "1254444444682919",
  "message_id": "m_AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P",
  "attachment_id": "687799999980546"
}
```


## Save with the Attachment Upload API {#attachment-upload-api}

The Attachment Upload API allows you to upload assets in advance. This is useful if you know you will need to send particular assets repeatedly. Send a `POST` request to the `/<PAGE_ID>/message_attachments` endpoint.

### Save from URL

```
curl --location --request POST 'https://graph.facebook.com/v2.10/me/message_attachments?access_token=<PAGE_ACCESS_TOKEN>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "message":{
    "attachment":{
      "type":"image",
      "payload":{
        "url":"http://www.messenger-rocks.com/image.jpg",
        "is_reusable": true
      }
    }
  }
}'
```


### Save from file

Submit your request as form data, and specify the file location in the `filedata` field:

```
curl  \
  -F 'recipient={"id":"<PSID>"}' \
  -F 'message={"attachment":{"type":"<ASSET_TYPE>", "payload":{"is_reusable":true}}}' \
  -F 'filedata=@/tmp/shirt.png;type=image/png' \
  "https://graph.facebook.com/v25.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```


### Response

```curl
{
  "attachment_id":"1857777774821032"
}
```


## Send a saved asset {#send-saved}

To send a message with a previously uploaded asset (uploaded with `is_reusable` set to `true`), send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the `attachment_id` in the payload:

```
curl -X POST "https://graph.facebook.com/<LATEST_API_VERSION>/<PAGE_ID>/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": {
      "id": "<PSID>"
    },
    "message": {
      "attachment": {
        "type": "image",
        "payload": {
          "attachment_id": "<ATTACHMENT_ID>"
        }
      }
    }
  }' \
  -F "access_token=<PAGE_ACCESS_TOKEN>"
```

## Upload and send in one step {#upload-and-send}

You can upload media and send it in a single API request. This avoids the 90-day attachment ID expiration since the attachment is not saved for reuse.

**Warning:** Do **not** set `is_reusable` to `true` when uploading and sending in one step. Attachments in the user's message thread are always private.

```
curl -X POST "https://graph.facebook.com/<LATEST_API_VERSION>/<PAGE_ID>/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": {
      "id": "<PSID>"
    },
    "message": {
      "attachment": {
        "type": "image",
        "payload": {
          "url": "https://example.com/image.jpg"
        }
      }
    }
  }' \
  -F "access_token=<PAGE_ACCESS_TOKEN>"
```

## Properties

For attachments from a URL, provide the following properties in the body of the request as a JSON object. For attachments from file, send properties as form data.

### `message.attachment` properties

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | The type of the attachment. Must be one of: `image`, `video`, `audio`, `file`. |
| `payload` | Object | Object that describes the attachment. See `payload` properties below. |

### `message.attachment.payload` properties

| Property | Type | Description |
|----------|------|-------------|
| `url` | String | *Optional.* URL of the file to upload. Max file size is 8 MB for images and 25 MB for all other file types (after encoding). Timeout is 75 seconds for videos and 10 seconds for all other file types. |
| `is_reusable` | Boolean | *Optional.* Defaults to `false`. Set to `true` only when you upload and send in separate steps. Do **not** set to `true` if you upload and send in one API call. Attachment IDs expire after 90 days. |
| `attachment_id` | String | *Optional.* The ID of a previously uploaded attachment. Used when sending a saved asset. |

## Error codes

| Error code | Subcode | Description |
|-----------|---------|-------------|
| 100 | 2018074 | Possible invalid ID or you do not own the attachment. |
| 100 | 2018008 | Failed to fetch the file from the URL. Check that the URL is valid, with a valid SSL certificate, valid file size, and that the server is responding fast enough to avoid timeouts. |
| 100 | 2018294 | Video upload timed out or video is corrupted. Videos that cannot be fetched within 75 seconds time out. |
| 100 | 2018047 | Upload attachment failure. A common cause is that the provided media type does not match the type of file provided in the URL. |

## Learn more

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Sticker API


This guide explains how to browse Meta's first-party sticker catalog, search for stickers by keyword, and send stickers through the Messenger Send API.

## Before you start

All Sticker Catalog API endpoints (browse and search) use an **App Access Token** (concatenated `app_id|app_secret`):

```
<APP_ID>|<APP_SECRET>
```

The Send Sticker endpoint uses a **Page Access Token** with `pages_messaging` permission, like all other Send API calls.

## Sticker catalog API

### Browse sticker packs

To get a list of available sticker packs, send a `GET` request to the `/sticker_packs` endpoint.

#### Sample request

```curl
curl -G 'https://graph.facebook.com/<API_VERSION>/sticker_packs' \
  -d 'access_token=<APP_ID>|<APP_SECRET>'
```

With locale for translated names and descriptions:

```curl
curl -G 'https://graph.facebook.com/<API_VERSION>/sticker_packs' \
  -d 'locale=vi_VN' \
  -d 'access_token=<APP_ID>|<APP_SECRET>'
```

##### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `locale` | string | No | [Supported locale](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales) code (for example, `vi_VN`, `ja_JP`, `ko_KR`). Returns translated pack names and descriptions. Default: `en_US` |

#### Sample response

```json
{
  "data": [
    {
      "id": "840909108572865",
      "name": "Catster",
      "description": "Let your inner cat do the talking",
      "preview_image_url": "https://scontent.xx.fbcdn.net/v/t39.1997-6/...",
      "sticker_count": 21
    },
    {
      "id": "1451975965911353",
      "name": "FB Marketplace Thanks Stickers",
      "preview_image_url": "https://scontent.xx.fbcdn.net/v/t39.1997-6/...",
      "sticker_count": 5
    },
    ...
  ]
}
```

### Browse stickers in a pack

To get the individual stickers within a specific pack, send a `GET` request to the `/sticker_packs/<STICKER_PACK_ID>/stickers` endpoint.

#### Sample request

```curl
curl -G 'https://graph.facebook.com/<API_VERSION>/sticker_packs/<STICKER_PACK_ID>/stickers' \
  -d 'access_token=<APP_ID>|<APP_SECRET>'
```

With locale for translated sticker names:

```curl
curl -G 'https://graph.facebook.com/<API_VERSION>/sticker_packs/<STICKER_PACK_ID>/stickers' \
  -d 'locale=ja_JP' \
  -d 'access_token=<APP_ID>|<APP_SECRET>'
```

##### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `locale` | string | No | [Supported locale](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales) code (for example, `vi_VN`, `ja_JP`). Returns translated sticker names. Default: `en_US` |

#### Sample response

```json
{
  "data": [
    {
      "id": "842488328414943",
      "name": "Cat with heart eyes",
      "image_url": "https://scontent.xx.fbcdn.net/v/t39.1997-6/...",
      "width": 240,
      "height": 240,
      "is_animated": false
    },
    {
      "id": "842488331748276",
      "name": "Cat waving",
      "image_url": "https://scontent.xx.fbcdn.net/v/t39.1997-6/...",
      "width": 240,
      "height": 240,
      "is_animated": false
    },
    ...
  ]
}
```

### Search stickers by keyword

To search for stickers across all packs, send a `GET` request to the `/sticker_search` endpoint with a search query.

#### Sample request

```curl
curl -G 'https://graph.facebook.com/<API_VERSION>/sticker_search' \
  -d 'q=love' \
  -d 'access_token=<APP_ID>|<APP_SECRET>'
```

With locale for non-English search:

```curl
curl -G 'https://graph.facebook.com/<API_VERSION>/sticker_search' \
  --data-urlencode 'q=감사' \
  -d 'locale=ko_KR' \
  -d 'access_token=<APP_ID>|<APP_SECRET>'
```

##### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query (minimum 2 characters). For example, `love`, `thank you`, `cat` |
| `locale` | string | No | [Supported locale](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales) code (for example, `vi_VN`, `ko_KR`). Searches in the specified language first; falls back to English if no results found. Default: `en_US` |

> **Important:** If your users search in a non-English language, you must pass the `locale` parameter. Without it, the API defaults to `en_US` and only matches English sticker tags — non-English queries will return empty results.

#### Sample response

```json
{
  "data": [
    {
      "id": "842488328414943",
      "name": "Cat with heart eyes",
      "image_url": "https://scontent.xx.fbcdn.net/v/t39.1997-6/...",
      "width": 240,
      "height": 240,
      "is_animated": false
    }
  ]
}
```

## Send a sticker

To send a sticker in a conversation, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the `sticker_id` in the message body. This endpoint requires a **Page Access Token** with `pages_messaging` permission.

Stickers can only be sent within the standard messaging window, following the same rules as other Send API message types. Only public, free, first-party stickers can be sent — the same set of stickers returned by the Sticker Catalog API (the `/sticker_packs` and `/sticker_search` endpoints).

In addition to catalog stickers, you can send the thumbs-up (like) sticker using sticker ID `369239263222822`. This sticker is not included in the catalog API but is always available for sending.

### Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "<PSID>"
  },
  "message": {
    "sticker_id": 767226160478561
  }
}' "https://graph.facebook.com/<API_VERSION>/<PAGE_ID>/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

On success, the API returns the following JSON response:

```json
{
  "recipient_id": "<PAGE_SCOPED_ID>",
  "message_id": "<MESSAGE_ID>"
}
```

## Sticker in webhooks

When a sticker is sent (by you or the end user), the webhook payload includes a `sticker` attachment type. During the 90-day transition period, sticker messages are also sent as an `image` attachment for backward compatibility.

### Sample webhook payload

```json
{
  "sender": {
    "id": "<PSID>"
  },
  "recipient": {
    "id": "<PAGE_ID>"
  },
  "message": {
    "mid": "<MESSAGE_ID>",
    "attachments": [
      {
        "type": "sticker",
        "payload": {
          "sticker_id": "842488328414943",
          "url": "https://scontent.xx.fbcdn.net/v/t39.1997-6/..."
        }
      },
      {
        "type": "image",
        "payload": {
          "url": "https://scontent.xx.fbcdn.net/v/t39.1997-6/..."
        }
      }
    ]
  }
}
```

After the 90-day transition period, only the `sticker` attachment type will be sent.

## Notes

- Only free, first-party Meta stickers are available (approximately 105 packs). Avatar stickers, GIFs, custom stickers, and charged packs are not supported.
- The search query must be at least 2 characters long.
- Standard Send API rate limits apply.
# Buttons


Most [message templates](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates), as well as the [persistent menu](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/persistent-menu), support buttons that invoke different types of actions. These buttons allow you to offer the message recipient actions they can take in response to the template. Examples include opening the Messenger webview, starting a payment flow, and sending a postback message to your webhook.

For message templates, buttons are defined by objects in the `buttons` array. For the persistent menu, buttons are defined by objects in the `call_to_actions` array.

## Button types

| Button | Type value | Description |
|--------|-----------|-------------|
| [URL button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/url) | `web_url` | Opens a web page in the Messenger webview |
| [Postback button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/postback) | `postback` | Sends a postback event to your webhook |
| [Call button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/call) | `phone_number` | Dials a phone number |
| [Log in button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/login) | `account_link` | Triggers the account linking authentication flow |
| [Log out button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/logout) | `account_unlink` | Unlinks a linked account |
| [Game play button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/game-play) | `game_play` | Launches an Instant Game |

## Best practices

- Use buttons to prompt for follow-up or further interaction with a particular message.
- Start with a verb to help people understand the action they are taking.
- Use URL buttons for tasks that you want completed on your website (for example, purchases, or account linking). Make it clear you are sending people outside of Messenger.
- Send a response after someone taps a postback button. This confirms that you have processed or completed their action (for example, canceling a reservation or answering a question).
- Do not use buttons when their action depends on the current state of the bot, since buttons are permanently available in the thread.
- Do not use more than 1 to 3 words or add punctuation. Keep your text under 20 characters, including spaces.
- Do not rely on URLs for every button. The more interactions you can build within Messenger, the more seamless your experience will be.
- Do not use a single postback button. When there is only one button to choose from, people often think it is a continuation of your message text and do not understand it is an action you want them to take.

## Learn more

- [Quick replies](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/quick-replies) — get message recipient input with inline buttons
- [Message templates](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates) — structured messages that support buttons
- [Persistent menu](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/persistent-menu) — always-available menu with button actions
# URL button


The URL button opens a web page in the [Messenger webview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webview). The URL button allows you to enrich the conversation with a web-based experience, where you have the full development flexibility of the web. For example, you might display a product summary in-conversation, then use the URL button to open the full product page on your website.

## App links

If the site contains [App Links](https://developers.facebook.com/documentation/applinks/metadata-reference), the button launches the specified native app.

[The Facebook Crawler](https://developers.facebook.com/docs/sharing/webmasters/crawler) needs to read the app link meta tags for the redirect to work. If you just implemented the tags in your website, you can request a new scrape with the [Sharing Debugger Tool](https://developers.facebook.com/tools/debug/sharing/). After the crawler has scraped the site, new URL buttons sent should follow the redirect behavior.

## Supported usage

The URL button is supported for use with the following:

- Persistent menu
- Generic template
- List template
- Button template
- Media template

## Messenger Extensions SDK — required domain allowlisting

To display a webpage with the [Messenger Extensions SDK](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webview/extensions) enabled in the Messenger webview you __must__ allowlist the domain, including sub-domain, in the [`whitelisted_domains` property of your bot's Messenger Profile](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/domain-whitelisting). This ensures that only trusted domains have access to user information available via SDK functions.

For more information on allowlisting domains, see the [`whitelisted_domains` reference](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/domain-whitelisting).

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | Type of button. Must be `web_url`. |
| `title` | String | Button title. 20 character limit. |
| `url` | String | The URL opened in a mobile browser when the button is tapped. Must use HTTPS protocol if `messenger_extensions` is `true`. |
| `webview_height_ratio` | String | *Optional.* Height of the webview. Valid values: `compact`, `tall`, `full`. Defaults to `full`. |
| `messenger_extensions` | Boolean | *Optional.* Must be `true` if using Messenger Extensions. |
| `fallback_url` | String | *Optional.* The URL to use on clients that don't support [Messenger Extensions](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webview). If not defined, the client uses the `url` as the fallback. May only be specified if `messenger_extensions` is `true`. |
| `webview_share_button` | String | *Optional.* Set to `hide` to disable the share button in the webview (for sensitive info). This does not affect any shares initiated by you using Extensions. |

## Sample request

```bash
curl -X POST "https://graph.facebook.com/<LATEST_API_VERSION>/<PAGE_ID>/messages?access_token=<PAGE_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": {
      "id": "<PSID>"
    },
    "message": {
      "attachment": {
        "type": "template",
        "payload": {
          "template_type": "button",
          "text": "Try the URL button!",
          "buttons": [
            {
              "type": "web_url",
              "url": "https://www.example.com/",
              "title": "URL Button",
              "webview_height_ratio": "full"
            }
          ]
        }
      }
    }
  }'
```

## Sample response

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```
# Postback button


The postback button sends a [`messaging_postbacks`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_postbacks) event to your webhook with the string set in the `payload` property. This allows you to take an arbitrary action when the button is tapped. For example, you might display a list of products, then send the product ID in the postback to your webhook, where the product ID can be used to query your database and return the product details as a structured message.

## Supported usage

Use the postback button with the following:

- Persistent menu
- Generic template
- List template
- Button template
- Media template

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | Type of button. Must be `postback`. |
| `title` | String | Button title. 20 character limit. |
| `payload` | String | Messenger sends this data to your webhook. 1000 character limit. |

## Sample request

```bash
curl -X POST "https://graph.facebook.com/<LATEST_API_VERSION>/<PAGE_ID>/messages?access_token=<PAGE_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": {
      "id": "<PSID>"
    },
    "message": {
      "attachment": {
        "type": "template",
        "payload": {
          "template_type": "button",
          "text": "Try the postback button!",
          "buttons": [
            {
              "type": "postback",
              "title": "Postback Button",
              "payload": "DEVELOPER_DEFINED_PAYLOAD"
            }
          ]
        }
      }
    }
  }'
```

## Sample response

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```
# Persistent menu


The persistent menu allows you to create a menu of your business's main features — such as hours of operation, store locations, and products — that is always visible in a person's Messenger conversation with your business.

Set the persistent menu via the `persistent_menu` property of the [Messenger Profile API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api). The menu automatically appears in a thread if the person has been away for a certain period of time and returns.

**Warning:** The persistent menu is not supported when Messenger is accessed via the Facebook Mobile Browser (the in-app browser within the Facebook app).

**Warning:** If [commands](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/commands) are set, they take priority over the persistent menu.

## Requirements

For the persistent menu to appear, the following must be true:

- The person must be running Messenger v106 or above on iOS or Android.
- The Facebook Page the Messenger bot is subscribed to must be published.
- The Messenger bot must be set to "public" in the app settings.
- The Messenger bot must have the `pages_messaging` permission.
- The Messenger bot must have a [Get Started button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen#set_postback) set.
- You must have the Administrator role for the Page associated with the bot.

## Supported buttons

The persistent menu uses an array of [buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons). The persistent menu supports the following button types:

- `web_url` — [URL button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/url)
- `postback` — [Postback button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/postback)

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `locale` | String | The locale for this menu configuration. At least one object in the `persistent_menu` array must specify `"locale": "default"`. This is the fallback menu if no object matches the user's locale. See [supported locales](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales). |
| `composer_input_disabled` | Boolean | Disables the Messenger composer field if set to `true`. The bot can only be interacted with via the persistent menu, postbacks, buttons, and webviews. Defaults to `false`. |
| `call_to_actions` | Array | An array of top-level `menu_item` objects for the persistent menu. Maximum of 20 items. Required if `composer_input_disabled` is `true`. |

### `menu_item` properties

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | The type of menu item: `web_url` or `postback`. |
| `title` | String | Title to display on the menu item. 30 character limit. |
| `url` | String | URL to open when the button is tapped. Required if type is `web_url`. |
| `payload` | String | Data sent back to your webhook as a `messaging_postbacks` event. Required if type is `postback`. 1000 character limit. |
| `webview_height_ratio` | String | *Optional.* Height of the webview. Valid values: `compact`, `tall`, `full`. |
| `messenger_extensions` | Boolean | *Optional.* Must be `true` if the item type is `web_url` and the [Messenger Extensions SDK](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webview) will be used in the webview. |
| `fallback_url` | String | *Optional.* URL to open in the webview for clients that do not support the Messenger Extensions SDK. If not defined, the `url` is used as the fallback. May only be specified if `messenger_extensions` is `true`. |
| `webview_share_button` | String | *Optional.* Set to `hide` to disable sharing in the webview (for sensitive info). |

## Set the persistent menu

To set the persistent menu, send a `POST` request to the [Messenger Profile API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api) to set the `persistent_menu` property. Up to 20 buttons are allowed in the `call_to_actions` array.

```http
{
    "persistent_menu": [
        {
            "locale": "default",
            "composer_input_disabled": false,
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
                    "url": "https://www.originalcoastclothing.com/",
                    "webview_height_ratio": "full"
                }
            ]
        }
    ]
}
```


## Disable the composer

Disable the composer to make the persistent menu the only way for a person to interact with your Messenger bot. Disabling the composer is useful if your bot has a very specific purpose or set of options. Set `"composer_input_disabled": true` when you create the persistent menu.

## Localization

You may provide default and localized button text for the persistent menu that is displayed based on a person's locale. Specify a separate object in the `persistent_menu` array for each locale, setting the `locale` property to a [supported locale](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales):

```json
{
  "locale": "default",
  "call_to_actions": [...]
},
{
  "locale": "zh_CN",
  "call_to_actions": [...]
}
```

## User-level menu

You can override the Page-level persistent menu with a user-level setting. This allows your app to dynamically control the buttons on the menu and the visibility of the composer for each user.

To enable or disable the user-level setting, use the `custom_user_settings` endpoint. This endpoint supports POST, GET, and DELETE calls. A `psid` parameter is needed to indicate the user that this override applies to.

The user-level persistent menu updates happen in real time, while Page-level persistent menu updates can take up to 24 hours.

User-level settings are rate limited to 10 calls per user per 10 minutes.

### Set user-level menu

```
curl -X POST "https://graph.facebook.com/<LATEST_API_VERSION>/me/custom_user_settings" \
  -H "Content-Type: application/json" \
  -d '{
    "psid": "<PSID>",
    "persistent_menu": [
      {
        "locale": "default",
        "composer_input_disabled": false,
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
            "url": "https://www.example.com/",
            "webview_height_ratio": "full"
          }
        ]
      }
    ]
  }' \
  -F "access_token=<PAGE_ACCESS_TOKEN>"
```

### Get user-level menu

Retrieves the current user and Page-level settings. If there are no user-level settings, only the Page-level settings are returned.

```
curl -X GET "https://graph.facebook.com/<LATEST_API_VERSION>/me/custom_user_settings?psid=<PSID>&access_token=<PAGE_ACCESS_TOKEN>"
```

### Delete user-level menu

Removes the user-level settings, leaving the Page-level menu if set.

```
curl -X DELETE "https://graph.facebook.com/<LATEST_API_VERSION>/me/custom_user_settings?psid=<PSID>&params=[%22persistent_menu%22]&access_token=<PAGE_ACCESS_TOKEN>"
```

## Rate limits

## Rate Limit {#rate_limit}
Calls to the Messenger Profile API are limited to 10 API calls per 10 minute interval. This rate limit is enforced per Page.

Meta limits user-level menu calls to 10 API calls per user per 10-minute interval and enforces this rate limit per Page.

## Best practices

- Use the menu for entry points into your bot's functionality.
- Be descriptive — your menu lets people know what your bot can do.
- Limit menu items to 5 for the best user experience.
- Do not expect the menu to contain user-specific data. It is the same for everyone who uses your bot, though it can be localized.
- Do not put a "Menu" button in the menu that sends the user a message containing a menu. Put that content directly in the menu.
- Do not put generic actions like "Restart" in the menu.
- Do not use prime menu real estate for secondary info like about, terms of service, or privacy policy.

## Learn more

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.
# Quick replies


Quick replies provide a way to present a set of up to 13 buttons in-conversation that contain a title and optional image, and appear prominently above the composer. You can also use quick replies to request a person's location, email address, and phone number.

When a quick reply is tapped, the buttons are dismissed, and the title of the tapped button is posted to the conversation as a message. A `messages` event is sent to your webhook that contains the button title and an optional payload.

## Send quick replies

To send a quick reply, add the `quick_replies` array to a text message, and include objects that define up to 13 quick reply buttons.

The following quick reply types are supported:

- [Text](#text)
- [Phone number](#phone)
- [Email](#email)

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"{PSID}"
  },
  "messaging_type": "RESPONSE",
  "message":{
    "text": "Pick a color:",
    "quick_replies":[
      {
        "content_type":"text",
        "title":"Red",
        "payload":"{POSTBACK_PAYLOAD}",
        "image_url":"http://example.com/img/red.png"
      },{
        "content_type":"text",
        "title":"Green",
        "payload":"{POSTBACK_PAYLOAD}",
        "image_url":"http://example.com/img/green.png"
      }
    ]
  }
  }' "https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}"
```


## Message properties

| Property | Type | Description |
|----------|------|-------------|
| `text` | String | Non-empty message text to send with the quick replies. `text` or `attachment` must be set. |
| `attachment` | Object | An attachment to send with the quick replies. `text` or `attachment` must be set. |
| `quick_replies` | Array | An array of `quick_reply` objects that describe the quick reply buttons to send. A maximum of 13 quick replies are supported. |

### `quick_reply` object properties

| Property | Type | Description |
|----------|------|-------------|
| `content_type` | String | Must be one of: `text` (sends a text button), `user_phone_number` (sends a button allowing recipient to send the phone number associated with their account), `user_email` (sends a button allowing recipient to send the email associated with their account). |
| `title` | String | Required if `content_type` is `text`. The text to display on the quick reply button. 20 character limit. |
| `payload` | String or Number | Required if `content_type` is `text`. Custom data sent back to you via the `messaging_postbacks` webhook event. 1000 character limit. May be set to an empty string if `image_url` is set. |
| `image_url` | String | *Optional.* URL of image to display on the quick reply button for text quick replies. Image should be a minimum of 24px x 24px. Larger images are automatically cropped and resized. Required if `title` is an empty string. |

## Text quick reply {#text}

Text quick replies may also be sent with an optional image that appears as an icon beside the title. If the `content_type` for a quick reply is specified as `text`, you must specify a non-empty `title`.

### Syntax

```json
{
  "content_type": "text",
  "title": "<BUTTON_TEXT>",
  "image_url": "http://example.com/img/red.png",
  "payload": "<DEVELOPER_DEFINED_PAYLOAD>"
}
```

### Webhook event

When a quick reply is tapped, a text message is sent to your webhook [Message Received Callback](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages).

The `text` property of the event corresponds to the title of the quick reply. The message object also contains a field named `quick_reply` containing the `payload` data on the quick reply.

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
            "id": "1254459154682919"
          },
          "recipient": {
            "id": "682498171943165"
          },
          "timestamp": 1502905976377,
          "message": {
            "quick_reply": {
              "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_GREEN"
            },
            "mid": "m_AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P",
            "text": "Green"
          }
        }
      ]
    }
  ]
}
```


## User phone number quick reply {#phone}

The user phone number quick reply allows you to ask a user for their phone number. When sent, the Messenger Platform automatically pre-fills the displayed quick reply with the phone number from the user's profile information.

If the user's profile does not have a phone number, the quick reply is not shown. You do not receive the phone number until the user taps the quick reply. Choosing the quick reply transmits the information once and does not constitute permission to access the information in the future.

### Syntax

```json
{
  "content_type": "user_phone_number"
}
```

### Webhook event

When the user taps the quick reply, the phone number is passed in the `payload` attribute of the `messages` webhook event.

```json
{
  "object": "page",
  "entry": [
    {
      "id": "<PAGE_ID>",
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "<SENDER_PSID>"
          },
          "recipient": {
            "id": "<PAGE_ID>"
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

## User email quick reply {#email}

The user email quick reply allows you to ask a user for their email. When sent, the Messenger Platform automatically pre-fills the displayed quick reply with the email from the user's profile information.

If the user's profile does not have an email address, the quick reply is not shown. The bot does not receive the email until the user taps the quick reply. Choosing the quick reply transmits the information once and does not constitute permission to access the information in the future.

### Syntax

```json
{
  "content_type": "user_email"
}
```

### Webhook event

When the user taps the quick reply, the email address is passed in the `payload` attribute of the `messages` webhook event.

```json
{
  "object": "page",
  "entry": [
    {
      "id": "<PAGE_ID>",
      "time": 1502905976963,
      "messaging": [
        {
          "sender": {
            "id": "<SENDER_PSID>"
          },
          "recipient": {
            "id": "<PAGE_ID>"
          },
          "timestamp": 1502905976377,
          "message": {
            "quick_reply": {
              "payload": "<EMAIL_ADDRESS>"
            },
            "mid": "<MESSAGE_ID>",
            "text": "<EMAIL_ADDRESS>"
          }
        }
      ]
    }
  ]
}
```

## Best practices

- Use quick replies to prompt for specific next steps.
- Be brief — long quick replies are truncated.
- Do not use for actions you want to be permanent. Quick replies disappear after the next message.

## Learn more

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.

# Send a utility message



This document shows you how to send a utility message.

#### What's a utility message? 

A utility message is a message, created from a template, sent to your customers that contain order or account status updates, and appointment or event reminders, and can be personalized with a customer's name, locale, appointment or event date, and more. A utility message template contains placeholder values such as a person's name, order id, tracking number, and so on, that are filled in at the time the message is sent to the consumer. Your app users can create their own utility message templates or use one of Meta's utility message templates to create these messages.

### How it works

There are a number of flows for your app users to send utility messages:

**Use a Meta template**

1. Search for a template
2. Clone it to the Page's template library
3. Send a message

#### Create and send a Page-owned template

1. Create a template
2. Receive approval (within seconds of creation)
3. Send a message

#### Use an existing Page-owned template

1. Search for a template (already approved)
2. Send a message

**Note:** Facebook Pages are not required to be linked to a business to send utility messages.

## Before You Start

This guide assumes you have set up your webhooks server to receive notifications and subscribed to the `message_template_status_update` field as well as other webhook messaging fields your app user's utility messages need.

You need the following:

* The ID for the Page sending the message
* The Page-scoped ID of the customer receiving the message
* A Page access token from your app user who is sending the message
* Your app user has granted your app the `page_utility_messaging` permission

### Limitations

* Utility messages must not contain marketing materials. Learn more in our [Marketing Messages documentation](https://developers.facebook.com/docs/messenger-platform/marketing-messages).

## Meta utility message templates

Meta has a number of pre-approved templates that your app users can use to send utility templates.

### Step 1. Search for a template

To get a list of Meta utility message templates, send a `GET` request to the `/message_template_library` endpoint. Add additional parameters to refine your search. In the following example we are searching for English templates that include the word "order" in the name or message content.

```html
curl -X GET "https://graph.facebook.com/v25.0/message_template_library?name_or_content=order&language=en?access_token=EAACE..."
```

On success your app receives a JSON response with a list of templates that match the query. The template's `name` value is needed to use the template for your app user's utility messages.

```html
{
  "data": [
    {
      "name": "order_confirmation_1",
      "language": "en",
      "category": "UTILITY",
      "topic": "ORDER_MANAGEMENT",
      "usecase": "DELIVERY_CONFIRMATION",
      "industry": [
        "E_COMMERCE"
      ],
      "body": "{{1}}, your order was successfully delivered!

You can track your package and manage your order below.",
      "body_params": [
        "John"
      ],
      "body_param_types": [
        "TEXT"
      ],
      "buttons": [
        {
          "type": "URL",
          "text": "Manage order",
          "url": "https://www.example.com"
        }
      ],
      "id": "7635027653257090"
    },
    ...                               // List is truncated for brevity
  ]
}
```


### Step 2. Clone the template

To clone a Meta utility message template to a Page's template library, send a `POST` request to the `/<PAGE_ID>/message_templates` endpoint with the following parameters:

* `name` set to the name of the cloned template
* `category` set to `UTILITY`
* `language` set to the language code for this message
* `library_template_name` set to the name of the Meta template being cloned (`order_confirmation_1`)

In the following example, the the cloned template requires the additional `library_template_body_inputs` and  `library_template_button_inputs` parameters set to the components containing the app user's values.

```html
curl -X POST -H "Content-Type: application/json"
     -d '{
           "name": "jaspers_market_order_confirmation_1",
           "category": "UTILITY",
           "language": "en_US",
           "library_template_name”: "order_confirmation_1",
           "library_template_body_inputs": [
             {
                "type": "body",
                "text": "{{1}}, your order was successfully delivered!\n\n You can track your package and manage your order below."
             }
           ],
           "library_template_button_inputs": [
             {
                "type": "URL",
                "text": "Manage your order",
                "url": {
                  "base_url": "https://www.jaspersmarket.com/"
                }
             }
           ]
         }' "https://graph.facebook.com/v25.0/1909458034523498/message_templates?access_token=EAACE..."
```

On success your app receives a JSON response with the template's ID, the approval status, and the template category.

```
{
  "id": "102295129340398",
  "status": "APPROVED",
  "category": "UTILITY"
}
```


### Step 3. Send a message

To send a utility message from a cloned Meta template, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the following parameters:

* `recipient.id` set to the Page-scoped ID for the person your app user is sending the message to
* `messaging_type` set to `UTILITY`
* `template` with the following parameters:
    * `name` set to the name of the specific template being used to create the message
    * `language.code` set to the language code for this message
    * `components` array with the following parameters:
        * `type` set to `body`
        * `parameters.type` set to `text`
        * `parameter.text` set to the input needed for the template

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id":"2348927398743287"
  },
  "template": {
    "name": "jaspers_market_order_confirmation_1",
    "language": { "code": "en" },
    "components": [
      {
        "type": "body",
        "parameters": [
          {
            "type": "body",
            "text": "566701"
          }
        ]
      }
    ]
  }
}' "https://graph.facebook.com/v25.0/1909458034523498/messages?access_token=EAACE..."
```

## Page-owned utility message template

Your app users can create their own template for their utility messages.

### Step 1. Create a Page-owned template

To create a utility message template, send a `POST` request to the `/<PAGE_ID>/message_templates` endpoint with the following required parameters:

* `name` set to the name of the template
* `language` set to the language of the message text
* `category` set to `UTILITY`
* `components` set to an array of message components including an example with message values

### Parameter Formats

Templates support two parameter formats:

* **Named parameters** — Placeholders use descriptive names: `{{customer_name}}`, `{{order_id}}`. Set `parameter_format` to `NAMED` when creating the template. Example values are provided in the `body_text_named_params` and `header_text_named_params` fields using `param_name` and `example` pairs.

* **Positional parameters** (default) — Placeholders use sequential numbers: `{{1}}`, `{{2}}`, `{{3}}`. Example values are provided in the `body_text` and `header_text` fields. This is the default format when `parameter_format` is not specified.

#### Text-Only Templates (Named Parameters)
In the following example, we use named parameters with descriptive placeholder names. The `parameter_format` is set to `NAMED`, and example values are provided using `body_text_named_params` and `header_text_named_params` with `param_name` and `example` pairs.

```html
curl -H 'Content-Type: application/json' \
     -d '{
           "name": "jaspers_market_order_delivery_update_named_us",
           "language": "en",
           "category": "UTILITY",
           "parameter_format": "NAMED",
           "components": [
            {
              "type": "HEADER",
              "format": "TEXT",
              "text":"{{order_type}} Update",
              "example": {
               "header_text_named_params": [
                 {
                   "param_name": "order_type",
                   "example": "Order"
                 }
               ]
              }
             },
             {
               "type": "BODY",
               "text": "Good news! Your order #{{order_id}} is on its way. Thank you for your order, {{customer_name}}!",
               "example": {
                 "body_text_named_params": [
                   {
                     "param_name": "order_id",
                     "example": "566701"
                   },
                   {
                     "param_name": "customer_name",
                     "example": "John"
                   }
                 ]
               }
             }
           ]
         }' "https://graph.facebook.com/v25.0/102290129340398/message_templates?access_token=EAAJB..."
```

#### Text-Only Templates (Positional Parameters)
In the following example, we have message body text and header text. The body component and header component includes example customer information that would be used to customize the message.

```html
curl -H 'Content-Type: application/json' \
     -d '{
           "name": "jaspers_market_order_delivery_update_us",
           "language": "en",
           "category": "UTILITY",
           "components": [
            {
              "type": "HEADER",
              "format": "TEXT",
              "text":"{{1}} Update",
              "example": {
               "header_text":["Order"]
              }
             },
             {
               "type": "BODY",
               "text": "Good news! Your order #{{1}} is on its way. Thank you for your order!",
               "example": {
                 "body_text": [
                   [
                     "566701"
                   ]
                 ]
               }
             }
           ]
         }' "https://graph.facebook.com/v25.0/102290129340398/message_templates?access_token=EAAJB..."
```

#### Text + Image Templates
You can also create templates with images. Images need to be first uploaded using the [Resumable Upload API](https://developers.facebook.com/docs/graph-api/guides/upload) to generate the handle for the image. You can then use the handle and pass it in the Header component while creating the template.

```html
curl -H 'Content-Type: application/json' \
     -d '{
           "name": "jaspers_market_order_delivery_update_named_us",
           "language": "en",
           "category": "UTILITY",
           "parameter_format": "NAMED",
           "components": [
             {
              "type": "HEADER",
              "format": "IMAGE",
              "text":"{{order_type}} Update",
              "example": {
               "header_handle": ["4:dGVzdF9pbWFn......."],
               "header_text_named_params": [
                 {
                   "param_name": "order_type",
                   "example": "Order"
                 }
               ]
              }
             },
             {
               "type": "BODY",
               "text": "Good news! Your order #{{order_id}} is on its way. Thank you for your order, {{customer_name}}!",
               "example": {
                 "body_text_named_params": [
                   {
                     "param_name": "order_id",
                     "example": "566701"
                   },
                   {
                     "param_name": "customer_name",
                     "example": "John"
                   }
                 ]
               }
             }
           ]
         }' "https://graph.facebook.com/v25.0/102290129340398/message_templates?access_token=EAAJB..."
```

On success your app receives a JSON response with the template ID, the review status, and the template category.

```
{
  "id": "104595129340398",
  "status": "APPROVED",
  "category": "UTILITY"
}
```


### Step 2. Send a message {#step-2--send-a-message}

To send a utility message using a template from your app user's template library, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the following required parameters:

* `recipient.id` set to the Page-scoped ID for the person your app user is sending the message to
* `message.template` set to a list of parameters:
* `name` set to the name of the specific template being used to create the message
* `language` set to the language code for this template
* `components` set to an array of component objects with parameters to fill in the template placeholders

#### Sending with Positional Parameters

For templates created with positional parameters (the default), parameters are matched by position. In the following example, `{{1}}` in the header will be replaced with the first header parameter, and `{{1}}` in the body will be replaced with the first body parameter.

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "2348927398743287"
  },
  "message": {
    "template": {
      "name": "jaspers_market_order_delivery_update_us",
      "language": {
        "code": "en"
      },
      "components": [
        {
          "type": "header",
          "parameters": [
            {
              "type": "text",
              "text": "Order"
            }
          ]
        },
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "text": "566701"
            }
          ]
        }
      ]
    }
  }
}' "https://graph.facebook.com/v25.0/1909458034523498/messages?access_token=EAACE..."
```

#### Sending with Named Parameters

For templates created with `parameter_format` set to `NAMED`, include the `parameter_name` field in each parameter to match it to the corresponding placeholder in the template. In the following example, `{{order_type}}` in the header and `{{order_id}}` and `{{customer_name}}` in the body will be replaced with their respective values.

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "2348927398743287"
  },
  "message": {
    "template": {
      "name": "jaspers_market_order_delivery_update_named_us",
      "language": {
        "code": "en"
      },
      "components": [
        {
          "type": "header",
          "parameters": [
            {
              "type": "text",
              "parameter_name": "order_type",
              "text": "Order"
            }
          ]
        },
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "parameter_name": "order_id",
              "text": "566701"
            },
            {
              "type": "text",
              "parameter_name": "customer_name",
              "text": "John"
            }
          ]
        }
      ]
    }
  }
}' "https://graph.facebook.com/v25.0/1909458034523498/messages?access_token=EAACE..."
```

On success your app will receive a JSON response with the recipient ID and message ID.

```json
{
  "recipient_id": "25381719828140932",
  "message_id": "m_zm2fACsz21560tai1om-TvABABVG5smou58Xoe7OB4ekibklqP8d2WdzC-Z8j2LVG1G43QVrtVr-jwVZFg72kg"
}
```


## Use an existing Page's template

### Step 1. Search for a template

To get a list of a Page's utility message templates, send a `GET` request to the `/<PAGE_ID>/message_templates` endpoint.

Add additional parameters to find specific utility message types. In the following example we are searching for templates that include the word "`delivery_confirmation`" in the template name.

```html
curl -X GET "https://graph.facebook.com/v25.0/102290129340398/message_templates?name=delivery_confirmation&access_token=EAAJB..."
```

On success your app receives a JSON response with a list of templates that match your query. You will need the template `name` value to use the template for your app user's utility messages.

```html
{
  "data": [
    {
      "name": "delivery_confirmation_1",
      "language": "en",
      "category": "UTILITY",
      "topic": "ORDER_MANAGEMENT",
      "usecase": "DELIVERY_CONFIRMATION",
      "industry": [
        "E_COMMERCE"
      ],
      "body": "{{1}}, your order was successfully delivered!",
      "body_params": [
        "Mark"
      ],
      "body_param_types": [
        "TEXT"
      ],
      "id": "7635027653257090"
    },
    {
      "name": "delivery_confirmation_2",
    ...
    },
  ]
}
```


### Step 2. Send a message

To send a utility message using a template from your app user's template library, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the following required parameters:

* `recipient.id` set to the Page-scoped ID for the person your app user is sending the message to
* `message.template` set to a list of parameters:
* `name` set to the name of the specific template being used to create the message
* `language` set to the language code for this template
* `components` set to an array of component objects with parameters to fill in the template placeholders

#### Sending with Positional Parameters

For templates created with positional parameters (the default), parameters are matched by position. In the following example, `{{1}}` in the header will be replaced with the first header parameter, and `{{1}}` in the body will be replaced with the first body parameter.

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "2348927398743287"
  },
  "message": {
    "template": {
      "name": "jaspers_market_order_delivery_update_us",
      "language": {
        "code": "en"
      },
      "components": [
        {
          "type": "header",
          "parameters": [
            {
              "type": "text",
              "text": "Order"
            }
          ]
        },
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "text": "566701"
            }
          ]
        }
      ]
    }
  }
}' "https://graph.facebook.com/v25.0/1909458034523498/messages?access_token=EAACE..."
```

#### Sending with Named Parameters

For templates created with `parameter_format` set to `NAMED`, include the `parameter_name` field in each parameter to match it to the corresponding placeholder in the template. In the following example, `{{order_type}}` in the header and `{{order_id}}` and `{{customer_name}}` in the body will be replaced with their respective values.

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "2348927398743287"
  },
  "message": {
    "template": {
      "name": "jaspers_market_order_delivery_update_named_us",
      "language": {
        "code": "en"
      },
      "components": [
        {
          "type": "header",
          "parameters": [
            {
              "type": "text",
              "parameter_name": "order_type",
              "text": "Order"
            }
          ]
        },
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "parameter_name": "order_id",
              "text": "566701"
            },
            {
              "type": "text",
              "parameter_name": "customer_name",
              "text": "John"
            }
          ]
        }
      ]
    }
  }
}' "https://graph.facebook.com/v25.0/1909458034523498/messages?access_token=EAACE..."
```

On success your app will receive a JSON response with the recipient ID and message ID.

```json
{
  "recipient_id": "25381719828140932",
  "message_id": "m_zm2fACsz21560tai1om-TvABABVG5smou58Xoe7OB4ekibklqP8d2WdzC-Z8j2LVG1G43QVrtVr-jwVZFg72kg"
}
```

## Use a Template with Customizable Postback Button

### Step 1. Create a template with a postback button

To create a utility message template, send a `POST` request to the `/<PAGE_ID>/message_templates` endpoint with the following required parameters:

* `name` set to the name of the template
* `language` set to the language of the message text
* `category` set to `UTILITY`
* `components` set to an array of message components including an example with message values

In the following example, we have a customizable message body text and a  `POSTBACK` button with a customizable payload.

#### Using Positional Parameters

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "name": "jaspers_market_order_confirmation_update_us",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Your order is now {{1}}",
      "example": {
        "body_text": [
          [
            "Your order is now confirmed"
          ]
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "POSTBACK",
          "text": "Track Order",
          "payload": "order_id_{{2}}"
        }
      ]
    }
  ]
}' "https://graph.facebook.com/v21.0/1909458034523498/messages?access_token=EAACE..."
```

#### Using Named Parameters

You can also use named parameters for the body text by setting `parameter_format` to `NAMED`. Note that button payloads continue to use positional parameters.

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "name": "jaspers_market_order_confirmation_update_named_us",
  "language": "en",
  "category": "UTILITY",
  "parameter_format": "NAMED",
  "components": [
    {
      "type": "BODY",
      "text": "Your order is now {{order_status}}",
      "example": {
        "body_text_named_params": [
          {
            "param_name": "order_status",
            "example": "confirmed"
          }
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "POSTBACK",
          "text": "Track Order",
          "payload": "order_id_{{number}}"
        }
      ]
    }
  ]
}' "https://graph.facebook.com/v21.0/1909458034523498/messages?access_token=EAACE..."
```

On success your app receives a JSON response with the template ID, the review status, and the template category.

```
{
  "id": "104595129340398",
  "status": "APPROVED",
  "category": "UTILITY"
}
```

### Step 2. Send a message

To send a utility message using a template from your app user's template library, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the following required parameters:

* `recipient.id` set to the Page-scoped ID for the person your app user is sending the message to
* `message.template` set to a list of parameters:
    * `name` set to the name of the specific template being used to create the message
    * `language` set to the language code for this template
    * `components` set to the name of the app user's template library

Add additional parameters to customize the message. In the following example, `{{1}}` and `{{2}}` will be replaced with the recipient's order ID, updating both the body text and the `POSTBACK` button's payload.

**Note:** The example uses positional parameters. If your template was created with `parameter_format` set to `NAMED`, you must include the `parameter_name` field in each body parameter. The button payload remains the same for both positional and named parameter formats. See [Send a message](#step-2--send-a-message) for details.  

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "25381719828140932"
  },
  "messaging_type": "UTILITY",
  "message": {
    "template": {
      "name": "jaspers_market_order_confirmation_update_us",
      "language": {
        "code": "en"
      },
      "components": [
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "text": "confirmed"
            }
          ]
        },
        {
          "type": "buttons",
          "parameters": [
            {
              "type": "POSTBACK",
              "payload": "12345"
            }
          ]
        }
      ]
    }
  }
}' "https://graph.facebook.com/v21.0/1909458034523498/messages?access_token=EAACE..."
```

On success your app will receive a JSON response with the template ID, review status, and template category.

```json
{
  "recipient_id": "25381719828140932",
  "message_id": "m_zm2fACsz21560tai1om-TvABABVG5smou58Xoe7OB4ekibklqP8d2WdzC-Z8j2LVG1G43QVrtVr-jwVZFg72kg"
}
```

## Use a Template with Customizable URL Button

### Step 1. Create a template with a URL button

To create a utility message template, send a `POST` request to the `/<PAGE_ID>/message_templates` endpoint with the following required parameters:

* `name` set to the name of the template
* `language` set to the language of the message text
* `category` set to `UTILITY`
* `components` set to an array of message components including an example with message values

In the following example, we have a customizable message body text and a  `URL` button with a customizable URL.

#### Using Positional Parameters

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "name": "jaspers_market_order_confirmation_update_us",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Your order is now {{1}}",
      "example": {
        "body_text": [
          [
            "Your order is now confirmed"
          ]
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Track Order",
          "url": "http://www.example.com/orders/{{1}}",
          "example": {
            "url_suffix_example": "https://www.example.com/orders/1234"
          }
        }
      ]
    }
  ]
}' "https://graph.facebook.com/v21.0/1909458034523498/messages?access_token=EAACE..."
```

#### Using Named Parameters

You can also use named parameters for the body text by setting `parameter_format` to `NAMED`. Note that URL button suffixes continue to use positional parameters.

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "name": "jaspers_market_order_confirmation_update_named_us",
  "language": "en",
  "category": "UTILITY",
  "parameter_format": "NAMED",
  "components": [
    {
      "type": "BODY",
      "text": "Your order is now {{order_status}}",
      "example": {
        "body_text_named_params": [
          {
            "param_name": "order_status",
            "example": "confirmed"
          }
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Track Order",
          "url": "http://www.example.com/orders/{{url_suffix}}",
          "example": {
            "url_suffix_example": "https://www.example.com/orders/1234"
          }
        }
      ]
    }
  ]
}' "https://graph.facebook.com/v21.0/1909458034523498/messages?access_token=EAACE..."
```

On success your app receives a JSON response with the template ID, the review status, and the template category.

```
{
  "id": "104595129340398",
  "status": "APPROVED",
  "category": "UTILITY"
}
```

### Step 2. Send a message

To send a utility message using a template from your app user's template library, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the following required parameters:

* `recipient.id` set to the Page-scoped ID for the person your app user is sending the message to
* `message.template` set to a list of parameters:
    * `name` set to the name of the specific template being used to create the message
    * `language` set to the language code for this template
    * `components` set to the name of the app user's template library

Add additional parameters to customize the message. In the following example, `{{1}}` in the body text will be replaced with with the word `confirmed` and the `{{1}}` in the URL of the button will be replaced with the order ID.

**Note:** The example uses positional parameters. If your template was created with `parameter_format` set to `NAMED`, you must include the `parameter_name` field in each body parameter. The button URL suffix remains the same for both positional and named parameter formats. See [Send a message](#step-2--send-a-message) for details.

```html
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "25381719828140932"
  },
  "messaging_type": "UTILITY",
  "message": {
    "template": {
      "name": "jaspers_market_order_confirmation_update_us",
      "language": {
        "code": "en"
      },
      "components": [
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "text": "confirmed"
            }
          ]
        },
        {
          "type": "buttons",
          "parameters": [
            {
              "type": "URL",
              "url": "1234"
            }
          ]
        }
      ]
    }
  }
}' "https://graph.facebook.com/v21.0/1909458034523498/messages?access_token=EAACE..."
```

On success your app will receive a JSON response with the template ID, review status, and template category.

```json
{
  "recipient_id": "25381719828140932",
  "message_id": "m_zm2fACsz21560tai1om-TvABABVG5smou58Xoe7OB4ekibklqP8d2WdzC-Z8j2LVG1G43QVrtVr-jwVZFg72kg"
}
```

## Utility Messages in Conversation API

Utility Messages that use only a `BODY` component will be represented in the Conversation API the same as [basic text](https://developers.facebook.com/documentation/business-messaging/messenger-platform/introduction/conversation-components#text_messages) messages whereas messages that use a `HEADER` and `BUTTONS` components will be represented the same as
[generic template messages](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates#generic).

### Example: Utility Message with Only a Body in Conversation API

```html
curl -X GET "https://graph.facebook.com/v21.0/me/messages?access_token=EAACE..."
```

```json
{
  "data": [
    {
      "messages": {
        "data": [
          {
            "message": "Good news! Your order #123123123 is confirmed!",
            "id": "m_-9paUc9QYpm9VbVRgslJlNAcspcsz2P9LWJH6flWihChxY9ujvS623AfYOMWiHeq_fgsSh4GXjGwTPWN9Slm2Q"
          },
  ...
}
```

### Example: Utility Message With Header or Buttons in Conversation API

```html
curl -X GET "https://graph.facebook.com/v21.0/me/messages?access_token=EAACE..."
```

```json
{
  "data": [
    {
      "messages": {
        "data": [
          {
            "attachments": {
              "data": [
                {
                  "generic_template": {
                    "title": "Order is being shipped",
                    "subtitle": "Good news! Your order #123123123 is now shipped. The tracking number is #track123"
                  }
                }
              ]
            },
            "message": "",
            "id": "m_qvfnMpHYUNzLf__jekbCjdAcspcsz2P9LWJH6flWihCIJ-wkOtKKkRzUDwl0nKO-is6mGR_WeP0caoCVKTWfLw"
          },
  ...
}
```

## Common Template Rejection Reasons

Submissions are commonly rejected for the following reasons, so make sure you avoid these mistakes.

### Parameter Formatting

* Variable parameters are missing or have mismatched curly braces. The correct format is {{1}}.
* Variable parameters contain special characters such as a #, $, or %.
* Variable parameters are not sequential. For example, {{1}}, {{2}}, {{4}}, {{5}} are defined but {{3}} does not exist.
* Template contains too many variable parameters relative to the message length. You need to decrease the number of variable parameters or increase the message length.
* The message template cannot start or end with a parameter. In essence, dangling parameters are not allowed. In this case, the template will not be able to be created.

The below table shows various rejection reason codes and their details.

| Rejection Reason Code | Description |
| --- | --- |
| `INCORRECT_PARAMS` | Your template has incorrect parameter formatting. Parameters must use double curly braces (e.g., `{{1}}` for positional parameters). Common issues include:<br><br>* Using single braces (e.g., `{1}`)<br>* Mixing positional and named parameter formats<br>* Invalid positional parameters (e.g., `{{1a}}`, `{{name}}` when using positional format) |
| `PARAMS_TO_WORD_RATIO_EXCEED_LIMIT` | The template contains too many variable parameters relative to the message length |
| `TAG_SHOULD_BE_MARKETING` | Template doesn't qualify for Utility Messages due to presence of marketing related content |

### Content and Policy Violations

* The message template contains content that violates Utility Messages policy: When you offer goods or services for sale, we consider all messages and media related to your goods or services, including any descriptions, prices, fees, taxes and/or any required legal disclosures, to constitute transactions.
* Do not request sensitive identifiers from users. For example, do not ask people to share full length individual payment card numbers, financial account numbers, National Identification numbers, or other sensitive identifiers. This also includes not requesting documents from users that might contain sensitive identifiers. Requesting partial identifiers (ex: last 4 digits of their Social Security number) is OK.
* The content contains potentially abusive or threatening content, such as threatening a customer with legal action or threatening to publicly shame them.

## See Also

To learn more about the concepts and endpoints mentioned in this document, please visit the following guides:

- [Message Template Library API Reference](https://developers.facebook.com/docs/messenger-platform/reference/templates/message-template-library)

# Message Templates



Message templates let you combine buttons, images, lists, and more alongside text in a single message, going beyond what standard text messages support. Use templates for many purposes, such as displaying product information, asking the message recipient to choose from a predetermined set of options, and showing search results.

## Available templates {#available_templates}

The following templates are available for sending structured messages:

| Template | Description | Use case |
|----------|-------------|----------|
| [Button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/button) | Text message with up to three attached buttons. | Offer the recipient predefined response options or actions to take. |
| [Generic](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/generic) | Structured message with a title, subtitle, image, and up to three buttons. Supports a `default_action` URL. | Display product cards, search results, or content previews. |
| [Media](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/media) | Send images, GIFs, or video as a structured message with a button. Videos and GIFs are playable in the conversation. | Share rich media with an optional call-to-action. |
| [Receipt](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/receipt) | Order confirmation with order summary, payment details, and shipping information. | Send purchase confirmations and order receipts. |
| [Product](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/product) | Renders products from your [catalog](https://www.facebook.com/business/help/1275400645914358). Product details (image, title, price) are pulled automatically. | Showcase products from your catalog in a conversation. |
| [Coupon](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/coupon) | Send a coupon or discount offer in a structured format. | Deliver promotional offers or discount codes. |
| [Customer Feedback](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates/customer-feedback-template) | Native feedback survey template for measuring customer experience. Supports rating scales and free-text responses. | Collect customer satisfaction data after a support interaction. |
| [Image Grid](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/image-grid) | Grid of 2 to 6 images in a single message, each with an optional tap action, plus an optional title, subtitle, and up to three buttons. | Showcase product variants, a photo gallery, or a small set of related items. |
| [Utility Messaging](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/utility-messages) | Pre-approved template for order updates, account notifications, and appointment reminders with personalized details and call-to-action buttons. | Send transactional updates such as shipping status, appointment reminders, or account alerts. |
| [Structured Information](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates/structured-information-template) | Collect customer information, such as shipping details, within a conversation. | Gather structured details, for example shipping information, from the recipient. |

## Choosing a template

Use this guide to select the right template for your use case:

- **Presenting options or actions** → [Button template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/button)
- **Displaying a product, article, or content card** → [Generic template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/generic)
- **Sharing an image, GIF, or video** → [Media template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/media)
- **Confirming a purchase or order** → [Receipt template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/receipt)
- **Showcasing catalog products** → [Product template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/product)
- **Sending a promotional offer** → [Coupon template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/coupon)
- **Collecting feedback after an interaction** → [Customer Feedback template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/templates/customer-feedback-template)
- **Showing a gallery or set of related images** → [Image Grid template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/image-grid)
- **Sending transactional updates (orders, appointments, accounts)** → [Utility Messaging template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/utility-messages)

## Send a message template {#sending_a_message_template}

To send a message template, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the recipient's Page-scoped ID, the `messaging_type`, and the message attachment containing the template type and payload with details about the specific template, such as title, images, and buttons.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<PSID>"
  },
  "messaging_type":"RESPONSE",
  "message":{
    "attachment":{
      "type":"template",
      "payload":{
        "template_type":"<TEMPLATE_TYPE>",
        "elements":[
          {
            "title":"<TEMPLATE_TITLE>",
            ...
          }
        ]
      }
    }
  }
}' "https://graph.facebook.com/<API_VERSION>/<PAGE_ID>/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

The body of the request follows a standard format for all template types, with the `message.attachment.payload` property containing the type and content details that are specific to each template type.

## Using buttons {#buttons}

Most message templates allow you to incorporate one or more [buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) as part of the template. These buttons allow you to offer the message recipient actions they can take in response to the template.

The button types you can use vary by template. See the specific template reference documentation for more information.

For more on button types available in the Messenger Platform, see [Buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons).

# Button template


The button template sends a text message with up to three attached buttons. This template is useful for offering the message recipient options to choose from, such as pre-determined responses to a question or actions to take.

For a complete list of available buttons, see [Buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons).

## Request URI

```curl
https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}
```


## Payload properties

| Property | Type | Description |
|----------|------|-------------|
| `template_type` | String | Must be `button`. |
| `text` | String | UTF-8-encoded text of up to 640 characters. Text appears above the buttons. |
| `buttons` | Array | Set of 1-3 [buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) that appear as call-to-actions. |

## Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"{PSID}"
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
          }
        ]
      }
    }
  }
}' "https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}"
```


## Sample response

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```
# Coupon Template



This document describes how to create and send a coupon to a person in a Messenger conversation.

### How It Works

A coupon template message has some preset elements and a number of optional properties. The title for the message recipient is required and gives the recipient details about the coupon. The disclaimer, **Terms may apply.**, is a preset element but can be configured. The **Reveal code** button is a preset element that can not be changed. You can add a second button, with default text **Shop now**, that is configurable with your own text and a URL to redirect a person to your store.

When a person clicks the **Reveal code** button, the coupon code is displayed in the conversation and a webhook notification is sent to your server.

## Before You Start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components for sending and receiving messages and notifications.

You need the following:

* The Page ID for the Facebook Page sending the message
* A Page access token representing the Facebook Page sending the message
* The `pages_show_list` and `pages_messaging` permissions
* Your app subscribed to the `messages` webhook
* The ID for the person receiving the coupon message. Can be one of the following:
    * Page-scoped ID (PSID)  
    * Post or Comment ID
    * Notification Message Token
    * User Ref

## Send a Basic Coupon

In the following example, we are sending a basic coupon message that contains a coupon code.

To send a coupon message, send a `POST` request to the `/PAGE-ID/messages` endpoint with a JSON object with the attachment type set to `template` and payload set with the `template_type` set to `coupon`, `title` set to coupon text, and the `coupon_code` set to the coupon code to send to the person.

In the following code example we have set `title` to "10% off everything" and  `coupon_code` to "10PERCENT".

The subtitle text, **Terms may apply.**, and **Reveal code** button text are the default text for these coupon message properties.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"PSID"
  },
  "message":{
    "attachment": {
      "type": "template",
      "payload": {
          "template_type": "coupon",
          "title":"10% off everything",
          "coupon_code":"10PERCENT",
      },
    }
  }
}' "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS-TOKEN"
```

On success, your app receives the following JSON response with the PSID for the recipient and the ID for the message:

```json
{
  "recipient_id": "PSID",
  "message_id": "MESSAGE-ID"
}
```

## Send a Complex Coupon

In the following example, we are sending a more complex coupon message that contains all the properties you can send in the coupon template payload.

In the following code example we have configured a greeting using the `coupon_pre_message`, `title`, `subtitle`, the disclaimer that applies to this coupon, the second button with my store's URL and "Shop now" text, an image from my store, and additional information to be sent in the webhook notification when a person clicks the **Reveal code** button.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"PSID"
  },
  "message":{
    "attachment": {
      "type": "template",
      "payload": {
          "template_type": "coupon",
          "title":"10% off everything",
          "subtitle":"10% off. Limit 1 per customer. Expires on October 1st, 2022",
          "coupon_code":"10PERCENT",
          "coupon_url":"https://www.myshop.com/",
          "coupon_url_button_title":"Shop now",
          "coupon_pre_message":"Here'\''s a deal just for you!",
          "image_url": "https://www.myshop.com/sale-image.png",
          "payload":"The coupon for 10% off everything that expires 2022-10-1",
      },
    }
  }
}' "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS-TOKEN"
```

On success, your app receives the following JSON response with the PSID for the recipient and the ID for the message:

```json
{
  "recipient_id": "PSID",
  "message_id": "MESSAGE-ID"
}
```

## Webhook Notification

When a person clicks on the coupon message, a `messages` webhook notification is sent to your server. The notification will contain the PSID for the person who clicked the coupon message, the ID for the Page that sent the message, and payload information about the coupon.

```json
{
  "sender": {
    "id": "PSID",
  },
  "recipient": {
    "id": "PAGE-ID",
  },
  "timestamp": UNIX-TIMESTAMP,
  "template": {
    "type" : "coupon",
    "payload" : "ADDITIONAL-INFORMATION",
    "coupon_code":"COUPON-CODE",
  }
}
```

## Reference

| Property | Description |
| --- | --- |
| `recipient` *object* | **Required.** Object containing information about the person receiving the coupon message |
| `id`<br>*string* | The Page-scoped ID (PSID) for the person receiving the coupon message |
| `comment_id`<br>*string* | Send a Private Reply that contains a coupon template to a person who commented on a post on the Facebook Page |
| `notification_message_token`<br>*string* | Send Marketing Messages that contain a coupon template to a person |
| `post_id`<br>*string* | Send a Private Reply that contains a coupon template to a person who published a visitor post on the Facebook Page |
| `user_ref`<br>*string* | Send a Checkbox plugin that contains a coupon template |
| `message`<br>*object* | **Required.** Contains the attachment object |
| `attachment`<br>*object* | **Required.** Contains the type of message and payload. |
| `type`<br>*enum {`template`}* | **Required.** Message type, set to `coupon` |
| `payload`<br>*object* | **Required.** Contains the message coupon details |
| `template_type`<br>*enum {`coupon`}* | **Required.** Set to `coupon` |
| `title`<br>*string* | **Required.** Title to display in the message. 80 character limit. |
| `subtitle`<br>*string* | Subtitle to display in the message. 80 character limit. |
| `coupon_code`<br>*string* | **Required** unless `coupon_url` is set. The coupon code to send to a person. Can not have spaces. |
| `coupon_pre_message`<br>*string* | The message sent before the coupon message |
| `coupon_url`<br>*string* | **Required** unless `coupon_code` is set. The coupon URL that allows a person to use the coupon. |
| `coupon_url_button_title`<br>*string* | The text for the button that allows a person to click to the coupon URL |
| `image_url`<br>*string* | The URL for the image displayed in the coupon message |
| `payload`<br>*string* | Additional information to be included in the webhook notification |
# Customer Feedback Template



**Warning:** This functionality is in development. Meta can change or remove this functionality at any time.

Messenger helps brands build lasting relationships through conversation. Whether you are talking to a loyal customer or someone brand new, Messenger lets businesses help customers with their pre and post purchase inquiries. Every interaction is an opportunity for the businesses to delight the customer. And, businesses now have more robust tools such as Customer Feedback Template to measure the experience they provide to their customers. With Customer Feedback Template businesses can:

1. **Increase response rates** for your customer feedback surveys with Messenger's native customer feedback template.
2. **Aggregate customer satisfaction ratings across channels easily** with built-in Messenger templates such as Customer Satisfaction (CSAT), Net Promoter Score (NPS) and Customer Effort Score (CES) surveys.
3. **Reduce biases and inconsistency** in survey scores with optimized UX.

CSAT
CES
NPS

### Use case details:

**Allowed:**

* Post purchase feedback collection via NPS
* Post customer service conversation feedback collection via CSAT and CES

**Not allowed:**

* User research survey unrelated to a preceding interaction
* Promotional survey, any survey wording or content that are promotional in nature

## Flow Walkthrough {#flow-walkthrough}

A typical flow using the Customer Feedback template is shown above:

1. After a case has been completed the Customer Feedback template is triggered into the thread via the Send API (detailed in sections below). The template will have a title, disclaimer and a button to start the rating flow.
2. Tapping the button will trigger the bottom sheet to pop up which will have the configured scoring components.
3. A customer selects a score and can provide additional text if the business has configured the free-form text input (detailed in sections below). Once the scores are selected the Submit button pops up.
4. Customer completes feedback and taps the Submit button.
5. Feedback is sent to the business via the configured web-hook URL.
6. The bottom sheet collapses and the template in the thread will have the button replaced with Complete. An admin text will show that the feedback has been shared with the business.
7. Note: As long as the Submit button is not tapped, the customer can collapse and come back to give feedback provided the template has not expired (an expiry can be set for the template, detailed in sections below)

Details of the template and its setup is provided in the following sections.

## Score Types {#score-types}
We support the most commonly used scoring standards in the industry which include CSAT, NPS, CES as well as Free Form inputs.

Below are the various scoring options and their nomenclature for our API calls.

```js
Score Type: CSAT
    type: "csat "
    default_title: "How would you rate your experience with <business>?"
    options: "one_to_five", "five_stars" (default if no option set), "five_emojis"
    payload: "1", "2", "3", "4", "5"

Score Type: NPS
    type: "nps"
    default_title: "How likely are you to recommend <business> to a friend?"
    options: "zero_to_ten" (also default if no option set)
    payload: "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"

Score Type: CES
    type: "ces"
    defaut_title: "Overall, how easy was it to solve your problem today?"
    options: "one_to_seven" (also default if no option set)
    payload: "1", "2", "3", "4", "5", "6", "7"
```

**CSAT(Customer Satisfaction Score)** will be able to support views with 1 to 5, 5 stars or 5 emojis, default if none is provided would be **"five_stars"**. You can provide your own custom title for the question, if none is provided, the **default_title** will be chosen. Note: default_titles will be translated and localized to the locale of the user. Custom titles will not be translated, you would have to perform the translation yourselves if needed.

Selecting a score in any of the view formats will translate to a numeric score from 1 to 5 which will be the value that would be sent to your web-hook. That is what the payload fields show above. An example CSAT view using five_stars is shown below.

**NPS(Net Promoter Score)** will be able to support views with numbers from 0 to 10, default if none is provided would be **"zero_to_ten"**.. You can provide your own custom title for the question, if none is provided, the **default_title** will be chosen. Note: default_titles will be translated and localized to the locale of the user. Custom titles will not be translated, you would have to perform the translation yourselves if needed.

Selecting a score will translate to a numeric score from 0 to 10, which will be the value that would be sent to your web-hook. An example NPS view is shown below.

**CES(Customer Effort Score)** will be able to support views with numbers from 1 to 7, default if none is provided would be **"one_to_seven"**. You can provide your own custom title for the question, if none is provided, the **default_title** will be chosen. Note: default_titles will be translated and localized to the locale of the user. Custom titles will not be translated, you would have to perform the translation yourselves if needed.
Selecting a score will translate to a numeric score from 1 to 7, which will be the value that would be sent to your web-hook. An example CES view is shown below.

**Optional Free Form Input Field**: To each of the score types you can also attach an additional free-form input. This input can be optionally set and can be used if you need text feedback in addition to the score a customer selects. Please note, a customer can choose to submit a score without providing text feedback. **Also, the form input has a character limit of 400**. Below is an example for a CSAT score type with five_stars and the additional free-from input.

## Score Labels {#score-labels}
For each of the scoring options you can also set the score labels to clearly define the level of the lowest value and the highest value in the template. The values that you can use are below. Please note, some values are default for certain score options, provided in parentheses below. For e.g. if no score label for CSAT is provided, it will take neg_pos as the default. You could also choose "none" if you would like to not show any labels at all.

```js
"neg_pos" = Negative - Positive (default value for CSAT)
"hard_easy" = Hard - Easy (default value for CES)
"dis_sat" = Very Dissatisfied - Very Satisfied
"unlike_like" = Very Unlikely - Very Likely (default value for NPS)
"poor_great" = Poor - Great
"none" = ""
```

For eg. a CSAT five_stars score option with *neg_pos* set would show the Negative and Positive indicators as below.

## 24 hour restriction

The standard messaging window for sending the template to a user is 24 hours after the user's last message. We encourage you to send the template within the 24 hour window for better customer experience and response rates. We also recognize that sometimes surveys will need to be sent outside this window. For that, you can use the [message-tag](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/send-api#sending): **CUSTOMER_FEEDBACK** while sending the template. This tag allows you to send the template within 7 days after the user's last message.
Please note, the tag can only be used with the customer feedback template. Use in any other form is prohibited and will fail.

## API details: {#api-details}
### Sending a template to the thread: {#sending-template}
With the specific nomenclature out of the way, let us now look at the API that can be used to send the Customer Satisfaction Template to a thread.

A call should be made to the Send API with the following POST structure. Example values filled in:

```
  curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "<PSID>"
  },
  "message": {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "customer_feedback",
        "title": "Rate your experience with Original Coast Clothing.", // Business needs to define.
        "subtitle": "Let Original Coast Clothing know how they are doing by answering two questions", // Business needs to define.
        "button_title": "Rate Experience", // Business needs to define.
        "feedback_screens": [{
          "questions":[{
            "id": "hauydmns8", // Unique id for question that business sets
            "type": "csat",
            "title": "How would you rate your experience with Original Coast Clothing?", // Optional. If business does not define, we show standard text. Standard text based on question type ("csat", "nps", "ces" >>> "text")
            "score_label": "neg_pos", // Optional
            "score_option": "five_stars", // Optional
            "follow_up": // Optional. Inherits the title and id from the previous question on the same page.  Only free-from input is allowed. No other title will show.
            {
              "type": "free_form",
              "placeholder": "Give additional feedback" // Optional
            }
          }]
        }],
        "business_privacy":
        {
            "url": "https://www.example.com"
         },
        "expires_in_days" : 3 // Optional, default 1 day, business defines 1-7 days
      }
    }
  }
}' "https://graph.facebook.com/v7.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

### API Properties: {#api-props}
| Property | Type | Description |
| --- | --- | --- |
| `id` | String | *Required*. The `PSID` of the customer. |
| `attachment.type` | String | *Required*. Must be "template". |
| `template_type` | String | *Required*. Must be "customer_feedback". |
| `title` | String | *Required*. Defines the main title of the template that gets sent to the thread with the button to open the feedback form. **Max 65 chars allowed. No URLs.** |
| `subtitle` | String | *Required*. Defines the sub-title of the template that gets sent to the thread with the button to open the feedback form. **Max 80 chars allowed. No URLs.** |
| `button_title` | String | *Required*. Defines the button title for the button that will open the feedback form. **Max 20 chars allowed. No URLs.** |
| `feedback_screens` | Array<`Objects`> | *Required*. This is an array of objects. Each object represents 1 page. Please note we only support one page and one question per page right now. If multiple pages or multiple questions per page are set, we will throw an error back. |
| `questions` | Array<`question`> | *Required*. Each page may have up to 1 questions. This is an array of objects. Each object represents 1 question. |
| `question.id` | String | *Required*. Alphanumeric. Maximum 80 characters. Must be unique throughout the entire form. You shall use these as the unique identifiers of the questions which would be sent back in the response to help you tie context back to your system. Ids should be alpha numeric and can contain any number of underscores(_) for e.g. banjkkl__2345 is a valid id, abnj-4567 is not a valid id due to the "-". |
| `question.type` | String | *Required*. The type of the question. Currently supported values include: "csat", "nps", "ces", "free_form. Please check Score Types section above for more details. |
| `question.title` | String | *Optional*. You can provide your own custom title for the question, if none is provided, the default_title will be chosen. Please check Score Types section above for more details.  Note: default_titles will be translated and localized to the locale of the user. Custom titles will not be translated, you would have to perform the translation yourselves if needed. **Min 5 chars and Max 85 chars allowed. No URLs.** |
| `question.score_label` | String | *Optional*. Field to define the level labels for low and high values. Please check Score Level Indicators section above for details. Values include 'neg_pos', 'hard_easy', 'dis_sat', 'unlike_like','poor_great' |
| `question.score_option` | String | *Optional*. Field to define the score selector views. For e.g. values include '1_to_5', 'five_stars', 'five_emojis' for csat type. Please check Score Types section above for more details. |
| `question.follow_up` | `Object` | *Optional*. Object to set a free form input. Inherits the title and id from the previous question on the same page.  Only free-from input is allowed. |
| `question.follow_up.type` | String | *Required*. Set value as 'free_form'. |
| `question.follow_up.placeholder` | String | *Optional*. Placeholder to be shown inside the free form text input. Defaults to **"Give additional feedback"**, if none provided. **Max 65 chars allowed. No URLs.** |
| `business_privacy` | `Object` | *Required*. Object to provide your privacy policies in the template. |
| `business_privacy.url` | String | *Required*. The link to your hosted privacy policy. Example, the "privacy policy" link in the screenshots. You only need to provide the URL, and the link text will be automatically generated in the template. |
| `expires_in_days` | Integer | *Optional*.  Set the time for template expiration in minutes. You can set a value between 1 to 7. Unit is days. If no value is set then a default of 1 day would be set. |

### Restrictions: {#restrictions}
Please re-note the following restrictions that apply to the template.

* A template can have:
    * 1 title + 1 scoring component + 1 free-form input box
    * 1 title + 1 scoring component
    * 1 title + 1 free-form input
* A template CANNOT have:
    * More than 1 title
    * More than 1 scoring component

Please check individual field restrictions in the API properties table above.

### Receiving data on submission: {#receiving-data}
After the template is sent in thread, you shall wait and expect the customer to fill in the information and submit it. Your web-hook server will receive a "**messaging_feedback**" event (i.e., an event that contains the submitted data) once the customer submits the feedback. Please ensure you have subscribed to the "**messaging_feedback**" webhook subscription for your app and page in the app dashboard.

Note: The customer will have the time; set in the **expires_in_days** field of the send request (default 1 day, if not set) to fill the template and submit the feedback. The form will auto-expire after the set time, after which the in-thread entry point will no longer be available.

The received feedback event will be as below:

```
  {
  "object": "page",
  "entry": [{
    "time": <timestamp>,
    "messaging": [{
      "sender": {
        "id": "<PSID>"
      },
      "recipient": {
        "id": "<page_id>"
      },
      "messaging_feedback": {
        "feedback_screens": [{
          "screen_id": 0,
          "questions": {
            "hauydmns8": {
              "type": "csat",
              "payload" : "5",
              "follow_up": {
                "type": "free_form",
                "payload" : "I am very satisfied!"
              }
            }
          }
        }]
      }
    }]
  }]
}
```

### Receive Event Properties: {#receive-props}
| Property | Type | Description |
| --- | --- | --- |
| `time` | Integer | The timestamp when the customer submits the feedback. |
| sender `id` | String | The customer `PSID`. |
| recipient `id` | String | The page `ID` of your business page. |
| `messaging_feedback` | `Object` | The standard key of a "messaging_feedback" event. This holds an array of feedback_screens with an array of object of feedback question responses. |
| `messaging_feedback.feedback_screens` | Array<`Objects`> | Holds feedback by the customer. Each object represents a form page of your original request, with customer feedbacks. Each object has a key "screen_id", which is the form page index, and a key "questions", which holds your question ids and customer answers. The objects are present in the same sequence as your original request. |
| `feedback_screens.questions` | `Object` | Holds questions in a form page. Each object has the key as the question id, and the value answered by the customer. |
| `question.<id>` | String | question.id set in the Send API request, as a key to the responses submitted by the customer. |
| `question.<id>.type` | String | Defines the type of the scoring mechanism used. For e.g csat, nps, ces etc |
| `question.<id>.payload` | String | Score value selected by the customer. |
| `question.<id>.follow_up` | `Object` | Object that stores the value of the free form text input if set. |
| `follow_up.type` | String | Will be set to free_form to identify free form responses vs other responses. |
| `follow_up.payload` | String | Free form text feedback provided by the customer. |
# Generic template


The generic template is a simple structured message that includes a title, subtitle, image, and up to three buttons. You may also specify a `default_action` object that sets a URL that is opened in the Messenger webview when the template is tapped.

## Carousel

The Messenger Platform supports sending a horizontally scrollable carousel of generic templates. To create a scrollable carousel, include up to 10 generic templates in the `elements` array of the `payload`.

## Request URI

```curl
https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}
```


## Payload properties

| Property | Type | Description |
|----------|------|-------------|
| `template_type` | String | Must be `generic`. |
| `elements` | Array | An array of `element` objects that describe each item. Maximum of 10 elements. |
| `sharable` | Boolean | *Optional.* Set to `true` to enable the native share button in Messenger for the template message. Defaults to `false`. |

### `element` properties

At least one property must be set in addition to `title`.

| Property | Type | Description |
|----------|------|-------------|
| `title` | String | The title to display in the template. 80 character limit. |
| `subtitle` | String | *Optional.* The subtitle to display in the template. 80 character limit. |
| `image_url` | String | *Optional.* The URL of the image to display in the template. |
| `default_action` | Object | *Optional.* The default action executed when the template is tapped. Accepts the same properties as [URL button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/url), except `title`. |
| `buttons` | Array | *Optional.* An array of [buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) to append to the template. Maximum of 3 buttons per element. |

## Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<PSID>"
  },
  "message":{
    "attachment":{
      "type":"template",
      "payload":{
        "template_type":"generic",
        "elements":[
           {
            "title":"Welcome!",
            "image_url":"https://raw.githubusercontent.com/fbsamples/original-coast-clothing/main/public/styles/male-work.jpg",
            "subtitle":"We have the right hat for everyone.",
            "default_action": {
              "type": "web_url",
              "url": "https://www.originalcoastclothing.com/",
              "webview_height_ratio": "tall"
            },
            "buttons":[
              {
                "type":"web_url",
                "url":"https://www.originalcoastclothing.com/",
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
}' "https://graph.facebook.com/v25.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```


## Sample response

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```


## Best practices

- Use for messages with a consistent information hierarchy (for example, product or article previews, weather forecasts).
- Use the correct aspect ratio for your image. Messenger scales or crops photos in the generic template that are not 1.91:1.
- Do not use if your message does not have structured information or require hierarchy.
- Do not use if you need people to be able to zoom your image to full screen.
- Do not use GIFs in the template if you intend for them to be animated. GIFs are supported but are not animated.

### Carousel best practices

- Use a carousel when there is a priority order to your content — the first item is probably the most interesting.
- Strive for consistency. If one bubble has a photo, include a photo in all of them.
- Minimize the number of generic templates in your carousel. Too many makes it hard for people to remember all the options.
- Do not mix types of content. If you include an article next to a list of products, your experience could cause confusion.
- Do not use a carousel when it is important that people see everything in the list. They may not scroll to the end.
# Image grid template


The image grid template displays a collection of 2 to 6 images arranged in a grid within a single message. Each image can have its own tap action that opens a URL or sends a postback to your webhook, and you can add an optional title, subtitle, and up to three buttons below the grid.

## Request URI

```curl
https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}
```


## Payload properties

| Property | Type | Description |
|----------|------|-------------|
| `template_type` | String | Must be `image_grid`. |
| `elements` | Array | An array containing exactly one `element` object that describes the grid. Maximum of 1 element. |

### `element` properties

| Property | Type | Description |
|----------|------|-------------|
| `images` | Array | An array of `image` objects to display in the grid. Minimum of 2, maximum of 6. |
| `title` | String | *Optional.* The title to display with the grid. 45 character limit. |
| `subtitle` | String | *Optional.* The subtitle to display with the grid. 80 character limit. |
| `buttons` | Array | *Optional.* An array of buttons to append below the grid. Only [URL](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/url) and [postback](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/postback) buttons are supported. Maximum of 3 buttons. |

### `image` properties

| Property | Type | Description |
|----------|------|-------------|
| `url` | String | *Required.* The URL of the image to display. |
| `is_hero_image` | Boolean | *Optional.* Set to `true` to feature this image more prominently in the grid layout. At most one image in the grid can have `is_hero_image` set to `true`; sending more than one fails with an error. Defaults to `false`. |
| `action` | Object | *Optional.* The action executed when this image is tapped. An image can have at most one action. See [`action` properties](#action-properties). |

### `action` properties

An image action opens a URL or sends a postback. Set `type` to `web_url` or `postback`, then include the fields required for that type.

| Property | Type | Description |
|----------|------|-------------|
| `type` | String | The action type. Must be `web_url` or `postback`. |
| `url` | String | The URL to open when the image is tapped. Required when `type` is `web_url`. Not allowed when `type` is `postback`. |
| `payload` | String | The payload sent to your webhook in a [`messaging_postbacks`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_postbacks) event when the image is tapped. Required when `type` is `postback`. Not allowed when `type` is `web_url`. |
| `text` | String | The text shown in the conversation as the recipient's reply when the image is tapped. Required when `type` is `postback`. Not allowed when `type` is `web_url`. |

## Sample request

The following request sends a grid of four images. The first image is featured as the hero image and opens a URL when tapped, the second sends a postback, and the remaining images have no action.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "<PSID>"
  },
  "message": {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "image_grid",
        "elements": [
          {
            "title": "Spring collection",
            "subtitle": "Tap an item to learn more",
            "images": [
              {
                "url": "https://www.example.com/images/jacket.jpg",
                "is_hero_image": true,
                "action": {
                  "type": "web_url",
                  "url": "https://www.example.com/products/jacket"
                }
              },
              {
                "url": "https://www.example.com/images/boots.jpg",
                "action": {
                  "type": "postback",
                  "payload": "PRODUCT_BOOTS",
                  "text": "Tell me about the hiking boots"
                }
              },
              {
                "url": "https://www.example.com/images/hat.jpg"
              },
              {
                "url": "https://www.example.com/images/gloves.jpg"
              }
            ],
            "buttons": [
              {
                "type": "web_url",
                "url": "https://www.example.com/shop",
                "title": "View all"
              }
            ]
          }
        ]
      }
    }
  }
}' "https://graph.facebook.com/<API_VERSION>/<PAGE_ID>/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

## Sample response

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```


## Per-image actions

Each image in the grid can have a single tap `action`:

- **`web_url`** — Opens the specified `url` in the Messenger webview when the image is tapped. See the [URL button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/url) reference for related behavior.
- **`postback`** — Sends the `payload` to your webhook in a [`messaging_postbacks`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_postbacks) event when the image is tapped, and posts `text` into the conversation as the recipient's reply. See the [Postback button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons/postback) reference for related behavior.

Images without an `action` are not tappable.

## Best practices

- Use the image grid template to present a set of related images, such as product variants, gallery photos, or a small catalog, in a single message.
- Provide 2 to 6 images. The grid layout adapts to the number of images you send.
- Use `is_hero_image` to draw attention to your most important image.
- Add a per-image `action` when tapping different images should do different things — for example, each product image opening its own product page (`web_url`), or each image sending a different reply to your webhook so you can respond (`postback`).
- Keep text short. The grid's `title` is limited to 45 characters and its `subtitle` to 80 characters.
# Instant Form Template



Instant Form templates help you generate and qualify leads by asking people to fill out a form without leaving the conversation.

**Warning:** This functionality is in development. Meta can change or remove this functionality at any time.

This guide explains how to send an instant form for a Messenger conversation.

## Before You Start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components for sending and receiving messages and notifications.

You will need:

- An eligible form ID

- [Create a form](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/create)

- [Get the ID for an existing form](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/create#get-a-list-of-eligible-forms-for-messenger)

### Form Eligibility Requirements

For a form to be eligible, it must contain the following elements:

- Questions in the form can only be one of the following types:

* `CUSTOM`
* `EMAIL`

* `FIRST_NAME`
* `FULL_NAME`

* `LAST_NAME`
* `PHONE`

If a form has a `questions.type` that is set to any other value than those listed, the form will be ineligible.

- During form creation, the `block_display_for_non_targeted_viewer` parameter must be set to `false`. This marks the form as Open Sharing.

Visit the
[Marketing API - Lead Ads Forms documentation](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/create)
for more information.

## Step 2. Send

Use the instant form template to send the form to a potential customer.

To send an instant form message, send a `POST` request to the `/`***`page_id`***`/messages` endpoint where ***page_id** is the Page sending the message with the following required parameters:

* a `recipient_id` set to the person's Page-scoped ID
* `message.attachment` object with:
    * `type` set to `template`
    * `payload` object with:
        * `template_type` set to `instant_form`
        * `form_id` set to the ID for your form

#### Example Request
*Formatted for readability. Replace **bold, italics values**, such as **ad_account_id**, with your values.*

```curl
curl -X POST "https://graph.facebook.com/v25.0/YOUR_PAGE_ID/messages" \
     -H "Content-Type: application/json" \
     -d '{
           "access_token":"YOUR_PAGE_ACCESS_TOKEN",
           "recipient": { "id": "PAGE_SCOPED_ID" },
           "message": {
             "attachment": {
               "type": "template",
               "payload": {
                 "template_type": "instant_form",
                 "form_id": "YOUR_INSTANT_FORM_ID",
  }'
```

On success your app receives the following JSON response with the ID for the recipient and the ID for the message.

```json
{
  "recipient_id": "RECIPIENT_ID",
  "message_id": "MESSAGE_ID"
}
```

#### Error Codes

The most common error response your app will receive is `2018382` where in the form ID is incorrect or the form is ineligible.

```json
{
  "error": {
    "message": "(#1) The given \"FORM_ID\" field is incorrect, or the form is not inthread eligible.",
    "type": "OAuthException",
    "code": 1,
    "error_subcode": 2018382,
    "fbtrace_id": "..."
  }
}
```

## Webhook Notifications

When a person has submitted an instant form message, the `messaging_in_thread_lead_form_submit` webhook is triggered and your app will receive a notification with information about the form submission.

### Example Notification

```json
{
  "object": "page",
  "entry": [
    {
      "time": UNIX_TIME_STAMP,
      "id":  PAGE_ID,
      "messaging:": [
        {
          "sender": {
            "id":  SENDER_ID},
"recipient": {
  "id":  RECIPIENT_ID    }
"timestamp":  UNIX_TIME_STAMP,
          "form": {
            "id":  FORM_ID          }
        }
      ]
    }
  ]
}
```
# Media template


The media template allows you to send images, GIFs, and video as a structured message with an optional [button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons). Videos and animated GIFs sent with the media template are playable in the conversation.

The media template can be sent via the Send API and from the Messenger webview with the Messenger Extension SDK's `beginShareFlow()` function.

### Limitations

- **Images and video only** — The media template only supports sending images and video. Audio is not supported.
- **Re-using media from Facebook URLs** — Attachment IDs are not supported for media from Facebook URLs. These files are already cached, and should be attached to the media template with their Facebook URL.
- **Facebook URLs only** — The media template does not allow any external URL, only Facebook URLs. To send an image or video with an external URL, upload it using the [Attachment Upload API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/attachment-upload-api) and get an `attachment_id`.

## Request URI

```curl
https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}
```


## Payload properties

| Property | Type | Description |
|----------|------|-------------|
| `template_type` | String | Must be `media`. |
| `elements` | Array | An array containing 1 `element` object that describes the media in the message. Maximum of 1 element. |
| `sharable` | Boolean | *Optional.* Set to `true` to enable the native share button in Messenger for the template message. Defaults to `false`. |

### `element` properties

| Property | Type | Description |
|----------|------|-------------|
| `media_type` | String | The type of media being sent. `image` or `video` is supported. |
| `attachment_id` | String | The attachment ID of the image or video. Cannot be used if `url` is set. |
| `url` | String | The URL of the image. Cannot be used if `attachment_id` is set. |
| `buttons` | Array | *Optional.* An array of [buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) to append to the template. Maximum of 3 buttons. |

## Send media by attachment ID

To send an image, send a `POST` request to the Send API with the `attachment_id` property, where `attachment_id` is an ID generated from the [Attachment Upload API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/attachment-upload-api). Images and videos are supported.

```
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<PSID>"
  },
  "message":{
    "attachment": {
      "type": "template",
      "payload": {
         "template_type": "media",
         "elements": [
            {
               "media_type": "<image|video>",
               "attachment_id": "<ATTACHMENT_ID>"
            }
         ]
      }
    }
  }
}' "https://graph.facebook.com/v25.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```


## Send media by Facebook URL

To send images and video uploaded to Facebook, send a `POST` request to the `/<PAGE_ID>/messages` endpoint with the Facebook URL in the `url` property of the request.

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<PSID>"
  },
  "message":{
    "attachment": {
      "type": "template",
      "payload": {
         "template_type": "media",
         "elements": [
            {
               "media_type": "<image|video>",
               "url": "<FACEBOOK_URL>"
            }
         ]
      }
    }
  }
}' "https://graph.facebook.com/v25.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```


### Get the Facebook URL

To get the Facebook URL for an image or video:

1. Click the image or video thumbnail to open the full-size view.
2. Copy the URL from your browser's address bar.

Facebook URLs should be in the following base format:

| Media type | Media source | URL format |
|-----------|-------------|------------|
| Video | Facebook Page | `https://business.facebook.com/<PAGE_NAME>/videos/<NUMERIC_ID>` |
| Video | Facebook Account | `https://www.facebook.com/<USERNAME>/videos/<NUMERIC_ID>/` |
| Image | Facebook Page | `https://business.facebook.com/<PAGE_NAME>/photos/<NUMERIC_ID>` |
| Image | Facebook Account | `https://www.facebook.com/photo.php?fbid=<NUMERIC_ID>` |

## Add a button

Optionally, buttons may be attached to the media template. The number and types of supported buttons vary depending on whether you are using the media template with the Messenger Extensions SDK's `beginShareFlow()`, or sending it with the Send API:

- **Send API**: Up to 3 buttons of any type may be attached.
- **`beginShareFlow()`**: Only 1 button of type URL may be attached.

To add a button, add a `buttons` array to the template definition in the body of your request. For more on available buttons, see [Buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons).

## Sample response

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```


## Error codes

| Error code | Description |
|-----------|-------------|
| 2018173 | Failed to generate preview URL |
| 2018175 | Media preview failed |
| 2018182 | Media type not valid |
| 2018183 | Attachment ID is missing |
| 2018184 | Media template Facebook media URL is not supported |
| 2018185 | Non-Facebook URL in URL parameter |
| 2018186 | Unable to get photo or video from Facebook URL |
| 2018187 | Either URL or attachment ID is required |
| 2018188 | External URL is not supported |
# Product Template



**Warning:** Product template is only available on Graph API v8.0+

The product template is a structured message that can be used to render products that have been uploaded to a [catalog](https://www.facebook.com/business/help/1275400645914358). Product details (image, title, price) will automatically be pulled from the product catalog.

### Contents

- [Template Payload](#payload)
- [Sending a Carousel of Product Templates](#carousel)
- [Example Request](#example_request)
- [Example Response](#example_response)

## Template Payload {#payload}

```http
"payload": {
  "template_type":"product",
  "elements":[
     {
        "id":<PRODUCT_ID>
      },
    ]
  }
```

`product_ids` can be obtained via [Catalog API](https://developers.facebook.com/documentation/ads-commerce/catalog) or via [Facebook Commerce Manager](https://www.facebook.com/business/help/2371372636254534?id=533228987210412). Product template only supports `product_ids` owned by the same page.

## Sending a Carousel of Product Templates {#carousel}

The Messenger Platform supports the sending of a horizontally scrollable carousel of product templates.

To create a scrollable carousel, include up to 10 products in the `elements` array of the `payload`.

```http
"payload": {
  "template_type":"product",
  "elements":[
    {
        "id":<PRODUCT_ID_1>
    },
    {
        "id":<PRODUCT_ID_2>
    }
    ...
  ]
}
```

## Example Request {#example_request}

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<PSID>"
  },
  "message":{
    "attachment":{
      "type":"template",
        "payload": {
          "template_type": "product",
          "elements": [
            {
              "id": "<PRODUCT_ID_1>"
            },
            {
              "id": "<PRODUCT_ID_2>"
            }
         ]
      }
    }
  }
}' "https://graph.facebook.com/v8.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```

## Example Response {#example_response}

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```


## Error Codes

| Code | Subcode | Message |
| --- | --- | --- |
| `100` | `2018320  ` | Invalid product id. See [Product Template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/product) |
| `100` | `2018328` | Product template is not supported below version 8. Use api version 8 or higher to use product templates. See [Product Template](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/product) |

For other errors returned by the Send API, see [error code](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)
# Receipt template


The receipt template allows you to send an order confirmation as a structured message. The template may include an order summary, payment details, and shipping information.

## Request URI

```curl
https://graph.facebook.com/v25.0/me/messages?access_token={PAGE_ACCESS_TOKEN}
```


## Payload properties

| Property | Type | Description |
|----------|------|-------------|
| `template_type` | String | Must be `receipt`. |
| `sharable` | Boolean | *Optional.* Set to `true` to enable the native share button in Messenger for the template message. Defaults to `false`. |
| `recipient_name` | String | The recipient's name. |
| `merchant_name` | String | *Optional.* The merchant's name. If present, the `merchant_name` value is shown as logo text. |
| `order_number` | String | The order number. Must be unique. |
| `currency` | String | The currency of the payment. |
| `payment_method` | String | The payment method used. Provide enough information for the end user to identify which payment method and account they used. This can be a custom string, such as "Visa 1234". |
| `timestamp` | String | *Optional.* Timestamp of the order in seconds. |
| `elements` | Array | *Optional.* Array of a maximum of 100 `element` objects that describe items in the order. Sort order of the elements is not guaranteed. |
| `address` | Object | *Optional.* The shipping address of the order. See `address` properties below. |
| `summary` | Object | The payment summary. See `summary` properties below. |
| `adjustments` | Array | *Optional.* An array of `adjustment` objects that describe payment adjustments, such as discounts. |

### `address` properties

| Property | Type | Description |
|----------|------|-------------|
| `street_1` | String | The street address, line 1. |
| `street_2` | String | *Optional.* The street address, line 2. |
| `city` | String | The city name of the address. |
| `postal_code` | String | The postal code of the address. |
| `state` | String | The state abbreviation for U.S. addresses, or the region/province for non-U.S. addresses. |
| `country` | String | The two-letter country abbreviation of the address. |

### `summary` properties

The property values of the `summary` object should be valid, well-formatted decimal numbers, using `.` (dot) as the decimal separator. Most currencies only accept up to 2 decimal places.

| Property | Type | Description |
|----------|------|-------------|
| `subtotal` | Number | *Optional.* The sub-total of the order. |
| `shipping_cost` | Number | *Optional.* The shipping cost of the order. |
| `total_tax` | Number | *Optional.* The tax of the order. |
| `total_cost` | Number | The total cost of the order, including sub-total, shipping, and tax. |

### `adjustment` properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | String | Required if the `adjustments` array is set. Name of the adjustment. |
| `amount` | Number | Required if the `adjustments` array is set. The amount of the adjustment. |

### `element` properties

| Property | Type | Description |
|----------|------|-------------|
| `title` | String | The name to display for the item. |
| `subtitle` | String | *Optional.* The subtitle for the item, usually a brief item description. |
| `quantity` | Number | *Optional.* The quantity of the item purchased. |
| `price` | Number | The price of the item. For free items, `0` is allowed. |
| `currency` | String | *Optional.* The currency of the item price. |
| `image_url` | String | *Optional.* The URL of an image to be displayed with the item. |

## Sample request

```curl
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient":{
    "id":"<PSID>"
  },
  "message":{
    "attachment":{
      "type":"template",
      "payload":{
        "template_type":"receipt",
        "recipient_name":"Stephane Crozatier",
        "order_number":"12345678902",
        "currency":"USD",
        "payment_method":"Visa 2345",
        "order_url":"http://originalcoastclothing.com/order?order_id=123456",
        "timestamp":"1428444852",
        "address":{
          "street_1":"1 Hacker Way",
          "street_2":"",
          "city":"Menlo Park",
          "postal_code":"94025",
          "state":"CA",
          "country":"US"
        },
        "summary":{
          "subtotal":75.00,
          "shipping_cost":4.95,
          "total_tax":6.19,
          "total_cost":56.14
        },
        "adjustments":[
          {
            "name":"New Customer Discount",
            "amount":20
          },
          {
            "name":"$10 Off Coupon",
            "amount":10
          }
        ],
        "elements":[
          {
            "title":"Classic White T-Shirt",
            "subtitle":"100% Soft and Luxurious Cotton",
            "quantity":2,
            "price":50,
            "currency":"USD",
            "image_url":"http://originalcoastclothing.com/img/whiteshirt.png"
          },
          {
            "title":"Classic Gray T-Shirt",
            "subtitle":"100% Soft and Luxurious Cotton",
            "quantity":1,
            "price":25,
            "currency":"USD",
            "image_url":"http://originalcoastclothing.com/img/grayshirt.png"
          }
        ]
      }
    }
  }
}' "https://graph.facebook.com/v25.0/me/messages?access_token=<PAGE_ACCESS_TOKEN>"
```


## Sample response

```js
{
  "recipient_id": "1254477777772919",
  "message_id": "AG5Hz2Uq7tuwNEhXfYYKj8mJEM_QPpz5jdCK48PnKAjSdjfipqxqMvK8ma6AC8fplwlqLP_5cgXIbu7I3rBN0P"
}
```


## Best practices

- Continue to keep people informed. After the receipt is delivered, send timely updates that contain shipping and delivery confirmation.
- Do not use the receipt template to communicate info unrelated to purchases. It should only be used to confirm a previous transaction.
# Structured Information Template



The Structured Information Template from Messenger Platform allows you to get customer information for shipping purposes within an existing conversation. This document shows you how to use this template.

## Overview

The Structured Information template allows you to send a customer a message that contains a form that gathers the customer's shipping information. You can select the fields you need, make fields required or optional, and receive webhooks with this information when the customer submits the form.

## Before You Start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components for sending and receiving messages and notifications.

You will need:

* The ID for the business' Facebook Page
* The Page-scoped ID for the customer
* A Page access token
* A subscription to the `messaging_customer_information` webhook

## Send the Template

To send the template to a customer, send a `POST` request to the `/PAGE-ID/messages` endpoint with the `recipient.id` set to the customer's Page-scoped ID. In the `message` `attachment.payload` property set `template_type` to `customer_information`, `countries` to a list of countries your business is allowed to collect address information, `business_privacy` to the URL for the business' privacy policy, and `expires_in_days` to up to 7 days.

```json
curl -X POST -H "Content-Type: application/json" -d '{
  "recipient": {
    "id": "CUSTOMER-PAGE-SCOPED-ID"
  },
  "message": {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "customer_information",
        "countries": [
          "US"
        ],
        "business_privacy": {
          "url": "PRIVACY-POLICY-URL"
        },
        "expires_in_days": 1
      }
    }
  }
}' "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/messages?access_token=PAGE-ACCESS-TOKEN"
```

Note: The `countries` property defaults to all available countries if not included in your API call. The `expires_in_days` property defaults to `1` if not included in your API call.

## Attachment Payload Reference

The following table contains the properties for the template.

| Property | Description |
| --- | --- |
| `address_overrides`<br>*array* | Allows you to specify whether an address form field is required and to set the field label in the **Confirm address** form.  Maximum length of 85 characters for all customer field inputs except postal code with a maximum length of 10 characters.<br><br>Possible keys:<br><br>* `country` – Value is the country the override applies to<br>* `overrides` – Value is an array of overrides to apply<br>    *    Possible `overrides` keys include:<br><br>* `address_line_1`<br>* `address_line_2`<br>* `administrative_area`<br>* `locality`<br><br>* `postal_code`<br>* `subadministrative_area`<br>* `sublocality`<br><br>Each `overrides` key has two key-value pairs:<br><br>* `label` – The label for the field that is displayed in the form<br>* `required` – `true` to signal this field is required; `false` to signal this field is not required<br><br>See the [table below for specific country field information](#address-components-by-country). |
| `business_privacy`*object* | **Required**. An object with key `url` and value set to the URL of the business' privacy privacy policies |
| `contact_overrides`*array* | Allows you to specify whether a field is required, `true`, or not, `false`, and to set the field label in the **Confirm address** form. Fields are pre-filled with the customer's name and phone number.<br><br>\| Form fields \| Field Label Values \|<br>\| --- \| --- \|<br>\| `name` \|  \|<br>\| `phone` \| `PHONE` \| |
| `countries`*array* | A comma separated list of<br>[two letter codes for countries](https://www.iban.com/country-codes)<br>where your business is allowed to collect customer shipping information. Defaults to all countries your business is allowed to collect shipping information.<br> |
| `expires_in_days`*int* | The number of days before the request for shipping information will expire. Values can be from 1 to 7. Defaults to `1`. |
| `template_type`*string* | **Required**. Value must be `customer_information` |
| `purpose`*enum { `SHIPPING`}* | Sets the template title, subtitle, and button text. Defaults to `SHIPPING`. |

## Meta Webhooks Notification

You will receive the following notification when a customer submits the form and your app is subscribed to the `messaging_customer_information` webhook.

```json
{
  "object": "page",
  "entry": [
    {
      "time": TIMESTAMP,
      "id": PAGE-ID",
      "messaging": [
        {
          "sender": {
            "id": "CUSTOMER-PAGE-SCOPED-ID"
          },
          "recipient": {
            "id": "PAGE-ID"
          },
          "timestamp": "TIMESTAMP",
          "messaging_customer_information": {
            "screens": [
              {
                "screen_id": "Add address",
                "responses": [
                  {
                    "key": "country",
                    "value": "CUSTOMER-COUNTRY"
                  },
                  {
                    "key": "locality",
                    "value": "CUSTOMER-CITY-VILLAGE"
                  },
                  {
                    "key": "administrative_area",
                    "value": "CUSTOMER-STATE-PROVINCE"
                  },
                  {
                    "key": "phone",
                    "value": "CUSTOMER-PHONE"
                  },
                  {
                    "key": "name",
                    "value": "CUSTOMER-NAME"
                  },
                  {
                    "key": "address_line_1",
                    "value": "CUSTOMER-STREET-ADDRESS"
                  },
                  {
                    "key": "postal_code",
                    "value": "CUSTOMER-POSTAL-CODE"
                  }
                ]
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Address Components by Country

Different countries have different input forms and required fields. The following tables list the address properties for a specific country's address intake form, labels for each form field, and, if no address override objects are set, the default required fields.

All input values are a string up to 85 characters in length unless otherwise stated.

### Brazil

| Overide Property | `label` | `required` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `STATE` | `false` | State |
| `locality` | `CITY` | `true` | City |
| `postal_code` | `POSTAL_CODE` | `false` | Postal Code   – *Input is 4 to 10 characters* |
| `sublocality` | `VILLAGE_NEIGHBORHOOD_QUARTER` | `false` | Village/Neighborhood/Quarter |

### Canada

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `PROVINCE` | `true` | Province |
| `locality` | `CITY_MUNICIPALITY` | `false` | City/Municipality |
| `postal_code` | `POSTAL_CODE` | `true` | Postal Code – *Input is 7 numbers* |

### France

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `TOWN` | `true` | Town |
| `locality` | `LOCALITY` | `false` | Locality |
| `postal_code` | `POSTAL_CODE` | `true` | Postal Code – *Input is 5 numbers* |
| `subadministrative_area` | `CODEX_DELIVERY_OFFICE` | `false` | Codex delivery office |

### India

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `STATE` | `true` | State |
| `locality` | `CITY_VILLAGE` | `true` | City/Village |
| `postal_code` | `PIN_CODE` | `true` | PIN code – *Input is 6 numbers* |
| `subadministrative_area` | `DISTRICT_AND_OR_TALUK` | `false` | District and/or Taluk |
| `sublocality` | `LOCALITY` | `false` | Locality |

### Indonesia

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `PROVINCE` | `false` | Province |
| `locality` | `VILLAGE_DESA_OR_KELURAHAN` | `true` | Village (Desa or Kelurahan) |
| `postal_code` | `POSTAL_CODE` | `true` | Postal code – *Input is 5 numbers* |
| `subadministrative_area` | `CITY_OR_REGENCY` | `true` | City or Regency |
| `sublocality` | `SUBDISTRICT_KECAMATAN` | `true` | Subdistrict (Kecamatan) |

### Mexico

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `PROVINCE_CITY` | `false` | Province/City |
| `locality` | `VILLAGE_NEIGHBORHOOD_QUARTER` | `false` | Village/Neighborhood/Quarter |
| `postal_code` | `CODIGO_POSTAL` | `true` | Código postal – *Input is 5 numbers* |
| `subadministrative_area` | `CITY` | `true` | City |

### Phillippines

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `PROVINCE` | `true` | Province |
| `locality` | `BARAGGAY_DISTRICT_VILLAGE` | `false` | Barangay/District/Village |
| `postal_code` | `ZIP` | `false` | Zip  – *Input is 5 numbers or 5 numbers, a hypen, and 4 numbers* |
| `subadministrative_area` | `CITY_MUNICIPALITY` | `true` | City/Municipality |

### Singapore

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `TOWN` | `true` | Town |
| `postal_code` | `POSTCODE` | `false` | Postcode – *Input is 6 numbers* |

### Thailand

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `PROVINCE` | `true` | Province |
| `locality` | `VILLAGE_AND_DISTRICT_AMPHOE_KHET` | `true` | Village and District (Amphoe/Khet) |
| `postal_code` | `POSTAL_CODE` | `false` | Postal Code – *Input is 1 to 10 characters* |
| `sublocality` | `SUBDISTRICT_TAMBON_KHWAENG` | `false` | Subdistrict (Tambon/Khwaeng) |

### United Kingdom

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `COUNTY` | `false` | County |
| `locality` | `LOCALITY` | `false` | Locality |
| `postal_code` | `POST_CODE` | `true` | Post code – *Input is up to 8 characters* |
| `subadministrative_area` | `POSTAL_TOWN` | `true` | Postal Town |

### USA

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `true` | Address Line 1 |
| `address_line_2` | `ADDRESS_LINE_2` | `false` | Address Line 2 |
| `administrative_area` | `STATE` | `true` | State *– Input is selected from a dropdown menu* |
| `locality` | `CITY` | `true` | City |
| `postal_code` | `ZIP` | `false` | Zip *– Input is 5 numbers or 5 numbers, a hypen, and 4 numbers* |

### Vietnam

| Overide Property | `label` | `required<br>` | Form Label |
| --- | --- | --- | --- |
| `address_line_1` | `ADDRESS_LINE_1` | `false` | Address Line 1 |
| `administrative_area` | `PROVINCE_CITY` | `true` | Province/City |
| `locality` | `LOCALITY_COMMUNE_PRECINCT ` | `true` | Locality/commune/precinct |
| `subadministrative_area` | `DISTRICT_AND_OR_TOWN` | `true` | District and/or Town |

# Conversations API for Messenger Platform



This document explains how to get information about your Messenger and Instagram Messaging conversations. You can get:

- A list of conversations for your Facebook Page or your Instagram Professional account
- A list of messages within each conversation
- Details about each message including when the message was sent and from who

## Before You Start

This tutorial assumes you have read the [Messenger Platform Overview](docs/messenger-platform/overview) and the [Instagram Messaging Overview](https://developers.facebook.com/docs/messenger-platform/instagram/overview) and implemented the needed components.

You will need:

* The ID for your Facebook Page for your business or the Facebook Page that is linked to your Instagram Professional account
* A Page access token requested from a person who can perform the `MESSAGING` or `MODERATE` task on the Page
* Advanced Access is required to access conversations between your business and people who do not have a role on your messaging app, your Instagram Professional account, your Facebook Page, or your business

For Messenger conversations between people and your Page, your app will need:

* Page access token requested by a person who can perform the [`MESSAGING` or `MODERATE` task](https://developers.facebook.com/docs/pages/overview#tasks) on the Page
* The [`pages_manage_metadata`, `pages_read_engagement`, and `pages_messaging` permissions](https://developers.facebook.com/docs/pages/overview#permissions)

For Instagram Messaging conversations between people and your Instagram Professional account, your app will need:

* A Page access token requested by a person who can perform the [`MESSAGING` task](https://developers.facebook.com/docs/pages/overview#tasks) on the Page linked to your Instagram Business account
* The [`instagram_basic`, `instagram_manage_messages`, and `pages_manage_metadata` permissions](https://developers.facebook.com/docs/pages/overview#permissions)
* Your app must be owned by a verified business

### Limitations

* Only the image or video URL for a share will be included in the data returned in a call to the API or in the webhooks notification.
* If your accounts are linked using private keys, such as an email or phone number, you will not be able to retrieve conversations between these accounts. Only conversations between one Facebook User and one Instagram account will be available. This issue will be resolved when your app has been approved for Advanced Access. If you have multiple accounts linked in the Account Center on the Instagram app, you will be able to retrieve conversations between all linked accounts.
* Conversations that are within the Requests folder that have not been active for 30 days will not be returned in API calls.

You can leverage this API to do inbox syncing on past conversations when an Instagram business account is newly connected to your app.

## Get a List of Conversations {#conversation-list}

To get a list of conversations, send a `GET` request to the `/PAGE-ID/conversations` endpoint and include the `platform` parameter set to `instagram` or `messenger`.

#### Sample Request

*Formatted for readability*

```curl
curl -i -X GET "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/conversations
    ?platform=PLATFORM
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, your app will receive a JSON object with a list of IDs for the conversations between you and a person and the most recent time a message was sent.

```json
{
  "data":
    {
      "id": "CONVERSATION-ID-1",
      "updated_time": "UNIX-TIMESTAMP"
    },
    {
      "id": "CONVERSATION-ID-2",
      "updated_time": "UNIX-TIMESTAMP"
    }
    ...
  ]
}
```

### Find a Conversation with a Specific User

To get a conversation between your Instagram Professional account or Facebook Page and a specific person, send a `GET` request to the `/PAGE-ID/conversations` endpoint with `platform` parameter and the `user_id` parameters set to the Instagram-scoped ID or Page-scoped ID for the person.

#### Sample Request

*Formatted for readability*

```curl
curl -i -X GET "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/conversations
    ?platform=PLATFORM
    &user_id=INSTAGRAM-OR-PAGE-SCOPED-ID
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, your app will receive the ID for the conversation.

```
{
  "data": [
      {
        "id": "CONVERSATION-ID"
      },
  ]
}
```

## Get a List of Messages in a Conversation

To get a list of messages in a conversations, send a `GET` request to the `/CONVERSATION-ID` endpoint and include the `messages` field.

```curl
curl -i -X GET "https://graph.facebook.com/LATEST-API-VERSION/CONVERSATION-ID
    ?fields=messages
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, your app will receive a list of message IDs and the time each message was created.

```
{
  "messages": {
    "data": [
      {
        "id": "Message ID-1",
        "created_time": "UNIX-TIMESTAMP-MOST-RECENT-MESSAGE"
      },
      {
        "id": "Message ID-2",
        "created_time": "UNIX-TIMESTAMP"
      },
      {
        "id": "Message ID-3",
        "created_time": "UNIX-TIMESTAMP"
      },
...
    ]
  },
  "id": "Conversation ID",
}
```

### Get Information about a Message

To get information about a message, such as the sender, receiver, and message content, send a `GET` request to the `/MESSAGE-ID` endpoint with the fields you are interested.

The `reply_to` field is present only when a message is a reply to another message in the thread; the `is_self_reply` flag indicates if the reply is to the sender's own message.

Default fields are `id` and `created_time`.

**Note:** Queries to the `/CONVERSATION-ID` endpoint will return all message IDs in a conversation. However, you can only get details about the 20 most recent messages in the conversation. If you query a message that is older than the last 20, you will see [an error that the message has been deleted.](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)

```curl
curl -i -X GET "https://graph.facebook.com/LATEST-API-VERSION/MESSAGE-ID
    ?fields=id,created_time,from,to,message,reply_to
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, your app will receive the following JSON response. In this example a customer sent a plain text message to your Instagram Professional account.

```json
{
  "id": "aWdGGiblWZ...",
  "created_time": "2022-07-12T19:11:07+0000",
  "to": {
    "data": [
      {
        "username": "INSTAGRAM-PROFESSIONAL-ACCOUNT-USERNAME",
        "id": "INSTAGRAM-PROFESSIONAL-ACCOUNT-ID"
      }
    ]
  },
  "from": {
    "username": "INSTAGRAM-USERNAME",
    "id": "INSTAGRAM-SCOPED-ID"
  },
  "message": "Hi Kitty!",
  "reply_to": {
    "mid":"zEspJ9wmRG9…",
    "is_self_reply":true
  }
}
```

## Conversation Ownership Filtering

The Conversations API now supports the `is_owner` field, allowing your app to determine if it is responsible for responding to a conversation thread.

**Why use `is_owner`?**

- Efficiently filter and act only on conversations your app owns.
- Avoid unnecessary ticket creation and reduce operational overhead.
- No need for extra logic to determine thread ownership.

**How to use:**

1. Ensure your app uses [Conversation Routing](https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing).
2. Explicitly request the `is_owner` field in your API call.
3. Filter and respond only to threads where `is_owner` is `true`.

**Sample Request:**

```curl
curl -i -X GET "https://graph.facebook.com/LATEST-API-VERSION/conversations?fields=messages,is_owner&access_token=PAGE-ACCESS-TOKEN"
```

**Sample Response:**

```json
{
  "data": [
    {
      "messages": {
        "data": [
          { "id": "Message ID-1", "created_time": "UNIX-TIMESTAMP" },
          { "id": "Message ID-2", "created_time": "UNIX-TIMESTAMP" }
        ]
      },
      "is_owner": true,
      "id": "Conversation ID-1"
    },
    {
      "messages": {
        "data": [
          { "id": "Message ID-3", "created_time": "UNIX-TIMESTAMP" }
        ]
      },
      "is_owner": false,
      "id": "Conversation ID-2"
    }
  ]
}
```

## Learn more

Visit our reference for:

* [The Conversations endpoint](https://developers.facebook.com/docs/graph-api/reference/page/conversations)
* [The Conversation endpoint](https://developers.facebook.com/docs/graph-api/reference/conversation)
* [The Message endpoint](https://developers.facebook.com/docs/graph-api/reference/message)

### Developer Support

* Use the  [Meta Status tool](https://metastatus.com) to check for the status and outages of Meta business products.
* Use the [Meta Developer Support tool](https://developers.facebook.com/support) to report bugs and view reported bugs, get help with Ads or Business Manager, and more.

# IDs & profile information



Identity is central to creating a personalized Messenger experience. The Messenger Platform provides a set of APIs to retrieve basic profile information, link Messenger accounts with your business accounts, and organize end users with custom labels.

## User profile {#profile}

Use a Page-scoped ID (PSID) to retrieve a person's profile information — such as name and profile picture — to personalize the conversation.

[Learn more →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/user-profile)

## Account linking {#account_linking}

Use your web-based login flow to authenticate a person's identity and link it with their Messenger account. This lets you securely access existing customer data to provide a richer conversation experience.

[Learn more →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/account-linking)

## Custom labels {#custom_labels}

Create and manage custom labels to organize and segment your end users. Labels help you categorize people for targeted messaging and audience management.

[Learn more →](https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/custom-labels)

# Account Linking



When a user starts a conversation with your business, you may want to identify him or her as a customer who already has an account with your business. To help with this, we have created a secured protocol to link and unlink the Messenger user identity with your business user identity.

Account Linking allows you to invite users to log-in using your own authentication flow, and to receive a Messenger page-scoped ID (PSID) upon completion. You can then provide a more secure, personalized and relevant experience to users.

Use the [ `getContext()`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webview/context) function in Messenger Extensions to securely get your app user's Page-scoped ID. Bots can then use that to link the user's account or personalize the experience.

### Limitations

Account Linking is only supported on iOS and Android Messenger apps.

Account Linking can only be started via [Log In buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons). It cannot be started from a [persistent menu](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/persistent-menu), a [URL buttons](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons), or an already-opened webview flow.

## Linking Process {#linking_process}

The Account Linking flow follows few simple steps.

1. Register a callback URL using [Log In Button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons).
2. Messenger Platform invokes the registered URL when a user starts the account linking flow. The `redirect_uri` and `account_linking_token` parameters are appended to your registered callback.
3. Once linking is complete, redirect users to the location provided by `redirect_uri` and append a `authorization_code` parameter (defined by you) to confirm linking.
4. Optionally retrieve the user's page-scoped ID (PSID) using the [account linking endpoint](#endpoint). This step should only be used in special cases when you need the user's PSID as part of the linking process.

Account Unlinking can be initiated:

* By the user when tapping a [Log Out button](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons) sent by the developer
* By the business using the [Account Unlink endpoint](#unlink)

## Set your account linking URL

Before using account linking, you must set the `account_linking_url` property in your bot's [Messenger Profile](https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api). You must have the Administrator role for the Page associated with the bot.

```json
{
  "account_linking_url": "<YOUR_ACCOUNT_LINKING_URL>"
}
```

## Callback {#callback}

Your account linking URL is invoked by the Messenger Platform when a user triggers account linking. The `redirect_uri` and `account_linking_token` parameters are appended to the URL callback.

```
<yourAccountLinkingUrl>
  ?account_linking_token=ACCOUNT_LINKING_TOKEN
  &redirect_uri=CALLBACK_URL
```

If **account linking is successful**, you need to complete the flow by redirecting the browser to the URL specified in the `redirect_uri` parameter and appending an `authorization_code` parameter defined by you. Note that the URL may already contain parameters, so you should append the authorization code accordingly:

```
<redirect_uri>
  &authorization_code=AUTHORIZATION_CODE
```

If **account linking failed**, redirect the browser to the `redirect_uri` passed to you as a parameter but do not append the `authorization_code`.

### Parameters {#parameters}

| Parameter Name | Description |
| --- | --- |
| `redirect_uri` | Redirect URI which will be added by Messenger, you must redirect the browser to this location at the end of the authentication flow. It may contain URL encoded parameters. |
| `account_linking_token` | Short-lived token passed by Messenger which you need to pass back as part of the redirect scheme. This token is only valid for 5 minutes, it is encrypted and unique per user.  <br>You can call the [PSID retrieval endpoint](#endpoint) with this token to fetch the corresponding PSID. |
| `authorization_code` | Code provided by you to confirm a successful linking. Messenger Platform will pass back this code along with the user's PSID as the [Account Linking webhook event](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_account_linking). Failing to pass this parameter will cause the linking process to abort. |

## Webhook event {#webhook}

A successful linking flow triggers the [Account Linking event](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_account_linking) to deliver the user's page-scoped ID (PSID).

**Warning:** You must register to the [account linking callback](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_account_linking) event. Not acknowledging this webhook event will cause the linking process to abort.

## PSID retrieval endpoint {#endpoint}

In certain cases you need to retrieve the user page-scoped ID (PSID) during the linking flow. To help with this situation we are providing a PSID retrieval endpoint allowing you to fetch the user's PSID given a valid and unexpired `account_linking_token`.

### Request

```
curl -X GET "https://graph.facebook.com/v2.6/me?access_token=PAGE_ACCESS_TOKEN \
      &fields=recipient \
      &account_linking_token=ACCOUNT_LINKING_TOKEN"
```

### Response

```
{
  "id": "PAGE_ID",
  "recipient": "PSID"
}
```

## Account Unlink Endpoint {#unlink}

In certain cases you need to unlink the user page-scoped ID (PSID) programmatically from your backend. To help with this situation we are providing a PSID unlinking endpoint allowing you to unlink the user's account given a valid PSID.

### Request

```
curl -X POST -H "Content-Type: application/json" -d '{
   "psid":"PSID"
}' "https://graph.facebook.com/v2.6/me/unlink_accounts?access_token=PAGE_ACCESS_TOKEN"
```

### Response

```
{
  "result": "unlink account success"
}
```

## Best Practices {#best_practices}
✅ Use Account Linking when you have a user account system that extends beyond Messenger.

✅ Let people create an account from within Messenger, so it's available elsewhere.

✅ Prompt for login when it's contextually relevant—that is, when your bot user can see the benefit of doing it.

✅ Consider how your bot should behave if a user declines login.

✅ Provide clear confirmation and a friendly welcome after login.

❌ Don't use Account Linking if people will _only_ interact with you via Messenger. You can store account information via thread ID.

❌ Don't require Account Linking right away if you can avoid it; let people get a sense for your bot first.

### Recommended Design Flow
1. Prompt for login with a message that includes our Account Linking button.
2. Show your login page (including a Create Account option) in the Account Linking webview. Ensure it looks good and works well on mobile screens.
3. After successful login, display a confirmation message in the webview. Users will need to dismiss it themselves afterward.
4. Follow up with a friendly thank-you and/or next steps in the thread, including a Log Out option.

# User Profile API



The User Profile API allows you to use a Page-scoped ID (PSID) to retrieve user profile information that can be used to personalize the experience of people interacting with your Messenger.

## Requirements
* To retrieve a user's profile information, you need to have Advanced Access for the [Business Asset User Profile Access](https://developers.facebook.com/docs/graph-api/changelog/version8.0#baupa) feature. Some fields require [additional permissions](#fields) for access.

## Limitations
Though a PSID may be valid, in some cases it may not be able to be used to retrieve a person's profile information. For example, PSIDs associated with Instant Games Pages are not accessible via the User Profile API.

### User Opt-in {#optin}

The following events will authorize your Messenger bot to access a person's profile information:

- The person starts the conversation via [a welcome screen](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen) and tapped the "Get Started" button.
- The person starts the conversation by clicking a "Send to Messenger" button.
- The person starts the conversation by sending a message.
- The person starts the conversation by accepting a Page's message request.
- Your Messenger bot uses the [`askPermission()` function](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webview/permissions) of the Messenger Extensions SDK in the webview to ask for the `user_profile` permission.
- For [Business apps](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/app-types#business), the [Business Asset User Profile Access](https://developers.facebook.com/docs/apps/features-reference#business-asset-user-profile-access) feature is additionally required, and can be applied for via [App Review](https://developers.facebook.com/docs/app-review).

Some entry points allow apps to initiate a conversation without granting the app authorization to access the person's public profile. In those cases, the app will be granted permission to access the person's profile after the person replied to the initial message. Notable situations where a person may initiate a conversation with the app, but not authorize profile permission include the following:

- Conversations started via the [Checkbox Plugin](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery) where the person did not respond on Messenger.
- Interactions with [Ads that Click to Messenger](https://developers.facebook.com/docs/messenger-platform/guides/ads) before the person has replied on Messenger

### Profile Unavailable {#profile_unavailable}

Currently, the User Profile API does not support retrieving profile information for Messenger accounts that were created using a phone number.

In this case, the API will return the error code `2018218` along with the message 'No profile available for this user.'

## Available Profile Fields {#fields}

Apps that have received [App Review approval](https://developers.facebook.com/docs/app-review) for the required feature and permission may retrieve the following fields for users who have made this information public and have opted-in to your Page.

| Field Name | Description | Feature or Permission Required for Access |
| --- | --- | --- |
| `id` | The user's PSID | [Business Asset User Profile Access](https://developers.facebook.com/docs/apps/features-reference/business-asset-user-profile-access) feature |
| `name` | The user's first and last name | [Business Asset User Profile Access](https://developers.facebook.com/docs/apps/features-reference/business-asset-user-profile-access) feature |
| `first_name` | First name | [Business Asset User Profile Access](https://developers.facebook.com/docs/apps/features-reference/business-asset-user-profile-access) feature |
| `last_name` | Last name | [Business Asset User Profile Access](https://developers.facebook.com/docs/apps/features-reference/business-asset-user-profile-access) feature |
| `profile_pic` | URL to the Profile picture. The URL will expire. | [Business Asset User Profile Access](https://developers.facebook.com/docs/apps/features-reference/business-asset-user-profile-access) feature |
| `locale` | Locale of the user on Facebook. For supported locale codes, see [Supported Locales](https://developers.facebook.com/documentation/business-messaging/messenger-platform/messenger-profile/supported-locales). | [`pages_user_locale` permission](https://developers.facebook.com/docs/permissions/reference/pages_user_locale) |
| `timezone` | Timezone, number relative to GMT | [`pages_user_timezone` permission](https://developers.facebook.com/docs/permissions/reference/pages_user_timezone) |
| `gender` | Gender | [`pages_user_gender` permission](https://developers.facebook.com/docs/permissions/reference/pages_user_gender) |

### Requesting feature access to user fields for the Page

1. Go to _Page Settings > Advanced Messaging_
2. Under 'Info About People' select the field and click the 'Request' button.

## Retrieving a Person's Profile {#request}

To use the User Profile API, send a `GET` request with the [profile fields](#fields) you want for the person:

```curl
curl -X GET "https://graph.facebook.com/<PSID>?fields=first_name,last_name,profile_pic&access_token=<PAGE_ACCESS_TOKEN>"
```


If the app is able to access the person's profile, the User Profile API will return a JSON string with the requested fields from the person's profile.

```curl
{
  "first_name": "Peter",
  "last_name": "Chang",
  "profile_pic": "https://fbcdn-profile-a.akamaihd.net/hprofile-ak-xpf1/v/t1.0-1/p200x200/13055603_10105219398495383_8237637584159975445_n.jpg?oh=1d241d4b6d4dac50eaf9bb73288ea192&oe=57AF5C03&__gda__=1470213755_ab17c8c8e3a0a447fed3f272fa2179ce",
  "locale": "en_US",
  "timezone": -7,
  "gender": "male",
}
```


If the app is unable to access the person's profile, an empty object is returned.

## See Also

* [Messenger Platform Error Codes](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)

# Custom Labels for Customers



This guide shows you how to programmatically create and manage custom labels for your customers.

## How It Works

The Custom Labels API allows your business to create, update and delete labels for the business' messaging experience and the business' Facebook Page Inbox for people who interact with your business. You can create custom labels, such as VIP or Platinum Status, to filter your customers for promotional messaging or lead generation among other things.

After you create a label using the API, v12.0 or higher, you associate the label with a specific Page-scoped ID (PSID) to assign the label to the customer  You can update your label, assign it or remove it from a specific person, or delete the label.

### Labels for Lead Generations {#leadgen_labels}

Messages you receive from lead generation ad campaigns for Messenger are assigned one of the following labels:

* Lead Complete – All questions have been answered and leads received the Thank You note
* Lead Disqualified – The lead replied with a disqualifying answer
* Lead in Progress – Questions are in the process of being answered
* Lead Incomplete – No response has been received from the customer after 48 hours

#### Recommendations

We recommend filtering messages by **Lead Complete** to show only the most relevant conversations to the Social Care or live agent teams who follow up with leads.

### Webhooks Notifications

A webhooks notification is sent to your server when a person's label has been updated. This update can be when a label is assigned to a person or removed for a person.

### Limitations

- v12.0 or higher is required

- The Page admin for the business' Facebook Page must accept our
[Page Contact Terms](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy)

### Before You Start

This guide assumes you have read the [Messenger Platform Overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview) and implemented the needed components for sending and receiving messages and notifications.

* The Page ID for the Facebook Page for which you are managing custom labels
* The `pages_me`, `pages_manage_metadata`, and `pages_show_list` permissions
* A Page access token requested from a person who can perform the `MESSAGING` task on the Page
* The Page-scoped ID for the customer if you are assigning, updating, or deleting a label for the customer

## Create a Label {#create_label}

To create a custom label, send a `POST` request to the `/PAGE-ID/custom_labels` endpoint with the `page_label_name` parameter set to the name for your label.

#### Sample API Request

*Formatted for readability.*

```curl
curl -i -X POST "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/custom_labels
    ?page_label_name=CUSTOM-LABEL-NAME
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, you will receive the following JSON response with the ID for the custom label:

```json
{
  "id": CUSTOM-LABEL-ID
}
```

### Get Details for a Label {#get_label_details}

To get details for a label, send a `GET` request to the `CUSTOM-LABEL-ID/custom_labels` endpoint with the `page_label_name` field.

#### Sample API Request

*Formatted for readability.*

```curl
curl -X GET "https://graph.facebook.com/LATEST-API-VERSION/CUSTOM-LABEL-ID/custom_labels
    ?fields=page_label_name
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, you will receive the following JSON response with the name and associated ID for the custom label:

```json
{
  "page_label_name":"CUSTOM-LABEL-NAME",
  "id":"CUSTOM-LABEL-ID"
}
```

### Get a List of Your Labels {#get_all_labels}

To get a list of all your custom labels for a Page, send a `GET` request to the `/PAGE-ID/custom_labels` endpoint with the `page_label_name`.

#### Sample API Request

*Formatted for readability.*

```curl
curl -X GET "https://graph.facebook.com/LATEST-API-VERSION/PAGE-ID/custom_labels
    ?fields=page_label_name
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, you will receive the following JSON response with a list of label names and associated label IDs:

```json
{
  "data": [
    {
      "page_label_name": "CUSTOM-LABEL-A",
      "id": "CUSTOM-LABEL-A-ID"
    },
    {
      "page_label_name": "CUSTOM-LABEL-B",
      "id": "CUSTOM-LABEL-B-ID"
    }
  ]
}
```

## Assign a Label to a Customer {#associate_label}

To assign a label to a customer, send a `POST` request to the `/CUSTOM-LABEL-ID/label` endpoint with the `user` parameter set to the PSID for the customer.

#### Sample API Request

```curl
curl -i -X POST "https://graph.facebook.com/LATEST-API-VERSION/CUSTOM-LABEL-ID/label
    ?user=PSID
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, you will receive the following JSON response with `success` set to `true`:

```json
{
  "success": true
}
```

### Get Labels for a Person {#retrieving_labels_by_psid}

To get a list of labels assigned to a specific person,  send a `GET` request to the `/PSID/custom_labels` endpoint with the `page_label_name` field.

#### Sample API Request

*Formatted for readability.*

```curl
curl -X GET "https://graph.facebook.com/LATEST-API-VERSION/PSID/custom_labels
    ?fields=page_label_name
    &access_token=PAGE-ACCESS-TOKEN"
```

Currently, the Messenger Platform does not support getting labels for Messenger accounts that were created using a phone number instead of a Facebook account.

On success, you will receive the following JSON response with a list of label names and associated label IDs:

```json
{
  "data": [
    {
      "page_label_name": "CUSTOM-LABEL-A",
      "id": "CUSTOM-LABEL-A-ID"
    },
    {
      "page_label_name": "CUSTOM-LABEL-B",
      "id": "CUSTOM-LABEL-B-ID"
    }
  ]
}
```

### Remove a Label from a Person {#remove_label}

To remove a label currently associated with a person, send a `DELETE` request to the `/CUSTOM-LABEL-ID/label` endpoint, with the `user` parameter set to that person's PSID.

#### Sample API Request

*Formatted for readability.*

```curl
curl -i -X DELETE "https://graph.facebook.com/LATEST-API-VERSION/CUSTOM-LABEL-ID/label
    ?user=PSID
    &access_token=PAGE-ACCESS-TOKEN"
```

On success, you will receive the following JSON response with `success` set to `true`:

```json
{
  "success": true
}
```

## Deleting a Label {#delete_label}

To delete a label, send a `DELETE` request to the `/CUSTOM-LABEL-ID` endpoint:

#### Sample API Request

*Formatted for readability.*

```curl
curl -i -X DELETE "https://graph.facebook.com/LATEST-API-VERSION/CUSTOM-LABEL-ID
    ?access_token=PAGE-ACCESS-TOKEN"
```

On success, you will receive the following JSON response with `success` set to `true`:

```json
{
  "success": true
}
```

## `inbox_labels` Webhooks {#webhook}

When you subscribe to the `inbox_labels` webhook field, a webhook notification will be sent to your server when there is an update to a label for a person. The webhook notification will contain the Page ID, the PSID for the person, the change that triggered the webhook, and the label name and ID.

#### Sample Webhook Notification

```
 {
   "object":"page",
   "entry":[
      {
         "id": "PAGE-ID",
         "time":UNIX-TIMESTAMP,
         "changes":[
            {
               "value":{
                  "user":{
                     "id":"PSID"
                  },
                  "action":"SPECIFIC-CHANGE",
                  "label":{
                     "id": "LABEL-ID",
                     "page_label_name":"LABEL-NAME"
                  }
               },
               "field":"inbox_labels"
            }
         ]
      }
   ]
}
```

## See Also




















