# Direct Send API overview


**Note:** The Direct Send API is in beta. Features and behavior described here are subject to change and may be released incrementally. Participation is subject to acceptance of the beta terms.

The Direct Send API simplifies WhatsApp utility and authentication integration. Instead of pre-creating and managing message templates, you send business-initiated messages directly and Meta auto-generates the matching templates behind the scenes.

## What is the Direct Send API

The Direct Send API streamlines the integration process, eliminates template creation complexity, and enables more flexible re-categorization enforcement. By removing the template-management step, you can accelerate time-to-market for utility and authentication messaging.

You use the existing `/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages` endpoint to send business-initiated messages without a template, adding a `category` field to the request body:

```html
POST /<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages

{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "text",
  "text": {
    "body": "<BODY_TEXT>"
  },
  "category": "utility"
}
```

See [Send utility and authentication messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/send-utility-and-authentication-messages) for the full request reference.

## How Direct Send works

Direct Send auto-creates templates on the fly and matches incoming messages against those templates before sending.

> **How Direct Send selects a template:** A business sends a message with a `category` field. If it matches an existing template, Direct Send sends using that template. If not, it sends using a fallback onboarding template and asynchronously creates a new template (content PII-redacted, language detected) so future matching messages use it.

**Onboarding.** When a WhatsApp Business Account (WABA) is onboarded to Direct Send, Meta adds a small set of fallback templates to the WABA. These are used when an incoming message can't be matched to an existing template, ensuring Direct Send always attempts to send the message.

**Sending a message.** For each incoming message:

- Direct Send first checks whether the message matches an existing template.
- If a matching template is found, that template is used to send the message.
- If no matching template is found, Direct Send falls back to the onboarding templates and the message is still sent.
- When there's no match, Direct Send asynchronously triggers creation of a new template from the message. The message content is PII-redacted and its language is detected before the template is created.

## Controlling how templates are generated

If message attribution to a specific template is critical, you can provide a template name as input on the send call. Direct Send creates a template with that exact name, and all messages using that name are attributed to that template.

See [Business-named templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/business-named-templates) for details.

## Next steps

- [Get started with Direct Send](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/get-started) — onboarding prerequisites
- [Supported features and limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/supported-features-and-limits) — formats, languages, and limits
- [Send utility and authentication messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/send-utility-and-authentication-messages)
- [Supported message types](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/supported-message-types)
# Supported features and limits


**Note:** The Direct Send API is in beta. Features and behavior described here are subject to change and may be released incrementally. Participation is subject to acceptance of the beta terms.

This page summarizes what the Direct Send API supports during beta.

## Supported message formats

| Category | Support | Features |
|----------|---------|----------|
| Utility messages, per [Meta's category guidelines](https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines) | ✅ Supported | Text messages · Interactive call-to-action URL button messages · Interactive reply button messages · Interactive messages with mixed call-to-action URL and reply buttons (up to 10 total, max 2 CTA) · Custom time-to-live (TTL) · Image, video, and document message headers |
| Authentication messages, per [Meta's category guidelines](https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines) | ✅ Supported | Text messages |
| Marketing messages | ❌ Not supported | All other button formats · Address, audio, contacts, location, sticker, and reaction messages · Other media formats |

> **Note.** This list is exhaustive for the beta. Any message format or feature not listed here is not yet supported.

> Image, video, and document headers are access-restricted during beta. See [Media message headers](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/media-headers).

## Supported languages

All [WhatsApp Cloud API languages](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/supported-languages) are supported.

See the FAQ for [what happens with an unsupported language](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/faq).

## Message format limits

Direct Send aligns with the message-length limits for business-initiated template messages:

- **Body text:** 1024 characters
- **Header:** 60 characters
- **Footer:** 60 characters
- **Button text:** 20 characters

Button counts:

- **Quick reply buttons:** 10 (max)
- **Call-to-action (CTA) buttons:** 2 (max)

## Message throughput

Direct Send supports standard Cloud API throughput, per [Cloud API throughput eligibility](https://developers.facebook.com/docs/whatsapp/throughput).

# Supported message types


**Note:** The Direct Send API is in beta. Features and behavior described here are subject to change and may be released incrementally. Participation is subject to acceptance of the beta terms.

Direct Send supports text and several interactive message types. For every type, remember to add `"category": "utility"` (or `"authentication"` where supported) to the request body to invoke the Direct Send API.

Interactive message headers can be `text`, `image`, `video`, or `document`. Media headers are access-restricted during beta — see [Media message headers](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/media-headers).

## Text messages

Text messages contain a text body and an optional link preview.

> **Note.** The `preview_url` field is not currently supported. Messages sent with Direct Send do not render a URL preview.

Add `"category": "utility"` or `"category": "authentication"` to the bottom of your request body to invoke Direct Send.

[Learn more about formatting text messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages)

## Interactive call-to-action URL button messages

Call-to-action (CTA) URL button messages map a URL to a button, so you don't include the raw URL in the message body. We recommend the combined CTA URL and reply button format instead — see [Interactive button messages with CTA URL or reply buttons](#interactive-button-messages-with-cta-url-or-reply-buttons).

> **Note.** The header must be `type: "text"`, `"image"`, `"video"`, or `"document"`. See [Media message headers](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/media-headers) for access requirements.

[Learn more about formatting CTA URL button messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-cta-url-messages)

## Interactive reply button messages

Reply button messages let you send up to three predefined replies for the user to choose from. Selecting a button triggers a messages webhook describing the user's choice.

[Learn more about formatting interactive reply button messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages)

## Interactive button messages with CTA URL or reply buttons

This is the recommended way to send interactive buttons. You can mix call-to-action URL and reply buttons in the same message:

- Up to **10** buttons total.
- A maximum of **2** CTA buttons.
- CTA buttons are always listed **before** reply buttons.

See [Multiple call-to-action URL button samples](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/send-sample-payloads#multiple-call-to-action-url-button-samples) for the request format.

## Message success and pricing

The message-success webhook payload is at parity with the current Cloud API message-status webhook and includes pricing details. See the [webhook statuses object](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components#statuses-object) and [per-message pricing webhooks](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing#per-message-pricing-cloud-api-webhooks) for the latest structure.

Direct Send adds one field to the status webhook: **`template_id`**, the template used to send the Direct Send message. It appears in the `statuses` section:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "statuses": [
              {
                "id": "<ID>",
                "status": "<read/delivered/sent>",
                "timestamp": "<EPOCH_TIME>",
                "recipient_id": "<RECIPIENT_PHONE_NUMBER>",
                "template_id": "<TEMPLATE_ID>",
                "conversation": { },
                "pricing": { }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

> **Note.** `recipient_id` is the message recipient's identifier — a phone number, or a business-scoped user ID (BSUID) if the message was addressed to one. See [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/).

## Related

- [Media message headers](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/media-headers)
- [Send sample message payloads](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/send-sample-payloads) — full JSON samples for each type
# Media message headers


**Note:** The Direct Send API is in beta. Features and behavior described here are subject to change and may be released incrementally. Participation is subject to acceptance of the beta terms.

Interactive Direct Send messages can include a media header in addition to a text header. Supported header types are `text`, `image`, `video`, and `document`.

> **Access restricted.** Image, video, and document headers are access-restricted during beta. To request access, reach out to your partner manager.

The header `type` field determines which media object is required:

| Header type | Required object | Object fields |
|-------------|-----------------|---------------|
| `text` | `text` | `text` (header string) |
| `image` | `image` | At least one of `link` or `id` |
| `video` | `video` | At least one of `link` or `id` |
| `document` | `document` | At least one of `link` or `id`; optional `filename` |

For each media header, you must provide at least one of:

- `link` — a public URL to the media file.
- `id` — a media handle (`<MEDIA_ID>`) for media already uploaded to WhatsApp.

## Image header

```json
"header": {
  "type": "image",
  "image": {
    "link": "<IMAGE_LINK>",
    "id": "<MEDIA_ID>"
  }
}
```

## Video header

```json
"header": {
  "type": "video",
  "video": {
    "link": "<VIDEO_LINK>",
    "id": "<MEDIA_ID>"
  }
}
```

## Document header

Document headers additionally accept a `filename`:

```json
"header": {
  "type": "document",
  "document": {
    "link": "<DOCUMENT_LINK>",
    "id": "<MEDIA_ID>",
    "filename": "<FILENAME>"
  }
}
```

## Related

- [Supported message types](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/supported-message-types)
- [Send sample message payloads](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/send-sample-payloads) — complete interactive samples with media headers

# View templates generated by Direct Send


**Note:** The Direct Send API is in beta. Features and behavior described here are subject to change and may be released incrementally. Participation is subject to acceptance of the beta terms.

When you use Direct Send, message templates are generated for you automatically. If you already use templates, you'll see these generated templates both in WhatsApp Manager and through the API.

Direct Send creates two types of templates:

1. **Based on message content** — named starting with `auto_generated`, for example `auto_generated_1234567890`.
2. **Based on the `template_name` provided in the API** — named exactly as provided. For example, if `direct_send_config.template_name="order_delivery"`, the template name is `order_delivery`. See [Business-named templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/business-named-templates).

Other considerations:

- You **cannot edit or delete** templates generated by Direct Send. This applies to both auto-generated templates and business-named templates created via `direct_send_config`.
- Direct Send templates are identified by a `source` field with the value `AUTO_GENERATED`.

## View generated templates via the API

Call `GET /<WABA_ID>/message_templates` and filter on `source=AUTO_GENERATED`. All Direct Send templates (content-based and name-based) are returned.

### Request syntax

```html
GET /<WABA_ID>/message_templates?source=AUTO_GENERATED
```

### Example response

```json
{
  "data": [
    {
      "name": "auto_generated_text_e22a3ec4_7c4a_4097_ae40_56ed1e89941c",
      "parameter_format": "POSITIONAL",
      "components": [
        {
          "type": "BODY",
          "text": "Hi {{1}}, Your order is delivered.",
          "example": {
            "body_text": [
              ["sample 1"]
            ]
          }
        }
      ],
      "language": "en_US",
      "status": "APPROVED",
      "category": "UTILITY",
      "correct_category": "UTILITY",
      "source": "AUTO_GENERATED",
      "id": "1951933648908188"
    }
  ],
  "paging": {
    "cursors": {
      "before": "MAZDZD",
      "after": "MjQZD"
    }
  }
}
```

## View generated templates in WhatsApp Manager

Templates created by Direct Send appear in WhatsApp Manager. Each row has an indicator showing that the template was auto-generated by Meta.

![WhatsApp Manager template list, with an indicator on each Direct Send template row showing it was auto-generated by Meta](https://developers.facebook.com/images/business-messaging/direct-send-templates.png)

*WhatsApp Manager flags each Direct Send template as auto-generated by Meta.*

### Filters

If your business has both Direct Send (auto-generated) and manually created templates, WhatsApp Manager shows a filter to separate them.

![WhatsApp Manager filter that separates Direct Send auto-generated templates from manually created templates](https://developers.facebook.com/images/business-messaging/direct-send-template-filter.png)

*The filter appears when your business has both auto-generated and manually created templates.*

## Related

- [View insights and analytics](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/view-insights-and-analytics)
- [Integrity and content guidelines](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/integrity-and-content-guidelines)
# Send sample message payloads for onboarding


**Note:** The Direct Send API is in beta. Features and behavior described here are subject to change and may be released incrementally. Participation is subject to acceptance of the beta terms.

Sending sample messages to Meta helps ensure that the messages you send with Direct Send are accurately classified and transformed into useful templates. Use the `POST /<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_samples` endpoint to upload 3–4 samples of the messages and use cases you plan to send.

## Request syntax

```html
POST /<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_samples
```

The sections below show the input payloads for each message type.

## Text message samples

```json
{
  "type": "text",
  "text": {
    "body": "<BODY_TEXT>"
  }
}
```

## Call-to-action URL button message samples

The header is optional and can be `text`, `image`, `video`, or `document`. See [Media message headers](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/media-headers) for access requirements.

```json
{
  "type": "interactive",
  "interactive": {
    "type": "cta_url",
    "header": {
      "type": "text|image|video|document",
      "text": "<HEADER_TEXT>",
      "image": {
        "link": "<IMAGE_LINK>",
        "id": "<MEDIA_ID>"
      },
      "video": {
        "link": "<VIDEO_LINK>",
        "id": "<MEDIA_ID>"
      },
      "document": {
        "link": "<DOCUMENT_LINK>",
        "id": "<MEDIA_ID>",
        "filename": "<FILENAME>"
      }
    },
    "body": {
      "text": "<BODY_TEXT>"
    },
    "footer": {
      "text": "<FOOTER_TEXT>"
    },
    "action": {
      "name": "cta_url",
      "parameters": {
        "display_text": "<BUTTON_TEXT>",
        "url": "<BUTTON_URL>"
      }
    }
  }
}
```

> For each media header, include at least one of `link` or `id`. The header object only needs the media object matching its `type`.

## Reply button message samples

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": {
      "type": "text|image|video|document",
      "text": "<HEADER_TEXT>"
    },
    "body": {
      "text": "<BODY_TEXT>"
    },
    "footer": {
      "text": "<FOOTER_TEXT>"
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": {
            "id": "<BUTTON_ID>",
            "title": "<BUTTON_LABEL_TEXT>"
          }
        }
      ]
    }
  }
}
```

## Multiple call-to-action URL button samples

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": {
      "text": "<TEXT>"
    },
    "action": {
      "buttons": [
        {
          "type": "cta_url",
          "cta_url": {
            "display_text": "<CTA_TEXT>",
            "url": "<CTA_LINK>"
          }
        },
        {
          "type": "cta_url",
          "cta_url": {
            "display_text": "<CTA_TEXT>",
            "url": "<CTA_LINK>"
          }
        }
      ]
    }
  },
  "category": "utility"
}
```

## Multiple reply button samples

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": {
      "type": "text",
      "text": "<TEXT>"
    },
    "body": {
      "text": "<TEXT>"
    },
    "footer": {
      "text": "<TEXT>"
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": {
            "id": "<BUTTON_ID>",
            "title": "<BUTTON_LABEL_TEXT>"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "<BUTTON_ID>",
            "title": "<BUTTON_LABEL_TEXT>"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "<BUTTON_ID>",
            "title": "<BUTTON_LABEL_TEXT>"
          }
        }
      ]
    }
  },
  "category": "utility"
}
```

## Multiple call-to-action URL and reply button samples

CTA buttons must be listed before reply buttons. Up to 10 buttons total, with a maximum of 2 CTA buttons.

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": {
      "type": "text",
      "text": "<TEXT>"
    },
    "body": {
      "text": "<TEXT>"
    },
    "footer": {
      "text": "<TEXT>"
    },
    "action": {
      "buttons": [
        {
          "type": "cta_url",
          "cta_url": {
            "display_text": "<CTA_TEXT>",
            "url": "<CTA_LINK>"
          }
        },
        {
          "type": "cta_url",
          "cta_url": {
            "display_text": "<CTA_TEXT>",
            "url": "<CTA_LINK>"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "<BUTTON_ID>",
            "title": "<BUTTON_LABEL_TEXT>"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "<BUTTON_ID>",
            "title": "<BUTTON_LABEL_TEXT>"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "<BUTTON_ID>",
            "title": "<BUTTON_LABEL_TEXT>"
          }
        }
      ]
    }
  },
  "category": "utility"
}
```

## Sample API response

The response indicates whether the sample was processed successfully and the detected category of the content:

```json
{
  "success": true,
  "category": "UTILITY"
}
```

The `category` can be `UTILITY`, `MARKETING`, or `AUTHENTICATION`.

If you believe the category is incorrect, reach out to [wadirectsendapisupport@meta.com](mailto:wadirectsendapisupport@meta.com) to initiate a review.

## Related

- [Supported message types](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/supported-message-types)
- [Media message headers](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/media-headers)
- [Integrity and content guidelines](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/integrity-and-content-guidelines)
# Utility templates



This document describes how to create and send utility templates.

Utility templates are typically sent in response to a user action or request, such as an order confirmation or update.

Utility templates have strict content requirements, particularly around marketing material. If you attempt to create or update a utility template with marketing material, the template will automatically be re-categorized as a marketing template.

See our [template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization#utility-template-guidelines) documentation for content guidelines.

## Supported components

Utility templates support the following components:

- 1 header (optional; all types supported)
- 1 body
- 1 footer (optional)
- Up to 10 buttons (optional). Supported types:
  - Call request
  - Copy code
  - Phone number
  - Quick-reply
  - URL

## Create a utility template

### Request syntax

Use the [Message Templates API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-waba-id-message-templates) to create a utility template.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "name": "<TEMPLATE_NAME>",
  "language": "<TEMPLATE_LANGUAGE>",
  "category": "utility",
  "parameter_format": "<PARAMETER_FORMAT>",
  "components": [

    <!-- header component optional -->
    {
      "type": "header",
      "format": "<HEADER_TYPE>",
      "example": {
        "header_handle": [
          "<HEADER_HANDLE>"
        ]
      }
    },

    <!-- body component required -->
    {
      "type": "body",
      "text": "<BODY_TEXT>",

      <!-- example required if <BODY_TEXT> contains one or more parameters -->
      "example": {
        "body_text_named_params": [
          {
            "param_name": "<PARAMETER_NAME>",
            "example": "<PARAMETER_EXAMPLE_VALUE>"
          },

          <!-- additional parameters would follow, if using multiple parameters -->
        ]
      }
    },

    <!-- footer component optional -->
    {
      "type": "footer",
      "text": "<FOOTER_TEXT>"
    },

    <!-- button components optional -->
    {
      "type": "buttons",
      "buttons": [
        {
          "type": "url",
          "text": "<URL_BUTTON_LABEL_TEXT>",
          "url": "<URL>"
        },
        {
          "type": "phone_number",
          "text": "<PHONE_BUTTON_LABEL_TEXT>",
          "phone_number": "<PHONE_NUMBER>"
        },
        {
          "type": "quick_reply",
          "text": "<QUICK_REPLY_BUTTON_LABEL_TEXT>"
        }
      ]
    }
  ]
}'
```

### Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Template body text. Variables are supported.<br><br>Maximum 1024 characters. | `You're all set! Your reservation for {{number_of_guests}} at Lucky Shrub Eatery on {{day}}, {{date}}, at {{time}}, is confirmed. See you then!` |
| `<FOOTER_TEXT>`<br><br>_String_ | **Optional.**<br><br>Template footer text. Variables are supported.<br><br>Maximum 60 characters. | `Lucky Shrub Eatery: The Luckiest Eatery in Town!` |
| `<HEADER_ASSET_HANDLE>`<br><br>_String_ | **Required if using a header with a media asset.**<br><br>Asset handle of example media asset uploaded on your WhatsApp Business account.<br><br>Maximum 60 characters. | `4::aW1hZ2UvcG5n:ARYpf5zqqUjggwGfsZOJ2_o26Zs8ntcO2mss2vKpFb8P_IvskL043YXKpehYTD7IxqEB4t-uZcIzOTxOFRavEcN_tZLhk1WXFb3IOr4S8UKJcQ:e:1759093121:634974688087057:100089620928913:ARYyOAh63uQLhDpqOdk\n4::aW1hZ2UvcG5n:ARZW8t9-cBNjpdmxV5Z9wcRAMhfmw4ATpJcJiHT0nY62hXq4ppOeBaTWaGI0IwX-twF2IkeKo-_MyW2pEDuBAE5vyw2oHTNgPZQkntclrgWMGg:e:1759093121:634974688087057:100089620928913:ARZE4NC5MrxnZUe5GRw` |
| `<HEADER_TYPE>`<br><br>_String_ | **Required if using a header.**<br><br>Header format. Values can be:<br><br>- documentation<br>- image<br>- location<br>- text<br>- video | `image` |
| `<PARAMETER_EXAMPLE_VALUE>`<br><br>_String_ | **Required if using a body component string that includes one or more parameters.**<br><br>Example parameter value. You must supply an example for each parameter defined in your body component string. | `Saturday` |
| `<PARAMETER_NAME>`<br><br>_String_ | **Required if using named parameters.**<br><br>Must be a unique string, composed of lowercase characters and underscores, wrapped in double curly brackets. | `{{day}}` |
| `<PHONE_BUTTON_LABEL_TEXT>`<br><br>_String_ | **Required if using a phone number button.**<br><br>Button label text.<br><br>Maximum 25 characters. Alphanumeric characters only. | `Change reservation` |
| `<PHONE_NUMBER>`<br><br>_String_ | **Required if using a phone number button component.**<br><br>Business phone number to be called in the WhatsApp user's default phone app when tapped by the user.<br><br>Note that some countries have special phone numbers that have leading zeros after the country calling code (for example, +55-0-955-585-95436). If you assign one of these numbers to the button, the leading zero will be stripped from the number. If your number will not work without the leading zero, assign an alternate number to the button, or add the number as message<br><br>Maximum 20 characters. Alphanumeric characters only. | `15550051310` |
| `<QUICK_REPLY_BUTTON_LABEL_TEXT>` | **Required if using a quick-reply button.**<br><br>Button label text.<br><br>Maximum 25 characters. Alphanumeric characters only. | `Cancel reservation` |
| `<TEMPLATE_LANGUAGE>`<br><br>_String_ | **Required.**<br><br>[Template language code](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages). | `en_US` |
| `<TEMPLATE_NAME>`<br><br>_String_ | **Required.**<br><br>Template name. Must be unique, unless existing templates with the same name have a different template language.<br><br>Maximum 512 characters. Lowercase, alphanumeric characters and underscores only. | `reservation_confirmation` |
| `<URL>`<br><br>_String_ | **Required if including a URL button.**<br><br>URL to be loaded in WhatsApp user's default web browser when tapped. | `https://www.luckyshrubeater.com/reservations` |
| `<URL_BUTTON_LABEL_TEXT>`<br><br>_String_ | **Required if using a URL button.**<br><br>Button label text.<br><br>Maximum 25 characters. Alphanumeric characters only. | `Change reservation` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>` | **Required.**<br><br>WhatsApp Business account ID. | `546151681022936` |

### Response syntax

Upon success:

```html
{
  "id": "<TEMPLATE_ID>",
  "status": "<TEMPLATE_STATUS>",
  "category": "<TEMPLATE_CATEGORY>"
}
```

### Response parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<TEMPLATE_CATEGORY>` | [Template category](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization). | `UTILITY` |
| `<TEMPLATE_ID>` | Template ID. | `546151681022936` |
| `<TEMPLATE_STATUS>` | [Template status](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#template-status). | `PENDING` |

### Example request

This example request creates a utility template with:

- an image header component
- a body component with a string that has 4 named parameters
- a footer component
- a URL button component
- a phone number button component
- a quick-reply button component

```bash
curl 'https://graph.facebook.com/v23.0/102290129340398/message_templates' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "name": "reservation_confirmation",
  "language": "en_US",
  "category": "utility",
  "parameter_format": "named",
  "components": [
    {
      "type": "header",
      "format": "image",
      "example": {
        "header_handle": [
          "4::aW..."
        ]
      }
    },
    {
      "type": "body",
      "text": "*You're all set!*\n\nYour reservation for {{number_of_guests}} at Lucky Shrub Eatery on {{day}}, {{date}}, at {{time}}, is confirmed. See you then!",
      "example": {
        "body_text_named_params": [
          {
            "param_name": "number_of_guests",
            "example": "4"
          },
          {
            "param_name": "day",
            "example": "Saturday"
          },
          {
            "param_name": "date",
            "example": "August 30th, 2025"
          },
          {
            "param_name": "time",
            "example": "7:30 pm"
          }
        ]
      }
    },
    {
      "type": "footer",
      "text": "Lucky Shrub Eatery: The Luckiest Eatery in Town!"
    },
    {
      "type": "buttons",
      "buttons": [
        {
          "type": "url",
          "text": "Change reservation",
          "url": "https://www.luckyshrubeater.com/reservations"
        },
        {
          "type": "phone_number",
          "text": "Call us",
          "phone_number": "+15550051310"
        },
        {
          "type": "quick_reply",
          "text": "Cancel reservation"
        }
      ]
    }
  ]
}'
```

### Example response

```json
{
  "id": "546151681022936",
  "status": "PENDING",
  "category": "UTILITY"
}
```

## Send a utility template

### Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send an approved utility template in template message.

```bash
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "template",
  "template": {
    "name": "<TEMPLATE_NAME>",
    "language": {
      "code": "<TEMPLATE_LANGUAGE>"
    },
    "components": [

      <!-- Only required if the template uses a media header component -->
      {
        "type": "header",
        "parameters": [
          {
            "type": "<MEDIA_HEADER_TYPE>",
            "<MEDIA_HEADER_TYPE>": {
              "id": "<MEDIA_HEADER_ASSET_ID>"
            }
          }
        ]
      },

      <!-- Only required if the template uses body component parameters -->
      {
        "type": "body",
        "parameters": [
          {
            "type": "<NAMED_PARAM_TYPE>",
            "parameter_name": "<NAMED_PARAM_NAME>",
            "text": "<NAMED_PARAM_VALUE>"
          },

          <!-- Additional parameters values would follow, if needed -->

        ]
      }
    ]
  }
}'
```

### Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>API version. If omitted, defaults to the newest API version available to your app. | v25.0 |
| `<MEDIA_HEADER_ASSET_ID>`<br><br>_String_ | **Required if template uses a media header component.** | `2871834006348767` |
| `<MEDIA_HEADER_TYPE>`<br><br>_String_ | **Required if template uses a media header component.**<br><br>Media header type. Values can be:<br><br>- document<br>- image<br>- video<br><br>Note that this placeholder appears twice in the request syntax above. | `image` |
| `<NAMED_PARAM_NAME>` | **Required if template uses body component parameters.**<br><br>Name of parameter as defined in the template body component text string. | `number_of_guests` |
| `<NAMED_PARAM_TYPE>` | **Required if template uses body component parameters.**<br><br>Parameter type. Set to text. | `text` |
| `<NAMED_PARAM_VALUE>` | **Required if template uses body component parameters.**<br><br>Parameter value. | `4` |
| `<TEMPLATE_LANGUAGE>`<br><br>_String_ | **Required.**<br><br>[Template language code](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages). | `en_US` |
| `<TEMPLATE_NAME>`<br><br>_String_ | **Required.**<br><br>Template name. Must be unique, unless existing templates with the same name have a different template language.<br><br>Maximum 512 characters. Lowercase, alphanumeric characters and underscores only. | `reservation_confirmation` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>` | **Required.**<br><br>WhatsApp Business account ID. | `546151681022936` |
| `<WHATSAPP_USER_PHONE_NUMBER>` | **Required.**<br><br>WhatsApp user phone number. | `16505551234` |

### Response syntax

Upon success:

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "<WHATSAPP_USER_PHONE_NUMBER>",
      "wa_id": "<WHATSAPP_USER_ID>"
    }
  ],
  "messages": [
    {
      "id": "<WHATSAPP_MESSAGE_ID>",
      "message_status": "<PACING_STATUS>"
    }
  ]
}
```

### Response parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<PACING_STATUS>` | [Template pacing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing) status. | `accepted` |
| `<WHATSAPP_MESSAGE_ID>` | WhatsApp Message ID.<br><br>This ID is included in status [messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) webhooks for delivery status purposes. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJBRkJENzExMTRFRjk2NTI1OTEA` |
| `<WHATSAPP_USER_ID>` | WhatsApp user's WhatsApp ID. May not match input value. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>` | WhatsApp user's WhatsApp phone number. May not match wa_id value. | `16505551234` |

### Example request

This is an example request that sends the template created in the example template creation request above.

```bash
curl 'https://graph.facebook.com/v23.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "16505551234",
  "type": "template",
  "template": {
    "name": "reservation_confirmation",
    "language": {
      "code": "en_US"
    },
    "components": [
      {
        "type": "header",
        "parameters": [
          {
            "type": "image",
            "image": {
              "id": "2871834006348767"
            }
          }
        ]
      },
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "parameter_name": "number_of_guests",
            "text": "4"
          },
          {
            "type": "text",
            "parameter_name": "day",
            "text": "Saturday"
          },
          {
            "type": "text",
            "parameter_name": "date",
            "text": "August 30th, 2025"
          },
          {
            "type": "text",
            "parameter_name": "time",
            "text": "7:30 pm"
          }
        ]
      }
    ]
  }
}'
```

### Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJBRkJENzExMTRFRjk2NTI1OTEA",
      "message_status": "accepted"
    }
  ]
}
```
# Call permission request templates



Call permission request templates allow you to request permission to call WhatsApp users. They are composed of a required **body** component and a **call permission request** component. When a WhatsApp user receives the message, they can grant or deny your business permission to call them.

You can categorize call permission request templates as either `MARKETING` or `UTILITY`. This page demonstrates creating and sending a call permission request template with the `UTILITY` category. See [Call permission request message template](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/call-permission-request-message-template/) for a marketing example.

## Limitations

- Only templates categorized as `MARKETING` or `UTILITY` can include a call permission request component
- Body text is required and must not be empty
- The call permission request component cannot be combined with other interactive components

## Step 1: Create a call permission request template

Use the [Message Templates API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api) to [create a call permission request template](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-waba-id-message-templates).

### Request syntax

```html
curl -X POST \
  'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "<TEMPLATE_NAME>",
    "language": "<TEMPLATE_LANGUAGE>",
    "category": "<CATEGORY>",
    "parameter_format": "named",
    "components": [
      {
        "type": "body",
        "text": "<BODY_TEXT>",
        "example": {
          "body_text_named_params": [
            {
              "param_name": "<PARAM_NAME>",
              "example": "<EXAMPLE_PARAM_VALUE>"
            }
          ]
        }
      },
      {
        "type": "call_permission_request"
      }
   ]
}'
```

### Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Body text string. Supports named parameters in `{{parameter_name}}` format.<br><br>Maximum 1024 characters. | `Hi {{first_name}}, we would like to call you to assist with your recent order. Our support team is ready to help.` |
| `<CATEGORY>`<br><br>_Enum_ | **Required.**<br><br>Template category. Must be `MARKETING` or `UTILITY`. | `UTILITY` |
| `<EXAMPLE_PARAM_VALUE>`<br><br>_String_ | **Required if body text uses named parameters.**<br><br>Example value for the named parameter. | `Pablo` |
| `<PARAM_NAME>`<br><br>_String_ | **Required if body text uses named parameters.**<br><br>Name of the parameter, matching the placeholder in the body text. | `first_name` |
| `<TEMPLATE_LANGUAGE>`<br><br>_Enum_ | **Required.**<br><br>Template [language and locale code](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages). | `en_US` |
| `<TEMPLATE_NAME>`<br><br>_String_ | **Required.**<br><br>Template name.<br><br>Maximum 512 characters. | `order_support_call` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp Business account ID. | `106540352242922` |

### Example request


```bash
curl -X POST \
  'https://graph.facebook.com/v23.0/106540352242922/message_templates' \
  -H 'Authorization: Bearer EAAJB...' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "order_support_call",
    "language": "en_US",
    "category": "UTILITY",
    "parameter_format": "named",
    "components": [
      {
        "type": "body",
        "text": "Hi {{first_name}}, we would like to call you to assist with your recent order. Our support team is ready to help.",
        "example": {
          "body_text_named_params": [
            {
              "param_name": "first_name",
              "example": "Pablo"
            }
          ]
        }
      },
      {
        "type": "call_permission_request"
      }
   ]
}'
```


### Example response

```json
{
  "id": "546151681022936",
  "status": "PENDING",
  "category": "UTILITY"
}
```

## Step 2: Send a call permission request template

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api) to [send an approved call permission request template](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) in a template message.

### Request syntax

```html
curl -X POST \
  'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "<WHATSAPP_USER_PHONE_NUMBER>",
    "type": "template",
    "template": {
      "name": "<TEMPLATE_NAME>",
      "language": {
        "policy": "deterministic",
        "code": "<TEMPLATE_LANGUAGE_CODE>"
      },
      "components": [
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "parameter_name": "<PARAM_NAME>",
              "text": "<PARAM_VALUE>"
            }
          ]
        }
      ]
    }
}'
```

### Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<PARAM_NAME>`<br><br>_String_ | **Required if the template body uses named parameters.**<br><br>Name of the parameter to replace in the template body. | `first_name` |
| `<PARAM_VALUE>`<br><br>_String_ | **Required if the template body uses named parameters.**<br><br>Value to substitute for the named parameter. | `Pablo` |
| `<TEMPLATE_LANGUAGE_CODE>`<br><br>_Enum_ | **Required.**<br><br>Template [language and locale code](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages). | `en_US` |
| `<TEMPLATE_NAME>`<br><br>_String_ | **Required.**<br><br>Name of the template to send. | `order_support_call` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

### Example request

```bash
curl -X POST \
  'https://graph.facebook.com/v23.0/106540352242922/messages' \
  -H 'Authorization: Bearer EAAJB...' \
  -H 'Content-Type: application/json' \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "+15551234567",
    "type": "template",
    "template": {
      "name": "order_support_call",
      "language": {
        "policy": "deterministic",
        "code": "en_US"
      },
      "components": [
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "parameter_name": "first_name",
              "text": "Pablo"
            }
          ]
        }
      ]
    }
}'
```

### Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+15551234567",
      "wa_id": "15551234567"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTMyMzI4NjU2NzgVAgARGBJBQzRBRDBEMDEwQzVBM0M0QkIA",
      "message_status": "accepted"
    }
  ]
}
```
# Location templates



Location templates include a map header that displays a specific location. When a WhatsApp user taps the map, their default map app opens to the specified coordinates. Location templates are useful for order tracking, delivery updates, ride-hailing pickup and drop-off, and locating physical stores.

Location templates can be categorized as either `MARKETING` or `UTILITY`. This page demonstrates creating and sending a location template with the `UTILITY` category. See [Location templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/location-templates/) for a marketing example.

Real-time locations are not supported. The location is specified when you send the template, not when you create it.

## Limitations

- Only templates categorized as `UTILITY` or `MARKETING` can include a location header
- Real-time locations are not supported
- The location (latitude, longitude, name, address) is specified at send time, not at template creation time

## Create a location template

Use the [Message Templates API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api) to [create a location template](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-waba-id-message-templates).

### Supported components

Location templates support the following components:

- 1 location header (**required**)
- 1 body (**required**; supports named parameters)
- 1 footer (optional)
- Buttons (optional)

### Request syntax

```bash
curl -X POST \
  'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "<TEMPLATE_NAME>",
    "language": "<TEMPLATE_LANGUAGE>",
    "category": "<CATEGORY>",
    "parameter_format": "named",
    "components": [
      {
        "type": "header",
        "format": "location"
      },
      {
        "type": "body",
        "text": "<BODY_TEXT>",
        "example": {
          "body_text_named_params": [
            {
              "param_name": "<BODY_PARAM_NAME>",
              "example": "<BODY_PARAM_EXAMPLE>"
            }
          ]
        }
      },
      {
        "type": "footer",
        "text": "<FOOTER_TEXT>"
      }
    ]
}'
```

### Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BODY_PARAM_EXAMPLE>`<br><br>_String_ | **Required if body text contains named parameters.**<br><br>Example value for the named parameter. You must supply one example for each parameter in your body text. | `Mark` |
| `<BODY_PARAM_NAME>`<br><br>_String_ | **Required if body text contains named parameters.**<br><br>Name of the parameter, matching the placeholder in the body text. | `customer_name` |
| `<BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Body text string. Supports named parameters in `{{parameter_name}}` format.<br><br>Maximum 1024 characters. | `Good news {{customer_name}}! Your order #{{order_number}} is on its way. Check the map above for the delivery location.` |
| `<CATEGORY>`<br><br>_Enum_ | **Required.**<br><br>Template category. Must be `UTILITY` or `MARKETING` for location templates. | `UTILITY` |
| `<FOOTER_TEXT>`<br><br>_String_ | **Optional.**<br><br>Footer text. Maximum 60 characters. | `Tap the button below to stop delivery updates.` |
| `<TEMPLATE_LANGUAGE>`<br><br>_Enum_ | **Required.**<br><br>Template [language and locale code](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages). | `en_US` |
| `<TEMPLATE_NAME>`<br><br>_String_ | **Required.**<br><br>Template name.<br><br>Maximum 512 characters. | `order_delivery_update` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp Business account ID. | `106540352242922` |

### Example request

Create a utility template with a location header, body with named parameters, footer, and a quick reply button:


```bash
curl -X POST \
  'https://graph.facebook.com/v25.0/106540352242922/message_templates' \
  -H 'Authorization: Bearer EAAJB...' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "order_delivery_update",
    "language": "en_US",
    "category": "UTILITY",
    "parameter_format": "named",
    "components": [
      {
        "type": "HEADER",
        "format": "LOCATION"
      },
      {
        "type": "BODY",
        "text": "Good news {{customer_name}}! Your order #{{order_number}} is on its way to the location above. Thank you for your order!",
        "example": {
          "body_text_named_params": [
            {
              "param_name": "customer_name",
              "example": "Mark"
            },
            {
              "param_name": "order_number",
              "example": "566701"
            }
          ]
        }
      },
      {
        "type": "FOOTER",
        "text": "To stop receiving delivery updates, tap the button below."
      },
      {
        "type": "BUTTONS",
        "buttons": [
          {
            "type": "QUICK_REPLY",
            "text": "Stop Delivery Updates"
          }
        ]
      }
    ]
}'
```


### Example response

```json
{
  "id": "546151681022936",
  "status": "PENDING",
  "category": "UTILITY"
}
```

## Send a location template

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api) to [send an approved location template](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) in a template message. You must specify the location coordinates at send time in the header component.

### Request syntax

```bash
curl -X POST \
  'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "<WHATSAPP_USER_PHONE_NUMBER>",
    "type": "template",
    "template": {
      "name": "<TEMPLATE_NAME>",
      "language": {
        "policy": "deterministic",
        "code": "<TEMPLATE_LANGUAGE_CODE>"
      },
      "components": [
        {
          "type": "header",
          "parameters": [
            {
              "type": "location",
              "location": {
                "latitude": "<LOCATION_LATITUDE>",
                "longitude": "<LOCATION_LONGITUDE>",
                "name": "<LOCATION_NAME>",
                "address": "<LOCATION_ADDRESS>"
              }
            }
          ]
        },
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "parameter_name": "<BODY_PARAM_NAME>",
              "text": "<BODY_PARAM_VALUE>"
            }
          ]
        }
      ]
    }
}'
```

### Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BODY_PARAM_NAME>`<br><br>_String_ | **Required if the template body uses named parameters.**<br><br>Name of the parameter to replace in the template body. | `customer_name` |
| `<BODY_PARAM_VALUE>`<br><br>_String_ | **Required if the template body uses named parameters.**<br><br>Value to substitute for the named parameter. | `Jane` |
| `<LOCATION_ADDRESS>`<br><br>_String_ | **Optional.**<br><br>Location address. | `101 Forest Ave, Palo Alto, CA 94301` |
| `<LOCATION_LATITUDE>`<br><br>_String_ | **Required.**<br><br>Location latitude in decimal degrees. | `37.44211676562361` |
| `<LOCATION_LONGITUDE>`<br><br>_String_ | **Required.**<br><br>Location longitude in decimal degrees. | `-122.16155960083124` |
| `<LOCATION_NAME>`<br><br>_String_ | **Optional.**<br><br>Location name. | `Philz Coffee` |
| `<TEMPLATE_LANGUAGE_CODE>`<br><br>_Enum_ | **Required.**<br><br>Template [language and locale code](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages). | `en_US` |
| `<TEMPLATE_NAME>`<br><br>_String_ | **Required.**<br><br>Name of the template to send. | `order_delivery_update` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

### Example request

Send the template [created in the example request above](#example-request). The location coordinates and body parameter values are provided at send time. Note that the send-time values differ from the creation-time example values to demonstrate that they are independent.

```bash
curl -X POST \
  'https://graph.facebook.com/v25.0/106540352242922/messages' \
  -H 'Authorization: Bearer EAAJB...' \
  -H 'Content-Type: application/json' \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "+16505551234",
    "type": "template",
    "template": {
      "name": "order_delivery_update",
      "language": {
        "policy": "deterministic",
        "code": "en_US"
      },
      "components": [
        {
          "type": "header",
          "parameters": [
            {
              "type": "location",
              "location": {
                "latitude": "37.44211676562361",
                "longitude": "-122.16155960083124",
                "name": "Philz Coffee",
                "address": "101 Forest Ave, Palo Alto, CA 94301"
              }
            }
          ]
        },
        {
          "type": "body",
          "parameters": [
            {
              "type": "text",
              "parameter_name": "customer_name",
              "text": "Jane"
            },
            {
              "type": "text",
              "parameter_name": "order_number",
              "text": "892104"
            }
          ]
        }
      ]
    }
}'
```

### Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY1MDU..."
    }
  ]
}
```
# Address Messages



**Warning:** This feature is only available for businesses based in India and their India customers.

Address messages give your users a simpler way to share the shipping address with the business on WhatsApp.

Address messages are interactive messages that contain the four main parts: `header`, `body`, `footer`, and `action`. Inside the action component, the business specifies the name "address_message" and relevant parameters.

The following table outlines the fields that are supported by the address message.

| Field Name | Display Label | Input Type | Supported Countries | Limitations |
| --- | --- | --- | --- | --- |
| `name` | Name | text | India | None |
| `phone_number` | Phone Number | tel | India | Valid phone numbers only |
| `in_pin_code` | Pin Code | text | India | Max length: 6 |
| `house_number` | Flat/House Number | text | India | None |
| `floor_number` | Floor Number | text | India | None |
| `tower_number` | Tower Number | text | India | None |
| `building_name` | Building/Apartment Name | text | India | None |
| `address` | Address | text | India | None |
| `landmark_area` | Landmark/Area | text | India | None |
| `city` | City | text | India | None |
| `state` | State | text | India | None |

## Sample API call

This is a sample API call for the address message. The `country` attribute is a mandatory field in the action parameters. If the country attribute is not included, there will be a validation error.

```html
curl -X  POST \
'https://graph.facebook.com/<API_VERSION>/<FROM_PHONE_NUMBER_ID>/messages' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-H 'Content-Type: application/json' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<PHONE_NUMBER>",
  "type": "interactive",
  "interactive": {
    "type": "address_message",
    "body": {
      "text": "Thanks for your order! Tell us what address you'd like this order delivered to."
    },
    "action": {
      "name": "address_message",
      "parameters": {
        "country": "<COUNTRY_ISO_CODE>"
      }
    }
  }
}'
```

## Error handling

If the area code of the phone number for the given country is not correct, businesses will be unable to request the address message from the recipient. For example, businesses will be unable to request an address message from a recipient that has the country as "India" but has a phone number with an area code of "65".

Once the address message is sent, the business waits for the user to fill in the address and send it back. The [webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview) registered in the [setup process](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview) shares the address the user entered.

## Address message steps

The steps involved in an Address Message are the following:

1. Business sends an address message with the action name `address_message` to the user.
2. User interacts with the message by clicking on the CTA, which brings up an Address Message screen. The user fills out their address and submits the form.
3. After the user submits the address message form, the partner receives a webhook notification, which contains the details of the address the user submitted.

**Sample India Address Message **

The following sequence diagram shows a typical integration flow for an address message.

## Additional action parameters

The business can pass additional attributes such as `values`, `validation_errors`, or `saved_addresses` as part of the interactive action parameters. You can find information on each of their usage below.

| Action Parameter | Usage |
| --- | --- |
| `values` | Businesses prefill this for address fields (for example, prefilling the city address field with "India") |
| `saved_addresses` | Businesses can pass in saved addresses previously associated with the user.<br><br>For users, they are presented with the option to choose the saved address instead of manually filling it in |
| `validation_errors` | Businesses can throw errors in the address fields and WhatsApp will prevent the user from submitting the address until all issues are resolved. |

### Send an address message to a user

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send an end-to-end encrypted address message to the user:

```html
curl -X  POST \
'https://graph.facebook.com/<API_VERSION>/<FROM_PHONE_NUMBER_ID>/messages' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-H 'Content-Type: application/json' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<PHONE_NUMBER>",
  "type": "interactive",
  "interactive": {
    "type": "address_message",
    "body": {
      "text": "Thanks for your order! Tell us what address you'd like this order delivered to."
    },
    "action": {
      "name": "address_message",
      "parameters": "JSON Payload"
    }
  }
}'
```

To send an address message without any saved addresses, WhatsApp will prompt the user or business with an address form to enter a new address.

```html
curl -X  POST \
'https://graph.facebook.com/<API_VERSION>/<FROM_PHONE_NUMBER_ID>/messages' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-H 'Content-Type: application/json' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+91xxxxxxxxxx",
  "type": "interactive",
  "interactive": {
    "type": "address_message",
    "body": {
      "text": "Thanks for your order! Tell us what address you'd like this order delivered to."
    },
    "action": {
      "name": "address_message",
      "parameters": {
        "country": "IN",
        "values": {
          "name": "<CUSTOMER_NAME>",
          "phone_number": "+91xxxxxxxxxx"
        }
      }
    }
  }
}'
```

To send an address message with saved addresses, WhatsApp will prompt the user or business with an option to select among the saved addresses or add an address option. Users can ignore the saved address and enter a new address.

```html
curl -X  POST \
'https://graph.facebook.com/<API_VERSION>/<FROM_PHONE_NUMBER_ID>/messages' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-H 'Content-Type: application/json' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "91xxxxxxxxxx",
  "type": "interactive",
  "interactive": {
    "type": "address_message",
    "body": {
      "text": "Thanks for your order! Tell us what address you'd like this order delivered to."
    },
    "action": {
      "name": "address_message",
      "parameters": {
        "country": "IN",
        "saved_addresses": [
          {
            "id": "address1",
            "value": {
              "name": "<CUSTOMER_NAME>",
              "phone_number": "+91xxxxxxxxxx",
              "in_pin_code": "400063",
              "floor_number": "8",
              "building_name": "",
              "address": "Wing A, Cello Triumph,IB Patel Rd",
              "landmark_area": "Goregaon",
              "city": "Mumbai"
            }
          }
        ]
      }
    }
  }
}'
```

## Check your response {#response}

A successful response includes a `messages` object with an ID for the newly created message.

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "<PHONE_NUMBER>",
      "wa_id": "<WHATSAPP_ID>"
    }
  ],
  "messages": [
    {
      "id": "wamid.ID"
    }
  ]
}
```

An unsuccessful response contains an error message. See [Error and Status Codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes) for more information.

## Send an address message with validation errors

Re-send the address message to the user in the case of a validation error on the business server. The business should send back the set of values previously entered by the user, along with the respective validation errors for each invalid field, as shown in the sample payloads below.

```html
curl -X  POST \
'https://graph.facebook.com/<API_VERSION>/<FROM_PHONE_NUMBER_ID>/messages' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-H 'Content-Type: application/json' \
-d
'{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "91xxxxxxxxxx",
  "type": "interactive",
  "interactive": {
    "type": "address_message",
    "body": {
      "text": "Thanks for your order! Tell us what address you'd like this order delivered to."
    },
    "action": {
      "name": "address_message",
      "parameters": {
          "country": "IN",
          "values": {
             "name": "CUSTOMER_NAME",
             "phone_number": "+91xxxxxxxxxx",
             "in_pin_code": "666666",
             "address": "Some other location",
             "city": "Delhi"
          },
          "validation_errors": {
             "in_pin_code": "We could not locate this pin code."
          }
       }
    }
  }
}'
```

## Receive notifications for address submissions

Businesses will receive address submission notifications through [webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview), such as the one shown below.

```json
{
  "messages": [
    {
      "id": "gBGGFlAwCWFvAgmrzrKijase8yA",
      "from": "<PHONE_NUMBER>",
      "interactive": {
        "type": "interactive",
        "action": "address_message",
        "nfm_reply": {
          "name": "address_message",
          "response_json": "<response_json from client>",
          "body": "<body text from client>"
        },
        "timestamp": "1670394125"
      }
    }
  ]
}
```

The webhook notification has the following values.
| Field Name | Type | Description |
| --- | --- | --- |
| `interactive` | Object | Holds the response from the client |
| `type` | String | Would be `nfm_reply` indicating it is a Native Flow Response (NFM) from the client |
| `nfm_reply` | Object | Holds the data received from the client |
| `response_json` | String | The values of the address fields filled by the user in JSON format that are always present |
| `body` (Optional) | String | Body text from client, what the user sees |
| `name` (Optional) | String | Would be `address_message` indicating the type of NFM action response from the client |

An address message reply as an NFM response type for an India address message request is shown below.

```json
{
  "messages": [
    {
      "context": {
        "from": "FROM_PHONE_NUMBER_ID",
        "id": "wamid.HBgLMTIwNjU1NTAxMDcVAgARGBI3NjNFN0U5QzMzNDlCQjY0M0QA"
      },
      "from": "<PHONE_NUMBER>",
      "id": "wamid.HBgLMTIwNjU1NTAxMDcVAgASGCA5RDhBNENEMEQ3RENEOEEzMEI0RUExRDczN0I1NThFQwA=",
      "timestamp": "1671498855",
      "type": "interactive",
      "interactive": {
        "type": "nfm_reply",
        "nfm_reply": {
          "response_json": "{\"saved_address_id\":\"address1\",\"values\":{\"in_pin_code\":\"400063\",\"building_name\":\"\",\"landmark_area\":\"Goregaon\",\"address\":\"Wing A, Cello Triumph, IB Patel Rd\",\"city\":\"Mumbai\",\"name\":\"CUSTOMER_NAME\",\"phone_number\":\"+91xxxxxxxxxx\",\"floor_number\":\"8\"}}",
          "body": "CUSTOMER_NAME\n +91xxxxxxxxxx\n 400063, Goregaon, Wing A, Cello Triumph,IB Patel Rd, Mumbai, 8",
          "name": "address_message"
        }
      }
    }
  ]
}
```

## Feature not supported

In the case where the client does not support `address_message`, WhatsApp silently drops the messages and sends an error message back to the business in a webhook. The webhook notification that would be sent back is shown below:

```json
{
  "statuses": [
    {
      "errors": [
        {
          "code": 1026,
          "href": "/docs/whatsapp/api/errors",
          "title": "Receiver Incapable"
        }
      ],
      "id": "gBGGFlAwCWFvAgkyHMGKnRu4JeA",
      "message": {
        "recipient_id": "+91xxxxxxxxxx"
      },
      "recipient_id": "91xxxxxxxxxx",
      "status": "failed",
      "timestamp": "1670394125",
      "type": "message"
    }
  ]
}
```
# Audio messages


**Warning:** On March 17th, 2026, voice messages will start receiving a ["played" status webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) the first time a WhatsApp user plays a voice message shared by the business.

You can use Cloud API to send voice messages and basic audio messages.

## Voice messages

A voice message (sometimes referred to as a voice note, voice memo, or audio) is a recording of one or more persons speaking, and can include background sounds like music. Voice messages include features like automatic download, profile picture, and voice icon. These features are not available with basic audio messages. If the user sets voice message transcripts to **Automatic**, the message includes a text transcription.

- Voice messages require .ogg files encoded with the **OPUS** codec. If you send a different file type or a file encoded with a different codec, voice message transcription will fail.
- The play icon will only appear if the file is 512KB or smaller, otherwise it will be replaced with a download icon (a downward facing arrow).
- The message displays your business's profile image with a microphone icon.
- The text transcription appears if the user has enabled **Automatic** [voice message transcripts](https://faq.whatsapp.com/241617298315321/). If the user has set this to **Manual**, the text "Transcribe" will appear instead, which will display the transcribed text once tapped. If the user has set voice message transcripts to **Never**, no text will appear.

## Basic audio messages

Basic audio messages display a download icon and a music icon. When the WhatsApp user taps the play icon, the user manually downloads the audio message for the WhatsApp client to load and then play the audio file.

- The download icon will be replaced with a play icon if the WhatsApp user has enabled [auto-download](https://faq.whatsapp.com/366146522333492/) for audio media and conditions for auto-download are met (for example, connected to wi-fi).
- If you send a .ogg file encoded with the OPUS codec as a basic audio message, the music icon will be replaced with a microphone icon. In addition, if the user has enabled **Automatic** or **Manual** [voice message transcripts](https://faq.whatsapp.com/241617298315321/), a text transcription or the text "Transcribe" will accompany the message.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send an audio message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "audio",
  "audio": {
    "id": "<MEDIA_ID>", <!-- Only if using uploaded media -->
    "link": "<MEDIA_URL>", <!-- Only if using hosted media (not recommended) -->
    "voice": <IS_VOICE?> <!-- Only include if sending voice message -->
  }
}'
```

## Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<IS_VOICE?>`<br><br>_Boolean_ | **Optional.**<br><br>Set to `true` if sending a [voice message](#voice-messages). Voice messages must be Ogg files encoded with the **OPUS** codec.<br><br>To send a [basic audio message](#basic-audio-messages), set to `false` or omit entirely. | `true` |
| `<MEDIA_ID>`<br><br>_String_ | **Required if using uploaded media, otherwise omit.**<br><br>ID of the [uploaded media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media). | `1013859600285441` |
| `<MEDIA_URL>`<br><br>_String_ | **Required if using hosted media, otherwise omit.**<br><br>URL of the media asset hosted on your public server. For better performance, we recommend using `id` and an [uploaded media asset ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media) instead. | `https://www.luckyshrub.com/media/ringtones/wind-chime.mp3` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Supported audio formats

| Audio Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| AAC | .aac | audio/aac | 16 MB |
| AMR | .amr | audio/amr | 16 MB |
| MP3 | .mp3 | audio/mpeg | 16 MB |
| MP4 Audio | .m4a | audio/mp4 | 16 MB |
| OGG Audio | .ogg | audio/ogg (OPUS codecs only; base audio/ogg not supported; mono input only) | 16 MB |

The most common errors associated with audio files are mismatched MIME types (MIME type doesn't match the file type indicated by the file name) and invalid encoding for Ogg files (OPUS codec only). If you encounter an error when sending a media file, verify that your audio file's MIME type matches its extension and is a supported type. For Ogg files, use the OPUS codec for encoding.

## Example request

Example request to send an image message using an uploaded media ID and a caption.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "audio",
  "audio": {
    "id" : "1013859600285441",
    "voice": true
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Contacts messages



Contacts messages allow you to send rich contact information directly to WhatsApp users, such as names, phone numbers, physical addresses, and email addresses.

When a WhatsApp user taps the message's profile arrow, it displays the contact's information in a profile view:

Each message can include information for up to 257 contacts, although it is recommended to send fewer for usability and negative feedback reasons.

A contact's metadata (for example, addresses, birthdays, emails) may not be supported by the recipient, especially on their primary device. Refer to this [documentation](https://faq.whatsapp.com/378279804439436/?cms_platform=android) for the definitions of primary and linked devices.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send a contacts message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "contacts",
  "contacts": [
    {
      "addresses": [
        {
          "street": "<STREET_NUMBER_AND_NAME>",
          "city": "<CITY>",
          "state": "<STATE_CODE>",
          "zip": "<ZIP_CODE>",
          "country": "<COUNTRY_NAME>",
          "country_code": "<COUNTRY_CODE>",
          "type": "<ADDRESS_TYPE>"
        }
        <!-- Additional addresses objects go here, if using -->
      ],
      "birthday": "<BIRTHDAY>",
      "emails": [
        {
          "email": "<EMAIL_ADDRESS>",
          "type": "<EMAIL_TYPE>"
        }
        <!-- Additional emails objects go here, if using -->
      ],
      "name": {
        "formatted_name": "<FULL_NAME>",
        "first_name": "<FIRST_NAME>",
        "last_name": "<LAST_NAME>",
        "middle_name": "<MIDDLE_NAME>",
        "suffix": "<SUFFIX>",
        "prefix": "<PREFIX>"
      },
      "org": {
        "company": "<COMPANY_OR_ORG_NAME>",
        "department": "<DEPARTMENT_NAME>",
        "title": "<JOB_TITLE>"
      },
      "phones": [
        {
          "phone": "<PHONE_NUMBER>",
          "type": "<PHONE_NUMBER_TYPE>",
          "wa_id": "<WHATSAPP_USER_ID>"
        }
        <!-- Additional phones objects go here, if using -->
      ],
      "urls": [
        {
          "url": "<WEBSITE_URL>",
          "type": "<WEBSITE_TYPE>"
        }
        <!-- Additional URLs go here, if using -->
      ]
    }
  ]
}'
```

## Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<ADDRESS_TYPE>`<br><br>_String_ | **Optional.**<br><br>Type of address, such as home or work. | `Home` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BIRTHDAY>`<br><br>_String_ | **Optional.**<br><br>Contact's birthday. Must be in `YYYY-MM-DD` format. | `1999-01-23` |
| `<CITY>`<br><br>_String_ | **Optional.**<br><br>City where the contact resides. | `Menlo Park` |
| `<COMPANY_OR_ORG_NAME>`<br><br>_String_ | **Optional.**<br><br>Name of the company where the contact works. | `Lucky Shrub` |
| `<COUNTRY_CODE>`<br><br>_String_ | **Optional.**<br><br>ISO two-letter country code. | `US` |
| `<COUNTRY_NAME>`<br><br>_String_ | **Optional.**<br><br>Country name. | `United States` |
| `<DEPARTMENT_NAME>`<br><br>_String_ | **Optional.**<br><br>Department within the company. | `Legal` |
| `<EMAIL_ADDRESS>`<br><br>_String_ | **Optional.**<br><br>Email address of the contact. | `bjohnson@luckyshrub.com` |
| `<EMAIL_TYPE>`<br><br>_String_ | **Optional.**<br><br>Type of email, such as personal or work. | `Work` |
| `<FIRST_NAME>`<br><br>_String_ | **Optional.**<br><br>Contact's first name. | `Barbara` |
| `<FORMATTED_NAME>`<br><br>_String_ | **Required.**<br><br>Contact's formatted name. This will appear in the message alongside the profile arrow button. | `Barbara J. Johnson` |
| `<JOB_TITLE>`<br><br>_String_ | **Optional.**<br><br>Contact's job title. | `Lead Counsel` |
| `<LAST_NAME>`<br><br>_String_ | **Optional.**<br><br>Contact's last name. | `Johnson` |
| `<MIDDLE_NAME>`<br><br>_String_ | **Optional.**<br><br>Contact's middle name. | `Joana` |
| `<PHONE_NUMBER>`<br><br>_String_ | **Optional.**<br><br>WhatsApp user phone number. | `+16505559999` |
| `<PHONE_NUMBER_TYPE>`<br><br>_String_ | **Optional.**<br><br>Type of phone number, such as cell, mobile, main, iPhone, home, or work. | `Home` |
| `<PREFIX>`<br><br>_String_ | **Optional.**<br><br>Prefix for the contact's name, such as Mr., Ms., Dr., etc. | `Dr.` |
| `<STATE_CODE>`<br><br>_String_ | **Optional.**<br><br>Two-letter state code. | `CA` |
| `<STREET_NUMBER_AND_NAME>`<br><br>_String_ | **Optional.**<br><br>Street address of the contact. | `1 Lucky Shrub Way` |
| `<SUFFIX>`<br><br>_String_ | **Optional.**<br><br>Suffix for the contact's name, if applicable. | `Esq.` |
| `<WEBSITE_TYPE>`<br><br>_String_ | **Optional.**<br><br>Type of website, such as company, work, personal, Facebook Page, or Instagram. | `Company` |
| `<WEBSITE_URL>`<br><br>_String_ | **Optional.**<br><br>Website URL associated with the contact or their company. | `https://www.luckyshrub.com` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | **Optional.**<br><br>WhatsApp user ID. If omitted, the message will display an Invite to WhatsApp button instead of the standard buttons.<br><br>See [Button Behavior](#button-behavior) below. | `19175559999` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |
| `<ZIP_CODE>`<br><br>_String_ | **Optional.**<br><br>Postal or ZIP code. | `94025` |

## Button behavior

If you include the contact's WhatsApp ID in the message (via the `wa_id` property), the message will include a **Message** and a **Save contact** button:

If the WhatsApp user taps the **Message** button, it will open a new message with the contact. If the user taps the **Save contact** button, they will be given the option to save the contact as a new contact, or to update an existing contact.

If you omit the `wa_id` property, both buttons will be replaced with an **Invite to WhatsApp** button:

## Example request

Example request to send a contacts message with two physical addresses, two email addresses, two phone numbers, and two website URLs.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "to": "+16505551234",
  "type": "contacts",
  "contacts": [
    {
      "addresses": [
        {
          "street": "1 Lucky Shrub Way",
          "city": "Menlo Park",
          "state": "CA",
          "zip": "94025",
          "country": "United States",
          "country_code": "US",
          "type": "Office"
        },
        {
          "street": "1 Hacker Way",
          "city": "Menlo Park",
          "state": "CA",
          "zip": "94025",
          "country": "United States",
          "country_code": "US",
          "type": "Pop-Up"
        }
      ],
      "birthday": "1999-01-23",
      "emails": [
        {
          "email": "bjohnson@luckyshrub.com",
          "type": "Work"
        },
        {
          "email": "bjohnson@luckyshrubplants.com",
          "type": "Work (old)"
        }
      ],
      "name": {
        "formatted_name": "Barbara J. Johnson",
        "first_name": "Barbara",
        "last_name": "Johnson",
        "middle_name": "Joana",
        "suffix": "Esq.",
        "prefix": "Dr."
      },
      "org": {
        "company": "Lucky Shrub",
        "department": "Legal",
        "title": "Lead Counsel"
      },
      "phones": [
        {
          "phone": "+16505559999",
          "type": "Landline"
        },
        {
          "phone": "+19175559999",
          "type": "Mobile",
          "wa_id": "19175559999"
        }
      ],
      "urls": [
        {
          "url": "https://www.luckyshrub.com",
          "type": "Company"
        },
        {
          "url": "https://www.facebook.com/luckyshrubplants",
          "type": "Company (FB)"
        }
      ]
    }
  ]
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Document messages



Document messages are messages that display a document icon, linked to a document, that a WhatsApp user can tap to download.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send a document message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "document",
  "document": {
    "id": "<MEDIA_ID>", <!-- Only if using uploaded media -->
    "link": "<MEDIA_URL>", <!-- Only if using hosted media (not recommended) -->
    "caption": "<MEDIA_CAPTION_TEXT>",
    "filename": "<MEDIA_FILENAME>",
    "caption": "<MEDIA_CAPTION_TEXT>"
  }
}'
```

## Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<MEDIA_CAPTION_TEXT>`<br><br>_String_ | **Optional.**<br><br>Media asset caption text.<br><br>Maximum 1024 characters. | `Lucky Shrub Invoice` |
| `<MEDIA_FILENAME>`<br><br>_String_ | **Optional.**<br><br>Document filename, with extension. The WhatsApp client will use an appropriate file type icon based on the extension. | `lucky-shrub-invoice.pdf` |
| `<MEDIA_ID>`<br><br>_String_ | **Required if using uploaded media, otherwise omit.**<br><br>ID of the [uploaded media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media). | `1013859600285441` |
| `<MEDIA_URL>`<br><br>_String_ | **Required if using hosted media, otherwise omit.**<br><br>URL of the media asset hosted on your public server. For better performance, we recommend using `id` and an [uploaded media asset ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media) instead. | `https://www.luckyshrub.com/invoices/FmOzfD9cKf/lucky-shrub-invoice.pdf` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Supported document types

| Document Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| Text | .txt | text/plain | 100 MB |
| Microsoft Excel | .xls | application/vnd.ms-excel | 100 MB |
| Microsoft Excel | .xlsx | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | 100 MB |
| Microsoft Word | .doc | application/msword | 100 MB |
| Microsoft Word | .docx | application/vnd.openxmlformats-officedocument.wordprocessingml.document | 100 MB |
| Microsoft PowerPoint | .ppt | application/vnd.ms-powerpoint | 100 MB |
| Microsoft PowerPoint | .pptx | application/vnd.openxmlformats-officedocument.presentationml.presentation | 100 MB |
| PDF | .pdf | application/pdf | 100 MB |

Only the above listed document types are officially supported and guaranteed to display correctly in the WhatsApp client. Other file types may be sent via the API, but they are not supported and may not be handled as expected.

## Example request

Example request to send a PDF in a document message with a caption to a WhatsApp user.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "document",
  "document": {
    "id": "1376223850470843",
    "filename": "order_abc123.pdf",
    "caption": "Your order confirmation (PDF)"
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Image messages



Image messages are messages that display a single image and an optional caption.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send an image message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "image",
  "image": {
    "id": "<MEDIA_ID>", <!-- Only if using uploaded media -->
    "link": "<MEDIA_URL>", <!-- Only if using hosted media (not recommended) -->
    "caption": "<MEDIA_CAPTION_TEXT>"
  }
}'
```

## Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<MEDIA_CAPTION_TEXT>`<br><br>_String_ | **Optional.**<br><br>Media asset caption text.<br><br>Maximum 1024 characters. | `The best succulent ever?` |
| `<MEDIA_ID>`<br><br>_String_ | **Required if using uploaded media, otherwise omit.**<br><br>ID of the [uploaded media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media). | `1013859600285441` |
| `<MEDIA_URL>`<br><br>_String_ | **Required if using hosted media, otherwise omit.**<br><br>URL of the media asset hosted on your public server. For better performance, we recommend using `id` and an [uploaded media asset ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media) instead. | `https://www.luckyshrub.com/assets/succulents/aloe.png` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Supported image formats

Images must be 8-bit, RGB or RGBA.

| Image Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| JPEG | .jpeg | image/jpeg | 5 MB |
| PNG | .png | image/png | 5 MB |

## Example request

Example request to send an image message with a caption to a WhatsApp user.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "image",
  "image": {
    "id" : "1479537139650973",
    "caption": "The best succulent ever?"
  }
}'
```

## Example response

Example response after successfully sending an image message.

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```


## Error handling

A request fails if the `<MEDIA_ID>` is invalid or has expired, if the image format isn't supported, or if the image exceeds the maximum size listed in [Supported image formats](#supported-image-formats). When a request fails, the API returns an error response instead of a message ID.

For the full list of error codes and recommended handling, see [WhatsApp Cloud API error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).

# Interactive Call-to-Action URL Button Messages



WhatsApp users may be hesitant to tap raw URLs containing lengthy or obscure strings in text messages. In these situations, send an interactive call-to-action (CTA) URL button message instead. CTA URL button messages allow you to map any URL to a button so you don't have to include the raw URL in the message body.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send an interactive CTA URL message.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "interactive",
  "interactive": {
    "type": "cta_url",

    <!-- If using document header, otherwise omit -->
    "header": {
      "type": "document",
      "document": {
        "link": "<ASSET_URL>"
      }
    },

    <!-- If using image header, otherwise omit -->
    "header": {
      "type": "image",
      "image": {
        "link": "<ASSET_URL>"
      }
    },

    <!-- If using text header, otherwise omit -->
    "header": {
      "type": "text",
      "text": "<HEADER_TEXT>"
      }
    },

    <!-- If using video header, otherwise omit -->
    "header": {
      "type": "video",
      "video": {
        "link": "<ASSET_URL>"
      }
    },

    "body": {
      "text": "<BODY_TEXT>"
    },
    "action": {
      "name": "cta_url",
      "parameters": {
        "display_text": "<BUTTON_LABEL_TEXT>",
        "url": "<BUTTON_URL>"
      }
    },

    <!-- If using footer text, otherwise omit -->
    "footer": {
      "text": "<FOOTER_TEXT>"
    }
  }
}'
```

## Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<ASSET_URL>`<br><br>_String_ | **Required if using a header with a media asset.**<br><br>Asset URL on a public server. | `https://www.luckyshrub.com/assets/lucky-shrub-banner-logo-v1.png` |
| `<BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Body text. URLs are automatically hyperlinked.<br><br>Maximum 1024 characters. | `Tap the button below to see available dates.` |
| `<BUTTON_LABEL_TEXT>`<br><br>_String_ | **Required.**<br><br>Button label text. Must be unique if using multiple buttons.<br><br>Maximum 20 characters. | `See Dates` |
| `<BUTTON_URL>` | **Required.**<br><br>URL to load in the device's default web browser when the WhatsApp user taps the button. | `https://www.luckyshrub.com?clickID=kqDGWd24Q5TRwoEQTICY7W1JKoXvaZOXWAS7h1P76s0R7Paec4` |
| `<FOOTER_TEXT>`<br><br>_String_ | **Required if using a footer.**<br><br>Footer text. URLs are automatically hyperlinked.<br><br>Maximum 60 characters. | `Dates subject to change.` |
| `<HEADER_TEXT>`<br><br>_String_ | **Required if using a text header.**<br><br>Header text.<br><br>Maximum 60 characters. | `New workshop dates announced!` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Example request

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "interactive",
  "interactive": {
    "type": "cta_url",
    "header": {
      "type": "image",
      "image": {
        "link": "https://www.luckyshrub.com/assets/lucky-shrub-banner-logo-v1.png"
      }
    },
    "body": {
      "text": "Tap the button below to see available dates."
    },
    "action": {
      "name": "cta_url",
      "parameters": {
        "display_text": "See Dates",
        "url": "https://www.luckyshrub.com?clickID=kqDGWd24Q5TRwoEQTICY7W1JKoXvaZOXWAS7h1P76s0R7Paec4"
      }
    },
    "footer": {
      "text": "Dates subject to change."
    }
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Interactive list messages



Interactive list messages allow you to present WhatsApp users with a list of options to choose from (options are defined as rows in the request payload):

When a user taps the button in the message, WhatsApp displays a modal that lists the available options:

Users can then choose one option, and WhatsApp sends their selection as a reply:

Selecting an option triggers a webhook, which identifies the user's selected option.

Interactive list messages support up to 10 sections, with up to 10 rows for all sections combined, and can include an optional header and footer.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send an interactive list message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "interactive",
  "interactive": {
    "type": "list",
    "header": {
      "type": "text",
      "text": "<MESSAGE_HEADER_TEXT>"
    },
    "body": {
      "text": "<MESSAGE_BODY_TEXT>"
    },
    "footer": {
      "text": "<MESSAGE_FOOTER_TEXT>"
    },
    "action": {
      "button": "<BUTTON_TEXT>",
      "sections": [
        {
          "title": "<SECTION_TITLE_TEXT>",
          "rows": [
            {
              "id": "<ROW_ID>",
              "title": "<ROW_TITLE_TEXT>",
              "description": "<ROW_DESCRIPTION_TEXT>"
            }
            <!-- Additional rows would go here -->
          ]
        }
        <!-- Additional sections would go here -->
      ]
    }
  }
}'
```

## Request parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BUTTON_TEXT>`<br><br>_String_ | **Required.**<br><br>Button label text. When tapped, reveals rows (options the WhatsApp user can tap). Supports a single button.<br><br>Maximum 20 characters. | `Shipping Options` |
| `<MESSAGE_BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Message body text. Supports URLs.<br><br>Maximum 4096 characters. | `Which shipping option do you prefer?` |
| `<MESSAGE_FOOTER_TEXT>`<br><br>_String_ | **Optional.**<br><br>Message footer text.<br><br>Maximum 60 characters. | `Lucky Shrub: Your gateway to succulents™` |
| `<MESSAGE_HEADER_TEXT>`<br><br>_String_ | **Optional.**<br><br>The `header` object is optional. Supports `text` header type only.<br><br>Maximum 60 characters. | `Choose Shipping Option` |
| `<ROW_DESCRIPTION_TEXT>`<br><br>_String_ | **Optional.**<br><br>Row description.<br><br>Maximum 72 characters. | `Next Day to 2 Days` |
| `<ROW_ID>`<br><br>_String_ | **Required.**<br><br>Arbitrary string identifying the row. This ID will be included in the webhook payload if the user submits the selection.<br><br>At least one row is required. Supports up to 10 rows.<br><br>Maximum 200 characters. | `priority_express` |
| `<ROW_TITLE_TEXT>`<br><br>_String_ | **Required.**<br><br>Row title. At least 1 row is required. Supports up to 10 rows.<br><br>Maximum 24 characters. | `Priority Mail Express` |
| `<SECTION_TITLE_TEXT>`<br><br>_String_ | **Required.**<br><br>Section title text. At least 1 section is required. Supports up to 10 sections.<br><br>Maximum 24 characters. | `I want it ASAP!` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Example request

Example request to send an interactive list message with a header, body, footer, and two sections containing two rows each.

```html
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "interactive",
  "interactive": {
    "type": "list",
    "header": {
      "type": "text",
      "text": "Choose Shipping Option"
    },
    "body": {
      "text": "Which shipping option do you prefer?"
    },
    "footer": {
      "text": "Lucky Shrub: Your gateway to succulents™"
    },
    "action": {
      "button": "Shipping Options",
      "sections": [
        {
          "title": "I want it ASAP!",
          "rows": [
            {
              "id": "priority_express",
              "title": "Priority Mail Express",
              "description": "Next Day to 2 Days"
            },
            {
              "id": "priority_mail",
              "title": "Priority Mail",
              "description": "1–3 Days"
            }
          ]
        },
        {
          "title": "I can wait a bit",
          "rows": [
            {
              "id": "usps_ground_advantage",
              "title": "USPS Ground Advantage",
              "description": "2–5 Days"
            },
            {
              "id": "media_mail",
              "title": "Media Mail",
              "description": "2–8 Days"
            }
          ]
        }
      ]
    }
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```


## Webhooks

When a WhatsApp user selects an option and sends their message, WhatsApp triggers a **messages** webhook identifying the ID (`id`) of the option they chose.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Pablo Morales"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "15550783881",
                  "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBIwMjg0RkMxOEMyMkNEQUFFRDgA"
                },
                "from": "16505551234",
                "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQTZDMzFGRUFBQjlDMzIzMzlEQwA=",
                "timestamp": "1712595443",
                "type": "interactive",
                "interactive": {
                  "type": "list_reply",
                  "list_reply": {
                    "id": "priority_express",
                    "title": "Priority Mail Express",
                    "description": "Next Day to 2 Days"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Interactive media carousel messages


Interactive media carousel messages display a set of horizontally scrollable media cards. Each card can display an image or video header, body text, and either quick-reply buttons or a URL button.

For example, this is an interactive media card carousel message showing three cards in a scrollable area (highlighted by a dotted rectangle), each with an image header, body text, and URL button:

This is the same message, but using quick-reply buttons instead of URL buttons:

## Components

- Messages must include between 2 and 10 cards.
- Main message body text is required.
- Main message headers, footers, and interactive components are not supported.
- Cards must include either an image or video header. Other header types are not supported.
- Card body text is optional.
- Cards must include either one URL button, or one or more quick-reply buttons. Button types and numbers must match across all cards (for example, if you define a card with 2 quick-reply buttons, all cards must define exactly 2 quick-reply buttons).


## Request syntax

```html
curl 'https://graph.facebook.com/<API_VERSION>/<BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<USER_PHONE_NUMBER>",
  "type": "interactive",
  "interactive": {
    "type": "carousel",
    "body": {
      "text": "<MESSAGE_BODY_TEXT>"
    },
    "action": {

      <!-- First card object -->
      "cards": [
        {
          "card_index": <CARD_INDEX>,
          "type": "cta_url",
          "header": {
            "type": "<HEADER_TYPE>",
            "<HEADER_TYPE>": {
              "link": "<MEDIA_ASSET_URL>"
            }
          },

          <!-- Card body text is optional -->
          "body": {
            "text": "<CARD_BODY_TEXT>"
          },

          "action": {
            <!-- Only if using a URL button -->
            "name": "cta_url",
            "parameters": {
              "display_text": "<URL_BUTTON_LABEL>",
              "url": "<URL_BUTTON_URL>"
            }
            <!-- Only if using one or more quick-reply buttons -->
            "buttons": [
              {
                "type": "quick_reply",
                "quick_reply": {
                  "id": "<QUICK_REPLY_BUTTON_ID>",
                  "title": "<QUICK_REPLY_BUTTON_LABEL>"
                }
              },
              <!-- Additional quick-reply buttons would follow -->
          }
        },
        <!-- Additional card objects would follow -->
      ]
    }
  }
}'
```

## Request parameters

| Placeholder | Description | Example value |
| ----- | ----- | ----- |
| `<ACCESS_TOKEN>` 

 *String* | **Required.** 

 Access token. | `EAAJB...` |
| `<API_VERSION>` 

 *String* | **Optional.** 

 API version. | `v23.0` |
| `<BUSINESS_PHONE_NUMBER_ID>` 

 *Integer* | **Required.** 

 Business phone number ID. | `106540352242922` |
| `<CARD_BODY_TEXT>` 

 *String* | **Optional.** 

 Card body text. Max 160 characters, and up to 2 line breaks. | `*Blue Echeveria*\n\nA rosette-shaped succulent with powdery blue leaves, perfect for brightening up any space.` |
| `<CARD_INDEX>` 

 *Integer* | **Required.** 

 Zero-index card index. Cards will appear left to right in scrollable view, starting from 0\. | `0` |
| `<HEADER_TYPE>` 

 *String* | **Required.** 

 Header type. Value can be: 

 `image` — Indicates a card image header. 

 `video` — Indicates a card video header. 

 See [Supported media types](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media). | `image` |
| `<MEDIA_ASSET_URL>` 

 *String* | **Required.** 

 Publicly available media asset URL. | `https://www.luckyshrub.com/assets/blue-echeveria.jpeg` |
| `<MESSAGE_BODY_TEXT>` 

 *String* | **Required.** 

 Main message body text. Maximum 1024 characters. | `Of course! Here are three of our latest arrivals, each under $25:` |
| `<QUICK_REPLY_BUTTON_ID>` 

 *String* | **Required if using a quick-reply button.** 

 Quick-reply button ID. Maximum 256 characters. | `learn-blue-echeveria` |
| `<QUICK_REPLY_BUTTON_LABEL>` 

 *String* | **Required if using a quick-reply button.**

 Quick-reply button label text. Maximum 20 characters. | `Learn more` |
| `<URL_BUTTON_LABEL>` 

 *String* | **Required if using a URL button.** 

 URL button label text. Maximum 20 characters. | `Buy now` |
| `<URL_BUTTON_URL>` 

 *String* | **Required if using a URL button.** 

 URL to load in the device's default web browser when tapped by the user. | `https://shop.luckyshrub.com/latest/blue-echeveria` |
| `<USER_PHONE_NUMBER>` 

 *String* | **Required.** 

 WhatsApp user phone number. | `16505551234` |

## Example requests

### URL buttons example

This example request sends a media carousel message composed of 3 cards, each with an image header, card body text, and a URL button.

```curl
curl 'https://graph.facebook.com/v23.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "16505551234",
  "type": "interactive",
  "interactive": {
    "type": "carousel",
    "body": {
      "text": "Of course! Here are three of our latest arrivals, each under $25:"
    },
    "action": {
      "cards": [
        {
          "card_index": 0,
          "type": "cta_url",
          "header": {
            "type": "image",
            "image": {
              "link": "https://www.luckyshrub.com/assets/blue-echeveria.jpeg"
            }
          },
          "body": {
            "text": "*Blue Echeveria*\n\nA rosette-shaped succulent with powdery blue leaves, perfect for brightening up any space."
          },
          "action": {
            "name": "cta_url",
            "parameters": {
              "display_text": "Buy now",
              "url": "https://shop.luckyshrub.com/latest/blue-echeveria"
            }
          }
        },
        {
          "card_index": 1,
          "type": "cta_url",
          "header": {
            "type": "image",
            "image": {
              "link": "https://www.luckyshrub.com/assets/zebra-haworthia.jpeg"
            }
          },
          "body": {
            "text": "*Zebra Haworthia*\n\nStriking white stripes on deep green leaves give this compact succulent a bold, modern look."
          },
          "action": {
            "name": "cta_url",
            "parameters": {
              "display_text": "Buy now",
              "url": "https://shop.luckyshrub.com/latest/zebra-haworthia"
            }
          }
        },
        {
          "card_index": 2,
          "type": "cta_url",
          "header": {
            "type": "image",
            "image": {
              "link": "https://www.luckyshrub.com/assets/panda-plant.jpeg"
            }
          },
          "body": {
            "text": "*Panda Plant*\n\nSoft, fuzzy leaves with chocolate-brown edges—adorable and easy to care for."
          },
          "action": {
            "name": "cta_url",
            "parameters": {
              "display_text": "Buy now",
              "url": "https://shop.luckyshrub.com/latest/panda-plant"
            }
          }
        }
      ]
    }
  }
}'
```

### Quick-reply buttons example

This example request sends a media carousel message composed of 3 cards, each with an image header, card body text, and two quick-reply buttons.

```curl
curl 'https://graph.facebook.com/v23.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "16505551234",
  "type": "interactive",
  "interactive": {
    "type": "carousel",
    "body": {
      "text": "Of course! Here are three of our latest arrivals, each under $25:"
    },
    "action": {
      "cards": [
        {
          "card_index": 0,
          "type": "cta_url",
          "header": {
            "type": "image",
            "image": {
              "link": "https://www.luckyshrub.com/assets/blue-echeveria.jpeg"
            }
          },
          "body": {
            "text": "*Blue Echeveria*\n\nA rosette-shaped succulent with powdery blue leaves, perfect for brightening up any space."
          },
          "action": {
            "buttons": [
              {
                "type": "quick_reply",
                "quick_reply": {
                  "id": "learn-blue-echeveria",
                  "title": "Learn more"
                }
              },
              {
                "type": "quick_reply",
                "quick_reply": {
                  "id": "fav-blue-echeveria",
                  "title": "Add to favorites"
                }
              }
            ]
          }
        },
        {
          "card_index": 1,
          "type": "cta_url",
          "header": {
            "type": "image",
            "image": {
              "link": "https://www.luckyshrub.com/assets/zebra-haworthia.jpeg"
            }
          },
          "body": {
            "text": "*Zebra Haworthia*\n\nStriking white stripes on deep green leaves give this compact succulent a bold, modern look."
          },
          "action": {
            "buttons": [
              {
                "type": "quick_reply",
                "quick_reply": {
                  "id": "learn-zebra-haworthia",
                  "title": "Learn more"
                }
              },
              {
                "type": "quick_reply",
                "quick_reply": {
                  "id": "fav-zebra-haworthia",
                  "title": "Add to favorites"
                }
              }
            ]
          }
        },
        {
          "card_index": 2,
          "type": "cta_url",
          "header": {
            "type": "image",
            "image": {
              "link": "https://www.luckyshrub.com/assets/panda-plant.jpeg"
            }
          },
          "body": {
            "text": "*Panda Plant*\n\nSoft, fuzzy leaves with chocolate-brown edges—adorable and easy to care for."
          },
          "action": {
            "buttons": [
              {
                "type": "quick_reply",
                "quick_reply": {
                  "id": "learn-panda-plant",
                  "title": "Learn more"
                }
              },
              {
                "type": "quick_reply",
                "quick_reply": {
                  "id": "fav-panda-plant",
                  "title": "Add to favorites"
                }
              }
            ]
          }
        }
      ]
    }
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Interactive reply buttons messages



Interactive reply buttons messages allow you to send up to three predefined replies for users to choose from.

Users can respond to a message by selecting one of the predefined buttons, which triggers a messages webhook describing their selection.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send an interactive reply buttons message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": {<MESSAGE_HEADER>},
    "body": {
      "text": "<BODY_TEXT>"
    },
    "footer": {
      "text": "<FOOTER_TEXT>"
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": {
            "id": "<BUTTON_ID>",
            "title": "<BUTTON_LABEL_TEXT>"
          }
        }
        <!-- Additional buttons would go here (maximum 3) -->
      ]
    }
  }
}'
```

## Request parameters

| Placeholder | Description | Sample value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Body text. URLs are automatically hyperlinked.<br><br>Maximum 1024 characters. | `Hi Pablo! Your gardening workshop is scheduled for 9am tomorrow. Use the buttons if you need to reschedule. Thank you!` |
| `<BUTTON_ID>`<br><br>_String_ | **Required.**<br><br>A unique identifier for each button. Supports up to 3 buttons.<br><br>Maximum 256 characters. | `change-button` |
| `<BUTTON_LABEL_TEXT>`<br><br>_String_ | **Required.**<br><br>Button label text. Must be unique if using multiple buttons.<br><br>Maximum 20 characters. | `Change` |
| `<FOOTER_TEXT>`<br><br>_String_ | **Required if using a footer.**<br><br>Footer text. URLs are automatically hyperlinked.<br><br>Maximum 60 characters. | `Lucky Shrub: Your gateway to succulents!™` |
| `<MESSAGE_HEADER>`<br><br>_JSON Object_ | **Optional.**<br><br>Header content. Supports the following types:<br><br>* `document`<br>* `image`<br>* `text`<br>* `video`<br><br>Media assets can be sent using their [uploaded media](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media) `id` or URL `link` (not recommended). | Image header example using uploaded media ID (same basic structure for all media types):<br>`{ "type": "image", "image": { "id": "2762702990552401" }`<br><br><br>Image header example using hosted media:<br>`{ "type": "image", "image": { "link": "https://www.luckyshrub.com/media/workshop-banner.png" }`<br><br><br>Text header example:<br>`{ "type":"text", "text": "Workshop Details" }`<br> |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Example request

Example request to send an interactive reply buttons message with an image header, body text, footer text, and two reply buttons.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": {
      "type": "image",
      "image": {
        "id": "2762702990552401"
      }
    },
    "body": {
      "text": "Hi Pablo! Your gardening workshop is scheduled for 9am tomorrow. Use the buttons if you need to reschedule. Thank you!"
    },
    "footer": {
      "text": "Lucky Shrub: Your gateway to succulents!™"
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": {
            "id": "change-button",
            "title": "Change"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "cancel-button",
            "title": "Cancel"
          }
        }
      ]
    }
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```


## Webhooks

When a WhatsApp user taps on a reply button, a **messages** webhook is triggered that describes their selection in a `button_reply` object:

```json
"button_reply": {
  "id": "<BUTTON_ID>",
  "title": "<BUTTON_LABEL_TEXT>"
}
```

* `<BUTTON_ID>` — The button ID of the button tapped by the user.
* `<BUTTON_LABEL_TEXT>` — The button label text of the button tapped by the user.

### Example webhook

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Pablo Morales"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "15550783881",
                  "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBJBM0Y4RUU0RUNFQkFDMjYzQUMA"
                },
                "from": "16505551234",
                "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQThBREYwNzc2RDc2QjA1QTIwMgA=",
                "timestamp": "1714510003",
                "type": "interactive",
                "interactive": {
                  "type": "button_reply",
                  "button_reply": {
                    "id": "change-button",
                    "title": "Change"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Location messages



Location messages allow you to send a location's latitude and longitude coordinates to a WhatsApp user.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send a location message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "location",
  "location": {
    "latitude": "<LOCATION_LATITUDE>",
    "longitude": "<LOCATION_LONGITUDE>",
    "name": "<LOCATION_NAME>",
    "address": "<LOCATION_ADDRESS>"
  }
}'
```

## Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<LOCATION_ADDRESS>`<br><br>_String_ | **Optional.**<br><br>Location address. | `101 Forest Ave, Palo Alto, CA 94301` |
| `<LOCATION_LATITUDE>`<br><br>_String_ | **Required.**<br><br>Location latitude in decimal degrees. | `37.44216251868683` |
| `<LOCATION_LONGITUDE>`<br><br>_String_ | **Required.**<br><br>Location longitude in decimal degrees. | `-122.16153582049394` |
| `<LOCATION_NAME>`<br><br>_String_ | **Optional.**<br><br>Location name. | `Philz Coffee` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Example request

Example request to send a location message with a name and address.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "location",
  "location": {
    "latitude": "37.44216251868683",
    "longitude": "-122.16153582049394",
    "name": "Philz Coffee",
    "address": "101 Forest Ave, Palo Alto, CA 94301"
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Location request messages



Location request messages display **body text** and a **send location button**. When a WhatsApp user taps the button, a location sharing screen appears, which the user can then use to share their location.

Once the user shares their location, a **messages** webhook is triggered, containing the user's location details.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send a location request message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "type": "interactive",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "interactive": {
    "type": "location_request_message",
    "body": {
      "text": "<BODY_TEXT>"
    },
    "action": {
      "name": "send_location"
    }
  }
}'
```

## Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Message body text. Supports URLs.<br><br>Maximum 1024 characters. | `Let's start with your pickup. You can either manually *enter an address* or *share your current location*.` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Webhook syntax

When a WhatsApp user shares their location in response to your message, a **messages** webhook is triggered containing the user's location details.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<WHATSAPP_BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "<WHATSAPP_BUSINESS_PHONE_NUMBER>",
                  "id": "<WHATSAPP_CONTEXT_MESSAGE_ID>"
                },
                "from": "<WHATSAPP_USER_ID>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<TIMESTAMP>",
                "location": {
                  "address": "<LOCATION_ADDRESS>",
                  "latitude": <LOCATION_LATITUDE>,
                  "longitude": <LOCATION_LONGITUDE>,
                  "name": "<LOCATION_NAME>"
                },
                "type": "location"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Webhook parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<LOCATION_ADDRESS>`<br><br>_String_ | Location address.<br><br>This parameter appears only if the WhatsApp user chooses to share it. | `1071 5th Ave, New York, NY 10128` |
| `<LOCATION_LATITUDE>`<br><br>_Number_ | Location latitude in decimal degrees. | `40.782910059774` |
| `<LOCATION_LONGITUDE>`<br><br>_Number_ | Location longitude in decimal degrees. | `-73.959075808525` |
| `<LOCATION_NAME>`<br><br>_String_ | Location name.<br><br>This parameter appears only if the WhatsApp user chooses to share it. | `Solomon R. Guggenheim Museum` |
| `<TIMESTAMP>`<br><br>_String_ | UNIX timestamp indicating when our servers processed the WhatsApp user's message. | `1702920965` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business account ID. | `102290129340398` |
| `<WHATSAPP_BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | WhatsApp Business phone number's display number. | `15550783881` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER>`<br><br>_String_ | WhatsApp Business phone number. | `15550783881` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | WhatsApp Business phone number ID. | `106540352242922` |
| `<WHATSAPP_CONTEXT_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID of message that the user is responding to. | `wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1QjJGRjI1RDY0RkE4Nzg4QzcA` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID of the user's message. | `wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQTRCRDcwNzgzMTRDNTAwRTgwRQA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user's WhatsApp ID. | `16505551234` |
| `<WHATSAPP_USER_NAME>`<br><br>_String_ | WhatsApp user's name. | `Pablo Morales` |

## Example request

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "type": "interactive",
  "to": "+16505551234",
  "interactive": {
    "type": "location_request_message",
    "body": {
      "text": "Let'\''s start with your pickup. You can either manually *enter an address* or *share your current location*."
    },
    "action": {
      "name": "send_location"
    }
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBJCNUQ5RUNBNTk3OEQ2M0ZEQzgA"
    }
  ]
}
```

## Example webhook

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Pablo Morales"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "15550783881",
                  "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1QjJGRjI1RDY0RkE4Nzg4QzcA"
                },
                "from": "16505551234",
                "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQTRCRDcwNzgzMTRDNTAwRTgwRQA=",
                "timestamp": "1702920965",
                "location": {
                  "address": "1071 5th Ave, New York, NY 10128",
                  "latitude": 40.782910059774,
                  "longitude": -73.959075808525,
                  "name": "Solomon R. Guggenheim Museum"
                },
                "type": "location"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Reaction messages



Reaction messages are emoji-reactions that you can apply to a WhatsApp user message you received.

## Limitations

When you send a reaction message, WhatsApp triggers only a [sent message webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) (`status` set to `sent`); it does not trigger delivered or read message webhooks.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to apply an emoji reaction on a message you have received from a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "reaction",
  "reaction": {
    "message_id": "<WHATSAPP_MESSAGE_ID>",
    "emoji": "<EMOJI>"
  }
}'
```

## Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<EMOJI>`<br><br>_String_ | **Required.**<br><br>Unicode escape sequence of the emoji, or the emoji itself, to apply to the user message. | Unicode escape sequence example:<br><br>`\uD83D\uDE00`<br><br>Emoji example:<br><br>😀 |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp message ID of message you want to apply the emoji to.<br><br>If the message you are reacting to is more than 30 days old, doesn't correspond to any message in the chat thread, has been deleted, or is itself a reaction message, the reaction message will not be delivered and you will receive a **messages** webhook with error code `131009`. | `wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQUZCMTY0MDc2MUYwNzBDNTY5MAA=` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Example request

Example request to apply the grinning face emoji (😀) to a previously received user message.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "reaction",
  "reaction": {
    "message_id": "wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQUZCMTY0MDc2MUYwNzBDNTY5MAA=",
    "emoji": "\uD83D\uDE00"
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Sticker messages



Sticker messages display animated or static sticker images in a WhatsApp message.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send a sticker message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "sticker",
  "sticker": {
    "id": "<MEDIA_ID>", <!-- Only if using uploaded media -->
    "link": "<MEDIA_URL>", <!-- Only if using hosted media (not recommended) -->
  }
}'
```

### Post body parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<MEDIA_ID>`<br><br>_String_ | **Required if using uploaded media, otherwise omit.**<br><br>ID of the [uploaded media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media). | `1013859600285441` |
| `<MEDIA_URL>`<br><br>_String_ | **Required if using hosted media, otherwise omit.**<br><br>URL of the media asset hosted on your public server. For better performance, we recommend using `id` and an [uploaded media asset ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media) instead. | `https://www.luckyshrub.com/assets/animated-smiling-plant.webp` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Supported sticker formats

WhatsApp supports the following sticker file formats and size limits for sticker messages.

| Sticker Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| Animated sticker | .webp | image/webp | 500 KB |
| Static sticker | .webp | image/webp | 100 KB |

## Example request

Example request to send an animated sticker image to a WhatsApp user.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "sticker",
  "sticker": {
    "id" : "798882015472548"
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```


## Error handling

A request fails if the `<MEDIA_ID>` is invalid or has expired, if the sticker isn't a supported WebP type, or if the file exceeds the maximum size listed in [Supported sticker formats](#supported-sticker-formats). When a request fails, the API returns an error response instead of a message ID.

For the full list of error codes and recommended handling, see [WhatsApp Cloud API error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).
# Text messages



Text messages are messages containing only a text body and an optional link preview.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send a text message to a WhatsApp user.

```html
curl 'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "text",
  "text": {
    "preview_url": <ENABLE_LINK_PREVIEW>,
    "body": "<BODY_TEXT>"
  }
}'
```

### Request parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Body text. The WhatsApp client automatically hyperlinks URLs in the body text.<br><br>Maximum 4096 characters. | `As requested, here's the link to our latest product: https://www.meta.com/quest/quest-3/` |
| `<ENABLE_LINK_PREVIEW>`<br><br>_Boolean_ | **Optional.**<br><br>Set to `true` to have the WhatsApp client attempt to render a link preview of any URL in the body text string.<br><br>See [Link Preview](#link-preview) below. | `true` |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Link preview

You can have the WhatsApp client attempt to render a preview of the first URL in the body text string, if it contains one. URLs must begin with `http://` or `https://`. If the body text string contains multiple URLs, the WhatsApp client renders only the first URL.

If `preview_url` is omitted, or if the WhatsApp client cannot retrieve a link preview, the client renders a clickable link instead.

## Example request

Example request to send a text message with link previews enabled and a body text string that contains a link.

```html
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "text",
  "text": {
    "preview_url": true,
    "body": "As requested, here'\''s the link to our latest product: https://www.meta.com/quest/quest-3/"
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Video Messages



Video messages display a thumbnail preview of a video image with an optional caption. When the WhatsApp user taps the preview, it loads the video and displays it to the user.

## Sending video messages

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send a video message to a WhatsApp user.

### Request syntax

```https
POST /<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages
```


### Post body

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "{{wa-user-phone-number}}",
  "type": "video",
  "video": {
    "id" : "<MEDIA_ID>", /* Only if using uploaded media */
    "link": "<MEDIA_URL>", /* Only if linking to your media */
    "caption": "<VIDEO_CAPTION_TEXT>"
  }
}
```

### Post body parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<VIDEO_CAPTION_TEXT>`<br><br>_String_ | **Optional.**<br><br>Video caption text.<br><br>Maximum 1024 characters. | `A succulent eclipse!` |
| `<MEDIA_ID>`<br><br>_String_ | **Required if using an uploaded media asset (recommended)**.<br><br>[Uploaded media](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media) asset ID. | `1166846181421424` |
| `<MEDIA_URL>`<br><br>_String_ | **Required if linking to your media asset (not recommended)**<br><br>URL of video asset on your public server. For better performance, [upload your media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media) instead. | `https://www.luckyshrub.com/assets/lucky-shrub-eclipse-viewing.mp4` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Supported video formats

Only H.264 video codec and AAC audio codec supported. Single audio stream or no audio stream only.

Note that videos encoded with the H.264 "High" profile and B-frames are not supported by Android WhatsApp clients. We recommend that you use H.264 "Main" profile without B-frames, or the H.264 "Baseline" profile when encoding (or re-encoding with a tool like ffmpeg), and place moov boxes before mdat boxes, for broader compatibility. If you are using ffmpeg, you can use the -movflags faststart flag to place moov boxes before mdata boxes.

| Video Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| 3GPP | .3gp | video/3gpp | 16 MB |
| MP4 Video | .mp4 | video/mp4 | 16 MB |

## Example request

Example request to send a video message with a caption to a WhatsApp user.

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "video",
  "video": {
    "id" : "1166846181421424",
    "caption": "A succulent eclipse!"
  }
}'
```

## Example response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
# Webhooks


This document describes webhooks and how the WhatsApp Business Platform uses them.

Webhooks are HTTP requests containing JSON payloads that Meta's servers send to a server of your designation. The WhatsApp Business Platform uses webhooks to inform you of incoming messages, the status of outgoing messages, and other important information, such as changes to your account status, messaging capability upgrades, and changes to your template quality scores.

For example, this is a webhook describing a message sent from a WhatsApp user to a business:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1749416383",
                "type": "text",
                "text": {
                  "body": "Does it come in another color?"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Create a webhook endpoint

To receive webhooks, you must create and configure a webhook endpoint. To create your own endpoint, see the [Create a webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) document.

If you aren't ready to create your own endpoint yet, you can [create a test webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/set-up-whatsapp-echo-bot) that logs webhook payloads to the console. Note, however, that before you can use your app in a production capacity, you must create your own endpoint.

## Permissions

You need the following permissions to receive webhooks:

- **whatsapp_business_messaging** — for **messages** webhooks
- **whatsapp_business_management** — for all other webhooks

If you are a direct developer, use your system user to grant your app these permissions when generating your [system token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens).

If you are a [partner](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview) and need these permissions to provide appropriate services to your business customers, you must be approved for advanced access for the permissions via [App Review](https://developers.facebook.com/docs/app-review) before your business customers will be able to grant your app these permissions during onboarding.

## Fields

Once you have [created and configured](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) your webhook endpoint (or have set up a [test webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/set-up-whatsapp-echo-bot)), use the **[App Dashboard](https://developers.facebook.com/apps)** > **WhatsApp** > **Configuration** panel to subscribe to individual webhook fields.

Note that if you created your app using the **Connect with customers through WhatsApp** use case, navigate to **[App Dashboard](https://developers.facebook.com/apps)** > **Use cases** > **Customize** > **Configuration** instead.

| Field name | Description |
| --- | --- |
| [account_alerts](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_alerts) | The **account_alerts** webhook notifies you of changes to a business phone number's [messaging limit](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits), [business profile](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers#business-profiles), and [Official Business Account](https://developers.facebook.com/documentation/business-messaging/whatsapp/whatsapp-business-accounts#official-business-account) status. |
| [account_review_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_review_update) | The **account_review_update** webhook notifies you when a WhatsApp Business Account has been reviewed against our policy guidelines. |
| [account_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update) | The **account_update** webhook notifies of changes to a WhatsApp Business Account's [partner-led business verification](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/partner-led-business-verification) submission, its [authentication-international rate](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/authentication-international-rates) eligibility, or primary business location, when it is shared with a [Solution Partner](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview), [policy or terms violations](https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement), offboarding, reconnection, or when it is deleted. |
| [automatic_events](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/automatic_events) | The **automatic_events** webhook notifies you when we detect a purchase or lead event in a chat thread between you and a WhatsApp user who has messaged you via your Click to WhatsApp ad, if you have opted-in to [Automatic Events](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/automatic-events-api) reporting. |
| [business_capability_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/business_capability_update) | The **business_capability_update** webhook notifies you of WhatsApp Business Account or business portfolio capability changes ([messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits#increasing-your-limit), [phone number limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers#registered-number-cap), etc.). |
| [history](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history) | The **history** webhook is used to synchronize the [WhatsApp Business app chat history](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) of a business customer onboarded by a solution provider. |
| [message_template_components_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_components_update) | The **message_template_components_update** webhook notifies you of changes to a template's components. |
| [message_template_quality_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_quality_update) | The **message_template_quality_update** webhook notifies you of changes to a template's [quality score](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality). |
| [message_template_status_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update) | The **message_template_status_update** webhook notifies you of changes to the status of an existing template. |
| [messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages) | The **messages** webhook describes messages sent from a WhatsApp user to a business and the status of messages sent by a business to a WhatsApp user. |
| [partner_solutions](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/partner_solutions) | The **partner_solutions webhook** describes changes to the status of a [Multi-Partner Solution](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/multi-partner-solutions). |
| [payment_configuration_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/payment_configuration_update) | The **payment_configuration_update** webhook notifies you of changes to payment configurations for [Payments API India](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-in/overview) and [Payments API Brazil](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-br/overview). |
| [phone_number_name_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/phone_number_name_update) | The **phone_number_name_update** webhook notifies you of business phone number [display name verification](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names#display-name-verificationn) outcomes. |
| [phone_number_quality_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/phone_number_quality_update) | The **phone_number_quality_update** webhook notifies you of changes to a business phone number's [throughput level](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput). |
| [security](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/security) | The **security** webhook notifies you of changes to a business phone number's security settings. |
| [smb_app_state_sync](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_app_state_sync) | The **smb_app_state_sync** webhook is used for synchronizing contacts of [WhatsApp Business app users who have been onboarded](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) via a solution provider. |
| [smb_message_echoes](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes) | The **smb_message_echoes** webhook notifies you of messages sent via the WhatsApp Business app or a [companion ("linked") device](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users#linked-devices) by a business customer who has been [onboarded to Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) via a solution provider. |
| [template_category_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/template_category_update) | The **template_category_update** webhook notifies you of changes to template's [category](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization). |
| [user_preferences](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/user_preferences) | The **user_preferences** webhook notifies you of changes to a WhatsApp user's [marketing message preferences](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates#user-preferences-for-marketing-messages). |

## Override webhooks

You can use an alternate webhook endpoint for [certain webhook fields](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override#supported-webhook-fields) for your WhatsApp Business account (WABA) or business phone number. An alternate endpoint can be useful for testing purposes, or if you are a partner and wish to use unique webhook endpoints for each of your onboarded customers.

See the [Webhook overrides](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override) document to learn how to override webhooks.

## Payload size

Webhook payloads can be up to 3 MB.

## Webhook delivery failure

If a webhook request to your endpoint receives an HTTP status code other than 200, or if the webhook cannot be delivered for another reason, Meta retries delivery with decreasing frequency until the request succeeds, for up to 7 days.

Note that Meta sends retries to all apps that have subscribed to webhooks (and their appropriate fields) for the WhatsApp Business account. These retries can result in duplicate webhook notifications.

## Mutual TLS

Webhooks support mutual TLS (mTLS) for added security. See Graph API's [mTLS for webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started#mtls-for-webhooks) document to learn how to enable and use mTLS.

## IP addresses

You can get the IP addresses of Meta's webhook servers by running the following command in your terminal:

```bash
whois -h whois.radb.net — '-i origin AS32934' | grep '^route' | awk '{print $2}' | sort
```

You can also use the geofeed to [download a CSV](https://facebook.com/peering/geofeed) that lists Meta's IP addresses.

Note, however, that Meta periodically changes its IP addresses, so to avoid having to regenerate your list of allowed IP addresses, consider [using mTLS instead](https://developers.facebook.com/docs/graph-api/webhooks/getting-started#mtls-for-webhooks).

## Troubleshooting

If you are not receiving webhooks:

- Make sure your endpoint is accepting requests.
- Send a test payload to your endpoint via the **[App Dashboard](https://developers.facebook.com/apps)** > **WhatsApp** > **Configurations** panel.
- Make sure your app is in **Live** mode; some webhooks will not be sent if your app is in **Dev** mode.
- Use the [test webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/set-up-whatsapp-echo-bot). If the test endpoint is digesting webhook payloads and displaying them in the console, the issue is likely with your endpoint code.

## Learn more

- See the [Using Node.js to implement webhooks](https://business.whatsapp.com/blog/how-to-use-webhooks-from-whatsapp-business-api) WhatsApp Business blog post.

# message_template_components_update webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account `message_template_components_update` webhook.

The **message_template_components_update** webhook notifies you of changes to a template's components.


## Triggers

- A template is edited.

## Syntax

```html
{
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "time": <WEBHOOK_TRIGGER_TIMESTAMP>,
      "changes": [
        {
          "value": {
            "message_template_id": <TEMPLATE_ID>,
            "message_template_name": "<TEMPLATE_NAME>",
            "message_template_language": "<TEMPLATE_LANGUAGE_AND_LOCALE_CODE>",
            "message_template_element": "<TEMPLATE_BODY_TEXT>,

            <!-- only included if template has a text header -->
            "message_template_title": "<TEMPLATE_HEADER_TEXT>",

            <!-- only included if template has a footer -->
            "message_template_footer": "<TEMPLATE_FOOTER_TEXT>",

            <!-- only included if template has a url or phone number button -->
            "message_template_buttons": [
              {
                "message_template_button_type": "<BUTTON_TYPE>",
                "message_template_button_text": "<BUTTON_LABEL_TEXT>",

                <!--only included for url buttons -->
                "message_template_button_url": "<BUTTON_URL>",

                <!--only included for phone number buttons -->
                "message_template_button_phone_number": "<BUTTON_PHONE_NUMBER>"
              }
            ]
          },
          "field": "message_template_components_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUTTON_LABEL_TEXT>`<br><br>_String_ | Button label text. | `Email support` |
| `<BUTTON_PHONE_NUMBER>`<br><br>_String_ | Button phone number. | `+15550783881` |
| `<BUTTON_TYPE>`<br><br>_String_ | [Button type](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components#buttons).<br><br>Values can include:<br><br>- `CATALOG`<br>- `COPY_CODE`<br>- `EXTENSION`<br>- `FLOW`, `MPM`<br>- `ORDER_DETAILS`<br>- `OTP`<br>- `PHONE_NUMBER`<br>- `POSTBACK`<br>- `REMINDER`<br>- `SEND_LOCATION`<br>- `SPM`<br>- `QUICK_REPLY`<br>- `URL`<br>- `VOICE_CALL` | `URL` |
| `<BUTTON_URL>`<br><br>_String_ | Button URL. | `https://www.luckyshrub.com/support` |
| `<TEMPLATE_BODY_TEXT>`<br><br>_String_ | Template body text. | `Thank you for your order, {{1}}! Your order number is {{2}}. If you have any questions, contact support using the buttons below. Thanks again!` |
| `<TEMPLATE_FOOTER_TEXT>`<br><br>_String_ | Template footer text. | `Lucky Shrub: the Succulent Specialists!` |
| `<TEMPLATE_HEADER_TEXT>`<br><br>_String_ | Template header text. | `Your order is confirmed!` |
| `<TEMPLATE_ID>`<br><br>_Integer_ | Template ID. | `1315502779341834` |
| `<TEMPLATE_LANGUAGE_AND_LOCALE_CODE>`<br><br>_String_ | Template [language and locale](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages) code. | `en_US` |
| `<TEMPLATE_NAME>`<br><br>_String_ | Template name. | `order_confirmation` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_Integer_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |

## Example

```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1751250234,
      "changes": [
        {
          "value": {
            "message_template_id": 1315502779341834,
            "message_template_name": "order_confirmation",
            "message_template_language": "en_US",
            "message_template_title": "Your order is confirmed!",
            "message_template_element": "Thank you for your order, {{1}}! Your order number is {{2}}. If you have any questions, contact support using the buttons below. Thanks again!",
            "message_template_footer": "Lucky Shrub: the Succulent Specialists!",
            "message_template_buttons": [
              {
                "message_template_button_type": "PHONE_NUMBER",
                "message_template_button_text": "Phone support",
                "message_template_button_phone_number": "+15550783881"
              },
              {
                "message_template_button_type": "URL",
                "message_template_button_text": "Email support",
                "message_template_button_url": "https://www.luckyshrub.com/support"
              }
            ]
          },
          "field": "message_template_components_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```# message_template_quality_update webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account `message_template_quality_update` webhook.

The **message_template_quality_update** webhook notifies you of changes to a template's [quality score](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality).


## Triggers

- A template's quality score changes.

## Syntax

```html
{
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "time": <WEBHOOK_TRIGGER_TIMESTAMP>,
      "changes": [
        {
          "value": {
            "previous_quality_score": "<PREVIOUS_QUALITY_SCORE>",
            "new_quality_score": "<NEW_QUALITY_SCORE>",
            "message_template_id": <TEMPLATE_ID>,
            "message_template_name": "<TEMPLATE_NAME>",
            "message_template_language": "<TEMPLATE_LANGUAGE_AND_LOCALE_CODE>"
          },
          "field": "message_template_quality_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<NEW_QUALITY_SCORE>`<br><br>_String_ | New template [quality score](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality).<br><br>Values can be:<br><br>`GREEN` — Indicates high quality.<br><br>`RED` — Indicates low quality.<br><br>`YELLOW` — Indicates medium quality.<br><br>`UNKNOWN` — Indicates quality pending. | `GREEN` |
| `<PREVIOUS_QUALITY_SCORE>`<br><br>_String_ | Previous template [quality score](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality).<br><br>Values can be:<br><br>`GREEN` — Indicates high quality.<br><br>`RED` — Indicates low quality.<br><br>`YELLOW` — Indicates medium quality.<br><br>`UNKNOWN` — Indicates quality pending. | `YELLOW` |
| `<TEMPLATE_ID>`<br><br>_Integer_ | Template ID. | `806312974732579` |
| `<TEMPLATE_NAME>`<br><br>_String_ | Template name. | `welcome_template` |
| `<TEMPLATE_LANGUAGE_AND_LOCALE_CODE>`<br><br>_String_ | Template [language and locale](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages) code. | `en-US` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_Integer_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |

## Example

```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1674864290,
      "changes": [
        {
          "value": {
            "previous_quality_score": "GREEN",
            "new_quality_score": "YELLOW",
            "message_template_id": 806312974732579,
            "message_template_name": "welcome_template",
            "message_template_language": "en-US"
          },
          "field": "message_template_quality_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```
# message_template_status_update webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business Account `message_template_status_update` webhook.

The **message_template_status_update** webhook notifies you of changes to the status of an existing template.


## Triggers

- A template is approved.
- A template is rejected.
- A template is disabled.
- A template is archived.
- A template is unarchived.

## Syntax

```html
{
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "time": <WEBHOOK_TRIGGER_TIMESTAMP>,
      "changes": [
        {
          "value": {
            "event": "<EVENT>",
            "message_template_id": <TEMPLATE_ID>,
            "message_template_name": "<TEMPLATE_NAME>",
            "message_template_language": "<TEMPLATE_LANGUAGE_AND_LOCALE_CODE>",
            "reason": "<REASON>",
            "message_template_category": "<TEMPLATE_CATEGORY>",

            <!-- only included if template disabled -->
            "disable_info": {
              "disable_date": "<DISABLE_TIMESTAMP>"
            },

            <!-- only included if template locked or unlocked -->
            "other_info": {
              "title": "<TITLE>",
              "description": "<DESCRIPTION>"
            },

            <!-- only included if template rejected with INVALID_FORMAT reason -->
            "rejection_info": {
              "reason": "<REASON_INFO>",
              "recommendation": "<RECOMMENDATION_INFO>"
            }
          },
          "field": "message_template_status_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<DESCRIPTION>`<br><br>_String_ | String describing why the template was locked or unlocked. | Your WhatsApp message template has been unpaused. |
| `<DISABLE_TIMESTAMP>`<br><br>_Integer_ | Unix timestamp indicating when the template was disabled. | `1751234563` |
| `<EVENT>`<br><br>_String_ | Template status event. Values can be:<br><br>`APPROVED` — Indicates the template has been approved and can now be sent in template messages.<br><br>`ARCHIVED` — Indicates the template has been [archived](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-archival) due to inactivity. Archived templates are scheduled for deletion after 28 days unless unarchived.<br><br>`UNARCHIVED` — Indicates the template has been [unarchived](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-archival) and restored to its previous status.<br><br>`DELETED` — Indicates the template has been deleted.<br><br>`DISABLED` — Indicates the template has been disabled due to user [feedback](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality).<br><br>`FLAGGED` — Indicates the template has received negative feedback and is at risk of being disabled.<br><br>`IN_APPEAL` — Indicates the template is in the [appeal](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review#appeals) process.<br><br>`LIMIT_EXCEEDED` — Indicates the WhatsApp Business Account template is at its [template limit](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview).<br><br>`LOCKED` — Indicates the template has been locked and cannot be edited.<br><br>`PAUSED` — Indicates the template has been [paused](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing).<br><br>`PENDING` — Indicates the template is undergoing template review.<br><br>`REINSTATED` — Indicates the template is no longer flagged or disabled and can be sent in template messages again.<br><br>`PENDING_DELETION` — Indicates template has been deleted via WhatsApp Manager.<br><br>`REJECTED` — Indicates the template has been rejected. You can [edit the template](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview) to have it undergo template review again or [appeal](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review#appeals) the rejection. | `APPROVED` |
| `<TEMPLATE_ID>`<br><br>_Integer_ | Template ID. | `1689556908129832` |
| `<TEMPLATE_NAME>`<br><br>_String_ | Template name. | `order_confirmation` |
| `<TEMPLATE_LANGUAGE_AND_LOCALE_CODE>`<br><br>_String_ | Template [language and locale](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages) code. | `en-US` |
| `<REASON>`<br><br>_String_ | Template rejection reason, if rejected.<br><br>If the template is scheduled for deletion, the value is `null` instead of a string. Otherwise, values can be:<br><br>`ABUSIVE_CONTENT` — Indicates template contains content that violates our policies.<br><br>`CATEGORY_NOT_AVAILABLE` — (Deprecated) Indicates an authentication templates for an unsupported region.<br><br>`INCORRECT_CATEGORY` — Indicates the template's content doesn't match the category designated at the time of template creation.<br><br>`INVALID_FORMAT` — Indicates template has an invalid format.<br><br>`NONE` — Indicates template was paused.<br><br>`PROMOTIONAL` — Indicates template contains content that violates our policies.<br><br>`SCAM` — Indicates template contains content that violates our policies.<br><br>`TAG_CONTENT_MISMATCH` — Indicates the template's content doesn't match the category designated at the time of template creation. | `INVALID_FORMAT` |
| `<TITLE>`<br><br>_String_ | Title of template pause or unpause event.<br><br>Values can be:<br><br>`FIRST_PAUSE` — Indicates template has been paused for the first time.<br><br>`SECOND_PAUSE` — Indicates the template has been paused a second time.<br><br>`RATE_LIMITING_PAUSE` — Indicates template has been paused due to rate limiting.<br><br>`UNPAUSE` — Indicates template has been unpaused.<br><br>`DISABLED` — Indicates template has been disabled. | `FIRST_PAUSE` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_Integer_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<MESSAGE_TEMPLATE_CATEGORY>`<br><br>_String_ | The template category.<br><br>Values can be:<br><br>`MARKETING` — Indicates template is categorized as MARKETING.<br><br>`UTILITY` — Indicates the template is categorized as UTILITY.<br><br>`AUTHENTICATION` — Indicates template is categorized as AUTHENTICATION. | `MARKETING` |
| `<REASON_INFO>`<br><br>_String_ | Provides a detailed explanation for why the template was rejected. This field describes the specific issue detected in the template content. | `Your template has parameters placed next to each other (like {{1}}{{2}}) without text or punctuation between them.` |
| `<RECOMMENDATION_INFO>`<br><br>_String_ | Offers actionable guidance on how to modify the template to resolve the rejection reason. This field suggests best practices for editing the template content. | `Separate parameters with descriptive text and ensure each parameter is clearly contextualized.` |

## Example

This example webhook describes a template that has been approved.

```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1751247548,
      "changes": [
        {
          "value": {
            "event": "APPROVED",
            "message_template_id": 1689556908129832,
            "message_template_name": "order_confirmation",
            "message_template_language": "en-US",
            "reason": "NONE",
            "message_template_category": "UTILITY"
          },
          "field": "message_template_status_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

This example webhook describes a template that has been rejected with INVALID_FORMAT.

```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1751247548,
      "changes": [
        {
          "value": {
            "event": "REJECTED",
            "message_template_id": 1689556908129835,
            "message_template_name": "abandoned_cart",
            "message_template_language": "en",
            "reason": "INVALID_FORMAT",
            "message_template_category": "MARKETING",
            "rejection_info": {
              "reason": "Your template has parameters placed next to each other (like {{1}}{{2}}) without text or punctuation between them.",
              "recommendation": "Separate parameters with descriptive text and ensure each parameter is clearly contextualized."
            }
          },
          "field": "message_template_status_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

# Audio messages webhook reference


This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for messages containing an audio recording.

## Triggers

- A WhatsApp user sends a WhatsApp audio recording, or audio file, to a business.
- A WhatsApp user sends a WhatsApp audio recording, or audio file, to a business via a Click to WhatsApp ad.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "audio",
                "audio": {
                  "mime_type": "<MEDIA_ASSET_MIME_TYPE>",
                  "sha256": "<MEDIA_ASSET_SHA256_HASH>",
                  "id": "<MEDIA_ASSET_ID>",
                  "url": "<MEDIA_ASSET_URL>",
                  "voice": <IS_VOICE_RECORDING?>
                },

                <!-- only included if message sent via a Click to WhatsApp ad -->
                "referral": {
                  "source_url": "<AD_URL>",
                  "source_id": "<AD_ID>",
                  "source_type": "ad",
                  "body": "<AD_PRIMARY_TEXT>",
                  "headline": "<AD_HEADLINE>",
                  "media_type": "<AD_MEDIA_TYPE>",
                  "image_url": "<AD_IMAGE_URL>",
                  "video_url": "<AD_VIDEO_URL>",
                  "thumbnail_url": "<AD_VIDEO_THUMBNAIL>",
                  "ctwa_clid": "<AD_CLICK_ID>",
                  "welcome_message": {
                    "text": "<AD_GREETING_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<AD_CLICK_ID>`<br><br>_String_ | Click to WhatsApp ad click ID.<br><br>The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)). | `Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50` |
| `<AD_GREETING_TEXT>`<br><br>_String_ | Click to WhatsApp ad greeting text. | `Hi there! Let us know how we can help!` |
| `<AD_HEADLINE>`<br><br>_String_ | Click to WhatsApp ad headline. | `Chat with us` |
| `<AD_ID>`<br><br>_String_ | Click to WhatsApp ad ID. | `120226305854810726` |
| `<AD_IMAGE_URL>`<br><br>_String_ | Click to WhatsApp ad image URL. Only included if the ad is an image ad. | `https://scontent.xx.fbcdn.net/v/t45.1...` |
| `<AD_MEDIA_TYPE>`<br><br>_String_ | Click to WhatsApp ad media type. Values can be:<br><br>`image` — Indicates an image ad.<br><br>`video` — Indicates a video ad. | `image` |
| `<AD_PRIMARY_TEXT>`<br><br>_String_ | Click to WhatsApp ad primary text. | `Summer succulents are here!` |
| `<AD_URL>`<br><br>_String_ | Click to WhatsApp ad URL. | `https://fb.me/3cr4Wqqkv` |
| `<AD_VIDEO_THUMBNAIL>`<br><br>_String_ | Click to WhatsApp ad video thumbnail URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.3...` |
| `<AD_VIDEO_URL>`<br><br>_String_ | Click to WhatsApp ad video URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.2...` |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<IS_VOICE_RECORDING?>`<br><br>_Boolean_ | Boolean indicating if audio is a recording made with the WhatsApp client voice recording feature (`true`) or not (`false`). | `true` |
| `<MEDIA_ASSET_ID>`<br><br>_String_ | Media asset ID. You can [perform a GET on this ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media) to get the asset URL, then perform a GET on the returned URL (using your access token) to get the underlying asset. | `1003383421387256` |
| `<MEDIA_ASSET_MIME_TYPE>`<br><br>_String_ | Media asset MIME type. | `audio/ogg; codecs=opus` |
| `<MEDIA_ASSET_SHA256_HASH>`<br><br>_String_ | Media asset SHA-256 hash. | `SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=` |
| `<MEDIA_ASSET_URL>`<br><br>_String_ | **This JSON property is being released to developers gradually over several weeks, starting November 12, 2025, and may not be available to you immediately.**<br><br>Media URL. You can query this URL directly with your access token to [download the media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#download-media). | `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1744344496",
                "type": "audio",
                "audio": {
                  "mime_type": "audio/ogg; codecs=opus",
                  "sha256": "wvqXMe6n7n1W0zphvLPoLj+s/NtKqmr3zZ7YzTP7xFI=",
                  "id": "1908647269898587",
                  "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...",
                  "voice": true
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Button messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for quick-reply button messages.

## Triggers

- A WhatsApp user taps a quick-reply button in a template message.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
                  "id": "<CONTEXTUAL_WHATSAPP_MESSAGE_ID>"
                },
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "button",
                "button": {
                  "payload": "<BUTTON_LABEL_TEXT>",
                  "text": "<BUTTON_LABEL_TEXT>"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<BUTTON_LABEL_TEXT>`<br><br>_String_ | Quick-reply button label text. | `Unsubscribe` |
| `<CONTEXTUAL_WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID of the message containing the button the WhatsApp user tapped. | `wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

The following example shows a quick-reply button messages webhook payload.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "15550783881",
                  "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA="
                },
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "timestamp": "1750091045",
                "type": "button",
                "button": {
                  "payload": "Unsubscribe",
                  "text": "Unsubscribe"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

# Contacts messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for messages containing one or more contacts.

## Triggers

- A WhatsApp user sends one or more contacts to a business.
- A WhatsApp user sends one or more contacts to a business via a Click to WhatsApp ad.

## Syntax

Many contact properties may be omitted if the WhatsApp user chooses not to share them or if their device prevents sharing.

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "contacts",
                "contacts": [
                  {
                    "addresses": [
                      {
                        "city": "<CONTACT_CITY>",
                        "country": "<CONTACT_COUNTRY>",
                        "country_code": "<CONTACT_COUNTRY_CODE>",
                        "state": "<CONTACT_STATE>",
                        "street": "<CONTACT_STREET>",
                        "type": "<CONTACT_ADDRESS_TYPE>",
                        "zip": "<CONTACT_ZIP>"
                      }
                    ],
                    "birthday": "<CONTACT_BIRTHDAY>",
                    "emails": [
                      {
                        "email": "<CONTACT_EMAIL>",
                        "type": "<CONTACT_EMAIL_TYPE>"
                      }
                    ],
                    "name": {
                      "formatted_name": "<CONTACT_FORMATTED_NAME>",
                      "first_name": "<CONTACT_FIRST_NAME>",
                      "last_name": "<CONTACT_LAST_NAME>",
                      "middle_name": "<CONTACT_MIDDLE_NAME>",
                      "suffix": "<CONTACT_NAME_SUFFIX>",
                      "prefix": "<CONTACT_NAME_PREFIX>"
                    },
                    "org": {
                      "company": "<CONTACT_ORG_COMPANY>",
                      "department": "<CONTACT_ORG_DEPARTMENT>",
                      "title": "<CONTACT_ORG_TITLE>"
                    },
                    "phones": [
                      {
                        "phone": "<CONTACT_PHONE>",
                        "wa_id": "<CONTACT_WHATSAPP_PHONE_NUMBER>",
                        "type": "<CONTACT_PHONE_TYPE>"
                      }
                    ],
                    "urls": [
                      {
                        "url": "<CONTACT_URL>",
                        "type": "<CONTACT_URL_TYPE>"
                      }
                    ]
                  }
                ],

                <!-- only included if message sent via a Click to WhatsApp ad -->
                "referral": {
                  "source_url": "<AD_URL>",
                  "source_id": "<AD_ID>",
                  "source_type": "ad",
                  "body": "<AD_PRIMARY_TEXT>",
                  "headline": "<AD_HEADLINE>",
                  "media_type": "<AD_MEDIA_TYPE>",
                  "image_url": "<AD_IMAGE_URL>",
                  "video_url": "<AD_VIDEO_URL>",
                  "thumbnail_url": "<AD_VIDEO_THUMBNAIL>",
                  "ctwa_clid": "<AD_CLICK_ID>",
                  "welcome_message": {
                    "text": "<AD_GREETING_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<AD_CLICK_ID>`<br><br>_String_ | Click to WhatsApp ad click ID.<br><br>The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)). | `Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50` |
| `<AD_GREETING_TEXT>`<br><br>_String_ | Click to WhatsApp ad greeting text. | `Hi there! Let us know how we can help!` |
| `<AD_HEADLINE>`<br><br>_String_ | Click to WhatsApp ad headline. | `Chat with us` |
| `<AD_ID>`<br><br>_String_ | Click to WhatsApp ad ID. | `120226305854810726` |
| `<AD_IMAGE_URL>`<br><br>_String_ | Click to WhatsApp ad image URL. Only included if the ad is an image ad. | `https://scontent.xx.fbcdn.net/v/t45.1...` |
| `<AD_MEDIA_TYPE>`<br><br>_String_ | Click to WhatsApp ad media type. Values can be:<br><br>`image` — Indicates an image ad.<br><br>`video` — Indicates a video ad. | `image` |
| `<AD_PRIMARY_TEXT>`<br><br>_String_ | Click to WhatsApp ad primary text. | `Summer succulents are here!` |
| `<AD_URL>`<br><br>_String_ | Click to WhatsApp ad URL. | `https://fb.me/3cr4Wqqkv` |
| `<AD_VIDEO_THUMBNAIL>`<br><br>_String_ | Click to WhatsApp ad video thumbnail URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.3...` |
| `<AD_VIDEO_URL>`<br><br>_String_ | Click to WhatsApp ad video URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.2...` |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<CONTACT_ADDRESS_TYPE>`<br><br>_String_ | The type of address, such as home or work. | `Home` |
| `<CONTACT_BIRTHDAY>`<br><br>_String_ | The contact's birthday. | `1999-01-23` |
| `<CONTACT_CITY>`<br><br>_String_ | City mentioned in the contact address. | `Menlo Park` |
| `<CONTACT_COUNTRY_CODE>`<br><br>_String_ | ISO country code on the contact address. | `US` |
| `<CONTACT_COUNTRY>`<br><br>_String_ | Country mentioned in the contact address. | `United States` |
| `<CONTACT_EMAIL_TYPE>`<br><br>_String_ | Type of email, such as personal or work. | `Personal` |
| `<CONTACT_EMAIL>`<br><br>_String_ | Email address of the contact. | `bjohson@socialtsunami.com` |
| `<CONTACT_FIRST_NAME>`<br><br>_String_ | Contact's first name. | `Barbara` |
| `<CONTACT_FORMATTED_NAME>`<br><br>_String_ | Contact's formatted name. | `Barbara J. Johnson` |
| `<CONTACT_LAST_NAME>`<br><br>_String_ | Contact's last name. | `Johnson` |
| `<CONTACT_MIDDLE_NAME>`<br><br>_String_ | Contact's middle name. | `Joana` |
| `<CONTACT_NAME_PREFIX>`<br><br>_String_ | Contact's name prefix. | `Dr.` |
| `<CONTACT_NAME_SUFFIX>`<br><br>_String_ | Contact's name suffix. | `Esq.` |
| `<CONTACT_ORG_COMPANY>`<br><br>_String_ | Name of the company where the contact works. | `Social Tsunami` |
| `<CONTACT_ORG_DEPARTMENT>`<br><br>_String_ | Name of the department where the contact works. | `Engineering` |
| `<CONTACT_ORG_TITLE>`<br><br>_String_ | Contact's job title. | `Software Engineer` |
| `<CONTACT_PHONE_TYPE>`<br><br>_String_ | Type of phone number. For example, cell, mobile, main, iPhone, home, or work. | `CELL` |
| `<CONTACT_PHONE>`<br><br>_String_ | Contact's phone number. | `+14125550829` |
| `<CONTACT_STATE>`<br><br>_String_ | State mentioned in the contact address. | `CA` |
| `<CONTACT_STREET>`<br><br>_String_ | Street mentioned in the contact address. | `1 Hacker Way` |
| `<CONTACT_URL_TYPE>`<br><br>_String_ | Type of website. For example, company, work, personal, Facebook Page, or Instagram. | `Company` |
| `<CONTACT_URL>`<br><br>_String_ | Website URL associated with the contact or their company. | `socialtsunami.com` |
| `<CONTACT_WHATSAPP_PHONE_NUMBER>`<br><br>_String_ | Contact's WhatsApp number. | `14125550829` |
| `<CONTACT_ZIP>`<br><br>_String_ | Zip code in the contact address. | `94025` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1744344496",
                "type": "contacts",
                "contacts": [
                  {
                    "name": {
                      "first_name": "Barbara",
                      "last_name": "Johnson",
                      "formatted_name": "Barbara J. Johnson"
                    },
                    "org": {
                      "company": "Social Tsunami"
                    },
                    "phones": [
                      {
                        "phone": "+1 (415) 555-0829",
                        "wa_id": "14125550829",
                        "type": "MOBILE"
                      }
                    ]
                  }
                ]
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Document messages webhook reference


This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for messages containing a document.

## Triggers

- A WhatsApp user sends a document to a business.
- A WhatsApp user sends a document to a business via a Click to WhatsApp ad.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "document",
                "document": {
                  "caption": "<MEDIA_ASSET_CAPTION>",
                  "filename": "<MEDIA_ASSET_FILENAME>",
                  "mime_type": "<MEDIA_ASSET_MIME_TYPE>",
                  "sha256": "<MEDIA_ASSET_SHA256_HASH>",
                  "id": "<MEDIA_ASSET_ID>",
                  "url": "<MEDIA_ASSET_URL>"
                },

                <!-- only included if message sent via a Click to WhatsApp ad -->
                "referral": {
                  "source_url": "<AD_URL>",
                  "source_id": "<AD_ID>",
                  "source_type": "ad",
                  "body": "<AD_PRIMARY_TEXT>",
                  "headline": "<AD_HEADLINE>",
                  "media_type": "<AD_MEDIA_TYPE>",
                  "image_url": "<AD_IMAGE_URL>",
                  "video_url": "<AD_VIDEO_URL>",
                  "thumbnail_url": "<AD_VIDEO_THUMBNAIL>",
                  "ctwa_clid": "<AD_CLICK_ID>",
                  "welcome_message": {
                    "text": "<AD_GREETING_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<AD_CLICK_ID>`<br><br>_String_ | Click to WhatsApp ad click ID.<br><br>The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)). | `Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50` |
| `<AD_GREETING_TEXT>`<br><br>_String_ | Click to WhatsApp ad greeting text. | `Hi there! Let us know how we can help!` |
| `<AD_HEADLINE>`<br><br>_String_ | Click to WhatsApp ad headline. | `Chat with us` |
| `<AD_ID>`<br><br>_String_ | Click to WhatsApp ad ID. | `120226305854810726` |
| `<AD_IMAGE_URL>`<br><br>_String_ | Click to WhatsApp ad image URL. Only included if the ad is an image ad. | `https://scontent.xx.fbcdn.net/v/t45.1...` |
| `<AD_MEDIA_TYPE>`<br><br>_String_ | Click to WhatsApp ad media type. Values can be:<br><br>`image` — Indicates an image ad.<br><br>`video` — Indicates a video ad. | `image` |
| `<AD_PRIMARY_TEXT>`<br><br>_String_ | Click to WhatsApp ad primary text. | `Summer succulents are here!` |
| `<AD_URL>`<br><br>_String_ | Click to WhatsApp ad URL. | `https://fb.me/3cr4Wqqkv` |
| `<AD_VIDEO_THUMBNAIL>`<br><br>_String_ | Click to WhatsApp ad video thumbnail URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.3...` |
| `<AD_VIDEO_URL>`<br><br>_String_ | Click to WhatsApp ad video URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.2...` |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<MEDIA_ASSET_FILENAME>`<br><br>_String_ | Media asset filename. | `receipt.pdf` |
| `<MEDIA_ASSET_CAPTION>`<br><br>_String_ | Media asset caption text. | `my receipt` |
| `<MEDIA_ASSET_ID>`<br><br>_String_ | Media asset ID. You can [perform a GET on this ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media) to get the asset URL, then perform a GET on the returned URL (using your access token) to get the underlying asset. | `1003383421387256` |
| `<MEDIA_ASSET_MIME_TYPE>`<br><br>_String_ | Media asset MIME type. | `application/pdf` |
| `<MEDIA_ASSET_SHA256_HASH>`<br><br>_String_ | Media asset SHA-256 hash. | `SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=` |
| `<MEDIA_ASSET_URL>`<br><br>_String_ | **This JSON property is being released to developers gradually over several weeks, starting November 12, 2025, and may not be available to you immediately.**<br><br>Media URL. You can query this URL directly with your access token to [download the media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#download-media). | `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

The following example shows a document messages webhook payload.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1744344496",
                "type": "document",
                "document": {
                  "caption": "my receipt",
                  "filename": "receipt.pdf",
                  "mime_type": "application/pdf",
                  "sha256": "V5OPpLD/gEG6Xjg0MbmQDLFgcKsL+j5LfY4ny/pZ4MY=",
                  "id": "622684793477189",
                  "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Edit messages webhook reference



**Warning:** **Edit messages are temporarily unsupported.** Edited messages are currently delivered as an unsupported message type webhook instead of an edit webhook. Work to restore edit message support is underway.

**Warning:** The edit webhook is only available to WhatsApp Business app users (aka "Coexistence")

This reference describes edit events and payload contents for the WhatsApp Business account **messages** webhook for replies to messages.

## Triggers

- A WhatsApp user edits a previously sent message (text, media with caption).
- A WhatsApp user edits a previously sent message within 15 minutes after it was sent.

## Syntax

```html
{
 "object": "whatsapp_business_account",
 "entry": [
   {
     "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
     "changes": [
       {
         "value": {
           "messaging_product": "whatsapp",
           "metadata": {
             "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
             "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
           },
           "contacts": [
             {
               "profile": {
                 "name": "<WHATSAPP_USER_PROFILE_NAME>"
               },
               "wa_id": "<WHATSAPP_USER_ID>"
             }
           ],
           "messages": [
             {
               "from": "<WHATSAPP_USER_PHONE_NUMBER>",
               "id": "<WHATSAPP_MESSAGE_ID>",
               "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
               "type": "edit",
               "edit": {
                 "original_message_id": "<ORIGINAL_WHATSAPP_MESSAGE_ID>",
                 "message": {
                   "context": {
                     "id": "<CONTEXT_ID>"
                   },
                   "type": "image",
                   "image": {
                     "caption": "<MEDIA_ASSET_CAPTION>",
                     "mime_type": "<MEDIA_ASSET_MIME_TYPE>",
                     "sha256": "<MEDIA_ASSET_SHA256_HASH>",
                     "id": "<MEDIA_ASSET_ID>",
                     "url": "<MEDIA_ASSET_URL>"
                   }
                 }
               }
             }
           ]
         },
         "field": "messages"
       }
     ]
   }
 ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>` | Business display phone number. | 15550783881 |
| `<BUSINESS_PHONE_NUMBER_ID>` | Business phone number ID. | 106540352242922 |
| `<WHATSAPP_USER_PROFILE_NAME>` | WhatsApp user's profile name. | Sheena Nelson |
| `<WHATSAPP_USER_ID>` | WhatsApp user ID. | 16505551234 |
| `<WHATSAPP_USER_PHONE_NUMBER>` | WhatsApp user phone number. | 16505551234 |
| `<WHATSAPP_MESSAGE_ID>` | WhatsApp message ID for the edit event. | wamid.HBgLMTY1MDM4Nzk0MzkV... |
| `<WEBHOOK_TRIGGER_TIMESTAMP>` | Unix timestamp when the webhook was triggered. | 1739321024 |
| `<ORIGINAL_WHATSAPP_MESSAGE_ID>` | ID of the original message being edited. | wamid.HBgLMTQxMjU1NTA4MjkV... |
| `<CONTEXT_ID>` | Contextual message ID (if applicable). | M0 |
| `<MEDIA_ASSET_CAPTION>` | Caption for the media asset. | Updated image caption |
| `<MEDIA_ASSET_MIME_TYPE>` | MIME type of the media asset. | image/jpeg |
| `<MEDIA_ASSET_SHA256_HASH>` | SHA256 hash of the media asset. | a1b2c3d4e5f6... |
| `<MEDIA_ASSET_ID>` | Media asset ID. | 1234567890 |
| `<MEDIA_ASSET_URL>` | URL to the media asset. | https://media.example.com/... |

## Sample webhooks

This example webhook describes an edit made by a user in a message.

```json
{
 "object": "whatsapp_business_account",
 "entry": [
   {
     "id": "102290129340398",
     "changes": [
       {
         "value": {
           "messaging_product": "whatsapp",
           "metadata": {
             "display_phone_number": "15550783881",
             "phone_number_id": "106540352242922"
           },
           "contacts": [
             {
               "profile": {
                 "name": "Sheena Nelson"
               },
               "wa_id": "16505551234"
             }
           ],
           "messages": [
             {
               "from": "16505551234",
               "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
               "timestamp": "1749854575",
               "type": "edit",
               "edit": {
                 "original_message_id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=",
                 "message": {
                   "context": {
                     "id": "M0"
                   },
                   "type": "image",
                   "image": {
                     "caption": "Updated image caption",
                     "mime_type": "image/jpeg",
                     "sha256": "a1b2c3d4e5f6...",
                     "id": "1234567890",
                     "url": "https://media.example.com/updated-image.jpg"
                   }
                 }
               }
             }
           ]
         },
         "field": "messages"
       }
     ]
   }
 ]
}
```
# Errors messages webhooks reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for errors messages.

## Triggers

- A system-level problem prevents a request from being processed.
- An app- or account-level problem prevents a request from being processed.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "errors": [
              {
                "code": <ERROR_CODE>,
                "title": "<ERROR_TITLE>",
                "message": "<ERROR_MESSAGE>",
                "error_data": {
                  "details": "<ERROR_DETAILS>"
                },
                "href": "<ERROR_CODES_URL>"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<ERROR_CODE>`<br><br>_Integer_ | [Error code](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes). | `130429` |
| `<ERROR_CODES_URL>`<br><br>_String_ | Link to [error code documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes). | `/docs/whatsapp/cloud-api/support/error-codes/` |
| `<ERROR_DETAILS>`<br><br>_String_ | [Error code](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes) details. | `Message failed to send because there were too many messages sent from this phone number in a short period of time` |
| `<ERROR_MESSAGE>`<br><br>_String_ | [Error code](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes) message. This value is the same as the `title` property value. | `Rate limit hit` |
| `<ERROR_TITLE>`<br><br>_String_ | [Error code](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes) title. This value is the same as the `message` property value. | `Rate limit hit` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |

## Example

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "errors": [
              {
                "code": 130429,
                "title": "Rate limit hit",
                "message": "Rate limit hit",
                "error_data": {
                  "details": "Message failed to send because there were too many messages sent from this phone number in a short period of time"
                },
                "href": "/documentation/business-messaging/whatsapp/support/error-codes"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Image messages webhook reference


This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for messages containing an image.

## Triggers

- A WhatsApp user sends an image to a business.
- A WhatsApp user forwards an image message to a business.
- A WhatsApp user forwards an [interactive reply button message to a business](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages).
- A WhatsApp user sends an image to a business via a Click to WhatsApp ad.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "image",
                "image": {
                  "caption": "<MEDIA_ASSET_CAPTION>",
                  "mime_type": "<MEDIA_ASSET_MIME_TYPE>",
                  "sha256": "<MEDIA_ASSET_SHA256_HASH>",
                  "id": "<MEDIA_ASSET_ID>",
                  "url": "<MEDIA_ASSET_URL>"
                },

                <!-- only included if message was forwarded to business by a user -->
                "context": {
                  "forwarded": true, <!-- only if forwarded 5 times or less -->
                  "frequently_forwarded": true <!-- only if forwarded more than 5 times  -->
                },

                <!-- only included if message sent via a Click to WhatsApp ad -->
                "referral": {
                  "source_url": "<AD_URL>",
                  "source_id": "<AD_ID>",
                  "source_type": "ad",
                  "body": "<AD_PRIMARY_TEXT>",
                  "headline": "<AD_HEADLINE>",
                  "media_type": "<AD_MEDIA_TYPE>",
                  "image_url": "<AD_IMAGE_URL>",
                  "video_url": "<AD_VIDEO_URL>",
                  "thumbnail_url": "<AD_VIDEO_THUMBNAIL>",
                  "ctwa_clid": "<AD_CLICK_ID>",
                  "welcome_message": {
                    "text": "<AD_GREETING_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<AD_CLICK_ID>`<br><br>_String_ | Click to WhatsApp ad click ID.<br><br>The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)). | `Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50` |
| `<AD_GREETING_TEXT>`<br><br>_String_ | Click to WhatsApp ad greeting text. | `Hi there! Let us know how we can help!` |
| `<AD_HEADLINE>`<br><br>_String_ | Click to WhatsApp ad headline. | `Chat with us` |
| `<AD_ID>`<br><br>_String_ | Click to WhatsApp ad ID. | `120226305854810726` |
| `<AD_IMAGE_URL>`<br><br>_String_ | Click to WhatsApp ad image URL. Only included if the ad is an image ad. | `https://scontent.xx.fbcdn.net/v/t45.1...` |
| `<AD_MEDIA_TYPE>`<br><br>_String_ | Click to WhatsApp ad media type. Values can be:<br><br>`image` — Indicates an image ad.<br><br>`video` — Indicates a video ad. | `image` |
| `<AD_PRIMARY_TEXT>`<br><br>_String_ | Click to WhatsApp ad primary text. | `Summer succulents are here!` |
| `<AD_URL>`<br><br>_String_ | Click to WhatsApp ad URL. | `https://fb.me/3cr4Wqqkv` |
| `<AD_VIDEO_THUMBNAIL>`<br><br>_String_ | Click to WhatsApp ad video thumbnail URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.3...` |
| `<AD_VIDEO_URL>`<br><br>_String_ | Click to WhatsApp ad video URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.2...` |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<MEDIA_ASSET_CAPTION>`<br><br>_String_ | Media asset caption text. | `Taj Mahal` |
| `<MEDIA_ASSET_ID>`<br><br>_String_ | Media asset ID. You can [perform a GET on this ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media) to get the asset URL, then perform a GET on the returned URL (using your access token) to get the underlying asset. | `1003383421387256` |
| `<MEDIA_ASSET_MIME_TYPE>`<br><br>_String_ | Media asset MIME type. | `image/jpeg` |
| `<MEDIA_ASSET_SHA256_HASH>`<br><br>_String_ | Media asset SHA-256 hash. | `SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=` |
| `<MEDIA_ASSET_URL>`<br><br>_String_ | **This JSON property is being released to developers gradually over several weeks, starting November 12, 2025, and may not be available to you immediately.**<br><br>Media URL. You can query this URL directly with your access token to [download the media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#download-media). | `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1744344496",
                "type": "image",
                "image": {
                  "caption": "Taj Mahal",
                  "mime_type": "image/jpeg",
                  "sha256": "SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=",
                  "id": "1003383421387256",
                  "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Interactive messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for replies to interactive messages.

## Triggers

- A WhatsApp user taps a row in an [interactive list message](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages).
- A WhatsApp user taps a button in an [interactive reply button message](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages).

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
                  "id": "<CONTEXTUAL_WHATSAPP_MESSAGE_ID>"
                },
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "interactive",

                <!-- interactive list message replies only -->
                "interactive": {
                  "type": "list_reply",
                  "list_reply": {
                    "id": "<ROW_ID>",
                    "title": "<ROW_TITLE>",
                    "description": "<ROW_DESCRIPTION>"
                  }
                },

                <!-- interactive reply button message replies only -->
                "interactive": {
                  "type": "button_reply",
                  "button_reply": {
                    "id": "<BUTTON_ID>",
                    "title": "<BUTTON_LABEL_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<BUTTON_ID>`<br><br>_String_ | Button ID. | `cancel-button` |
| `<BUTTON_LABEL_TEXT>`<br><br>_String_ | Button label text. | `Cancel` |
| `<CONTEXTUAL_WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID of the message containing the button the WhatsApp user tapped. | `wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<ROW_DESCRIPTION>`<br><br>_String_ | Row description. | `Next Day to 2 Days` |
| `<ROW_ID>`<br><br>_String_ | Row ID. | `priority_express` |
| `<ROW_TITLE>`<br><br>_String_ | Row title. | `Priority Mail Express` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Examples

This example webhook describes a WhatsApp user selecting a row in an interactive list message.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "15550783881",
                  "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA="
                },
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "timestamp": "1749854575",
                "type": "interactive",
                "interactive": {
                  "type": "list_reply",
                  "list_reply": {
                    "id": "priority_express",
                    "title": "Priority Mail Express",
                    "description": "Next Day to 2 Days"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

This example webhook describes a WhatsApp user tapping a button in an interactive reply button message.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "15550783881",
                  "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MEM2RUJFNkI0RENGQTVDRjUA"
                },
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTZBQzg0MzQ4QjRCM0NGNkVGOAA=",
                "timestamp": "1750025136",
                "type": "interactive",
                "interactive": {
                  "type": "button_reply",
                  "button_reply": {
                    "id": "cancel-button",
                    "title": "Cancel"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Location messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business Account **messages** webhook for messages containing location information.

## Triggers

- A WhatsApp user sends a location message to a business.
- A WhatsApp user sends a location to a business via a Click to WhatsApp ad.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "location": {
                  "address": "<LOCATION_ADDRESS>",
                  "latitude": <LOCATION_LATITUDE>,
                  "longitude": <LOCATION_LONGITUDE>,
                  "name": "<LOCATION_NAME>",
                  "url": "<LOCATION_URL>"
                },
                "type": "location",

                <!-- only included if message sent via a Click to WhatsApp ad -->
                "referral": {
                  "source_url": "<AD_URL>",
                  "source_id": "<AD_ID>",
                  "source_type": "ad",
                  "body": "<AD_PRIMARY_TEXT>",
                  "headline": "<AD_HEADLINE>",
                  "media_type": "<AD_MEDIA_TYPE>",
                  "image_url": "<AD_IMAGE_URL>",
                  "video_url": "<AD_VIDEO_URL>",
                  "thumbnail_url": "<AD_VIDEO_THUMBNAIL>",
                  "ctwa_clid": "<AD_CLICK_ID>",
                  "welcome_message": {
                    "text": "<AD_GREETING_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<AD_CLICK_ID>`<br><br>_String_ | Click to WhatsApp ad click ID.<br><br>The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)). | `Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50` |
| `<AD_GREETING_TEXT>`<br><br>_String_ | Click to WhatsApp ad greeting text. | `Hi there! Let us know how we can help!` |
| `<AD_HEADLINE>`<br><br>_String_ | Click to WhatsApp ad headline. | `Chat with us` |
| `<AD_ID>`<br><br>_String_ | Click to WhatsApp ad ID. | `120226305854810726` |
| `<AD_IMAGE_URL>`<br><br>_String_ | Click to WhatsApp ad image URL. Only included if the ad is an image ad. | `https://scontent.xx.fbcdn.net/v/t45.1...` |
| `<AD_MEDIA_TYPE>`<br><br>_String_ | Click to WhatsApp ad media type. Values can be:<br><br>`image` — Indicates an image ad.<br><br>`video` — Indicates a video ad. | `image` |
| `<AD_PRIMARY_TEXT>`<br><br>_String_ | Click to WhatsApp ad primary text. | `Summer succulents are here!` |
| `<AD_URL>`<br><br>_String_ | Click to WhatsApp ad URL. | `https://fb.me/3cr4Wqqkv` |
| `<AD_VIDEO_THUMBNAIL>`<br><br>_String_ | Click to WhatsApp ad video thumbnail URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.3...` |
| `<AD_VIDEO_URL>`<br><br>_String_ | Click to WhatsApp ad video URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.2...` |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<LOCATION_ADDRESS>`<br><br>_String_ | Location address. | `101 Forest Ave, Palo Alto, CA 94301` |
| `<LOCATION_LATITUDE>`<br><br>_Float_ | Location latitude in decimal degrees. | `37.44221496582` |
| `<LOCATION_LONGITUDE>`<br><br>_Float_ | Location longitude in decimal degrees. | `-122.16165924072` |
| `<LOCATION_NAME>`<br><br>_String_ | Location name. | `Philz Coffee` |
| `<LOCATION_URL>`<br><br>_String_ | Location URL. Usually only included for business locations. | `https://philzcoffee.com/` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "timestamp": "1744344496",
                "location": {
                  "address": "101 Forest Ave, Palo Alto, CA 94301",
                  "latitude": 37.44221496582,
                  "longitude": -122.16165924072,
                  "name": "Philz Coffee",
                  "url": "https://philzcoffee.com/"
                },
                "type": "location"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Order messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for order messages.

## Triggers

- A WhatsApp user orders one or more products via a [catalog, single-, or multi-product message](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview).

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "order",
                "order": {
                  "catalog_id": "<PRODUCT_CATALOG_ID>",
                  "text": "<ORDER_TEXT>",
                  "product_items": [
                    {
                      "product_retailer_id": "<PRODUCT_ID>",
                      "quantity": <PRODUCT_QUANTITY>,
                      "item_price": <PRODUCT_PRICE>,
                      "currency": "<CURRENCY_CODE>"
                    }
                  ]
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<CURRENCY_CODE>`<br><br>_String_ | Catalog currency code. | `USD` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<ORDER_TEXT>`<br><br>_String_ | Text accompanying the order. | `Love these!` |
| `<PRODUCT_CATALOG_ID>`<br><br>_String_ | [Product catalog ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview). | `194836987003835` |
| `<PRODUCT_ID>`<br><br>_String_ | [Product ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview). | `di9ozbzfi4` |
| `<PRODUCT_PRICE>`<br><br>_Integer_ | Individual product price. | `7.99` |
| `<PRODUCT_QUANTITY>`<br><br>_Integer_ | Product quantity. | `2` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

This example webhook describes an order placed by a WhatsApp user for 3 products via an interactive catalog message.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "timestamp": "1750096325",
                "type": "order",
                "order": {
                  "catalog_id": "194836987003835",
                  "text": "Love these!",
                  "product_items": [
                    {
                      "product_retailer_id": "di9ozbzfi4",
                      "quantity": 2,
                      "item_price": 30,
                      "currency": "USD"
                    },
                    {
                      "product_retailer_id": "nqryix03ez",
                      "quantity": 1,
                      "item_price": 25,
                      "currency": "USD"
                    }
                  ]
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Reaction messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for messages containing a reaction to a previous message sent by a business.

**Note:** When an end user removes a reaction emoji, a webhook without the "emoji" field will be sent as shown in the sample webhooks below.

## Triggers

- A WhatsApp user reacts to a previous message sent by a business within the last 30 days.
- A WhatsApp user removes a previously sent reaction to a previous message sent by a business within the last 30 days.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<REACTION_TIMESTAMP>",
                "type": "reaction",
                "reaction": {
                  "message_id": "<CONTEXTUAL_WHATSAPP_MESSAGE_ID>",
                  "emoji": "<EMOJI_UNICODE>" <!-- omitted if user removes reaction -->
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<CONTEXTUAL_WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID of the message the WhatsApp user reacted to. | `wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=` |
| `<EMOJI_UNICODE>`<br><br>_String_ | Unicode of emoji sent by the WhatsApp user as a reaction.<br><br>If the user removes their initial reaction, another webhook is triggered, but the `emoji` property will be omitted from the payload. | `U+1F44D` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<REACTION_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the WhatsApp user sent the reaction. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Sample Webhooks

***Receiving a reaction***

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "timestamp": "1749419544",
                "type": "reaction",
                "reaction": {
                  "message_id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=",
                  "emoji": "👍"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

***Reaction removed by end user***

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "timestamp": "1749419544",
                "type": "reaction",
                "reaction": {
                  "message_id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA="
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Revoke messages webhook reference



**Warning:** The revoke webhook is only available to WhatsApp Business app users (aka "Coexistence")

This reference describes revoke events and payload contents for the WhatsApp Business account messages webhook for replies to messages.

## Triggers

- A WhatsApp user revokes (deletes) a previously sent message.
- A WhatsApp user revokes a previously sent message within two days after being sent.

## Syntax

```html
{
 "object": "whatsapp_business_account",
 "entry": [
   {
     "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
     "changes": [
       {
         "value": {
           "messaging_product": "whatsapp",
           "metadata": {
             "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
             "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
           },
           "contacts": [
             {
               "profile": {
                 "name": "<WHATSAPP_USER_PROFILE_NAME>"
               },
               "wa_id": "<WHATSAPP_USER_ID>"
             }
           ],
           "messages": [
             {
               "from": "<WHATSAPP_USER_PHONE_NUMBER>",
               "id": "<WHATSAPP_MESSAGE_ID>",
               "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
               "type": "revoke",
               "revoke": {
                 "original_message_id": "<ORIGINAL_WHATSAPP_MESSAGE_ID>"
               }
             }
           ]
         },
         "field": "messages"
       }
     ]
   }
 ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>` | Business display phone number. | 15550783881 |
| `<BUSINESS_PHONE_NUMBER_ID>` | Business phone number ID. | 106540352242922 |
| `<WHATSAPP_USER_PROFILE_NAME>` | WhatsApp user's profile name. | Sheena Nelson |
| `<WHATSAPP_USER_ID>` | WhatsApp user ID. | 16505551234 |
| `<WHATSAPP_USER_PHONE_NUMBER>` | WhatsApp user phone number. | 16505551234 |
| `<WHATSAPP_MESSAGE_ID>` | WhatsApp message ID for the revoke event. | wamid.HBgLMTY1MDM4Nzk0MzkV... |
| `<WEBHOOK_TRIGGER_TIMESTAMP>` | Unix timestamp when the webhook was triggered. | 1739321024 |
| `<ORIGINAL_WHATSAPP_MESSAGE_ID>` | ID of the original message being revoked (deleted). | wamid.HBgLMTQxMjU1NTA4MjkV... |

## Example

This example webhook describes a delete made by a user in a message.

```json
{
 "object": "whatsapp_business_account",
 "entry": [
   {
     "id": "102290129340398",
     "changes": [
       {
         "value": {
           "messaging_product": "whatsapp",
           "metadata": {
             "display_phone_number": "15550783881",
             "phone_number_id": "106540352242922"
           },
           "contacts": [
             {
               "profile": {
                 "name": "Sheena Nelson"
               },
               "wa_id": "16505551234"
             }
           ],
           "messages": [
             {
               "from": "16505551234",
               "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
               "timestamp": "1749854575",
               "type": "revoke",
               "revoke": {
                 "original_message_id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA="
               }
             }
           ]
         },
         "field": "messages"
       }
     ]
   }
 ]
}
```
# Status messages webhook reference



This reference describes trigger events and payload contents for WhatsApp Business account status **messages** webhook.

## Triggers

- Your message is sent to a WhatsApp user.
- Your message is delivered to a WhatsApp user's device.
- Your message is displayed (that is, "read") in the WhatsApp client on a WhatsApp user's device.
- Your message is unable to be sent to a WhatsApp user.
- Your message is unable to be delivered to a WhatsApp user's device.
- Your message is sent to a WhatsApp user in a group chat.
- Your voice message is played by the WhatsApp user's device.

The triggers above also apply to a WhatsApp user who is part of a group chat.

A status is considered read only if it has been delivered. In some cases, like when a user receives a message while in the chat screen, the message is both delivered and read at the same time. In these cases, the "delivered" webhook is not sent because it's implied that the message was delivered since it was read. This behavior is due to internal optimization.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "statuses": [
              {
                "id": "<WHATSAPP_MESSAGE_ID>",
                "status": "<STATUS>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "recipient_id": "<USER_PHONE_NUMBER_OR_GROUP_ID>",
                "recipient_type": "group", <!-- Only included if message sent to a group -->
                "recipient_participant_id": "<GROUP_PARTICIPANT_USER_PHONE_NUMBER>", <!-- Only included if message sent to a group -->
                "recipient_identity_key_hash": "<IDENTITY_KEY_HASH>", <!-- Only included if identity change check enabled -->
                "biz_opaque_callback_data": "<BUSINESS_OPAQUE_DATA>", <!-- Only included if message sent with biz_opaque_callback_data -->

                <!-- (1) Only included with sent status, and one of either delivered or read status
                     (2) Omitted entirely for v24.0+ unless webhook is for a free entry point conversation -->
                "conversation": {
                  "id": "<CONVERSATION_ID>",
                  "expiration_timestamp": "<CONVERSATION_EXPIRATION_TIMESTAMP>",
                  "origin": {
                    "type": "<CONVERSATION_CATEGORY>"
                  }
                },

                <!-- only included with sent status, and one of either delivered or read status -->
                "pricing": {
                  "billable": <IS_BILLABLE?>,
                  "pricing_model": "<PRICING_MODEL>",
                  "type": "<PRICING_TYPE>",
                  "category": "<PRICING_CATEGORY>"
                },

                <!-- only included if failure to send or deliver message -->
                "errors": [
                  {
                    "code": <ERROR_CODE>,
                    "title": "<ERROR_TITLE>",
                    "message": "<ERROR_MESSAGE>",
                    "error_data": {
                      "details": "<ERROR_DETAILS>"
                    },
                    "href": "<ERROR_CODES_URL>"
                  }
                ]
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_OPAQUE_DATA>`<br><br>_String_ | String assigned by the business to the `biz_opaque_callback_data` property in the send message request.<br><br>Only included if the business set a `biz_opaque_callback_data` value when [sending](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#messages) the message. | `1744434060` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<CONVERSATION_CATEGORY>`<br><br>_String_ | [Conversation category](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#conversation-categories). Values can be:<br><br>`authentication` — Indicates an authentication conversation.<br><br>`authentication_international` — Indicates an [authentication-international](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/authentication-international-rates) conversation.<br><br>`marketing` — Indicates a marketing conversation.<br><br>`marketing_lite` — Indicates a [Marketing Messages API for WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview) conversation.<br><br>`referral_conversion` — Indicates a free entry point conversation.<br><br>`service` — Indicates a service conversation.<br><br>`utility` — Indicates a utility conversation. | `service` |
| `<CONVERSATION_EXPIRATION_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the conversation will expire.<br><br>The expiration_timestamp property is only included for `sent` status. | `1744434060` |
| `<CONVERSATION_ID>`<br><br>_String_ | Version 24.0 and higher:<br><br>The `conversation` object will be omitted entirely, unless the webhook is for a message sent within an open free entry point window, in which case the value will be unique per window.<br><br>Version 23.0 and lower:<br><br>Value will now be set to a unique ID per-message, unless the webhook is for a message sent with an open free entry point window, in which case the value will be unique per window. | `8f842dbba350821654c9dfed31f5635c` |
| `<ERROR_CODE>`<br><br>_Integer_ | [Error code](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes). | `131050` |
| `<ERROR_CODES_URL>`<br><br>_String_ | Link to [error code documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes). | `/docs/whatsapp/cloud-api/support/error-codes/` |
| `<ERROR_DETAILS>`<br><br>_String_ | [Error code](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes) details. | `In order to maintain a healthy ecosystem engagement, the message failed to be delivered.` |
| `<ERROR_MESSAGE>`<br><br>_String_ | [Error code](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes) message. This value is the same as the `title` property value. | `This message was not delivered to maintain healthy ecosystem engagement.` |
| `<ERROR_TITLE>`<br><br>_String_ | [Error code](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes) title. This value is the same as the `message` property value. | `This message was not delivered to maintain healthy ecosystem engagement.` |
| `<GROUP_PARTICIPANT_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. Property only included if message was sent to a [group](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups). | `16505551234` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<IS_BILLABLE?>`<br><br>_Boolean_ | Indicates if the message is billable (`true`) or not (`false`).<br><br>The `billable` property will be deprecated in a future versioned release. Use `pricing.type` and `pricing.category` together to determine whether a message is billable and, if so, its billing rate. | `true` |
| `<PRICING_CATEGORY>`<br><br>_String_ | Pricing category ([rate](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#rates)) applied if billable. Values can be:<br><br>`authentication` — Indicates authentication rate applied.<br><br>`authentication-international` — Indicates authentication-international rate applied.<br><br>`marketing` — Indicates marketing rate applied.<br><br>`marketing_lite` — Indicates a [Marketing Messages API for WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview) pricing applied.<br><br>`referral_conversion` — Indicates a [free entry point conversation](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#free-entry-point-conversations).<br><br>`service` – Indicates service rate applied.<br><br>`utility` — Indicates utility rate applied. | `service` |
| `<PRICING_MODEL>`<br><br>_String_ | Pricing model. Values can be:<br><br>`CBP` — Indicates conversation-based pricing applies. Will only be set to this value if the webhook was sent before July 1, 2025.<br><br>`PMP` — Indicates [per-message pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) applies. | `PMP` |
| `<PRICING_TYPE>`<br><br>_String_ | Pricing type.<br><br>`regular` — Indicates the message is billable.<br><br>`free_customer_service` — Indicates the message is free because it was either a utility template message or non-template message sent within a customer service window.<br><br>`free_entry_point` — Indicates the message is free because it was sent within an open free entry point window. | `regular` |
| `<STATUS>`<br><br>_String_ | Message status. Values can be:<br><br>`delivered` — Indicates message was successfully delivered to the WhatsApp user's device.<br><br>- WhatsApp UI equivalent: Two checkmarks.<br><br>`failed` — Indicates failure to send or deliver the message to the WhatsApp user's device.<br><br>- WhatsApp UI equivalent: Red error triangle.<br><br>`played` — Indicates the first time a voice message is played by the WhatsApp user's device.<br><br>- WhatsApp UI equivalent: Blue microphone.<br><br>`read` — Indicates the message was displayed in an open chat thread in the WhatsApp user's device.<br><br>- WhatsApp UI equivalent: Two blue checkmarks.<br><br>`sent` — Indicates the message was successfully sent from our servers.<br><br>- WhatsApp UI equivalent: One checkmark. | `read` |
| `<USER_PHONE_NUMBER_OR_GROUP_ID>`<br><br>_String_ | WhatsApp user phone number or group ID.<br><br>Value set to the WhatsApp user's phone number if the message was sent to their phone number, or set to a [group ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) if sent to a group ID. If sent to a group ID, the WhatsApp user's phone number is instead assigned to the `recipient_participant_id` property. | `16505551234` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |

## Examples

This example webhook describes a marketing message that has been successfully sent from our servers.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "statuses": [
              {
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "status": "sent",
                "timestamp": "1750030073",
                "recipient_id": "16505551234",
                "conversation": {
                  "id": "72b14d6bd5407799e66f64d1b338e567",
                  "expiration_timestamp": "1750116480",
                  "origin": {
                    "type": "marketing"
                  }
                },
                "pricing": {
                  "billable": true,
                  "pricing_model": "PMP",
                  "type": "regular",
                  "category": "marketing"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

This example v24.0 webhook describes a marketing message that has been displayed in the WhatsApp client (that is, "read"). Notice that in this case, the `conversation` object is omitted because it's a v24.0 webhook, and the `pricing` object is omitted because it happened to be displayed in an associated delivered status messages webhook (the object can only appear in one or the other).

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "statuses": [
              {
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "status": "sent",
                "timestamp": "1750030073",
                "recipient_id": "16505551234"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

This example describes a message that failed to be sent.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "statuses": [
              {
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0QUQ2MjA4NEYyRkExNjMyREUA",
                "status": "failed",
                "timestamp": "1751142888",
                "recipient_id": "16505551234",
                "errors": [
                  {
                    "code": 131049,
                    "title": "This message was not delivered to maintain healthy ecosystem engagement.",
                    "message": "This message was not delivered to maintain healthy ecosystem engagement.",
                    "error_data": {
                      "details": "In order to maintain a healthy ecosystem engagement, the message failed to be delivered."
                    },
                    "href": "/documentation/business-messaging/whatsapp/support/error-codes"
                  }
                ]
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Sticker messages webhook reference


This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for messages containing a sticker.

## Triggers

- A WhatsApp user sends a sticker to a business.
- A WhatsApp user sends a sticker to a business via a Click to WhatsApp ad.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "sticker",
                "sticker": {
                  "mime_type": "<MEDIA_ASSET_MIME_TYPE>",
                  "sha256": "<MEDIA_ASSET_SHA256_HASH>",
                  "id": "<MEDIA_ASSET_ID>",
                  "url": "<MEDIA_ASSET_URL>",
                  "animated": <IS_ANIMATED?>
                },

                <!-- only included if message sent via a Click to WhatsApp ad -->
                "referral": {
                  "source_url": "<AD_URL>",
                  "source_id": "<AD_ID>",
                  "source_type": "ad",
                  "body": "<AD_PRIMARY_TEXT>",
                  "headline": "<AD_HEADLINE>",
                  "media_type": "<AD_MEDIA_TYPE>",
                  "image_url": "<AD_IMAGE_URL>",
                  "video_url": "<AD_VIDEO_URL>",
                  "thumbnail_url": "<AD_VIDEO_THUMBNAIL>",
                  "ctwa_clid": "<AD_CLICK_ID>",
                  "welcome_message": {
                    "text": "<AD_GREETING_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<AD_CLICK_ID>`<br><br>_String_ | Click to WhatsApp ad click ID.<br><br>The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)). | `Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50` |
| `<AD_GREETING_TEXT>`<br><br>_String_ | Click to WhatsApp ad greeting text. | `Hi there! Let us know how we can help!` |
| `<AD_HEADLINE>`<br><br>_String_ | Click to WhatsApp ad headline. | `Chat with us` |
| `<AD_ID>`<br><br>_String_ | Click to WhatsApp ad ID. | `120226305854810726` |
| `<AD_IMAGE_URL>`<br><br>_String_ | Click to WhatsApp ad image URL. Only included if the ad is an image ad. | `https://scontent.xx.fbcdn.net/v/t45.1...` |
| `<AD_MEDIA_TYPE>`<br><br>_String_ | Click to WhatsApp ad media type. Values can be:<br><br>`image` — Indicates an image ad.<br><br>`video` — Indicates a video ad. | `image` |
| `<AD_PRIMARY_TEXT>`<br><br>_String_ | Click to WhatsApp ad primary text. | `Summer succulents are here!` |
| `<AD_URL>`<br><br>_String_ | Click to WhatsApp ad URL. | `https://fb.me/3cr4Wqqkv` |
| `<AD_VIDEO_THUMBNAIL>`<br><br>_String_ | Click to WhatsApp ad video thumbnail URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.3...` |
| `<AD_VIDEO_URL>`<br><br>_String_ | Click to WhatsApp ad video URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.2...` |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<IS_ANIMATED?>`<br><br>_Boolean_ | Boolean indicating if the sticker is animated (`true`) or not (`false`). | `true` |
| `<MEDIA_ASSET_ID>`<br><br>_String_ | Media asset ID. You can [perform a GET on this ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media) to get the asset URL, then perform a GET on the returned URL (using your access token) to get the underlying asset. | `1003383421387256` |
| `<MEDIA_ASSET_MIME_TYPE>`<br><br>_String_ | Media asset MIME type. | `image/webp` |
| `<MEDIA_ASSET_SHA256_HASH>`<br><br>_String_ | Media asset SHA-256 hash. | `SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=` |
| `<MEDIA_ASSET_URL>`<br><br>_String_ | **This JSON property is being released to developers gradually over several weeks, starting November 12, 2025, and may not be available to you immediately.**<br><br>Media URL. You can query this URL directly with your access token to [download the media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#download-media). | `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1744344496",
                "type": "sticker",
                "sticker": {
                  "mime_type": "image/webp",
                  "sha256": "wvqXMe6n7n1W0zphvLPoLj+s/NtKqmr3zZ7YzTP7xFI=",
                  "id": "1908647269898587",
                  "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...",
                  "animated": true
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# System messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for system messages.

Unlike other incoming messages webhooks, system **messages** webhooks don't include a `contacts` array.

## Triggers

- A WhatsApp user changes their WhatsApp phone number.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "system",
                "system": {
                  "body": "User <WHATSAPP_USER_PROFILE_NAME> changed from <WHATSAPP_USER_PHONE_NUMBER> to <NEW_WHATSAPP_USER_PHONE_NUMBER>",
                  "wa_id": "<NEW_WHATSAPP_USER_ID>",
                  "type": "user_changed_number"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<NEW_WHATSAPP_USER_ID>`<br><br>_String_ | New WhatsApp user ID. A WhatsApp user's ID and phone number may not match. | `12195555358` |
| `<NEW_WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | New WhatsApp user phone number. A WhatsApp user's phone number and ID may not match. | `12195555358` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_PHONE_NUMBER>` _String_ | WhatsApp user phone number. A WhatsApp user's phone number and ID may not match. | `16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>` _String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTk4MzU1NTE5NzQVAgASGAoxMTgyMDg2MjY3AA==",
                "timestamp": "1750269342",
                "system": {
                  "body": "User Sheena Nelson changed from 16505551234 to 12195555358",
                  "wa_id": "12195555358",
                  "type": "user_changed_number"
                },
                "type": "system"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Text messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for messages containing only text.

## Triggers

- A WhatsApp user sends a text message to a WhatsApp Business phone number.
- A WhatsApp user forwards a text message to a business phone number.
- A WhatsApp user uses the **Message business** button in a [catalog, single-, or multi-product message](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview) to send a message to the business.
- A WhatsApp user sends a text message to a business via a [Click to WhatsApp ad](https://www.facebook.com/business/help/447934475640650?id=371525583593535) (an ad with a WhatsApp **message destination**).

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "text",
                "text": {
                  "body": "<MESSAGE_TEXT_BODY>"
                },

                <!-- only if message originated from a "Message business" button -->
                "context": {
                  "from": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
                  "id": "<CONTEXTUAL_WHATSAPP_MESSAGE_ID>",
                  "referred_product": {
                    "catalog_id": "<PRODUCT_CATALOG_ID>",
                    "product_retailer_id": "<PRODUCT_ID>"
                  }
                },

                <!-- only if message forwarded to business by a user -->
                "context": {
                  "forwarded": true,            <!-- only included if forwarded 5 times or less -->
                  "frequently_forwarded": true  <!-- only included if forwarded more than 5 times -->
                },

                <!-- only included if message sent via a Click to WhatsApp ad -->
                "referral": {
                  "source_url": "<AD_URL>",
                  "source_id": "<AD_ID>",
                  "source_type": "ad",
                  "body": "<AD_PRIMARY_TEXT>",
                  "headline": "<AD_HEADLINE>",
                  "media_type": "<AD_MEDIA_TYPE>",
                  "image_url": "<AD_IMAGE_URL>",
                  "video_url": "<AD_VIDEO_URL>",
                  "thumbnail_url": "<AD_VIDEO_THUMBNAIL>",
                  "ctwa_clid": "<AD_CLICK_ID>",  <!-- omitted if message sent via a WhatsApp Status ad placement -->
                  "welcome_message": {
                    "text": "<AD_GREETING_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<AD_CLICK_ID>`<br><br>_String_ | Click to WhatsApp ad click ID.<br><br>The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)). | `Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50` |
| `<AD_GREETING_TEXT>`<br><br>_String_ | Click to WhatsApp ad greeting text. | `Hi there! Let us know how we can help!` |
| `<AD_HEADLINE>`<br><br>_String_ | Click to WhatsApp ad headline. | `Chat with us` |
| `<AD_ID>`<br><br>_String_ | Click to WhatsApp ad ID. | `120226305854810726` |
| `<AD_IMAGE_URL>`<br><br>_String_ | Click to WhatsApp ad image URL. Only included if the ad is an image ad. | `https://scontent.xx.fbcdn.net/v/t45.1...` |
| `<AD_MEDIA_TYPE>`<br><br>_String_ | Click to WhatsApp ad media type. Values can be:<br><br>`image` — Indicates an image ad.<br><br>`video` — Indicates a video ad. | `image` |
| `<AD_PRIMARY_TEXT>`<br><br>_String_ | Click to WhatsApp ad primary text. | `Summer succulents are here!` |
| `<AD_URL>`<br><br>_String_ | Click to WhatsApp ad URL. | `https://fb.me/3cr4Wqqkv` |
| `<AD_VIDEO_THUMBNAIL>`<br><br>_String_ | Click to WhatsApp ad video thumbnail URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.3...` |
| `<AD_VIDEO_URL>`<br><br>_String_ | Click to WhatsApp ad video URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.2...` |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<CONTEXTUAL_WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID of the message the WhatsApp user used to access the Message business button. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgARGA9wcm9kdWN0X2lucXVpcnkA` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<MESSAGE_TEXT_BODY>`<br><br>_String_ | Text body of the message. | `Is it available in another color?` |
| `<PRODUCT_CATALOG_ID>`<br><br>_String_ | [Product catalog ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview). | `194836987003835` |
| `<PRODUCT_ID>`<br><br>_String_ | [Product ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview). | `di9ozbzfi4` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Examples

### Text message

This example describes a text message sent by a WhatsApp user (the user just typed something into the chat field and sends).

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1749416383",
                "type": "text",
                "text": {
                  "body": "Does it come in another color?"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

### Message business button

This example describes a text message sent by a WhatsApp user who used a **Message business** button when [viewing a single product](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview) to send the message.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "419561257915477",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "15550783881",
                  "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGA9wcm9kdWN0X2lucXVpcnkA",
                  "referred_product": {
                    "catalog_id": "194836987003835",
                    "product_retailer_id": "di9ozbzfi4"
                  }
                },
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTA2NTUwRkNEMDdFQjJCRUU0NQA=",
                "timestamp": "1750016800",
                "text": {
                  "body": "Is this still available?"
                },
                "type": "text"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

### Click to WhatsApp ad

This example describes a text message sent by a WhatsApp user who tapped a [Click to WhatsApp ad](https://www.facebook.com/business/help/447934475640650) and sent the generated message to the business.

Note that for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)), the `referral.ctwa_clid` property is omitted entirely.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "referral": {
                  "source_url": "https://fb.me/3cr4Wqqkv",
                  "source_id": "120226305854810726",
                  "source_type": "ad",
                  "body": "Summer Succulents are here!",
                  "headline": "Chat with us",
                  "media_type": "image",
                  "image_url": "https://scontent.xx.fbcdn.net/v/t45.1...",
                  "ctwa_clid": "Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50",
                  "welcome_message": {
                    "text": "Hi there! Let us know how we can help!"
                  }
                },
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUQ0N0VFMDA2MTQ0RkJFNkNDNAA=",
                "timestamp": "1750275992",
                "text": {
                  "body": "Can I get more info about this?"
                },
                "type": "text"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Unsupported messages webhook reference



This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for unsupported messages.

## Triggers

- A WhatsApp user sends a message type not supported by Cloud API.
- You use the API to send a message to a number already in use with the API. When the number is already in use, Cloud API sends the webhook to the owner of the recipient number.
- A WhatsApp user messages a business [onboarded with a WhatsApp Business app phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) for the first time. This is especially common when users tap one of the business's [ads that click to WhatsApp](https://business.whatsapp.com/products/create-ads-that-click-to-whatsapp) and immediately send a message.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "errors": [
                  {
                    "code": <ERROR_CODE>,
                    "title": "<ERROR_TITLE>",
                    "message": "<ERROR_MESSAGE>",
                    "error_data": {
                      "details": "<ERROR_DETAILS>"
                    }
                  }
                ],
                "type": "unsupported",
                "unsupported": {
                  "type": "<UNSUPPORTED_TYPE>"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<ERROR_CODE>` | The error code. Possible values:<br><br>- `131051` — Cloud API does not support the message type.<br>- `131060` — The message is currently unavailable. This typically occurs when a WhatsApp user messages a business [onboarded with a WhatsApp Business app phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users), for the first time. | `131051` |
| `<ERROR_DETAILS>` | A human-readable description of the error. | `Message type is currently not supported.` |
| `<ERROR_MESSAGE>` | A human-readable error message. Same as `ERROR_TITLE`. | `Message type unknown` |
| `<ERROR_TITLE>` | A human-readable error title. Possible values:<br><br>- `Message type unknown` — Corresponds to error code `131051`.<br>- `This message is currently unavailable.` — Corresponds to error code `131060`. | `Message type unknown` |
| `<UNSUPPORTED_TYPE>` | Contains the type of message that is unsupported.<br><br>Values can be:<br><br>- `button`<br>- `edit`<br>- `errors`<br>- `gif`<br>- `group_invite`<br>- `hsm`<br>- `image`<br>- `interactive`<br>- `keep_in_chat`<br>- `link_preview`<br>- `list`<br>- `location`<br>- `media_placeholder`<br>- `order`<br>- `pin`<br>- `poll_creation`<br>- `poll_update`<br>- `product`<br>- `reaction` | `poll_update` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example

The following example shows a webhook triggered by a WhatsApp user sending an unsupported message type (error code `131051`). For unavailable messages (error code `131060`), the payload structure is the same but the `errors` object values differ — see the [`ERROR_CODE`](#parameters) parameter for details.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "timestamp": "1750090702",
                "errors": [
                  {
                    "code": 131051,
                    "title": "Message type unknown",
                    "message": "Message type unknown",
                    "error_data": {
                      "details": "Message type is currently not supported."
                    }
                  }
                ],
                "type": "unsupported",
                "unsupported": {
                  "type": "edit"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Video messages webhook reference


This reference describes trigger events and payload contents for the WhatsApp Business account **messages** webhook for messages containing a video.

## Triggers

- A WhatsApp user sends a video to a business.
- A WhatsApp user forwards a video to a business.
- A WhatsApp user sends a video to a business via a Click to WhatsApp ad.

## Syntax

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<WHATSAPP_USER_PROFILE_NAME>"
                },
                "wa_id": "<WHATSAPP_USER_ID>",
                "identity_key_hash": "<IDENTITY_KEY_HASH>" <!-- only included if identity change check enabled -->
              }
            ],
            "messages": [
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>",
                "id": "<WHATSAPP_MESSAGE_ID>",
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "type": "video",
                "video": {
                  "caption": "<MEDIA_ASSET_CAPTION>",
                  "mime_type": "<MEDIA_ASSET_MIME_TYPE>",
                  "sha256": "<MEDIA_ASSET_SHA256_HASH>",
                  "id": "<MEDIA_ASSET_ID>",
                  "url": "<MEDIA_ASSET_URL>"
                },

                <!-- only included if message was forwarded to business by a user -->
                "context": {
                  "forwarded": true, <!-- only if forwarded 5 times or less -->
                  "frequently_forwarded": true <!-- only if forwarded more than 5 times  -->
                },

                <!-- only included if message sent via a Click to WhatsApp ad -->
                "referral": {
                  "source_url": "<AD_URL>",
                  "source_id": "<AD_ID>",
                  "source_type": "ad",
                  "body": "<AD_PRIMARY_TEXT>",
                  "headline": "<AD_HEADLINE>",
                  "media_type": "<AD_MEDIA_TYPE>",
                  "image_url": "<AD_IMAGE_URL>",
                  "video_url": "<AD_VIDEO_URL>",
                  "thumbnail_url": "<AD_VIDEO_THUMBNAIL>",
                  "ctwa_clid": "<AD_CLICK_ID>",
                  "welcome_message": {
                    "text": "<AD_GREETING_TEXT>"
                  }
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

## Parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<AD_CLICK_ID>`<br><br>_String_ | Click to WhatsApp ad click ID.<br><br>The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status ([WhatsApp Status ad placements](https://www.facebook.com/business/help/1074444721456755)). | `Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50` |
| `<AD_GREETING_TEXT>`<br><br>_String_ | Click to WhatsApp ad greeting text. | `Hi there! Let us know how we can help!` |
| `<AD_HEADLINE>`<br><br>_String_ | Click to WhatsApp ad headline. | `Chat with us` |
| `<AD_ID>`<br><br>_String_ | Click to WhatsApp ad ID. | `120226305854810726` |
| `<AD_IMAGE_URL>`<br><br>_String_ | Click to WhatsApp ad image URL. Only included if the ad is an image ad. | `https://scontent.xx.fbcdn.net/v/t45.1...` |
| `<AD_MEDIA_TYPE>`<br><br>_String_ | Click to WhatsApp ad media type. Values can be:<br><br>`image` — Indicates an image ad.<br><br>`video` — Indicates a video ad. | `image` |
| `<AD_PRIMARY_TEXT>`<br><br>_String_ | Click to WhatsApp ad primary text. | `Summer succulents are here!` |
| `<AD_URL>`<br><br>_String_ | Click to WhatsApp ad URL. | `https://fb.me/3cr4Wqqkv` |
| `<AD_VIDEO_THUMBNAIL>`<br><br>_String_ | Click to WhatsApp ad video thumbnail URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.3...` |
| `<AD_VIDEO_URL>`<br><br>_String_ | Click to WhatsApp ad video URL. Only included if ad is a video ad. | `https://scontent.xx.fbcdn.net/v/t45.2...` |
| `<BUSINESS_DISPLAY_PHONE_NUMBER>`<br><br>_String_ | Business display phone number. | `15550783881` |
| `<BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | Business phone number ID. | `106540352242922` |
| `<IDENTITY_KEY_HASH>`<br><br>_String_ | Identity key hash. Only included if you have enabled the [identity change check](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) feature. | `DF2lS5v2W6x=` |
| `<MEDIA_ASSET_CAPTION>`<br><br>_String_ | Media asset caption text. | `Taj Mahal` |
| `<MEDIA_ASSET_ID>`<br><br>_String_ | Media asset ID. You can [perform a GET on this ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media) to get the asset URL, then perform a GET on the returned URL (using your access token) to get the underlying asset. | `1003383421387256` |
| `<MEDIA_ASSET_MIME_TYPE>`<br><br>_String_ | Media asset MIME type. | `image/jpeg` |
| `<MEDIA_ASSET_SHA256_HASH>`<br><br>_String_ | Media asset SHA-256 hash. | `SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=` |
| `<MEDIA_ASSET_URL>`<br><br>_String_ | **This JSON property is being released to developers gradually over several weeks, starting November 12, 2025, and may not be available to you immediately.**<br><br>Media URL. You can query this URL directly with your access token to [download the media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#download-media). | `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...` |
| `<WEBHOOK_TRIGGER_TIMESTAMP>`<br><br>_String_ | Unix timestamp indicating when the webhook was triggered. | `1739321024` |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | WhatsApp Business Account ID. | `102290129340398` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | WhatsApp message ID. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=` |
| `<WHATSAPP_USER_ID>`<br><br>_String_ | WhatsApp user ID. Note that a WhatsApp user's ID and phone number may not always match. | `16505551234` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | WhatsApp user phone number. This is the same value returned by the API as the `input` value when sending a message to a WhatsApp user. Note that a WhatsApp user's phone number and ID may not always match. | `+16505551234` |
| `<WHATSAPP_USER_PROFILE_NAME>`<br><br>_String_ | WhatsApp user's name as it appears in their profile in the WhatsApp client. | `Sheena Nelson` |

## Example video message webhook

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1744344496",
                "type": "video",
                "video": {
                  "caption": "Timelapse of growth",
                  "mime_type": "video/mp4",
                  "sha256": "vdGU5X4caz12KwFgYwpljlUNqMt1YnkH+5GkPc3mMnc=",
                  "id": "731675419373506",
                  "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```
# Template fundamentals



This document covers template mechanics that apply across all template categories. For category-specific template guides, see [Marketing messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview/), [Utility messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates/), and [Authentication messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates/).

Templates are WhatsApp Business Account assets that can be sent in template messages via Cloud API or Marketing Messages API for WhatsApp. Template messages are the only type of message that can be sent to WhatsApp users outside of a [customer service window](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#customer-service-windows). Templates are commonly used when messaging users in bulk or when no customer service window is open between you and the user.

## Creation

Use the [Message Templates API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-waba-id-message-templates) or [message templates panel](https://business.facebook.com/latest/whatsapp_manager/message_templates) in WhatsApp Manager to create a template.

Template creation via API uses a common syntax. The bulk of the variation occurs in the `category` string, which assigns a category to the template, and the `components` array, which defines the components that make up the template.

You can create a maximum of 100 templates in a WhatsApp Business Account per hour.

### Common syntax

```html
curl 'https://graph.facebook.com/v23.0/102290129340398/message_templates' \
-H 'Authorization: Bearer EAAJB...' \
-H 'Content-Type: application/json' \
-d '
{
"name": "<NAME>",
"category": "<CATEGORY>",
"language": "<LANGUAGE>",
"parameter_format": "<PARAMETER_FORMAT>",
"components": [<COMPONENTS>]
}'
```

### Names

Every template must have a name, but names are not unique. This flexibility allows you to create multiple templates with the same name, but in different languages.

Template names are limited to a maximum of 512 characters, consisting of lowercase alphanumeric characters and underscores.

### Categories

Each template must be categorized as **authentication**, **marketing**, or **utility**. The [template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization) guide describes how to assign the proper category to a template, and what can happen if a template has been miscategorized.

Note that template categories also factor into [pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).

### Components

Templates are made up of various text, media, and interactive UI components, which you define upon template creation. The [template components](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components) guide describes all possible components and how to define them.

Since there are a lot of components to choose from, see the [Authentication messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates), [Marketing messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview/), and [Utility messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates/) sections for category-specific template guides with code examples showing how to create various templates with commonly used components.

### Languages

You must assign a [template language code](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages) upon template creation. Template strings and variables are not translated by Meta, so you are responsible for supplying strings and example parameters in their appropriate language.

If you create multiple templates with the same name but with different languages, each template counts against your [template limit](#template-limits).

### Parameter formats

Some template components allow you to define strings that contain one or more parameters (described as "variables" in WhatsApp Manager). These are replaced with values included by you in your send message payload when you send the template.

Upon template creation, if a string includes one or more parameters, you can specify their format — either `named` or `positional` — and you must include an example value for each parameter. If you do not specify a format, the template uses `positional` format by default.

#### Named parameters

Parameters using the named format must be unique, single strings, composed of lowercase characters and underscores, wrapped in double curly brackets, for example, `{{first_name}}`. Example values in template creation payloads and real values in template send payloads can appear in any order.

Example template creation payload with named parameters:

```json
{
"name": "order_confirmation",
"language": "en_US",
"category": "utility",
"parameter_format": "named",
"components": [
  {
    "type": "body",
    "text": "Thank you, {{first_name}}! Your order number is {{order_number}}.",
    "example": {
      "body_text_named_params": [
        {
          "param_name": "first_name",
          "example": "Pablo"
        },
        {
          "param_name": "order_number",
          "example": "860198-230332"
        }
      ]
    }
  }
]
}
```

Example template send payload of template that uses named parameters:

```json
{
"messaging_product": "whatsapp",
"recipient_type": "individual",
"to": "+16505551234",
"type": "template",
"template": {
  "name": "order_confirmation",
  "language": {
    "code": "en_US"
  },
  "components": [
    {
      "type": "body",
      "parameters": [
        {
          "type": "text",
          "parameter_name": "first_name",
          "text": "Jessica"
        },
        {
          "type": "text",
          "parameter_name": "order_number",
          "text": "SKBUP2-4CPIG9"
        }
      ]
    }
  ]
}
}
```

#### Positional parameters

Positional parameters must be ordered array index numbers, starting from 1, wrapped in double curly brackets: (`{{1}}`...`{{2}}`...and so on). Example values in template creation payloads and real values in template send payloads must appear in the order in which their corresponding placeholders appear in the component text string.

Example template creation payload with positional parameter:

```json
{
"name": "order_confirmation",
"language": "en_US",
"category": "utility",
"parameter_format": "positional",
"components": [
  {
    "type": "body",
    "text": "Hi {{1}}! Your order number is {{2}}. Thank you.",
    "example": {
      "body_text": [
        [
          "Pablo",
          "860198-230332"
        ]
      ]
    }
  }
]
}
```

Example template send payload of template that uses positional parameter:

```json
{
"messaging_product": "whatsapp",
"recipient_type": "individual",
"to": "+16505551234",
"type": "template",
"template": {
  "name": "order_confirmation",
  "language": {
    "code": "en_US"
  },
  "components": [
    {
      "type": "body",
      "parameters": [
        {
          "type": "text",
          "text": "Jessica"
        },
        {
          "type": "text",
          "text": "SKBUP2-4CPIG9"
        }
      ]
    }
  ]
}
}
```

## Media

Template header components can display media assets. If you are creating a template with a media header, you must use the [Resumable Upload API](https://developers.facebook.com/docs/graph-api/guides/upload) to obtain an asset handle, and include this asset handle in your template creation request. The example asset will be reviewed as part of [template review](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review).

## Template review

Templates are automatically reviewed upon creation or after editing. If your template is approved, its status is set to `APPROVED` and you can begin sending it in template messages. If it is rejected, or if its status changes to any other value, it cannot be sent in template messages.

See [Template review](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review) to learn more about the review process, common rejection reasons, and what you can do if your template is rejected.

## Template status

Templates must have a status of `APPROVED` before they can be sent in template messages. A template's status is initially set by the template review process, but can be changed to another value based on usage and [quality feedback](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality).

Template status changes are communicated via [message_template_status_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update) webhooks, but you can use the [Template API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#get-version-template-id) and request the `status` field to get the status of a template at any time.

### Example request

```html
curl 'https://graph.facebook.com/<API_VERSION>/<TEMPLATE_ID>?fields=status' \
-H 'Authorization: Bearer <ACCESS_TOKEN>'
```

### Example response

```json
{
"status": "APPROVED",
"id": "1259544702043867"
}
```

See the [Template API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#get-version-template-id) reference for a list of all possible status values and what they mean.

### WhatsApp Manager

The [Manage templates](https://business.facebook.com/latest/whatsapp_manager/message_templates) panel in WhatsApp Manager also displays template statuses, and appends quality ratings for approved (`active`) templates:

- **In-Review**: Indicates that the template is still under review. Review can take up to 24 hours.
- **Rejected**: The template has been rejected during the review process or violates one or more policies.
- **Active - Quality pending**: The message template has yet to receive quality feedback or read-rate information from customers. Message templates with this status can be sent to customers.
- **Active - High Quality**: The template has received little to no negative customer feedback. Message templates with this status can be sent to customers.
- **Active - Medium Quality**: The template has received negative feedback from multiple customers, or low read-rates, but might soon become paused or disabled. Message templates with this status can be sent to customers.
- **Active - Low Quality**: The template has received negative feedback from multiple customers, or low read-rates. Message templates with this status can be sent to customers but are in danger of being paused or disabled soon, so address the issues that customers are reporting.
- **Paused**: The template has been paused due to recurring negative feedback from customers, or low read-rates. Message templates with this status cannot be sent to customers. See [Template Pausing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing).
- **Disabled**: The template has been disabled due to recurring negative feedback from customers. Message templates with this status cannot be sent to customers.
- **Appeal Requested**: Indicates that an appeal has been requested.

## Template limits

The number of templates a WhatsApp Business Account can have is determined by its parent business portfolio.

If a parent business portfolio is unverified, each of its WhatsApp Business Accounts is limited to 250 message templates. However, if the portfolio is [verified](https://www.facebook.com/business/help/1095661473946872), and at least one of its WhatsApp Business Accounts has a business phone number with an approved [display name](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names), each of its WhatsApp Business Accounts can have up to 6,000 templates.

Additionally, there are limits on the number of templates you can send, as well as processes that can affect template delivery:

- [Messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits) — A limit on the number of message templates you can send outside of customer service windows.
- [Template pacing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing) — A process that allows time for WhatsApp users to provide feedback on message templates.
- [Template pausing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing) — A process that can temporarily pause message templates that have received poor feedback.
- [Template archival](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-archival) — A process that automatically archives and deletes templates that have been inactive for 12 months or more. Archived templates are deleted after 28 days unless unarchived.
- [Per-user marketing template message limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits) — A process that limits the number of marketing message templates a given WhatsApp user may receive from any business.

## Time-to-live

If a message sent to a WhatsApp user cannot be delivered, the system will continue attempting delivery for a period known as the time-to-live (TTL). You can customize the TTL for templates upon template creation.

See [Time-to-live](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live) for more information.

## Quality rating

Template quality rating is a system used to evaluate the quality of message templates, based on usage, customer feedback, and engagement. This rating helps maintain a high-quality messaging ecosystem and helps ensure that you are sending relevant and well-received messages.

See [Template quality rating](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality) for more information about quality ratings, how they can affect a template's status, and how you can be notified of changes to template quality scores.

## Delivery sequence of multiple messages

When sending a series of messages, the order in which messages are delivered is not guaranteed to match the order of your API requests. If you need to ensure the sequence of message delivery, confirm receipt of a `delivered` status in a [status messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) webhook before sending the next message in your message sequence.

## Template management

See [Template management](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management) for a list of endpoints commonly used for getting, updating, and deleting templates.
# Template components



Templates are made up of four primary components which you define when you create a template: header, body, footer, and buttons. The components you choose for each of your templates should be based on your business needs. The only required component is the body component.

Some components support variables, whose values you can supply when using the Cloud API to send the template in a template message. If your templates use variables, you must include sample variable values upon template creation.

## Text header

Text headers are optional elements that can be added to the top of template messages. Each template may include only one text header. Do not use Markdown special characters in this component.

Text headers support 1 [parameter](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#parameter-formats).

### Creation syntax

```html
<!-- No parameter syntax -->
{
  "type": "header",
  "format": "text",
  "text": "<HEADER_TEXT>"
}

<!-- Named parameter syntax -->
{
  "type": "header",
  "format": "text",
  "text": "<HEADER_TEXT>",
  "example": {
    "header_text_named_params": [
      {
        "param_name": "<NAMED_PARAMETER_NAME>",
        "example": "<PARAMETER_EXAMPLE_VALUE>"
      }
    ]
  }
}

<!-- Positional parameter syntax -->
{
  "type": "header",
  "format": "text",
  "text": "<HEADER_TEXT>",
  "example": {
    "header_text": [
      "<PARAMETER_EXAMPLE_VALUE>"
    ]
  }
}
```

### Creation parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<HEADER_TEXT>`<br><br>_String_ | **Required.**<br><br>Header body text string. Supports 1 [parameter](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#parameter-formats).<br><br>If this string contains a parameter, you must include the `example` property and example parameter value.<br><br>Maximum 60 characters. | `Our new sale starts {{sale_start_date}}!` |
| `<NAMED_PARAMETER_NAME>`<br><br>_String_ | **Required if using a named parameter.**<br><br>[Named parameter](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#named-parameters) name. | `{{sale_start_date}}` |
| `<PARAMETER_EXAMPLE_VALUE>`<br><br>_String_ | **Required if using a parameter.**<br><br>[Parameter](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#parameter-formats) example value. | `December 1st` |

### Creation example

This example uses 1 named parameter.

```json
{
  "type": "HEADER",
  "format": "TEXT",
  "text": "Our new sale starts {{sale_start_date}}!",
  "example": {
    "header_text_named_params": [
      {
        "param_name": "sale_start_date",
        "example": "December 1st"
      }
    ]
  }
}
```

## Media header

Media headers can be an image, video, gif, or a document such as a PDF. You must upload all media with the [Resumable Upload API](https://developers.facebook.com/docs/graph-api/guides/upload). The syntax for defining a media header is the same for all media types.

Note: Gifs are only available for [Marketing Messages API for WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/features). Gifs are mp4 files with a max size of 3.5MB, and WhatsApp displays larger files as video messages.

### Creation syntax

```html
{
  "type": "HEADER",
  "format": "<FORMAT>",
  "example": {
    "header_handle": [
      "<HEADER_HANDLE>"
    ]
  }
}
```

### Creation parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<FORMAT>` | Indicates media asset type. Set to `IMAGE`, `VIDEO`, `GIF`, or `DOCUMENT`. | `IMAGE` |
| `<HEADER_HANDLE>` | Uploaded media asset handle. Use the [Resumable Upload API](https://developers.facebook.com/docs/graph-api/guides/upload) to generate an asset handle. | `4::aW...` |

### Creation example

```json
{
  "type": "HEADER",
  "format": "IMAGE",
  "example": {
    "header_handle": [
      "4::aW..."
    ]
  }
}
```

## Location header

Location headers appear as generic maps at the top of the template and are useful for use cases such as order tracking, delivery updates, ride-hailing pickup/dropoff, and locating physical stores. When tapped, the app user's default map app opens and loads the specified location. You specify locations when you send the template.

Location headers can only be used in templates categorized as `UTILITY` or `MARKETING`. Real-time locations are not supported.

### Creation syntax

```json
{
  "type": "header",
  "format": "location"
}
```

### Creation parameters

None.

### Creation example

```json
{
  "type": "header",
  "format": "location"
}
```

### Send syntax

```html
{
  "type": "header",
  "parameters": [
    {
      "type": "location",
      "location": {
        "latitude": "<LOCATION_LATITUDE>",
        "longitude": "<LOCATION_LONGITUDE>",
        "name": "<LOCATION_NAME>",
        "address": "<LOCATION_ADDRESS>"
      }
    }
  ]
}
```

### Send parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<LOCATION_ADDRESS>` | Location address. | `101 Forest Ave, Palo Alto, CA 94301` |
| `<LOCATION_LATITUDE>` | Location latitude in decimal degrees. | `37.44211676562361` |
| `<LOCATION_LONGITUDE>` | Location longitude in decimal degrees. | `122.16155960083124` |
| `<LOCATION_NAME>` | Location name. | `Philz Coffee` |

### Send example

```json
{
  "type": "header",
  "parameters": [
    {
      "type": "location",
      "location": {
        "latitude": "37.44211676562361",
        "longitude": "-122.16155960083124",
        "name": "Philz Coffee",
        "address": "101 Forest Ave, Palo Alto, CA 94301"
      }
    }
  ]
}
```

## Body

The body component represents the core text of your message template and is a text-only template component. Templates are limited to one body component.

The message text in the body component accepts multiple [parameters](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#parameter-formats).

### Creation syntax

```html
<!-- No parameters syntax -->
{
  "type": "body",
  "text": "<BODY_TEXT>"
}

<!-- Named parameters syntax -->
{
  "type": "body",
  "text": "<BODY_TEXT>",
  "example": {
    "body_text_named_params": [
      {
        "param_name": "<NAMED_PARAMETER_NAME>",
        "example": "<PARAMETER_EXAMPLE_VALUE>"
      }
      <!-- Additional named parameters go here, if using -->
    ]
  }
}

<!-- Positional parameters syntax -->
{
  "type": "body",
  "text": "<BODY_TEXT>",
  "example": {
    "body_text": [
      "<PARAMETER_EXAMPLE_VALUE>"
      <!-- Additional positional parameters go here, if using -->
    ]
  }
}
```

### Creation parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<BODY_TEXT>`<br><br>_String_ | **Required.**<br><br>Body text string. Supports multiple [parameters](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#parameter-formats).<br><br>Maximum of 1024 characters. | `Thank you, {{first_name}}! Your order number is {{order_number}}.` |
| `<NAMED_PARAMETER_NAME>`<br><br>_String_ | **Required if using a named parameter.**<br><br>[Named parameter](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#named-parameters) name. | `{{order_number}}` |
| `<PARAMETER_EXAMPLE_VALUE>`<br><br>_String_ | **Required if using a parameter.**<br><br>[Parameter](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#parameter-formats) example value. | `December 1st` |

### Creation example

```json
{
  "type": "body",
  "text": "Thank you, {{first_name}}! Your order number is {{order_number}}.",
  "example": {
    "body_text_named_params": [
      {
        "param_name": "first_name",
        "example": "Pablo"
      },
      {
        "param_name": "order_number",
        "example": "860198-230332"
      }
    ]
  }
}
```

## Footer

Footers are optional text-only components that appear immediately after the body component. Templates are limited to one footer component.

### Syntax

```html
{
  "type": "FOOTER",
  "text": "<TEXT>"
}
```

### Properties

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<TEXT>` | Text to appear in template footer when sent.<br><br>60 characters maximum. | `Use the buttons below to manage your marketing subscriptions` |

### Example

```json
{
  "type": "FOOTER",
  "text": "Use the buttons below to manage your marketing subscriptions"
}
```

## Buttons

Buttons are optional interactive components that perform specific actions when tapped.

Templates can have a combination of up to 10 button components in total, although there are limits to individual buttons of the same type as well as combination limits, which are described below. In addition, templates composed of 4 or more buttons, or a quick reply button and one or more buttons of another type, cannot be viewed on WhatsApp desktop clients. WhatsApp users who receive one of these template messages will be prompted to view the message on a phone instead.

Buttons are defined within a single buttons component object, packed into a single `buttons` array. For example, this template uses a voice call button and a URL button:

```json
{
  "type": "BUTTONS",
  "buttons": [
    {
      "type": "VOICE_CALL",
      "text": "Call"
    },
    {
      "type": "URL",
      "text": "Shop Now",
      "url": "https://www.luckyshrub.com/shop/"
    }
  ]
}
```

If a template has more than three buttons, two buttons appear in the delivered message, and WhatsApp replaces the remaining buttons with a **See all options** button. Tapping the **See all options** button reveals the remaining buttons.

### Copy code buttons

Copy code buttons copy a text string (defined when the template is sent in a template message) to the device's clipboard when tapped by the app user. Templates are limited to one copy code button.

#### Syntax

```html
{
  "type": "COPY_CODE",
  "example": "<EXAMPLE>"
}
```

#### Properties

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<EXAMPLE>` | String to be copied to the device's clipboard when tapped by the app user.<br><br>Maximum 20 characters. | `250FF` |

#### Example

```json
{
  "type": "COPY_CODE",
  "example": "250FF"
}
```

### Multi-product message buttons

Multi-product message buttons are special, non-customizable buttons that, when tapped, display up to 30 products from your ecommerce catalog, organized in up to 10 sections, in a single message. See [Multi-Product Message Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/mpm-template-messages).

### One-time password buttons

One-time password buttons are a special type of [URL button](#url-buttons) component used with authentication templates. See [Authentication Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates).

### Voice call buttons

Voice call buttons make a WhatsApp call to the business when tapped by the app user. See [Create and send WhatsApp call button template message](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links/#create-and-send-whatsapp-call-button-template-message) to learn more.

### Phone number buttons

Phone number buttons call the specified business phone number when tapped by the app user. Templates are limited to one phone number button.

#### Syntax

```html
{
  "type": "PHONE_NUMBER",
  "text": "<TEXT>",
  "phone_number": "<PHONE_NUMBER>"
}
```

#### Properties

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<PHONE_NUMBER>` | Alphanumeric string. Business phone number to be called when the user taps the button.<br><br>Note that some countries have special phone numbers that have leading zeros after the country calling code (for example, +55-0-955-585-95436). If you assign one of these numbers to the button, the leading zero will be stripped from the number. If your number will not work without the leading zero, assign an alternate number to the button, or add the number as message body text.<br><br>20 characters maximum. | `15550051310` |
| `<TEXT>` | Button label text.<br><br>25 characters maximum. | `Call` |

#### Example

```json
{
  "type": "PHONE_NUMBER",
  "text": "Call",
  "phone_number": "15550051310"
}
```

### Quick reply buttons

Quick reply buttons are custom text-only buttons that immediately message you with the specified text string when tapped by the app user. A common use case is a button that allows your customer to easily opt-out of any marketing messages.

Templates are limited to 10 quick reply buttons. If using quick reply buttons with other buttons, buttons must be organized into two groups: quick reply buttons and non-quick reply buttons. If grouped incorrectly, the API will return an error indicating an invalid combination.

Examples of valid groupings:

* Quick Reply, Quick Reply
* Quick Reply, Quick Reply, URL, Phone
* URL, Phone, Quick Reply, Quick Reply

Examples of invalid groupings:

* Quick Reply, URL, Quick Reply
* URL, Quick Reply, URL

When using the API to send a template that has multiple quick reply buttons, you can use the index property to designate the order in which buttons appear in the template message.

#### Syntax

```json
{
  "type": "QUICK_REPLY",
  "text": "<TEXT>"
}
```

#### Properties

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<TEXT>` | Button label text.<br><br>25 characters maximum. | `Unsubscribe` |

#### Example

```html
{
  "type": "QUICK_REPLY",
  "text": "Unsubscribe from Promos"
}
```

### SPM buttons

Single-product message (SPM) buttons are special, non-customizable buttons that can be mapped to a product in your product catalog. When tapped, they load details about the product, which the button pulls from your catalog. Users can then add the product to their cart and place an order. See [Single-Product Message Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/spm-template-messages) and [Product Card Carousel Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/product-card-carousel-template-messages).

### URL buttons

URL buttons load the specified URL in the device's default web browser when tapped by the app user. Templates are limited to two URL buttons.

#### Syntax

```html
{
  "type": "URL",
  "text": "<TEXT>",
  "url": "<URL>",

  # Required if <URL> contains a variable
  "example": [
    "<EXAMPLE>"
  ]
}
```

#### Properties

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<EXAMPLE>` | URL of website. Supports 1 variable.<br><br>If using a variable, add sample variable property to the end of the URL string. The URL loads in the device's default mobile web browser when the customer taps the button.<br><br>2000 characters maximum. | `https://www.luckyshrub.com/shop?promo=summer2023` |
| `<TEXT>` | Button label text. 25 characters maximum. | `Shop Now` |
| `<URL>` | URL of website that loads in the device's default mobile web browser when the button is tapped by the app user.<br><br>Supports 1 variable, appended to the end of the URL string.<br><br>2000 characters maximum. | `https://www.luckyshrub.com/shop?promo={{1}}` |

#### Example

```json
{
  "type": "URL",
  "text": "Shop Now",
  "url": "https://www.luckyshrub.com/shop?promo={{1}}",
  "example": [
    "summer2023"
  ]
}
```

#### URL encoding

If your URL button parameter values contain special characters, you must percent-encode them before including them in your send template message request. Unencoded special characters can cause the generated URL to fail validation, resulting in a message send error.

The following characters are common sources of encoding issues:

| Character | Encoded value | Example |
| --- | --- | --- |
| Space | `%20` | `New York` → `New%20York` |
| `:` | `%3A` | `x:key` → `x%3Akey` |
| `\|` | `%7C` | `9\|DL` → `9%7CDL` |
| `ç` | `%C3%A7` | `Gonçalves` → `Gon%C3%A7alves` |
| `ñ` | `%C3%B1` | `Peña` → `Pe%C3%B1a` |

For example, if your template URL is `https://example.com/order?name={{customer_name}}` and the parameter value is `Gonçalves`, you must send the value as `Gon%C3%A7alves`:

```json
{
  "type": "button",
  "sub_type": "url",
  "index": "0",
  "parameters": [
    {
      "type": "text",
      "parameter_name": "customer_name",
      "text": "Gon%C3%A7alves"
    }
  ]
}
```

## Limited-time offer

Limited-Time Offer components are special components used to create [limited-time offer templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/limited-time-offer-templates).

## Example requests

### Seasonal promotion

An example request to create a marketing template with the following components:

* a text header with a variable and sample value
* a text body with variables and sample values
* a text footer
* two quick-reply buttons

```curl
curl -L 'https://graph.facebook.com/v25.0/102290129340398/message_templates' \
-H 'Authorization: Bearer EAAJB...' \
-H 'Content-Type: application/json' \
-d '
{
  "name": "seasonal_promotion",
  "language": "en_US",
  "category": "MARKETING",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Our {{1}} is on!",
      "example": {
        "header_text": [
          "Summer Sale"
        ]
      }
    },
    {
      "type": "BODY",
      "text": "Shop now through {{1}} and use code {{2}} to get {{3}} off of all merchandise.",
      "example": {
        "body_text": [
          [
            "the end of August","25OFF","25%"
          ]
        ]
      }
    },
    {
      "type": "FOOTER",
      "text": "Use the buttons below to manage your marketing subscriptions"
    },
    {
      "type":"BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Unsubscribe from Promos"
        },
        {
          "type":"QUICK_REPLY",
          "text": "Unsubscribe from All"
        }
      ]
    }
  ]
}'
```

### Order confirmation

An example request to create a utility template with the following components:

* a document header with a sample value
* a text body with variables and sample values
* a phone number button
* a URL button

```curl
curl -L 'https://graph.facebook.com/v16.0/102290129340398/message_templates' \
-H 'Authorization: Bearer EAAJB...' \
-H 'Content-Type: application/json' \
-d '
{
  "name": "order_confirmation",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {
      "type": "HEADER",
      "format": "DOCUMENT",
      "example": {
        "header_handle": [
          "4::YX..."
        ]
      }
    },
    {
      "type": "BODY",
      "text": "Thank you for your order, {{1}}! Your order number is {{2}}. Tap the PDF linked above to view your receipt. If you have any questions, please use the buttons below to contact support. Thank you for being a customer!",
      "example": {
        "body_text": [
          [
            "Pablo","860198-230332"
          ]
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "PHONE_NUMBER",
          "text": "Call",
          "phone_number": "15550051310"
        },
        {
          "type": "URL",
          "text": "Contact Support",
          "url": "https://www.luckyshrub.com/support"
        }
      ]
    }
  ]
}'
```

### Order delivery update

An example request to create a utility template with the following components:

* a location header
* a text body with variables and sample values
* a footer
* a quick reply button

```curl
curl 'https://graph.facebook.com/v25.0/102290129340398/message_templates' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "name": "order_delivery_update",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {
      "type": "HEADER",
      "format": "LOCATION"
    },
    {
      "type": "BODY",
      "text": "Good news {{1}}! Your order #{{2}} is on its way to the location above. Thank you for your order!",
      "example": {
        "body_text": [
          [
            "Mark",
            "566701"
          ]
        ]
      }
    },
    {
      "type": "FOOTER",
      "text": "To stop receiving delivery updates, tap the button below."
    },
    {
      "type":"BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Stop Delivery Updates"
        }
      ]
    }
  ]
}'
```

## Webhooks

Subscribe to the [message_template_components_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_components_update) webhook field to be notified of changes to a template's components.
# Template Library



Template Library makes it faster and easier for businesses to create utility templates for common use cases, like payment reminders, delivery updates — and authentication templates for common identity verification use cases.

These pre-written templates have already been categorized as utility or authentication. Library templates contain fixed content that cannot be edited and parameters you can adapt for business or user-specific information.

You can browse and create templates using Template Library in WhatsApp Manager, or programmatically via the API.

## Creating templates via WhatsApp Manager (WAM)

Follow the instructions below to create templates using the Template Library in [WhatsApp Manager](https://business.facebook.com/wa/manage/template-library).

1. In the sidebar of WAM, under **Message Templates**, select **Create Template**.

2. Under *Browse the WhatsApp Template Library*, select **Browse Templates**.

3. You will now see all currently available templates. Use the search bar to search by topic or use case, or use the dropdown options on the sidebar to filter the results.

Hovering over a template will show you its parameter values.

4. To create a template, **select one** by clicking on it. Then, add your template name, select the language, and fill out the button details. Once you have completed these steps, click **Submit**.

Note: If you choose **Customize template**, your template will have to go through review before you are able to send messages.

## Template parameters and restrictions

**Warning:** When a template contains the value `library_template_name` in the `GET <WABAID>/message_templates?name=<TEMPLATE_NAME>` response, it is a template created from the Template Library and is subject to type checks and restrictions.

Templates in the library contain both fixed content and parameters. The parameters represent spaces in the template where variable information can be inserted, such as names, addresses, and phone numbers.

In the example above, parameters like the name `Jim` or the business name `CS Mutual` can be modified to accept variables like your customer's name and your business's name.

Messages sent using templates from Template Library are subject to parameter checks during send time. Values used in parameters that are outside of the established ranges listed below will cause the message send to fail.

### List of parameters and sample values

**Warning:** All parameters are length restricted. If you receive an error, try again with a shorter value.

| Parameter Type | Description | Sample Value |
| --- | --- | --- |
| `ADDRESS` | A location address.<br><br>* Must be a valid address | * `1 Hacker Way, Menlo Park, CA 94025` |
| `TEXT` | Basic text. | * `regarding your order.`<br>* `12 pack of paper towels`<br>* `your request`<br>* `purchase`<br>* `Jasper's Market` |
| `AMOUNT` | A number signifying a quantity.<br><br>* May contain a prefix or suffix for monetary values such as USD or RS<br>* May contain decimals (.) and commas (,)<br>* May contain valid currency symbols such as $ and € | * `145`<br>* `USD $375.32`<br>* `€1,376.22 EUR`<br>* `RS 1200` |
| `DATE` | A standard calendar date. | * `2021-04-19`<br>* `13/03/2021`<br>* `5th January 1982`<br>* `08.22.1991`<br>* `January 1st, 2024`<br>* `05 12 2022` |
| `PHONE NUMBER` | A telephone number.<br><br>* May contain numbers, spaces, dashes (-), parentheses, and plus symbols (+) | * `+1 4256789900`<br>* `+91-7884-789122`<br>* `+39 87 62232` |
| `EMAIL` | A standard email address.<br><br>* Must be a valid email address | * `1hackerway@meta.com`<br>* `yourcustomername@gmail.com`<br>* `abusinessorcustomername@hotmail.com` |
| `NUMBER` | A number.<br><br>* Must be a number.<br>* Cannot contain spaces. | * `23444`<br>* `90001234921388904`<br>* `453638` |

## Forms

**Warning:** Forms are only available to accounts who have had their message limits increased.

Some templates in Template Library are interactive forms that are powered by WhatsApp Flows.

In WhatsApp Manager, you can identify these specific templates by the "Form" label they contain. The current supported use cases are Customer Feedback and Delivery Failure.

### Identifying forms in the request response

When calling the `GET /message_template_library` endpoint, the `type` key in the `buttons` array will show as `"FORMS"`.

```json
{
      "name": "delivery_failed_2_form",
      "language": "en_US",
      "category": "UTILITY",
      "topic": "ORDER_MANAGEMENT",
      "usecase": "DELIVERY_FAILED",
      "industry": [
        "E_COMMERCE"
      ],
      "body": "We were unable to deliver order {{1}} today.

Please {{2}} to schedule another delivery attempt.",
      "body_params": [
        "#12345",
        "try a redelivery"
      ],
      "body_param_types": [
        "TEXT",
        "TEXT"
      ],
      "buttons": [
        {
          "type": "FLOW",
          "text": "Reschedule"
        }
      ],
      "id": "7138055039625658"
},
```

## Using the API

The Template Library API has two endpoints:

```https
// Used to browse available library templates
GET /message_template_library
```

```https
// Used when you are ready to create a template from the library.
POST /<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates
```

### Searching and filtering available templates

**Warning:** Templates with `Header` parameter types of `Document` only support PDFs.

To browse and filter available templates, use the `message_template_library` endpoint.

Once you find the template you are interested in, note the name as you will use it when creating the template via the `POST` method.

### Request syntax

```https
// Get all available templates
GET /message_template_library

// Search for substring
GET /message_template_library?search=<SEARCH_KEY>

// Filter by template topic
GET/message_template_library?topic=<TOPIC>

// Filter by template use case
GET/message_template_library?usecase=<USECASE>

// Filter by template industry
GET/message_template_library?industry=<INDUSTRY>

// Filter by template language
GET/message_template_library?language=<LANGUAGE>

// Search by template name
GET /message_template_library?name=<NAME>
```

### Query string parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<SEARCH_KEY>`<br><br>_String_ | **Optional.**<br><br>A substring you are searching for in the content, name, header, body, or footer of the template. | `payments` |
| `<TOPIC>`<br><br>_Enum_ | **Optional.**<br><br>The topic of the template.<br><br>See Template Filters below | `ORDER_MANAGEMENT` |
| `<USECASE>`<br><br>_Enum_ | **Optional.**<br><br>The use case of the template.<br><br>See Template Filters below | `SHIPMENT_CONFIRMATION` |
| `<INDUSTRY>`<br><br>_Enum_ | **Optional.**<br><br>The industry of the template.<br><br>See Template Filters below | `E_COMMERCE` |
| `<LANGUAGE>`<br><br>_Enum_ | **Optional.**<br><br>The template language locale code.<br><br>See [Supported Languages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages) | `en_US` |
| `<NAME>`<br><br>_String_ | **Optional.**<br><br>The name of the template you are searching for in the template library. | `verify_otp_usecase` |

### Example request

```curl
curl 'https://graph.facebook.com/v25.0/102290129340398/message_templates?search="payments"'
-H 'Authorization: Bearer EAAJB...'
```

### Example response

```json
{
      "name": "low_balance_warning_1",
      "language": "en_US",
      "category": "UTILITY",
      "topic": "PAYMENTS",
      "usecase": "LOW_BALANCE_WARNING",
      "industry": [
        "FINANCIAL_SERVICES"
      ],
      "header": "Your account balance is low",
      "body": "Hi {{1}},
This is to notify you that your {{2}} in your {{3}} account, ending in {{4}} is below your pre-set {{5}} of {{6}}.
Click the button to deposit more {{7}}.
{{8}}",
      "body_params": [
        "Jim",
        "available funds",
        "CS Mutual checking plus",
        "1234",
        "limit",
        "$75.00",
        "funds",
        "CS Mutual"
      ],
      "buttons": [
        {
          "type": "URL",
          "text": "Make a deposit",
          "url": "https://www.example.com/"
        },
        {
          "type": "PHONE_NUMBER",
          "text": "Call us",
          "phone_number": "+18005551234"
        }
      ],
      "id": "7147013345418927"
}
```

### Template filters

There are several templates to choose from in the Template Library. You can use the API to filter them based on a few factors.

**Industry**

- `E_COMMERCE`
- `FINANCIAL_SERVICES`

**Topic**

- `ACCOUNT_UPDATE`
- `CUSTOMER_FEEDBACK`
- `ORDER_MANAGEMENT`
- `PAYMENTS`

**Use case**

- `ACCOUNT_CREATION_CONFIRMATION`
- `AUTO_PAY_REMINDER`
- `DELIVERY_CONFIRMATION`
- `DELIVERY_FAILED`
- `DELIVERY_UPDATE`
- `FEEDBACK_SURVEY`
- `FRAUD_ALERT`
- `LOW_BALANCE_WARNING`
- `ORDER_ACTION_NEEDED`
- `ORDER_CONFIRMATION`
- `ORDER_DELAY`
- `ORDER_OR_TRANSACTION_CANCEL`
- `ORDER_PICK_UP`
- `PAYMENT_ACTION_REQUIRED`
- `PAYMENT_CONFIRMATION`
- `PAYMENT_DUE_REMINDER`
- `PAYMENT_OVERDUE`
- `PAYMENT_REJECT_FAIL`
- `PAYMENT_SCHEDULED`
- `RECEIPT_ATTACHMENT`
- `RETURN_CONFIRMATION`
- `SHIPMENT_CONFIRMATION`
- `STATEMENT_ATTACHMENT`
- `STATEMENT_AVAILABLE`
- `TRANSACTION_ALERT`

## Creating templates

**Warning:** **Note: The modification of rules surrounding body properties for this endpoint is for the explicit purpose of showcasing how to use the endpoint with Template Library.**

To create a new template using the Template Library, call the existing `<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates` endpoint using the body properties below.

### Request syntax

```https
POST /<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates
```

### Post body

```json
{
  "name": "<NAME>",
  "category": "UTILITY",
  "language": "en_US",
  "library_template_name": "<LIBRARY_TEMPLATE_NAME>",
  "library_template_button_inputs": "[
    {'type': 'URL', 'url': {'base_url' : 'https://www.example.com/{{1}}',
    'url_suffix_example' : 'https://www.example.com/demo'}},
    {type: 'PHONE_NUMBER', 'phone_number': '+16315551010'}
]"
}
```

### Body properties

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<NAME>`<br><br>_String_ | **Required.**<br><br>The name you are providing for your template.<br><br>Maximum 512 characters. | `my_payment_template` |
| `<CATEGORY>`<br><br>_Enum_ | **Required.**<br><br>The template category.<br><br>**Must be `UTILITY` for use with Template Library.** | `UTILITY` |
| `<LANGUAGE>`<br><br>_Enum_ | **Required.**<br><br>The template language locale code.<br><br>See [Supported Languages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages) | `en_US` |
| `<LIBRARY_TEMPLATE_NAME>`<br><br>_String_ | **Required.**<br><br>The exact name of the Template Library template. | `delivery_update_1` |
| `<LIBRARY_TEMPLATE_BUTTON_INPUTS>`<br><br>_Array of objects_ | **Optional.**<br><br>The website and/or phone number of the business being used in the template.<br><br>**Note: For utility templates that have button inputs, this property is _not_ optional.** | `"[<br>{'type': 'URL', 'url': {'base_url' : 'https://www.example.com/{{1}}',<br>'url_suffix_example' : 'https://www.example.com/demo'}},<br>{type: 'PHONE_NUMBER', 'phone_number': '+16315551010'}<br>]"<br>` |

### Library template button inputs

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `type`<br><br>_enum_ | The button type<br><br>`QUICK_REPLY`, `URL`, `PHONE_NUMBER`, `OTP`, `MPM`, `CATALOG`, `FLOW`, `VOICE_CALL`, `APP`<br><br>*Required* | `OTP` |
| `phone_number`<br><br>_String_ | Phone number for the button.<br><br>*Optional* | `"+13057652345"` |
| `url`<br><br>_JSON Object_ | [View JSON object URL parameters `base_url` and `url_suffix_example` here](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-waba-id-message-templates)<br><br>*Optional* |  |
| `zero_tap_terms_accepted`<br><br>_boolean_ | Whether the zero tap terms were accepted by the user or not.<br><br>*Optional* | `TRUE` |
| `otp_type`<br><br>_enum_ | The OTP type.<br><br>`COPY_CODE`, `ONE_TAP`, `ZERO_TAP`<br><br>*Optional* | `TRUE` |
| `supported_apps`<br><br>_Array of JSON Object_ | [View JSON object Supported App parameters `package_name` and `signature_hash` here](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-waba-id-message-templates)<br><br>*Optional* |  |

### Library template body inputs

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<LIBRARY_TEMPLATE_BODY_INPUTS>`<br><br>_JSON Object_ | **Optional.**<br><br>Optional data during creation of a template from Template Library. These are optional fields for the button component.<br><br>[_Learn how to create templates using Template Library_](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-library) |  |
| `add_contact_number`<br><br>_boolean_ | Boolean value to add information to the template about contacting business on their phone number.<br><br>*Optional* | `TRUE` |
| `add_learn_more_link`<br><br>_boolean_ | Boolean value to add information to the template about learning more information with a url link.<br><br>Not widely available and will be ignored if not available.<br><br>*Optional* | `TRUE` |
| `add_security_recommendation`<br><br>_boolean_ | Boolean value to add information to the template about not sharing authentication codes with anyone.<br><br>*Optional* | `TRUE` |
| `add_track_package_link`<br><br>_boolean_ | Boolean value to add information to the template to track delivery packages.<br><br>Not widely available and will be ignored if not available.<br><br>*Optional* | `TRUE` |
| `code_expiration_minutes`<br><br>_int64_ | Integer value to add information to the template on when the code will expire.<br><br>*Optional* | `5` |

### Example request

```curl
curl 'https://graph.facebook.com/v19.0/102290129340398/message_templates'
-H 'Authorization: Bearer EAAJB...'
-H 'Content-Type: application/json'
-d '
{
  "name": "my_delivery_update",
  "language": "en_US",
  "category": "UTILITY",
  "library_template_name": "delivery_update_1",
  "library_template_button_inputs": "[
    {'type': 'URL', 'url': {'base_url' : 'https://www.example.com/{{1}}',
    'url_suffix_example' : 'https://www.example.com/order_update}}
  ]"
}
```

### Example response

```curl
{
  "id": "{hsm-id}",
  "status": "APPROVED",
  "category": "UTILITY"
}
```

## Sending template messages

To learn how to send templated messages, view the [Template fundamentals](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)

# Template media



A media header allows you to add an image, video, GIF, or document at the top of your WhatsApp template message.

Before creating the template, you must upload your media file using the Resumable Upload API. This upload returns a media ID, which you then use as the value for the `header_handle` field in the template's header component.

## Create a template with a media header

### Request syntax

Use the [Message Templates API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-waba-id-message-templates) to create a template with a media header.

```html
curl -X POST \
  'https://graph.facebook.com/<API_VERSION>/<WABA_ID>/message_templates' \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "limited_time_offer_tuscan_getaway_2023",
    "language": "en_US",
    "category": "MARKETING",
    "components": [
      {
        "type": "HEADER",
        "format": "IMAGE",
        "example": {
          "header_handle": [
            "4::aW..."
          ]
        }
      }
    ]
  }'
```

## Send media-based message template

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to send a media-based template message. Set the `type` property to `template` and use the template property to define your template object and its media object.

When defining your media object, you can either [upload your media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#upload-media) to our servers and use its media ID (using the `id` property), or host the asset on your server and use its URL (using the `link` property). If you're using link, your asset must be on a publicly accessible server or the message will fail to send.

To reduce the likelihood of errors and avoid unnecessary requests to your public server, Meta recommends that you upload your media assets and use their IDs when sending messages.

You can also cache media assets. See [Media HTTP Caching](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#media-http-caching).

### Request syntax

```html
curl -X  POST \
 'https://graph.facebook.com/v23.0/FROM_PHONE_NUMBER_ID/messages' \
 -H 'Authorization: Bearer ACCESS_TOKEN' \
 -H 'Content-Type: application/json' \
 -d '{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "PHONE_NUMBER",
  "type": "template",
  "template": {
    "name": "TEMPLATE_NAME",
    "language": {
      "code": "LANGUAGE_AND_LOCALE_CODE"
    },
    "components": [
      {
        "type": "header",
        "parameters": [
          {
            "type": "image",
            "image": {
              "link": "https://URL"
            }
          }
        ]
      },
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "text": "TEXT-STRING"
          },
          {
            "type": "currency",
            "currency": {
              "fallback_value": "VALUE",
              "code": "USD",
              "amount_1000": NUMBER
            }
          },
          {
            "type": "date_time",
            "date_time": {
              "fallback_value": "MONTH DAY, YEAR"
            }
          }
        ]
      }
    ]
  }
}'
```

A successful response includes an object with an identifier prefixed with WAM id. Use the ID listed after wamid to track your message status.

```curl
{
  "messaging_product": "whatsapp",
  "contacts": [{
      "input": "PHONE_NUMBER",
      "wa_id": "WHATSAPP_ID",
    }]
  "messages": [{
      "id": "wamid.ID",
    }]
}
```
# Template management



Learn about common endpoints used to manage templates, including getting, editing, deleting, archiving, and unarchiving templates.

## Get templates

Use the [Message Templates API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#get-version-waba-id-message-templates) to get a list of templates in a WhatsApp Business account.

### Get all templates

Example request to get all templates (default fields):

```shell
curl 'https://graph.facebook.com/v23.0/102290129340398/message_templates' \
-H 'Authorization: Bearer EAAJB...'
```

Example response, truncated (`...`) for brevity:

```json
{
  "data": [
    {
      "name": "reservation_confirmation",
      "parameter_format": "NAMED",
      "components": [
        {
          "type": "HEADER",
          "format": "IMAGE",
          "example": {
            "header_handle": [
              "https://scontent.whatsapp.net/v/t61..."
            ]
          }
        },
        {
          "type": "BODY",
          "text": "*You're all set!*\n\nYour reservation for {{number_of_guests}} at Lucky Shrub Eatery on {{day}}, {{date}}, at {{time}}, is confirmed. See you then!",
          "example": {
            "body_text_named_params": [
              {
                "param_name": "number_of_guests",
                "example": "4"
              },
              {
                "param_name": "day",
                "example": "Saturday"
              },
              {
                "param_name": "date",
                "example": "August 30th, 2025"
              },
              {
                "param_name": "time",
                "example": "7:30 pm"
              }
            ]
          }
        },
        {
          "type": "FOOTER",
          "text": "Lucky Shrub Eatery: The Luckiest Eatery in Town!"
        },
        {
          "type": "BUTTONS",
          "buttons": [
            {
              "type": "URL",
              "text": "Change reservation",
              "url": "https://www.luckyshrubeater.com/reservations"
            },
            {
              "type": "PHONE_NUMBER",
              "text": "Call us",
              "phone_number": "+16467043595"
            },
            {
              "type": "QUICK_REPLY",
              "text": "Cancel reservation"
            }
          ]
        }
      ],
      "language": "en_US",
      "status": "APPROVED",
      "category": "UTILITY",
      "id": "1387372356726668"
    },
    {
      "name": "coupon_expiration_reminder_number_vars",
      "parameter_format": "POSITIONAL",
      "components": [
        {
          "type": "HEADER",
          "format": "TEXT",
          "text": "Act fast, {{1}}!",
          "example": {
            "header_text": [
              "Pablo"
            ]
          }
        },
        {
          "type": "BODY",
          "text": "Just a quick reminder—your exclusive coupon code, {{1}}, *expires in only {{2}} days!* Don't miss out on our special deals. Use your code at checkout before it's too late.\n\nHappy shopping! 😃",
          "example": {
            "body_text": [
              [
                "SUMMER20",
                "10"
              ]
            ]
          }
        },
        {
          "type": "FOOTER",
          "text": "Lucky Shrub Succulents"
        },
        {
          "type": "BUTTONS",
          "buttons": [
            {
              "type": "URL",
              "text": "See deals",
              "url": "https://www.luckyshrub.com/deals"
            },
            {
              "type": "QUICK_REPLY",
              "text": "Unsubscribe"
            }
          ]
        }
      ],
      "language": "en",
      "status": "APPROVED",
      "category": "MARKETING",
      "sub_category": "CUSTOM",
      "id": "1304694804498707"
    }

    ...

  ],
  "paging": {
    "cursors": {
      "before": "QVFIU...",
      "after": "QVFIU..."
    },
    "next": "https://graph.facebook.com/v23.0/10229..."
  }
}
```

### Get all templates and specific fields

Example request to get the name, category, and status of all templates in a WhatsApp Business account, limiting the response to 5 templates per result set:

```shell
curl 'https://graph.facebook.com/v23.0/102290129340398/message_templates?fields=name,category,status&limit=5' \
-H 'Authorization: Bearer EAAJB...'
```

Example response:

```json
{
  "data": [
    {
      "name": "reservation_confirmation",
      "category": "UTILITY",
      "status": "APPROVED",
      "id": "1387372356726668"
    },
    {
      "name": "coupon_expiration_reminder_number_vars",
      "category": "MARKETING",
      "status": "APPROVED",
      "id": "1304694804498707"
    },
    {
      "name": "coupon_expiration_reminder_named_vars",
      "category": "MARKETING",
      "status": "APPROVED",
      "id": "1625063511800527"
    },
    {
      "name": "address_update",
      "category": "UTILITY",
      "status": "PENDING",
      "id": "1137051647947973"
    },
    {
      "name": "reservation_confirmation_short_banner",
      "category": "UTILITY",
      "status": "REJECTED",
      "id": "1166414785519855"
    }
  ],
  "paging": {
    "cursors": {
      "before": "QVFIU...",
      "after": "QVFIU..."
    },
    "next": "https://graph.facebook.com/v23.0/10229..."
  }
}
```

### Get all approved and rejected templates

Example request to get all approved templates and their name, category, and status (swap `status=approved` with `status=rejected` to get rejected templates instead):

```shell
curl 'https://graph.facebook.com/v23.0/102290129340398/message_templates?fields=name,category,status&status=approved' \
-H 'Authorization: Bearer EAAJB...'
```

Example response:

```json
{
  "data": [
    {
      "name": "reservation_confirmation",
      "category": "UTILITY",
      "status": "APPROVED",
      "id": "1387372356726668"
    },
    {
      "name": "coupon_expiration_reminder_number_vars",
      "category": "MARKETING",
      "status": "APPROVED",
      "id": "1304694804498707"
    },
    {
      "name": "coupon_expiration_reminder_named_vars",
      "category": "MARKETING",
      "status": "APPROVED",
      "id": "1625063511800527"
    },
    {
      "name": "calling_permission_request",
      "category": "MARKETING",
      "status": "APPROVED",
      "id": "1092999222892024"
    },
    {
      "name": "location_request_v1",
      "category": "MARKETING",
      "status": "APPROVED",
      "id": "3373761659571648"
    },
    {
      "name": "order_confirmation",
      "category": "UTILITY",
      "status": "APPROVED",
      "id": "1667696820637468"
    }
  ],
  "paging": {
    "cursors": {
      "before": "QVFIU...",
      "after": "QVFIU..."
    },
    "next": "https://graph.facebook.com/v23.0/10229..."
  }
}
```

## Create templates

Use the [Message Templates API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-waba-id-message-templates) to [create a template](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#creation). See also [Create templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#creation) for detailed component and parameter guidance.

### Template name validation

Template names can only contain lowercase alphanumeric characters and underscores (regex: `^[a-z0-9_]+$`). The maximum length is 512 characters. If a name contains uppercase letters, spaces, or special characters, the API returns error code `100`.

Template names must be unique within a WhatsApp Business account for each language. Creating a template with a name that already exists for the same language returns error code `100`, subcode `2388024`, with message "Content in This Language Already Exists".

### Category and language validation

The API validates template parameters at creation time. Invalid categories or unsupported [language codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages) return error code `100`. Starting with v23.0, template component parameter issues at send time return error code `132018`.

## Edit templates

Use the [Message Template API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#post-version-template-id) to edit a template. You can also use the [Message templates](https://business.facebook.com/latest/whatsapp_manager/message_templates) panel in WhatsApp Manager to edit templates.

### Edit template limitations

- Only templates with an `APPROVED`, `REJECTED`, or `PAUSED` status can be edited.
- You can only edit a template's category, components, or time-to-live.
- You cannot edit individual template components; the API replaces all components with those in the edit request payload.
- You cannot edit the category of an approved template.
- Approved templates can be edited up to 10 times in a 30-day window, or 1 time in a 24-hour window. Rejected or paused templates can be edited an unlimited number of times.
- After you edit an approved or paused template, the API automatically re-approves the template unless it fails template review.

### Edit template category

Example request:

```shell
curl 'https://graph.facebook.com/v23.0/1252715608684590' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "category": "MARKETING"
}'
```

Example response:

```json
{
  "success": true
}
```

### Edit template components

Example request to overwrite a template's existing components with new components.

```shell
curl 'https://graph.facebook.com/v23.0/564750795574598' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Our {{1}} is on!",
      "example": {
        "header_text": [
          "Spring Sale"
        ]
      }
    },
    {
      "type": "BODY",
      "text": "Shop now through {{1}} and use code {{2}} to get {{3}} off of all merchandise.",
      "example": {
        "body_text": [
          [
            "the end of April",
            "25OFF",
            "25%"
          ]
        ]
      }
    },
    {
      "type": "FOOTER",
      "text": "Use the buttons below to manage your marketing subscriptions"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Unsubscribe from Promos"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Unsubscribe from All"
        }
      ]
    }
  ]
}'
```

## Delete templates

Use the [Message Templates API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api#delete-version-waba-id-message-templates) to delete a template by name or ID, or delete multiple templates by their IDs.

This endpoint requires the `whatsapp_business_management` permission. If you only have the `whatsapp_business_messaging` permission, the API returns error code `200`.

If a template with the specified name does not exist, the API returns an error.

### Delete template limitations

- If you delete a template that has been sent in a template message but has yet to be delivered (for example, because the WhatsApp user's phone is turned off), the template's status is set to `PENDING_DELETION` and WhatsApp attempts delivery for 30 days.
- If you delete an approved template, you cannot create a new template with the same name for 30 days.
- Templates that are in a disabled status cannot be deleted.

### Delete template by name

Deleting a template by name deletes all templates that match that name (meaning templates with the same name but different languages will also be deleted).

Example request:

```shell
curl -X DELETE 'https://graph.facebook.com/v23.0/102290129340398/message_templates?name=order_confirmation' \
-H 'Authorization: Bearer EAAJB...'
```

Example response:

```json
{
  "success": true
}
```

### Delete template by ID

To delete a template by ID, include the template's ID along with its name in your request; only the template with the matching template ID will be deleted.

Example request:

```shell
curl -X DELETE 'https://graph.facebook.com/v23.0/102290129340398/message_templates?hsm_id=1407680676729941&name=order_confirmation' \
-H 'Authorization: Bearer EAAJB...'
```

Example response:

```json
{
  "success": true
}
```

### Delete templates by IDs

To delete multiple templates at once, include an array of template IDs in the `hsm_ids` query parameter. You can include up to 100 template IDs per request.

The `hsm_ids` parameter cannot be combined with the `name` or `hsm_id` parameters. If any of the template IDs are invalid, the entire request fails and no templates are deleted.

Example request:

```shell
curl -X DELETE 'https://graph.facebook.com/v23.0/102290129340398/message_templates?hsm_ids=[1387372356726668,1304694804498707]' \
-H 'Authorization: Bearer EAAJB...'
```

Example response:

```json
{
  "success": true
}
```

## Archive and unarchive templates

When templates have been inactive for 12 months or more, the platform automatically archives them and schedules them for deletion after 28 days. You can also manually archive or unarchive templates in bulk using the API.

See [template archival](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-archival) for more information about auto-archival, the archive and unarchive endpoints, and notifications.

# Media


Use the [Media Upload API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/media-upload-api), [Media API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/media/media-api), and [Media Download API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/media/media-download-api) to manage your media:

| Endpoint | Uses |
| --- | --- |
| [`POST /PHONE_NUMBER_ID/media`](#upload-media) | Upload media. |
| [`GET /MEDIA_ID`](#get-media-url) | Retrieve the URL for a specific media. |
| [`DELETE /MEDIA_ID`](#delete-media) | Delete a specific media. |
| [`GET /MEDIA_URL`](#download-media) | Download media from a media URL. |

See [Supported Media Types](#supported-media-types) for supported types and size limits.

## Get media ID

Some of the API requests described in this document require a media ID. Media IDs are returned by the API when [uploading media](#upload-media), and are included in incoming media messages webhooks ([image messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/image), [video messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/video), and so on)

Media IDs returned by the API expire after 30 days. Media IDs in webhooks expire after 7 days.

## Upload media

Use the [Media Upload API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/media-upload-api) to [upload media](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/media-upload-api#post-version-phone-number-id-media). Include the parameters listed below. All media files sent through this API are encrypted and persist for 30 days, unless they are deleted earlier.

| Endpoint | Authentication |
| --- | --- |
| `/PHONE_NUMBER_ID/media`<br><br>(See [Get Phone Number ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers#get-all-phone-numbers))<br> | Developers can authenticate their API calls with the access token generated in the **App Dashboard** > **WhatsApp** > **API Setup**.<br><br><br>Solution Partners must authenticate themselves with an access token with the `whatsapp_business_messaging`  permission.<br> |

### Parameters

| Name | Description |
| --- | --- |
| `file` | **Required.**<br><br>Path to the file stored in your local directory. For example: "@/local/path/file.jpg". |
| `type` | **Required.**<br><br>Type of media file being uploaded. See [Supported Media Types](#supported-media-types) for more information. |
| `messaging_product` | **Required.**<br><br>Messaging service used for the request. In this case, use `whatsapp`. |

### Request

```html
curl 'https://graph.facebook.com/<API_VERSION>/<PHONE_NUMBER_ID>/media' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-F 'messaging_product=whatsapp' \
-F 'file=@<FILE_PATH_AND_NAME>;type=<MIME_TYPE>'
```


### Response

Upon success:

```html
{
  "id": "<MEDIA_ID>"
}
```

### Example request

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/media' \
-H 'Authorization: Bearer EAAJB...' \
-F 'messaging_product=whatsapp' \
-F 'file=@/media/template_assets/black_friday_2025.mp4;type=video/mp4'
```

### Example response

```json
{
  "id": "1037543291543636"
}
```

## Get media URL

Use the [Media API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/media/media-api) to [get a media URL](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/media/media-api#get-version-media-id) by querying the [media ID](#get-media-id) directly. You can then use the URL with your access token to [download the media asset](#download-media). Note that incoming media messages webhooks ([image messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/image), [video messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/video), and so on) include the media URL, which is assigned to the `url` property.

Media URLs **expire after 5 minutes**, after which you must query the ID again to get a new URL.

### Request syntax

```html
curl 'https://graph.facebook.com/<API_VERSION>/<MEDIA_ID>?phone_number_id=<BUSINESS_PHONE_NUMBER_ID>' \
-H 'Authorization: Bearer EAAJB'
```

Note that `phone_number_id` is optional. If included, the request will only be processed if the business phone number ID included in the query matches the ID of the business phone number that the media was uploaded on.

### Response syntax

A successful response includes an object with a media URL. The URL is only valid for 5 minutes. To use this URL, see [Download Media](#download-media).

```html
{
  "messaging_product": "whatsapp",
  "url": "<MEDIA_URL>",
  "mime_type": "<MEDIA_MIME_TYPE>",
  "sha256": "<SHA_256_HASH>",
  "file_size": "<MEDIA_FILE_SIZE>",
  "id": "<MEDIA_ID>"
}
```

## Delete media {#delete-media}

Use the [Media API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/media/media-api) to [delete a media asset](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/media/media-api#delete-version-media-id).

### Request syntax

```html
curl -X DELETE 'https://graph.facebook.com/<API_VERSION>/<MEDIA_ID>?phone_number_id=<BUSINESS_PHONE_NUMBER_ID>' \
-H 'Authorization: Bearer EAAJB...'
```

Note that `phone_number_id` is optional. If included, the request will only be processed if the business phone number ID included in the query matches the ID of the business phone number that the media was uploaded on.

### Example response

```json
{
  "success": true
}
```

## Download media

Use the [Media Download API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/media/media-download-api) to [download media](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/media/media-download-api#get-media-url). Include your access token in the request. **If you omit your token, the request will fail.**

Note that when retrieving a media from a media ID received via webhook, the media ID will only be available to download for 7 days.

### Request syntax

```html
curl '<MEDIA_URL>' \
-H 'Authorization: Bearer EAAJB...' \
-o '<DESIRED_FILE_NAME>'
```

Upon success, the API will respond with the binary data of the media asset. Response headers contain a content-type header to indicate the MIME type of returned data. Check [supported media types](#supported-media-types) for supported media types.

If the download attempt fails, you will receive a `404 Not Found` response code. In that case, try to [get a new media URL](#get-media-url) and download it again. If doing so doesn't resolve the issue, renew your access token and attempt to download the media asset again.

## Supported media types

### Audio

| Audio Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| AAC | .aac | audio/aac | 16 MB |
| AMR | .amr | audio/amr | 16 MB |
| MP3 | .mp3 | audio/mpeg | 16 MB |
| MP4 Audio | .m4a | audio/mp4 | 16 MB |
| OGG Audio | .ogg | audio/ogg (OPUS codecs only; base audio/ogg not supported; mono input only) | 16 MB |

### Document

| Document Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| Text | .txt | text/plain | 100 MB |
| Microsoft Excel | .xls | application/vnd.ms-excel | 100 MB |
| Microsoft Excel | .xlsx | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | 100 MB |
| Microsoft Word | .doc | application/msword | 100 MB |
| Microsoft Word | .docx | application/vnd.openxmlformats-officedocument.wordprocessingml.document | 100 MB |
| Microsoft PowerPoint | .ppt | application/vnd.ms-powerpoint | 100 MB |
| Microsoft PowerPoint | .pptx | application/vnd.openxmlformats-officedocument.presentationml.presentation | 100 MB |
| PDF | .pdf | application/pdf | 100 MB |

### Image

Images must be 8-bit, RGB or RGBA.

| Image Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| JPEG | .jpeg | image/jpeg | 5 MB |
| PNG | .png | image/png | 5 MB |

### Sticker

WebP images can only be sent in [sticker messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/sticker-messages).

| Sticker Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| Animated sticker | .webp | image/webp | 500 KB |
| Static sticker | .webp | image/webp | 100 KB |

### Video

Only H.264 video codec and AAC audio codec supported. Single audio stream or no audio stream only.

Note that videos encoded with the H.264 "High" profile and B-frames are not supported by Android WhatsApp clients. We recommend that you use H.264 "Main" profile without B-frames, or the H.264 "Baseline" profile when encoding (or re-encoding with a tool like ffmpeg), and place moov boxes before mdat boxes, for broader compatibility. If you are using ffmpeg, you can use the -movflags faststart flag to place moov boxes before mdata boxes.

| Video Type | Extension | MIME Type | Max Size |
| --- | --- | --- | --- |
| 3GPP | .3gp | video/3gpp | 16 MB |
| MP4 Video | .mp4 | video/mp4 | 16 MB |

Note that mismatched MIME type (`131053`) is a common error. Inspect your media files to verify their MIME type. Make sure that your file name extensions reflect their types. For example, if you are using UNIX, you can inspect a file via the command line to determine its MIME type:

`file -I your-image-asset.png`

## Media message download constraints {#constraints-media}

The maximum supported file size for media messages on Cloud API is 100MB. In the event the customer sends a file that is greater than 100MB, you will receive a webhook with error code [131052](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes#other-errors) and `title`:

_"Media file size too big. Max file size we currently support: 100MB. Please communicate with your customer to send a media file that is smaller than 100MB"_.

Send customers a warning message that their media file exceeds the maximum file size when this webhook event is triggered.

## Learn more

WhatsApp Business Blog – [Sending WhatsApp media messages from an app](https://business.whatsapp.com/blog/media-messages-via-app)

# Mark messages as read



When you receive a **message** webhook indicating an [incoming message](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages#incoming-messages), you can use the `message.id` value to mark the message as read.

Mark incoming messages as read within 30 days of receipt. When you mark a message as read, the API also marks earlier messages in the conversation as read.

If you mark a message as read with an invalid message ID, the API returns error code `131009` ("Parameter value is not valid"). Provide a valid `wamid` from a received message as the `message_id`.

## Request syntax

Use the [Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api#post-version-phone-number-id-messages) to mark a message as read.

```html
curl -X POST \
'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages'
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-H 'Content-Type: application/json' \
-d '
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "<WHATSAPP_MESSAGE_ID>"
}'
```

## Request parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp message ID. This ID is assigned to the `messages.id` property in **received message** [messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages) webhooks. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA` |

## Response

A successful mark-as-read request returns the following response:

```json
{
  "success": true
}
```

## Example request

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA"
}'
```

## Example response

A successful mark-as-read request returns:

```json
{
  "success": true
}
```

# Contextual replies



Contextual replies are a special way of responding to a WhatsApp user message. Sending a message as a contextual reply makes it clearer to the user which message you are replying to by quoting the previous message in a contextual bubble:

## Limitations

- You cannot send a [reaction message](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/reaction-messages) as a contextual reply.

The contextual bubble does not appear at the top of the delivered message if:

- The previous message has been deleted or moved to long term storage (messages are typically moved to long term storage after 30 days, unless you have enabled [local storage](https://developers.facebook.com/documentation/business-messaging/whatsapp/local-storage)).
- You reply with an [audio](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages), [image](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/image-messages), or [video message](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/video-messages) and the WhatsApp user is running KaiOS.
- You use the WhatsApp client to reply with a [push-to-talk](https://faq.whatsapp.com/657157755756612/?cms_platform=web) message and the WhatsApp user is running KaiOS.
- You reply with a [template message](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview).

## Request syntax

```https
POST /<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages
```


### Post body

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "context": {
    "message_id": "WAMID_TO_REPLY_TO"
  },

  /* Message type and type contents goes here */

}
```

### Post body parameters

| Placeholder | Description | Example Value |
| --- | --- | --- |
| `<WAMID_TO_REPLY_TO>`<br><br>_String_ | **Required.**<br><br>WhatsApp message ID (wamid) of the previous message you want to reply to. | `wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQTdCNTg5RjY1MEMyRjlGMjRGNgA=` |
| `<WHATSAPP_USER_PHONE_NUMBER>`<br><br>_String_ | **Required.**<br><br>WhatsApp user phone number. | `+16505551234` |

## Example request

Example of a text message sent as a reply to a previous message.

```curl
curl 'https://graph.facebook.com/v19.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "context": {
    "message_id": "wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQTdCNTg5RjY1MEMyRjlGMjRGNgA="
  },
  "type": "text",
  "text": {
    "body": "You're welcome, Pablo!"
  }
}'
```
# Typing indicators



When you get a **messages** webhook indicating a [received message](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages), you can use the `message.id` value to mark the message as read and display a typing indicator so the WhatsApp user knows you are preparing a response. This is good practice if it will take you a few seconds to respond.

The typing indicator will be dismissed once you respond, or after 25 seconds, whichever comes first. To prevent a poor user experience, only display a typing indicator if you are going to respond.

## Request syntax

```html
curl -X POST \
'https://graph.facebook.com/<API_VERSION>/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages'
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-H 'Content-Type: application/json' \
-d '
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "<WHATSAPP_MESSAGE_ID>",
  "typing_indicator": {
    "type": "text"
  }
}'
```

## Request parameters

| Placeholder | Description | Example value |
| --- | --- | --- |
| `<ACCESS_TOKEN>`<br><br>_String_ | **Required.**<br><br>[System token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens) or [business token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#business-integration-system-user-access-tokens). | `EAAA...` |
| `<API_VERSION>`<br><br>_String_ | **Optional.**<br><br>Graph API version. | v25.0 |
| `<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp business phone number ID. | `106540352242922` |
| `<WHATSAPP_MESSAGE_ID>`<br><br>_String_ | **Required.**<br><br>WhatsApp message ID. This ID is assigned to the `messages.id` property in **received message** [messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages) webhooks. | `wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA` |

## Response

Upon success:

```json
{
  "success": true
}
```

## Example request

```curl
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
-d '
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA",
  "typing_indicator": {
    "type": "text"
  }
}'
```

## Example response

Upon success:

```json
{
  "success": true
}
```
# Link Previews



WhatsApp supports link previews when the link is sent via chat or shared via status. WhatsApp will attempt to perform a link preview when possible for a better user experience. To enable this experience, WhatsApp relies on link owners to define properties that are specifically optimized for WhatsApp. Not meeting these requirements may risk the link to be not previewed.

## Get started

To get started with enabling link previews, websites need to add HTML mark-ups to the HEAD section on the page.

```html
<head>
  <meta property="og:title" content="WhatsApp"/>
  <meta property="og:description" content="Simple. Secure. Reliable messaging."/>
  <meta property="og:url" content="https://whatsapp.com"/>
  <meta property="og:image"content="https://static.whatsapp.net/rsrc.php/ym/r/36B424nhiL4.svg"/>
</head>
```

The `<head>` containing the HTML mark-ups must appear within the first 300KB of the HTML. The entire HTML does not need to fit within 300KB.

The `<og:title>`, `<og:description>` and `<og:url>` mark-ups must be inside the `<head>` tag. They should not be empty.

The `<og:title>` mark-up represents the title of the content without any branding. WhatsApp will display this in primary text color, in bold and in at most 2 lines.

The `<og:description>` mark-up represents the description of the content. WhatsApp will display this in a smaller size than the title and in secondary text color. It is limited to 1 or 2 lines and 80 characters will suffice.

The `<og:url>` mark-up represents the canonical URL of the page. The URL should be undecorated, without session variables, user identifying parameters and counters.

The `<og:image>` mark-up is an absolute URL for an image used as the thumbnail for the link preview. This image should be under 600KB in size. Image should be 300px or more in width with 4:1 width/height or less aspect ratio.

WhatsApp will make the best attempt to show link previews, for example: relaxing requirements, looking for other HTML mark-ups and reverting to small link previews. However, this should not be relied on. It's not guaranteed to work (and continue to work).

WhatsApp crawls the web page via an HTTP GET request.

The request will have the `User-Agent` header set to `WhatsApp/2.x.x.x A|I|N`, where `x` are major/minor numeric versions of WhatsApp and `A|I|N` is for Android, iOS, and web respectively. Some examples of valid `User-Agent` header values: `WhatsApp/2.22.20.72 A`, `WhatsApp/2.22.19.78 I`, `WhatsApp/2.2236.3 N`. Website owners can identify such incoming requests and can customize the content (mark-ups and images) accordingly.

The request will also have the `Accept-Language` header set to the language selected by the recipient, if any. Some examples of valid `Accept-Language` header values are: `en`, `fr`, `de`. Similarly, website owners can customize the content language accordingly. Note that the language set by the recipient will also be seen by the recipient.

## Verify your link preview

Start with composing a message with the link to test (not tap to send yet). On behalf of the sender, WhatsApp will crawl this URL and attempt to generate a link preview.

If a preview does not come up above the composer box after 10 seconds, please check all the requirements above are met. Else, continue with sending the message by tapping the "send" button.

If a preview does not show up in the expected large size, please check the image requirements above are met. Else, link previews are all working as expected. Your link preview is now configured.

# Business profiles



Your business phone number's profile displays additional information such as address, website, and description. You can add this information when registering your phone number or update the profile later via WhatsApp Manager or the API.

## View or update your profile in WhatsApp Manager

To view or update your business profile via WhatsApp Manager:

1. Navigate to [WhatsApp Manager](https://business.facebook.com/latest/whatsapp_manager/) > **Account tools** > **Phone numbers**.
2. Select your business phone number.
3. Click the **Profile** tab to view your current profile.
4. Use the form to set new profile values.

## Get your profile via the API

Before you call the API, make sure you have a business phone number ID and a [system user access token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens) with the [required permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/permissions).

Use the [WhatsApp Business Profile API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-profile-api#get-version-phone-number-id-whatsapp-business-profile) to get specific business profile fields:

### Example request

```html
curl 'https://graph.facebook.com/v25.0/106540352242922/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical' \
-H 'Authorization: Bearer EAAJB...'
```

### Example response

Upon success:

```json
{
  "data": [
    {
      "about": "Succulent specialists!",
      "address": "1 Hacker Way, Menlo Park, CA 94025",
      "description": "At Lucky Shrub, we specialize in providing a...",
      "email": "lucky@luckyshrub.com",
      "profile_picture_url": "https://pps.whatsapp.net/v/t61.24...",
      "websites": [
        "https://www.luckyshrub.com/"
      ],
      "vertical": "RETAIL",
      "messaging_product": "whatsapp"
    }
  ]
}
```

## Update your profile via the API

Use the [WhatsApp Business Profile API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-profile-api#post-version-phone-number-id-whatsapp-business-profile) to update specific business profile fields:

### Example request

```html
curl 'https://graph.facebook.com/v25.0/106540352242922/whatsapp_business_profile' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAAJB...' \
--data-raw '
{
  "about": "Succulent specialists!",
  "address": "1 Hacker Way, Menlo Park, CA 94025",
  "description": "At Lucky Shrub, we specialize in providing a diverse range of high-quality succulents to suit your needs. From rare and exotic varieties to timeless classics, our collection has something for everyone.",
  "email": "lucky@luckyshrub.com",
  "messaging_product": "whatsapp",
  "profile_picture_handle": "4::aW...",
  "websites": "[\n  \"https://www.luckyshrub.com\"\n]"
}'
```

### Example response

Upon success:

```json
{
  "success": true
}
```

### Field notes

- The `vertical` field can be updated via POST. The `WhatsAppVertical` enum defines the valid values (excluding `UNDEFINED` and `NOT_A_BIZ`). You can also change this value using [WhatsApp Manager](https://business.facebook.com/latest/whatsapp_manager/).
- The `address` field accepts freeform text (maximum 256 characters) and does not validate against any geographic database.





# Cloud API Calling



## Overview

The WhatsApp Business Calling API enables you to initiate and receive calls with WhatsApp users using Voice over Internet Protocol (VoIP).

## Value proposition (concise)

WhatsApp Business Calling: voice and video calling with global reach.

| Value | Description |
| --- | --- |
| **Unified communication** | Message and call from one number, worldwide. |
| **Branding and trust** | Built-in brand identity, verification, and global availability. |
| **Customer relationship** | A single point of contact for inbound and outbound communication. |
| **Sales and support** | Unify marketing and support channels in one place. |
| **Rich features** | Video*, screen share*, and call customization. |
| **Call deflection** | Move voice calls to WhatsApp chat. |
| **Customer convenience** | Free for your customers and available globally. |
| **Record keeping** | One thread with a centralized, long-term record. |

### Benefits for end-users

| Value | Description |
| --- | --- |
| **Universal access** | Free and available globally. |
| **Enhanced safety** | Built-in platform verification. |
| **Centralized history** | One unified thread for all voice and text history. |
| **Integrated voicemail** | Voicemail playable within the chat. |

**Note:** * Feature planned or in development. Reach out to your Meta or partner for more details.

## Value proposition (detailed)

The WhatsApp Business Calling API allows businesses to integrate voice and video* calling directly into their customer engagement strategy, offering a trusted, unified, and feature-rich communication channel.

| Feature | Benefit for your business |
| --- | --- |
| **Unified communication** | **One number for all communication.**<br>Use a single, verified WhatsApp number for all messaging and calling (inbound and outbound), and switch between chat and call, including chatting while on a call. |
| **Branding and trust** | **Built-in brand identity and verification.**<br>WhatsApp has native support for brand identity with security and verification, which applies globally and eliminates the need for region-specific third-party trust providers. |
| **Customer relationship** | **A single point of contact for customers.**<br>A single point of contact for both inbound and outbound communication supports ongoing customer relationships. |
| **Sales and support** | **Unify marketing and support channels.**<br>Centralize lead management by unifying support and marketing channels, which streamlines operations and supports product upsell and cross-sell. |
| **Rich features** | **Video*, screen sharing*, and call controls.**<br>Beyond voice, businesses can engage customers with video calls and screen sharing for richer, more detailed support and service. Businesses also control the calling experience by configuring calling hours, managing call icon visibility, sending call buttons with expiry, and using call deep links. |
| **Call deflection** | **Move calls to WhatsApp to improve deflection rates.**<br>By moving calls to WhatsApp, businesses can direct customers to chat, using interactive messaging templates to improve deflection and reduce voice-only support costs. |
| **Customer convenience** | **Free and globally accessible for customers.**<br>Offer your customers a globally accessible communication method that is free for them to use. |
| **Record keeping** | **One thread with a centralized, long-term record.**<br>Maintain a single, persistent thread of all text and voice communications with the customer, serving as a centralized, long-term record for reference. |

**Note:** * Feature planned or in development. Reach out to your Meta or partner for more details.

## Architecture

(_Right click image and choose "Open in new tab" for enlarged image_)

### Signaling and media possible configurations

|  | Default configuration after enabling calling | SIP with WebRTC | SIP with SDES media |
| --- | --- | --- | --- |
| Signaling protocol | Graph APIs + Webhooks | SIP (needs explicit [enablement](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-update-sip-settings-on-business-phone-number)) | SIP (needs explicit [enablement](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-update-sip-settings-on-business-phone-number)) |
| Signaling transport | HTTPS | TLS | TLS |
| Media protocol | WebRTC (ICE + DTLS1 + SRTP) | WebRTC (ICE + DTLS + SRTP) | [SDES](https://datatracker.ietf.org/doc/html/rfc4568) SRTP (needs explicit [enablement](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-sdes-for-srtp-key-exchange-protocol)) |
| Audio codec2 | OPUS | OPUS | OPUS |

**Notes**
1. You can use SDES instead of ICE+DTLS with Graph API + Webhook signaling
2. Additional audio codecs supported: `PCMA`, `PCMU`

## Get started

### Step 1: Prerequisites

Before you get started with the Calling API, ensure that:

1. [Your business number is in use with Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) (not the WhatsApp Business app).
1. Subscribe your app to the `calls` webhook field (unless you plan to use [SIP](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip)).
1. The same app should also be [subscribed to the WhatsApp Business account](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks) of your business phone number.
1. This app should have messaging permissions (`whatsapp_business_messaging`) for the business number.
1. The business must have a daily [messaging limit](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits) of at least 2,000 unique recipients. More details on [scaling your account capabilities](https://www.facebook.com/business/help/595597942906808).
1. [Enable Calling features on your business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings).

### Step 2: Configure calling features

The WhatsApp Business Calling API offers a number of features that affect when and how calling features appear to users on your WhatsApp profile.

* Inbound call control allows you to prevent users from placing calls from your business profile
* Business call hours allows you to avoid missed calls and direct users to message when your call center is closed
* Callback requests offer users the option to request a callback when you don't pick up a call or if your call center is closed

[Learn more about call control settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#parameter-details)

### Step 3: Make and receive calls

**Warning:** You can test your WhatsApp Calling integration using public test numbers and a sandbox WhatsApp Business account.

[Learn more about testing your WhatsApp Calling API integration](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling#testing-and-sandbox-accounts)

Cloud API Calling offers two call initiation paths:

* **User-initiated calls:** Calls that are made from a WhatsApp user to your business
* **Business-initiated calls:** Calls that are made from your business to a WhatsApp user

## Testing and sandbox accounts

**Warning:** Sandbox accounts are only available to Tech Partners.

[Sandbox accounts](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sandbox) and public test numbers enable you to test your WhatsApp Calling API integration with relaxed calling limitations.
Specifically, business-initiated calling limits are relaxed for sandbox accounts and public test numbers to help integration and testing efforts.

### Limits (per business + WhatsApp user pair)

* Sandbox accounts can send **25 call permissions per day** and **100 per week** (compared to 1 per day and 2 per week for production accounts)
* When business-initiated calls go unanswered or are rejected
  * **5 consecutive unanswered calls** result in a system message to reconsider an approved permission (compared to 2 consecutive unanswered calls for production accounts)
  * **10 consecutive unanswered calls** result in an approved permission being automatically revoked (compared to 4 consecutive unanswered calls for production accounts).

You obtain a public test number after completing the [Get Started flow](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started).

Your business isn't required to have a daily [messaging limit](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits) of 2,000 unique recipients to test Calling API features when using public test numbers and Sandbox accounts.

Calling is disabled by default on test numbers. You must [configure calling features in phone number call settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#configure-call-settings) before using the Calling API on a test number.

[Learn more about sandbox accounts for calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview#sandbox-accounts)

## Availability

### User-initiated calling

User-initiated calling is available in [every location Cloud API is available](https://developers.facebook.com/documentation/business-messaging/whatsapp/support#country-restrictions).

### Business-initiated calling
Business-initiated calling is available in [every location Cloud API is available](https://developers.facebook.com/documentation/business-messaging/whatsapp/support#country-restrictions), **except the following countries:**

* United States
* Canada
* Egypt
* Vietnam
* Nigeria

**Note:** The business phone number's country code must be in this supported list. The consumer phone number can be from any [country where Cloud API is available](https://developers.facebook.com/documentation/business-messaging/whatsapp/support#country-restrictions).

## Next steps

Use the guides below to integrate calling features in your application:

* [Learn how to receive user-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls)
* [Learn how to place business-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls)
* [Learn how to drive consumer awareness of calling availability in your business](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links)

## Changelog

Use this table as a centralized place to keep track of feature updates related to WhatsApp Business Calling APIs.

| Date | Title | Description |
| --- | --- | --- |
| March 23, 2026 | Support for G.711 (PCMA, PCMU) audio codec | New section for G.711 (PCMA, PCMU) audio codec configuration in call settings, including guidelines on transcoding, audio quality, and bandwidth considerations. [Learn more about audio codec settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#audio-codec). |
| January 27, 2026 | Calling restrictions based on user feedback are now in effect | Learn more about [calling restrictions based on user feedback](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#calling-restrictions-for-user-feedback). |
| December 19, 2025 | Update in business initiated call limit | The number of business-initiated calls per user has been increased to 100 per day from 10 per day.<br><br>[Learn more about business-initiated call limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions#limits--per-business---whatsapp-user-pair-) |
| December 10, 2025 | Introduced `restrict_to_user_countries` for call icon settings | Now you can control in which countries the call icon should be visible. [Learn more about call icon country settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#call-icons). |
| October 13, 2025 | * Update in business initiated call limit<br>* Added "Testing and Sandbox" section to documentation | The number of business-initiated calls per user has been increased to 10 per day from 5 per day.<br><br>[Learn more about business-initiated call limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions#limits--per-business---whatsapp-user-pair-)<br><br>A [Testing and Sandbox accounts](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling#testing-and-sandbox-accounts) has been added to the documentation |
| September 29, 2025 | Asterisk integration guide | New guide to [integrate with Asterisk](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples#asterisk-using-sip) |
| September 24, 2025 | Context propagation from call buttons and deep links | Specify an opaque string in call buttons or call deep links to help with tracking the origin of user-initiated calls. [Learn about call buttons and deep links](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links) |
| September 8, 2025 | Health status API calling update | [Health Status API](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status) is now extended to include a new `can_receive_call_sip` field to help you self-diagnose issues related to [SIP](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip) setup |
| September 5, 2025 | Introduced new low call pickup calling restrictions | Low call pickup rate restrictions are now in effect. Learn more at [Calling Restriction for Low Call Pickup Rates](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#calling-restrictions-for-low-call-pickup-rates) |
| July 21, 2025 | Account settings update webhooks | Get webhooks when settings are updated. [Learn about settings update webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#settings-update-webhooks). |

# Configure Call Settings


Calling is not enabled by default on a business phone number. To enable calling, you must have a [messaging limit](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits) of 2000 or above.

Use these endpoints to view and configure call settings for the Calling API.

You can also [configure session initiation protocol (SIP)](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip) for call signaling instead of using Graph API endpoint calls and webhooks.

## Configure or update business phone number calling settings

Use this endpoint to update call settings configuration for an individual business phone number.

### WhatsApp clients reflecting latest calling config

After you update call configuration, WhatsApp users may take up to 7 days to reflect those changes. Most users refresh much sooner. You can force an immediate refresh in WhatsApp by entering your business chat window and opening the chat info page. Regardless of WhatsApp client behavior, the server still honors the configured settings.

### Request syntax

```html
POST /<PHONE_NUMBER_ID>/settings
```

### Endpoint parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>ID of the business phone number whose Calling API settings you're updating. | `106540352242922` |

### Request body

```html
{
  "calling": {
    "status": "ENABLED",
    "call_icon_visibility": "DEFAULT",
    "call_icons": {
      "restrict_to_user_countries": [
        "US",
        "BR"
      ]
    },
    "call_hours": {
      "status": "ENABLED",
      "timezone_id": "America/Manaus",
      "weekly_operating_hours": [
        {
          "day_of_week": "MONDAY",
          "open_time": "0400",
          "close_time": "1020"
        },
        {
          "day_of_week": "TUESDAY",
          "open_time": "0108",
          "close_time": "1020"
        }
      ],
      "holiday_schedule": [
        {
          "date": "2026-01-01",
          "start_time": "0000",
          "end_time": "2359"
        }
      ]
    },
    "callback_permission_status": "ENABLED",
    "sip": {
      "status": "ENABLED | DISABLED (default)",
      "servers": [
        {
          "hostname": <SIP_SERVER_HOSTNAME>,
          "port": SIP_SERVER_PORT,
          "request_uri_user_params": {
            "KEY1": "VALUE1",
            "KEY2": "VALUE2"
          }
        }
      ]
    },
    "audio": {
      "additional_codecs": ["PCMA", "PCMU"]
    },
    "voicemail": {
      "status": "ENABLED",
      "triggers": [
        "REJECT",
        "TIMEOUT"
      ],
      "audio": {
        "default": {
          "announcement_media_id": 938884519013664,
          "timeout_seconds": 20
        }
      }
    }
  }
}
```

### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `status`<br><br>_String_ | **Optional**<br><br>Enable or disable calling on this phone number. | `"ENABLED"`<br><br>`"DISABLED"` |
| `call_icon_visibility`<br><br>_String_ | **Optional**<br><br>Configure whether WhatsApp shows the call button icon to WhatsApp users when they chat with your business.<br><br>[View call icon visibility behavior details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#call-icons) | [View call icon visibility behavior details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#call-icons) |
| `call_icons`<br><br>_String_ | **Optional**<br><br>Configure whether WhatsApp call button icon displays for WhatsApp users when chatting with your business.<br><br>[View call icons visibility behavior details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#call-icons) | [View call icons behavior details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#call-icons) |
| `call_hours`<br><br>_JSON object_ | **Optional**<br><br>Allows you to specify and trigger call settings for incoming calls based on your timezone, business operating hours, and holiday schedules.<br><br>Any previously configured values in `call_hours` will be replaced with the values passed in the request body of this API call.<br><br>[View call hours behavior details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#call-hours) | [View call hours behavior details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#call-hours) |
| `callback_permission_status`<br><br>_String_ | **Optional**<br><br>Configure whether a WhatsApp user is prompted with a call permission request after calling your business.<br><br>Note: The call permission request is triggered by either a missed or connected call.<br><br>[View callback permission status behavior details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#callback-permissions) | `"ENABLED"`<br><br>`"DISABLED"` |
| `sip`<br><br>_JSON object_ | **Optional**<br><br>Configure call signaling via session initiation protocol (SIP).<br><br>**Note: When SIP is enabled, you cannot use calling related endpoints and will not receive calling related webhooks.**<br><br>[Learn how to configure and use SIP call signaling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip) | View [Configure SIP settings on business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-or-update-sip-settings-on-business-phone-number) |
| `audio`<br><br>_JSON object_ | **Optional**<br><br>Configure call audio codec settings. Opus is the default codec and is always present.<br><br>[View audio codec details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#audio-codec) | ```json
"audio": {
  "additional_codecs": [
    "PCMA", "PCMU"
  ]
}
``` |
| `voicemail`<br><br>_JSON object_ | **Optional**<br><br>Configure voicemail collection for missed or rejected user-initiated calls.<br><br>[View voicemail details below](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#voicemail) | ```json
"voicemail": {
  "status": "ENABLED",
  "triggers": [
    "REJECT",
    "TIMEOUT"
  ],
  "audio": {
    "default": {
      "announcement_media_id": 938884519013664,
      "timeout_seconds": 20
    }
  }
}
``` |

### Calling status

When the `status` parameter is set to `"ENABLED"`, calling features are enabled for the business phone number. WhatsApp client apps render the call button icon in both the business chat and business chat profile.

When the `status` parameter is set to `"DISABLED"`, calling features are **disabled**, and both the business chat and business chat profile **do not display the call button icon.**

Updates to `status` update the call button icon in existing business chats in near real-time when the business phone number is in the WhatsApp user's contacts.

Otherwise, updates are real-time for a limited number of users in conversation with the business, and are eventual for the rest of the conversations.

#### Call button icon visibility

When Calling API features are enabled for a business number, you can still choose whether to show the call button icon or not by using the `call_icon_visibility` parameter. Note: Disabling call button icon visibility **does not** disable a WhatsApp user's ability to make unsolicited calls to your business.

The behavior for supported options is as follows:

`DEFAULT`

WhatsApp displays the call button icon in the chat menu bar and the business info page, allowing WhatsApp users to make unsolicited calls to the business.

`DISABLE_ALL`

The call button icon is hidden in the chat menu bar and the business info page, and all other entry points external to the chat are also disabled. WhatsApp users cannot make unsolicited calls to your business.

You can still [send interactive messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#send-interactive-message-with-a-whatsapp-call-button) or [template messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#create-and-send-whatsapp-call-button-template-message) with a Calling API CTA button.

### Callback permissions

Calling a WhatsApp user requires explicit permission from the user. One way to obtain calling permissions is to request permission when a WhatsApp user calls your business.

You can configure the call permission UI to automatically show in the WhatsApp user's client app when they call your business number. The user may change their permission selection at any time.

### Call icons

With the `call_icons` setting, you can specify the countries where these icons should show up.

```json
"call_icons": {
  "restrict_to_user_countries": [
    "US",
    "BR"
  ]
}
```

| Parameter | Description | Sample Values |
| --- | --- | --- |
| `restrict_to_user_countries`<br><br>_List of Strings_ | **Optional**<br><br>Restrict the visibility of call icons to these countries.<br><br>_NOTE: For example, if you restrict `restrict_to_user_countries` to "US," then it will apply to all the people who have a US registered phone number. These people could be physically located inside or outside of the USA._ | Restrict to US and Brazil:<br><br>```json
"restrict_to_user_countries": [
  "US",
  "BR"
]
```<br><br>No restriction:<br><br>```json
"restrict_to_user_countries": []
``` |

### Call hours

With the `call_hours` setting, you can specify the timezone, business operating hours, and holiday schedules that will be enforced for all user-initiated calls.

Configuring this setting restricts calls only to available weekly hours you configure. User-initiated calls are unavailable outside of the weekly hours and holiday schedules you set.

The WhatsApp client app shows WhatsApp users an option to chat with the business, or request a callback, if `callback_permission_status` is `ENABLED`. The user will also be shown the next available calling slot on the option screen.

```json
"call_hours": {
  "status": "ENABLED",
  "timezone_id": "America/Manaus",
  "weekly_operating_hours": [
    {
      "day_of_week": "MONDAY",
      "open_time": "0400",
      "close_time": "1020"
    },
    {
      "day_of_week": "TUESDAY",
      "open_time": "0108",
      "close_time": "1020"
    }
  ],
  "holiday_schedule": [
    {
      "date": "2026-01-01",
      "start_time": "0000",
      "end_time": "2359"
    }
  ]
}
```

| Parameter | Description | Sample Values |
| --- | --- | --- |
| `status`<br><br>_String_ | **Required**<br><br>Enable or disable the call hours for your business.<br><br>If call hours are disabled, your business is considered open all 24 hours of the day, 7 days a week. | `"ENABLED"`<br><br>`"DISABLED"` |
| `timezone_id`<br><br>_String_ | **Required**<br><br>The timezone that your business is operating within.<br><br>[Learn more about supported values for `timezone_id`](https://developers.facebook.com/docs/facebook-business-extension/fbe/reference#time-zones) | `"America/Menominee"`<br><br>`"Asia/Singapore"` |
| `weekly_operating_hours`<br><br>_List of JSON objects_ | **Required**<br><br>The operating hours schedule for each day of the week.<br><br>Each entry is a JSON object with 3 key-value pairs:<br><br>`day_of_week` — (_Enum_) **[Required]**<br><br>The day of the week.<br><br>Can take one of seven values: `"MONDAY"`, `"TUESDAY"`, `"WEDNESDAY"`, `"THURSDAY"`, `"FRIDAY"`, `"SATURDAY"`, `"SUNDAY"`<br><br>`open_time` \| `close_time` — (_Integer_) **[Required]**<br><br>Opening and closing times represented in 24-hour format, for example `"1130"` = 11:30 AM<br><br>- Maximum of 2 entries allowed per day of week<br>- `open_time` must be before `close_time`<br>- Overlapping entries not allowed | ```json
{
"day_of_week": "MONDAY",
"open_time": "0400",
"close_time": "1020"
},
{
"day_of_week":"TUESDAY",
"open_time": "0108",
"close_time": "1020"
}
...
``` |
| `holiday_schedule`<br><br>_List of JSON objects_ | **Optional**<br><br>An optional override to the weekly schedule.<br><br>Up to 20 overrides can be specified.<br><br>Note: If `holiday_schedule` is not passed in the request, then the existing `holiday_schedule` will be deleted and replaced with an empty schedule.<br><br>`date` — (_String_) **[Required]**<br><br>Date for which you want to specify the override.<br><br>YYYY-MM-DD format.<br><br>`open_time` \| `close_time` — (_Integer_) **[Required]**<br><br>Opening and closing times represented in 24-hour format, for example, `"1130"` = 11:30 AM<br><br>- Maximum of 2 entries allowed per day of week<br>- `open_time` must be before `close_time`<br>- Overlapping entries not allowed | ```json
{
"date": "2026-01-01",
"start_time": "0000",
"end_time": "2359"
}
...
``` |

### Audio codec

Opus is the default audio codec for all WhatsApp calls. You can enable G.711 (PCMA/PCMU) codecs for interoperability with legacy telephony systems or PSTN gateways.

#### Guidelines and considerations

- **Opus is the recommended codec.** Opus delivers higher audio quality with lower bandwidth usage and is the default for all WhatsApp calls. Use Opus unless you have a specific requirement for G.711.
- **G.711 requires transcoding.** When a G.711 codec is negotiated, audio is transcoded between Opus (on the WhatsApp user side) and G.711 (on the business side), which can add latency to the call.
- **G.711 has lower audio quality.** G.711 encodes audio at a fixed 64 kbps without advanced compression, resulting in lower fidelity compared to Opus.
- **G.711 uses more bandwidth.** G.711 requires approximately 64 kbps per direction, while Opus achieves comparable or better quality at significantly lower bitrates.
- **Use G.711 only when necessary.** The primary use case is interoperability with legacy telephony infrastructure and PSTN gateways that do not support Opus.

```json
"audio": {
  "additional_codecs": ["PCMA", "PCMU"]
}
```

| Parameter | Description | Sample Values |
| --- | --- | --- |
| `additional_codecs`<br><br>_List of Strings_ | **Optional**<br><br>Enable additional audio codecs. Supported values: `"PCMA"` (G.711 A-law), `"PCMU"` (G.711 µ-law). Opus is always enabled by default and cannot be removed. After enabling additional codecs, they can be selected during SDP codec negotiation according to RFC 3264. | ```json
"additional_codecs": [
  "PCMA",
  "PCMU"
]
```<br><br>No additional codecs:<br><br>```json
"additional_codecs": []
``` |

### Voicemail

When enabled, Cloud API does the following:
- Waits for a configured delay or a reject signal from you
- Automatically answers the call
- Plays an audio announcement
- Records the caller's voicemail
- Delivers the voicemail as an audio message via webhook

When voicemail is enabled, turn off call hours, because WhatsApp users can't place calls outside business hours.

Calling must be enabled on the phone number for the `voicemail` setting to take effect.

```html
"voicemail": {
  "status": "ENABLED",
  "triggers": [
    "REJECT",
    "TIMEOUT"
  ],
  "audio": {
    "default": {
      "announcement_media_id": <MEDIA_ID>,
      "timeout_seconds": 20
    }
  }
}
```

| Parameter | Description | Sample Values |
| --- | --- | --- |
| `status`<br><br>_String_ | **Required**<br><br>Enable or disable the voicemail feature for the business phone number. Disabled by default.<br><br>Calling must be enabled on the phone number, otherwise the voicemail setting is ignored. | `"ENABLED"`<br><br>`"DISABLED"` |
| `triggers`<br><br>_List of Strings_ | **Required when `status` is `ENABLED`**<br><br>Events that trigger voicemail collection. At least one trigger must be specified when voicemail is enabled. Supported values:<br><br>- `REJECT` — you reject the incoming call.<br>- `TIMEOUT` — you do not accept or reject the call within the configured `timeout_seconds`. | ```json
"triggers": [
  "REJECT",
  "TIMEOUT"
]
``` |
| `audio`<br><br>_JSON object_ | **Required when `status` is `ENABLED`**<br><br>Voicemail audio configuration.<br><br>`default` _(JSON object)_ **[Required]** — Default voicemail configuration applied to all WhatsApp users.<br><br>The `default` configuration accepts the following fields:<br><br>`announcement_media_id` _(Integer)_ **[Required when `status` is `ENABLED`]** — ID of an uploaded media file played to the WhatsApp user as the voicemail announcement. Upload the file via the [Media Upload API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/media-upload-api) with `use_case=call_voicemail_announcement`. The media file must satisfy the following:<br><br>- Duration must be less than 60 seconds.<br>- MIME type must be `audio/ogg` with the OPUS codec.<br>- The media must be uploaded with `use_case=call_voicemail_announcement` so it is exempt from the standard 30-day media TTL.<br><br>`timeout_seconds` _(Integer)_ **[Required when `TIMEOUT` trigger is used]** — Time in seconds after the call starts ringing before the voicemail announcement and recording begin. Only applies to the `TIMEOUT` trigger. Must be between `0` and `30` seconds inclusive. If the `TIMEOUT` trigger is configured without `timeout_seconds`, the trigger is disabled. | ```html
"audio": {
  "default": {
    "announcement_media_id": <MEDIA_ID>,
    "timeout_seconds": 20
  }
}
``` |

#### Upload a voicemail announcement media file

Voicemail announcement audio files must be uploaded through the [Media Upload API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/media-upload-api) with the `use_case` parameter set to `call_voicemail_announcement`. This skips the standard 30-day TTL applied to messaging media so that announcements remain available for the lifetime of the configuration.

```html
POST /<PHONE_NUMBER_ID>/media
```

Form data parameters:

- `file=@<FILE_PATH>;type=audio/ogg`
- `messaging_product=whatsapp`
- `use_case=call_voicemail_announcement`
- `description="Default announcement (English)"`

Media uploaded with `use_case=call_voicemail_announcement` can only be used as a voicemail announcement and cannot be sent as a regular message.

### Success response

```json
{
  "success": true
}
```

### Error response

Possible errors that can occur:

- Permissions/Authorization errors
- Invalid status
- Invalid schedule for `call_hours`
- Holiday given in `call_hours` is a past date
- Timezone is invalid in `call_hours`
- `weekly_operating_hours` in `call_hours` cannot be empty
- Date format in `holiday_schedule` for call_hours is invalid
- More than 2 entries not allowed in `weekly_operating_hours` schedule in `call_hours`
- Overlapping schedule in `call_hours` is not allowed

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Get phone number calling settings

Use this endpoint to check the configuration of your Calling API feature settings.

This endpoint can return information for other Cloud API feature settings.

### Request syntax

```html
GET /<PHONE_NUMBER_ID>/settings
```

### Endpoint parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>ID of the business phone number for which you are getting Calling API settings. | `106540352242922` |

### App permission required

`whatsapp_business_management`: Advanced access is required to use the API for end business clients

### Response body

```html
{
  "calling": {
    "status": "ENABLED",
    "call_icon_visibility": "DEFAULT",
    "callback_permission_status": "ENABLED",
    "call_hours": {
      "status": "ENABLED",
      "timezone_id": "[REDACTED]",
      "weekly_operating_hours": [
        {
          "day_of_week": "MONDAY",
          "open_time": "0400",
          "close_time": "1020"
        },
        {
          "day_of_week": "TUESDAY",
          "open_time": "0108",
          "close_time": "1020"
        }
      ],
      "holiday_schedule": [
        {
          "date": "2026-01-01",
          "start_time": "0000",
          "end_time": "2359"
        }
      ]
    },
    "sip": {
      "status": "ENABLED",
      "servers": [
        {
          "hostname": "[REDACTED]",
          "sip_user_password": "[REDACTED]"
        }
      ]
    },
    "audio": {
      "additional_codecs": ["PCMA", "PCMU"]
    },
    "voicemail": {
      "status": "ENABLED",
      "triggers": [
        "REJECT",
        "TIMEOUT"
      ],
      "audio": {
        "default": {
          "announcement_media_id": <MEDIA_ID>,
          "timeout_seconds": 20
        }
      }
    }
  },
  <Other non-calling feature configuration...>
}
```

### Include SIP user password in response

Optionally, you can include SIP user credentials in your response body by adding the SIP credentials query parameter in the POST request:

```html
GET /<PHONE_NUMBER_ID>/settings?include_sip_credentials=true
```

Where the response will look like this:

```json
{
  "calling": {
    ... // other calling api settings
    "sip": {
      "status": "ENABLED",
      "servers": [
        {
          "hostname": "sip.example.com",
          "sip_user_password": "{SIP_USER_PASSWORD}"
        }
      ]
    }
  }
}
```

### Response details

The [Settings API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/settings-api#get-version-phone-number-id-settings) returns Calling API settings, along with other configuration information for your WhatsApp Business phone number.

[Learn more about Calling API settings and their values](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#body-parameters)

#### Response with calling restrictions

If your business has restrictions enforced, the response body contains information about the restriction along with other calling API settings.

```json
 {
   "calling": {
     ... // other calling api settings
     "restrictions": {
       "restrictions_list": [
         {
           "type": "[RESTRICTED_BUSINESS_INITIATED_CALLING|RESTRICTED_USER_INITIATED_CALLING]",
           "reason": "Business|User initiated calling capability has been temporarily disabled for this phone number due to high negative feedback from users.",
           "expiration": 1754072386
         }
       ]
     }
   }
}
```

| Parameter | Description |
| --- | --- |
| `<restrictions>`<br><br>_JSON Object_ | The restrictions object contains the following values:<br>`restriction_list` _(JSON Object)_: list of currently imposed restrictions with the following values<br><br>`type` _(string)_ - for calling restriction, this would have the value of `RESTRICTED_BUSINESS_INITIATED_CALLING` or `RESTRICTED_USER_INITIATED_CALLING`<br><br>`reason` _(string)_ - description of restriction<br><br>`expiration` _(Integer)_ - The UNIX time at which the restriction will expire in UTC timezone |

### Error response

Possible errors that can occur:

- Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Call settings in WhatsApp Manager

You can also control your call settings via [WhatsApp Manager](https://business.facebook.com/latest/whatsapp_manager/).

To access calling controls in WhatsApp Manager:

1. Click **Account tools** > **Phone numbers** panel
1. Click the gear icon next to the phone number you are using for calling
1. Click the **Calls** tab

## Configure and use call signaling via session initiation protocol (SIP)

Session Initiation Protocol (SIP) is a signaling protocol used for initiating, maintaining, modifying, and terminating real-time communication sessions between two or more endpoints. You can send and receive call signals using SIP instead of Graph API endpoints.

[Learn more about how to use and configure SIP](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip)

## Voicemail webhooks

When a WhatsApp user leaves a voicemail on a business phone number that has voicemail [enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#voicemail), Cloud API delivers the recorded audio to your business through the existing `messages` webhook field as an inbound audio message.

The webhook payload follows the same schema as the [Audio messages webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/audio), with one difference: `messages[].id` contains the call ID (WACID) of the call that produced the voicemail rather than a regular message ID (WAMID). Use this call ID to correlate the voicemail with the originating call lifecycle webhooks.

No additional webhook subscription is required beyond the standard `messages` field; integrations that already handle inbound audio messages can process voicemails with minimal changes.

Voicemail collection is delivered as best-effort. If voicemail collection fails, Cloud API does not send a voicemail webhook for that call.

### Webhook payload

```html
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WABA_ID>",
      "changes": [
        {
          "field": "messages",
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>",
              "display_phone_number": "<BUSINESS_PHONE_NUMBER>"
            },
            "contacts": [
              {
                "wa_id": "<USER_PHONE_NUMBER>",
                "user_id": "<BSUID>",
                "parent_user_id": "<PARENT_BSUID>",
                "profile": {
                  "name": "<USER_PROFILE_NAME>",
                  "username": "<USERNAME>"
                }
              }
            ],
            "messages": [
              {
                "id": "wacid.HBgLMTQxMjYxMzYyASG...",
                "from": "<USER_PHONE_NUMBER>",
                "from_user_id": "<BSUID>",
                "from_parent_user_id": "<PARENT_BSUID>",
                "timestamp": "1728932177",
                "type": "audio",
                "audio": {
                  "id": "1002764438271669",
                  "sha256": "Y9vvGyeo3n76ptkXu3CwDBsnzbRFqpjHskQdMGSVqas=",
                  "mime_type": "audio/ogg; codecs=opus"
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

**Note:** **Usernames and business-scoped user IDs:** The `user_id`, `parent_user_id`, and `username` fields in `contacts` and the `from_user_id` and `from_parent_user_id` fields in `messages` identify the WhatsApp user by their BSUID; the phone number fields (`wa_id`, `from`) may be omitted if the user has adopted a username. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

For detailed field descriptions, see the [Audio messages webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/audio).

## Settings update webhooks

You can subscribe to a new webhook subscription field `account_settings_update` to get notified on updates to phone number settings.

- You'll be notified even for your own updates
- Currently, only changes to calling settings are supported. Under the calling object, only changes to these fields are observed: `status`, `call_icon_visibility`, `callback_permission_status`, `sip.status`, and `srtp_key_exchange_protocol`.

### Steps to get started

- [Set up your webhook subscription](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks) and subscribe to the `account_settings_update` field.
- The same app should also be subscribed to the WhatsApp Business account of your business phone number.
- Your app should have `whatsapp_business_management` permission to receive the webhooks. Using access token for the same app, if you're able to [get settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#get-phone-number-calling-settings) successfully, your app is good to receive the webhooks too.

### Webhook payload

```html
{
    "object": "whatsapp_business_account",
    "entry": [
        {
            "id": "whatsapp-business-account-id",
            "changes": [
                {
                    "value": {
                        "messaging_product": "whatsapp",
                        "timestamp": "1671644824",
                        "type": "[phone_number_settings]",
                        "phone_number_settings": {
                            "phone_number_id": "phone-number-id",
                            "calling": {
                                "status": "ENABLED",
                                "call_icon_visibility": "DEFAULT",
                                "callback_permission_status": "ENABLED",
                                "call_hours": {
                                    "status": "ENABLED",
                                    "timezone_id": "[REDACTED]",
                                    "weekly_operating_hours": [
                                        {
                                            "day_of_week": "MONDAY",
                                            "open_time": "0400",
                                            "close_time": "1020"
                                        },
                                        {
                                            "day_of_week": "TUESDAY",
                                            "open_time": "0108",
                                            "close_time": "1020"
                                        }
                                    ],
                                    "holiday_schedule": [
                                        {
                                            "date": "2026-01-01",
                                            "start_time": "0000",
                                            "end_time": "2359"
                                        }
                                    ]
                                },
                                "sip": {
                                    "status": "ENABLED",
                                    "servers": [
                                        {
                                            "hostname": "[REDACTED]",
                                            "port": SIP_SERVER_PORT
                                        }
                                    ]
                                }
                            }
                        }
                    },
                    "field": "account_settings_update"
                }
            ]
        }
    ]
}
```

### Webhook values

| Placeholder | Description |
| --- | --- |
| `messaging_product`<br><br>_String_ | Always `whatsapp`. |
| `timestamp`<br><br>_String_ | Time when the settings were updated. |
| `type`<br><br>_String_ | Type of the change. Currently, the only value is `PHONE_NUMBER_SETTINGS`. |
| `phone_number_settings`<br><br>_Object_ | This field is present if the type is `PHONE_NUMBER_SETTINGS`. Currently, only the `calling` sub-field is supported. |
| `phone_number_settings.phone_number_id`<br><br>_String_ | The phone number ID whose settings were updated. |
| `phone_number_settings.calling`<br><br>_Object_ | This is present only if fields related to `calling` are updated. It's null otherwise. When present, the payload is the same as [Get settings API](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#get-phone-number-calling-settings) |

## Calling restrictions for user feedback

If your calls receive high negative user feedback, such as blocks and reports, business-initiated calling, user-initiated calling, or both functionalities on your phone number can be restricted.

### Early warning

You will be notified when the business phone number is close to being paused as an early warning. The early warning notifications will be communicated via the channels below.

#### Email

Enforcement emails are sent to the email addresses of all users and admins associated with the business.
If you did not receive an email, confirm which email you have designated as the contact email for your app and make sure that it is active, can receive new email, and does not flag the email as junk or spam mail.

#### Webhook

A webhook will be sent on the `account_update` field:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "0",
      "time": 1623862418,
      "changes": [
        {
          "field": "account_update",
          "value": {
            "phone_number": "PN",
            "event": "ACCOUNT_VIOLATION",
            "violation_info": {
               "violation_type": "[LOW_BUSINESS_INITIATED_CALLING_QUALITY|LOW_USER_INITIATED_CALLING_QUALITY]",
            }
          }
        }
      ]
    }
  ]
}
```

If either business or user initiated calling are close to being paused, you will receive a webhook for the respective violation type. For more information about the webhook, see [account_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update).

### Pause in calling functionality

Once the negative user feedback reaches a threshold, Cloud API automatically restricts calling functionality on your phone number for a period of 7 days. While paused, the calling phone number will be unable to:

- Make business-initiated calls to users
- Send call permissions requests

Once your phone number has been paused, notifications will be communicated via the channels below.

Note: Any call permissions approved or declined by the users while paused will still be valid.

#### Email

Enforcement emails are sent to the email addresses of all users and admins associated with the business.
If you did not receive an email, confirm which email you have designated as the contact email for your app and make sure that it is active, can receive new email, and does not flag the email as junk or spam mail.

#### Webhook

A webhook will be sent on the `account_update` field:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "0",
      "time": 1641848059,
      "changes": [
        {
          "field": "account_update",
          "value": {
            "phone_number": "PN",
            "event": "ACCOUNT_RESTRICTION",
            "restriction_info": [
              {
                "restriction_type": "RESTRICTED_BUSINESS_INITIATED_CALLING",
                "expiration": 1641848057
              }
            ]
          }
        }
      ]
    }
  ]
}
```

For more information about the webhook, see [account_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update).

### Pause in user initiated calling functionality

Once the negative user feedback reaches a threshold, Cloud API automatically restricts user initiated calling functionality on your phone number for a period of 7 days. While paused, the calling phone number will be unable to:

- Receive calls from users
- Have call icon visible

Once your phone number has been paused, notifications will be communicated via the channels below.

#### Email

Enforcement emails are sent to the email addresses of all users and admins associated with the business.
If you did not receive an email, confirm which email you have designated as the contact email for your app and make sure that it is active, can receive new email, and does not flag the email as junk or spam mail.

#### Webhook

A webhook will be sent on the `account_update` field:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "0",
      "time": 1641848059,
      "changes": [
        {
          "field": "account_update",
          "value": {
            "phone_number": "PN",
            "event": "ACCOUNT_RESTRICTION",
            "restriction_info": [
              {
                "restriction_type": "RESTRICTED_USER_INITIATED_CALLING",
                "expiration": 1641848057
              }
            ]
          }
        }
      ]
    }
  ]
}
```

For more information about the webhook, see [account_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update).

## Calling restrictions for low call pickup rates

When calling is enabled on your business phone number, you are expected to pick up calls that WhatsApp users place to you.

If a significant number of calls placed to your calling-enabled business phone number are not picked up, you will be notified and expected to make a change.

### What happens if you do not pick up calls

1. **Warning via Email:** You receive an email notification with options to change how you handle incoming calls.
1. **Calling becomes restricted on the business phone number:** The calling button will be hidden from users.

### How to mitigate the situation

#### If you receive a warning

- **Continue allowing users to call:**
  - Identify and address the cause of calls not being picked up and make sure you are properly resourced to handle expected call volumes.
- **Hide call buttons for user-initiated calls:**
  - You can do so either by working with your partner or going to [WhatsApp Manager](https://business.facebook.com/latest/whatsapp_manager/overview/) > Account tools > Phone numbers > select Phone number [WA phone number] > Calls > toggle off Display call buttons.
- **Turn off calling altogether:**
  - You can do so either by working with your partner or going to [WhatsApp Manager](https://business.facebook.com/latest/whatsapp_manager/overview/) > Account tools > Phone numbers > select Phone number [WA phone number] > Calls > toggle off Allow voice calls.

#### If the call button is hidden for the business phone number

- **Re-display calling buttons:**
  - Identify and address the cause of calls not being picked up and make sure you are properly resourced to handle expected call volumes.
  - Next, display the calling buttons by either working with your partner or going to [WhatsApp Manager](https://business.facebook.com/latest/whatsapp_manager/overview/) > Account tools > Phone numbers > select Phone number [WA phone number] > Calls > toggle on Display call buttons.
- **Turn off calling altogether:**
  - You can do so either by working with your partner or going to [WhatsApp Manager](https://business.facebook.com/latest/whatsapp_manager/overview/) > Account tools > Phone numbers > select Phone number [WA phone number] > Calls > toggle off Allow voice calls.

### Webhooks

#### Warning webhook

```json
[
  {
    "object": "whatsapp_business_account",
    "entry": [
      {
        "id": "0",
        "time": 1641848059,
        "changes": [
          {
            "field": "account_update",
            "value": {
              "phone_number": "16505552771",
              "event": "ACCOUNT_VIOLATION",
              "violation_info": {
                "violation_type": "USER_INITIATED_CALLS_LOW_PICKUP_RATE",
                "remediation": "Please identify and address the cause of user-initiated calls not being picked up and make sure the business is properly resourced to handle expected call volumes."
              }
            }
          }
        ]
      }
    ]
  }
]
```

#### Enforcement webhook

```json
[
  {
    "object": "whatsapp_business_account",
    "entry": [
      {
        "id": "0",
        "time": 1641848059,
        "changes": [
          {
            "field": "account_update",
            "value": {
              "phone_number": "16505552771",
              "event": "ACCOUNT_RESTRICTION",
              "restriction_info": [
                {
                  "restriction_type": "RESTRICTED_USER_INITIATED_CALLING_CALL_BUTTON_HIDDEN",
                  "remediation": "The call button has been hidden due to low pickup rates. Please identify and address the cause of user-initiated calls not being picked up.  Next, display the calling buttons by either working with your partner or going to WhatsApp Manager > Account tools > Phone numbers > select Phone number > Calls > toggle on Display call buttons"
                }
              ]
            }
          }
        ]
      }
    ]
  }
]
```
# Business-Initiated Calls



## Overview

The Calling API lets your business call WhatsApp users.

The WhatsApp user controls when your business can call them by [granting call permissions to your business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions).

### Call sequence diagram

_Note: The `ACCEPTED` call status webhook arrives after the call is established. The Cloud API sends it for call event auditing._

## Prerequisites

Before you get started with business-initiated calling, ensure that:

* You [subscribe](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks) to the "calls" webhook field
* You [enable the Calling APIs on your business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings)

Lastly, **before you can call a WhatsApp user, you must obtain their permission to do so.**

[Learn how to obtain WhatsApp user calling permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions)

## Business-initiated calling flow

### Part 1: Obtain permission to call the WhatsApp user

You can obtain call permissions from the WhatsApp user in one of the following ways:

#### Send a call permission request message

You can request call permissions by sending the WhatsApp user a permission request. Send it as a free form message during an open customer service window, or use a template message.

* [Learn how to send a **free form** call permission request](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions#how-to-send-a-free-form-call-permission-request-message)
* [Learn how to send a **template** call permission request](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions#how-to-create-and-send-call-permission-request-template-messages)

#### Enable `callback_permission_status` in call settings

When `callback_permission_status` is enabled, the user automatically provides call permission to your business when they place a call to you.

[Learn how to enable `callback_permission_status`](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#configure-update-business-phone-number-calling-settings)

### Part 2: Your business initiates a new call to the WhatsApp user

Now that you have user permission, you can initiate a new call to the WhatsApp user in question.

Use the [Calls API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api) with the following request body to initiate a new call:

```https
POST <PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "to":"12185552828", // The WhatsApp user's phone number (callee)
  "recipient": "US.13491208655302741918",
  "action":"connect",
  "session" : {
      "sdp_type" : "offer",
      "sdp" : "<<RFC 8866 SDP>>"
  }
}
```

If there are no errors, you receive a successful response:

```https
{
  "messaging_product": "whatsapp",
  "calls" : [
    { "id" : "wacid.HBgLMTIxODU1NTI4MjgVAgARGCAyODRQIAFRoA" } // The WhatsApp call ID
   ]
}
```

_Note: Response with error code `138006` indicates a lack of a call request permission for this business number from the WhatsApp user._

### Part 3: You establish the call connection using webhook signaling

After you successfully initiate a new call, you receive a Call Connect webhook response containing an `SDP Answer` from Cloud API. Your business then applies the `SDP Answer` from this webhook to your WebRTC stack to initiate the media connection.

```https
{
    "entry": [
        {
            "changes": [
                {
                    "field": "calls",
                    "value": {
                        "calls": [
                            {
                                "biz_opaque_callback_data": "TRx334DUDFTI4Mj", // Arbitrary string passed by business for tracking purposes
                                "session": {
                                    "sdp_type": "answer",
                                    "sdp": "<RFC 8866 SDP>"
                                },
                                "from": "13175551399", // The business phone number placing the call (caller)
                                "connection": {
                                    "webrtc": {
                                        "sdp": "<RFC 8866 SDP>"
                                    }
                                },
                                "id": "wacid.HBgLMTIxODU1NTI4MjgVAgARGCAyODRQIAFRoA", // The WhatsApp call ID
                                "to": "12185552828", // The WhatsApp user's phone number (callee)
                                "to_user_id": "<BSUID>",
                                "to_parent_user_id": "<PARENT_BSUID>",
                                "event": "connect",
                                "timestamp": "1749196895",
                                "direction": "BUSINESS_INITIATED"
                            }
                        ],
                        "contacts": [
                            {
                                "profile": {
                                    "name": "<CALLEE_NAME>",
                                    "username": "<USERNAME>"
                                },
                                "wa_id": "<USER_PHONE_NUMBER>",
                                "user_id": "<BSUID>",
                                "parent_user_id": "<PARENT_BSUID>"
                            }
                        ],
                        "metadata": { // ID and display number for the business phone number placing the call (caller)
                            "phone_number_id": "436666719526789",
                            "display_phone_number": "13175551399"
                        },
                        "messaging_product": "whatsapp"
                    }
                }
            ],
            "id": "366634483210360" // WhatsApp Business Account ID associated with the business phone number
        }
    ],
    "object": "whatsapp_business_account"
}
```

You then receive an appropriate status webhook, indicating that the call is `RINGING`, `ACCEPTED`, or `REJECTED`:

```https
{
  "entry": [
    {
      "changes": [
        {
          "field": "calls",
          "value": {
            "statuses": [
              {
                "id": "wacid.HBgLMTIxODU1NTI4MjgVAgARGCAyODRQIAFRoA", // The WhatsApp call ID
                "type": "call",
                "status": "[RINGING|ACCEPTED|REJECTED]", // The current call status
                "timestamp": "1749197000",
                "recipient_id": "12185552828", // The WhatsApp user's phone number (callee)
                "recipient_user_id": "<BSUID>",
                "recipient_parent_user_id": "<PARENT_BSUID>"
              }
            ],
            "metadata": { // ID and display number for the business phone number placing the call (caller)
              "phone_number_id": "436666719526789",
              "display_phone_number": "13175551399"
            },
            "messaging_product": "whatsapp"
          }
        }
      ],
      "id": "366634483210360" // WhatsApp Business Account ID associated with the business phone number
    }
  ],
  "object": "whatsapp_business_account"
}
```

### Part 4: Your business or the WhatsApp user terminates the call

Either you or the WhatsApp user can terminate the call at any time.

Use the [Calls API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api) with the following request body to terminate the call:

```curl
POST <PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.HBgLMTIxODU1NTI4MjgVAgARGCAyODRQIAFRoA", // The WhatsApp call ID
  "action" : "terminate"
}
```

If there are no errors, you receive a success response:

```https
{
  "success" : true
}
```

When either the business or the WhatsApp user terminates the call, you receive a Call Terminate webhook:

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "366634483210360", // WhatsApp Business Account ID associated with the business phone number
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": { // ID and display number for the business phone number placing the call (caller)
              "phone_number_id": "436666719526789",
              "display_phone_number": "13175551399",

            },
            "calls": [
              {
                "id": "wacid.HBgLMTIxODU1NTI4MjgVAgARGCAyODRQIAFRoA",
                "to": "12185552828", // The WhatsApp user's phone number (callee)
                "to_user_id": "<BSUID>",
                "to_parent_user_id": "<PARENT_BSUID>",
                "from": "13175551399", // The business phone number placing the call (caller)
                "event": "terminate",
                "direction": "BUSINESS_INITIATED",
                "timestamp": "1749197480",
                "status": ["Failed", "Completed"],
                "start_time": "1671644824", // Call start UNIX timestamp
                "end_time": "1671644944", // Call end UNIX timestamp
                "duration": 480 // Call duration in seconds
              }
            ],
            "contacts": [
              {
                "profile": {
                  "name": "<CALLEE_NAME>",
                  "username": "<USERNAME>"
                },
                "wa_id": "<USER_PHONE_NUMBER>",
                "user_id": "<BSUID>",
                "parent_user_id": "<PARENT_BSUID>"
              }
            ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

## Endpoints for business-initiated calling

### Initiate call

Use this endpoint to initiate a call to a WhatsApp user by providing a phone number and a WebRTC call offer. There is a rate limit of 10000 per 24 hours for initiating new calls per business phone number.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>ID of the business phone number from which you are initiating the new call. | `106540352242922` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "to": "14085551234",
  "recipient": "US.13491208655302741918",
  "action": "connect",
  "session": {
    "sdp_type": "offer",
    "sdp": "<<RFC 8866 SDP>>"
  },
  "biz_opaque_callback_data": "0fS5cePMok"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `to`<br><br>_Integer_ | **Required** (unless `recipient` is provided)<br><br>The number being called (callee). The user can be identified by phone number (`to`), BSUID (`recipient`), or both. If you include both, `to` takes precedence.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)<br><br>[Learn how business-scoped user IDs apply to business-initiated call requests](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#businesses-initiated-call-requests) | `"17863476655"` |
| `recipient`<br><br>_String_ | **Optional**<br><br>The WhatsApp user's business-scoped user ID (BSUID) or parent BSUID. Use this instead of, or in addition to, `to`. If you include both, `to` takes precedence.<br><br>[Learn more about business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) | `"US.13491208655302741918"` |
| `action`<br><br>_String_ | **Required**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"connect"` |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#sdp-overview-and-sample-sdp-structures) | ```https
"session" :
{
"sdp_type" : "offer",
"sdp" : "<<RFC 8866 SDP>>"
}
``` |
| `biz_opaque_callback_data`<br><br>_String_ | **Optional**<br><br>An arbitrary string you can pass in that is useful for tracking and logging purposes.<br><br>Any app subscribed to the "calls" webhook field on your WhatsApp Business account can receive this string, as it is included in the `calls` object within the subsequent [Call Terminate Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#call-terminate-webhook) payload.<br><br>Cloud API does not process this field.<br><br>Maximum 512 characters | `"0fS5cePMok"` |

**Note:** **Usernames and business-scoped user IDs:** When initiating a call, you can identify the recipient by phone number (`to`), BSUID (`recipient`), or both; the user's phone number may be omitted if a `recipient` is provided. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "calls" : [{
     "id" : "wacid.ABGGFjFVU2AfAgo6V",
   }]
}
```

#### Error response

Possible errors that can occur:

* Invalid `<PHONE_NUMBER_ID>`
* Permissions/Authorization errors
* Request format validation errors, for example connection info, sdp, ice
* SDP validation errors
* Calling restriction errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

### Terminate call

Use this endpoint to terminate an active call.

This must be done even if there is an `RTCP BYE` packet in the media path. Ending the call this way also ensures pricing is more accurate.

When the WhatsApp user terminates the call, you do not have to call this endpoint. Once the call is successfully terminated, you receive a [Call Terminate Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#call-terminate-webhook).

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are terminating a call from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `18274459827` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "terminate"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Required**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"terminate"` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call_id`
* Invalid `<PHONE_NUMBER_ID>`
* The WhatsApp user has already terminated the call
* Reject call is already in progress
* Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Webhooks for business-initiated calling

With all Calling API webhooks, there is a `"calls"` object inside the `"value"` object of the webhook response. The `"calls"` object contains metadata about the call that is used to action on each call placed or received by your business.

To receive Calling API webhooks, subscribe to the "calls" webhook field.

[Learn more about Cloud API webhooks here](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)

### Call connect webhook

You receive a webhook notification in near real-time when a call initiated by your business is ready to connect to the WhatsApp user (an `SDP Answer`).

Critically, the webhook contains information required to establish a call connection via WebRTC.

Once you receive the Call Connect webhook, you can apply the `SDP Answer` received in the webhook to your WebRTC stack to initiate the media connection.

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "16315553601",
              "phone_number_id": "<PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<CALLEE_NAME>",
                  "username": "<USERNAME>"
                },
                "wa_id": "16315553602",
                "user_id": "<BSUID>",
                "parent_user_id": "<PARENT_BSUID>"
              }
            ],
            "calls": [
              {
                "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
                "to": "16315553601",
                "to_user_id": "<BSUID>",
                "to_parent_user_id": "<PARENT_BSUID>",
                "from": "16315553602",
                "event": "connect",
                "timestamp": "1671644824",
                "direction": "BUSINESS_INITIATED",
                "session": {
                  "sdp_type": "answer",
                  "sdp": "<<RFC 8866 SDP>>"
                }
              }
            ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

#### Webhook values for `"calls"`

| Placeholder | Description |
| --- | --- |
| `id`<br><br>_String_ | A unique ID for the call |
| `to`<br><br>_String_ | The number being called (callee). May be omitted if the user has adopted a username and the phone number cannot be included. |
| `to_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user. |
| `to_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `from`<br><br>_String_ | The number of the caller |
| `event`<br><br>_String_ | The calling event that this webhook is notifying the subscriber of |
| `timestamp`<br><br>_String_ | The UNIX timestamp of the webhook event |
| `direction`<br><br>_String_ | The direction of the call being made.<br><br>Can contain either:<br><br>`BUSINESS_INITIATED`, for calls initiated by your business.<br><br>`USER_INITIATED`, for calls initiated by a WhatsApp user. |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#sdp-overview-and-sample-sdp-structures) |
| `contacts`<br><br>_JSON object_ | `profile.name` — The display name of the callee.<br><br>`profile.username` — **Optional.** The username of the user, if the user has adopted a username.<br><br>`wa_id` — The WhatsApp ID of the callee. May be omitted if the user has adopted a username and the phone number cannot be included.<br><br>`user_id` — The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user.<br><br>`parent_user_id` — **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |

**Note:** **Usernames and business-scoped user IDs:** The Call connect webhook may include `to_user_id`, `to_parent_user_id`, and `contacts` fields containing the user's BSUID and username; the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

### Call status webhook

WhatsApp sends this webhook during the following calling events:

1. Ringing: When the WhatsApp user's client device begins ringing
1. Accepted: When the WhatsApp user accepts the call
1. Rejected: When the WhatsApp user rejects the call. You also receive the call terminate webhook when the user rejects the call.

The webhook structure here is similar to the Status webhooks used for the Cloud API messages.

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
              "messaging_product": "whatsapp",
              "metadata": {
                   "display_phone_number": "16315553601",
                   "phone_number_id": "<PHONE_NUMBER_ID>",
              },
              "statuses": [{
                    "id": "wacid.ABGGFjFVU2AfAgo6V",
                    "timestamp": "1671644824",
                    "type": "call",
                    "status": "[RINGING|ACCEPTED|REJECTED]",
                    "recipient_id": "163155536021",
                    "recipient_user_id": "<BSUID>",
                    "recipient_parent_user_id": "<PARENT_BSUID>",
                    "biz_opaque_callback_data": "random_string",
               }]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

[_Learn more about Cloud API status webhooks_](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)

#### Webhook values for `"statuses"`

| Placeholder | Description |
| --- | --- |
| `id`<br><br>_String_ | A unique ID for the call |
| `timestamp`<br><br>_String_ | The UNIX timestamp of the webhook event |
| `recipient_id`<br><br>_String_ | The phone number of the WhatsApp user receiving the call. May be omitted if the user has adopted a username and the phone number cannot be included. |
| `recipient_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user. |
| `recipient_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `status`<br><br>_String_ | The current call status.<br><br>Possible values:<br><br>`RINGING`: Business initiated call is ringing the user<br><br>`ACCEPTED`: Business initiated call is accepted by the user<br><br>`REJECTED`: Business initiated call is rejected by the user |
| `biz_opaque_callback_data`<br><br>_String_ | Arbitrary string your business passes into the call for tracking and logging purposes.<br><br>Will only be returned if provided through [Initiate New Call API requests](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#initiate-a-new-call) |

**Note:** **Usernames and business-scoped user IDs:** The Call status webhook may include `recipient_user_id` and `recipient_parent_user_id` fields containing the user's BSUID; the user's phone number (`recipient_id`) may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

### Call terminate webhook

WhatsApp sends a webhook notification whenever the call is terminated for any reason, such as when the WhatsApp user hangs up, or when the business uses the [Calls API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api) with an action of `terminate` or `reject`.

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
              "messaging_product": "whatsapp",
              "metadata": {
                   "display_phone_number": "16505553602",
                   "phone_number_id": "<PHONE_NUMBER_ID>",
              },
               "calls": [
                {
                    "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
                    "to": "16315553601",
                    "to_user_id": "<BSUID>",
                    "to_parent_user_id": "<PARENT_BSUID>",
                    "from": "16315553602",
                    "event": "terminate",
                    "direction": "BUSINESS_INITIATED",
                    "biz_opaque_callback_data": "random_string",
                    "timestamp": "1671644824",
                    "status" : [FAILED | COMPLETED],
                    "start_time" : "1671644824",
                    "end_time" : "1671644944",
                    "duration" : 120
                }
              ],
              "contacts": [
                {
                    "profile": {
                        "name": "<CALLEE_NAME>",
                        "username": "<USERNAME>"
                    },
                    "wa_id": "<USER_PHONE_NUMBER>",
                    "user_id": "<BSUID>",
                    "parent_user_id": "<PARENT_BSUID>"
                }
              ],
              "errors": [
                {
                    "code": INT_CODE,
                    "message": "ERROR_TITLE",
                    "href": "ERROR_HREF",
                    "error_data": {
                        "details": "ERROR_DETAILS"
                    }
                }
              ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

#### Webhook values for `"calls"`

| Placeholder | Description |
| --- | --- |
| `id`<br><br>_String_ | A unique ID for the call |
| `to`<br><br>_String_ | The number being called (callee). May be omitted if the user has adopted a username and the phone number cannot be included. |
| `to_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user. |
| `to_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `from`<br><br>_String_ | The number of the caller |
| `event`<br><br>_String_ | The calling event that this webhook is notifying the subscriber of |
| `timestamp`<br><br>_String_ | The UNIX timestamp of the webhook event |
| `direction`<br><br>_String_ | The direction of the call being made.<br><br>Can contain either:<br><br>`BUSINESS_INITIATED`, for calls initiated by your business.<br><br>`USER_INITIATED`, for calls initiated by a WhatsApp user. |
| `start_time`<br><br>_String_ | The UNIX timestamp of when the call started.<br><br>Only present when the call was picked up by the other party. |
| `end_time`<br><br>_String_ | The UNIX timestamp of when the call ended.<br><br>Only present when the call was picked up by the other party. |
| `duration`<br><br>_Integer_ | Duration of the call in seconds.<br><br>Only present when the call was picked up by the other party. |
| `biz_opaque_callback_data`<br><br>_String_ | Arbitrary string your business passes into the call for tracking and logging purposes.<br><br>Will only be returned if provided through an [Initiate Call API request](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#initiate-call) or [Accept Call request](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#accept-call) |
| `errors.code`<br><br>_Integer_ | The `errors` object is present only for failed calls when there is error information available. Code is one of the [calling error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting#calling-error-codes) |
| `contacts`<br><br>_JSON object_ | `profile.name` — The display name of the callee.<br><br>`profile.username` — **Optional.** The username of the user, if the user has adopted a username.<br><br>`wa_id` — The WhatsApp ID of the callee. May be omitted if the user has adopted a username and the phone number cannot be included.<br><br>`user_id` — The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user.<br><br>`parent_user_id` — **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |

**Note:** **Usernames and business-scoped user IDs:** The Call terminate webhook may include `to_user_id`, `to_parent_user_id`, and `contacts` fields containing the user's BSUID and username; the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## SDP overview and sample structures

Session Description Protocol (SDP) is a text-based format used to describe the characteristics of multimedia sessions, such as voice and video calls, in real-time communication applications. SDP provides a standardized way to describe the session's media streams. The SDP description includes media type, codecs, protocols, and parameters for establishing and managing the session.

In the context of WebRTC, SDP is used to negotiate the media parameters between the sender and receiver, enabling them to agree on the specifics of the media exchange.

[View SDP sample structures for business-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#sdp-overview-and-sample-sdp-structures)
# Obtain user call permissions



**Warning:** As of November 3, 2025, permanent permissions is now available. Users can now grant a business ongoing permission to call. Users can review and change calling permission for a business at any time in the business profile.

**Note:** Call permission related features are available only in regions where [business initiated calling is available](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling#availability).

## Overview

If you want to place a call to a WhatsApp user, your business must receive user permission first. When a WhatsApp user grants call permissions, they can be either temporary or permanent.

Your business does not have control over this permission; only the user can grant or revoke it, at any time. WhatsApp stores permanent permission data until the user revokes the permission.

You can obtain calling permission from a WhatsApp user in any of the following ways:

1. **Send a call permission request to the user** — Send a free-form or templated message requesting calling permission from the user. The user can choose between temporary or permanent.
1. **Callback permission is provided by the WhatsApp user** — The WhatsApp user automatically provides temporary call permissions by placing a call to the business. You must [enable the callback setting](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#configure-update-business-phone-number-calling-settings) on the business phone number.
1. **WhatsApp user provides call permission via Business Profile** — The WhatsApp user provides call permissions to the business through their business profile.

### Limits (per business and WhatsApp user pair)

* Temporary permissions are **granted for 7 calendar days (168 hours)**
  * Calculated as the number of seconds in a day multiplied by 7, from the time of the user's approval.
* Permanent permissions do not expire, but they have the same connected calls limit.
* Your business can make a maximum of **100 connected calls every 24 hours**
* These limits are on the **business phone number**

These limits are in place to protect WhatsApp users from unwanted calls.

**Warning:** When you test your WhatsApp Calling integration using public test numbers (PTNs) and sandbox accounts, Calling API restrictions are relaxed.

[Learn more about testing your WhatsApp Calling API integration](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling#testing-and-sandbox-accounts)

## Call permission request basics

You can proactively request a calling permission from a WhatsApp user by sending a permission request message, either as a:

* Free form interactive message
* Template message

The WhatsApp user may approve (temporary or permanent), decline, or simply not respond to a call permission request.

**With permissions, the WhatsApp user is in control.** Even if the user provides calling permission, they can revoke the granted permission at any time. Conversely, if the user declines a permission request, they can still grant calling permission, up until the permission request expires.

**A call permission request expires** when any of the following occurs:

* The WhatsApp user interacts with a subsequent new call permission request from the business
* 7 days after the permission was accepted or declined by the WhatsApp user
* 7 days after the permission was delivered if the WhatsApp user does not respond to the request

[View client UI behavior for expired permission requests](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions#call-permission-request-expiration-scenarios)

To ensure an optimal user experience around business initiated calling, the following limits are enforced:

1. **When sending a calling permission request message**
* Maximum of 1 permission request in 24 hours
* Maximum 2 permission requests within 7 days.
    * _These limits reset when any connected call (business-initiated/user-initiated) is made between the business and WhatsApp user._
    * _These limits apply toward permissions requests sent either as free form or template messages._

1. **When business-initiated calls go unanswered or are rejected**
* 2 consecutive unanswered calls result in a system message to reconsider an approved permission
* 4 consecutive unanswered calls result in an approved permission being automatically revoked. The user may again update this if they so choose.

[View client UI behavior for consecutive unanswered calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions#consecutive-unanswered-calls)

## Free form vs template call permission request message

**Note:** Call permission request messages are subject to [messaging charges](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)

A call permission request message can be sent to users in one of the following ways:

**Send a free form message**

* When you are within a customer service window with a WhatsApp user, you can send a free form message with a call permission request.
* The text body is optional. Include a text body to build context with the WhatsApp user. Free form calling permission request messages do not support header and footer sections.
* Since the customer service window is open, there is no need to create a conversation window.

**Create and send a template message**

* Sending a template message allows you to initiate a user conversation with a call permission request.
* Context (that is, a text body) is required when sending a template message with a call permission request.
* With template messages, you can further customize your permission request by adding a message header and footer.

## Client application UI experience

### Call permission request flow and sample messages

#### Allow calls

#### Temporarily allow calls

### Template message

With header, footer and body

With body only

With no text body

#### Free form message types

With no text body

With text body only

### Updating call permission on business profile
Users always have the option to change the permission using a new option on the business profile.

| Update call permission on business profile |
| --- |
|  |

### Consecutive unanswered calls

| Consecutive unanswered calls |
| --- |
| 2 consecutive unanswered calls — System message for user to update permission |
| 4 consecutive unanswered calls — Permissions automatically revoked |

### Call permission request expiration scenarios

Permission request expires after 7 days — User interacts with request

Permission request expires after 7 days — User does not interact

Previous permission request expires immediately — User does not interact / New call permission request is received

Previous permission request expires immediately — User allows / Interacts with the new request

## Send free form call permission request message

**Note:** Call permission request messages are subject to [messaging charges](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)

Use this endpoint to send a free form interactive message with a call permission request during a [customer service window](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#customer-service-windows). Cloud API sends a standard [message status webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) in response to this message send.

**Note:** The call permission request interactive object cannot be edited by the business. Only the message body can be customized.

[See how this message is rendered on the WhatsApp client](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions#call-permission-request-flow-and-sample-messages)

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/messages
```

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br><br>The business phone number which you are sending messages from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api) | `+18274459827` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<PHONE_NUMBER_ID> or <WHATSAPP_ID>",
  "recipient": "US.13491208655302741918",
  "type": "interactive",
  "interactive": {
    "type": "call_permission_request",
    "action": {
      "name": "call_permission_request"
    },
    "body": {
      "text": "We would like to call you to help support your query on Order No: ON-12853."
    }
  }
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `to`<br><br>_Integer_ | **Required** (unless `recipient` is provided)<br><br>The phone number of the WhatsApp user you are messaging<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api) | `+17863476655` |
| `recipient`<br><br>_String_ | **Optional**<br><br>The WhatsApp user's business-scoped user ID (BSUID) or parent BSUID. Use this instead of, or in addition to, `to`. If you include both, `to` takes precedence.<br><br>[Learn more about business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) | `US.13491208655302741918` |
| `type`<br><br>_String_ | **Required**<br><br>The type of interactive message you are sending.<br><br>In this case, you are sending a `call_permission_request`.<br><br>[Learn more about interactive messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api) | `"call_permission_request"` |
| `action`<br><br>_String_ | **Required**<br><br>The action of your interactive message.<br><br>Must be `call_permission_request`. | `"call_permission_request"` |
| `body`<br><br>_String_ | **Optional**<br><br>The body of your message.<br><br>Although this field is optional, give the WhatsApp user context when you request permission to call them. | `"Allow us to call you so we can support you with your order."` |

#### Success response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [{
      "input": "+1-408-555-1234",
      "wa_id": "14085551234",
      "user_id": "<BSUID>",
      "parent_user_id": "<PARENT_BSUID>"
    }],
  "messages": [{
      "id": "wamid.gBGGFlaCmZ9plHrf2Mh-o"
    }]
}
```

[_Learn more about messaging success responses_](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)

**Note:** **Usernames and business-scoped user IDs:** When sending a call permission request message, you can use the `recipient` field to identify the user by BSUID, and the response may include `user_id` and `parent_user_id` fields; the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### Error response

Possible errors that can occur:

* Invalid `phone-number-id`
* Permissions/Authorization errors
* Rate limit reached
* Sending this message to users on older app versions will result in error webhook with error code [131026](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
* Calling not enabled
* Calling restriction errors

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Create and send call permission request template messages

**Note:** Call permission request messages are subject to [messaging charges](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)

Use these endpoints to create and send a call permission request message template.

Once your permission request template message is created, your business can send the template message to the user as a call permission request outside of a customer service window.

[Learn more about creating and managing message templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)

### Create message template

Use this endpoint to create a call permission request message template.

#### Request syntax

```https
POST/<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates
```

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | **Required**<br><br>Your WhatsApp Business account ID.<br><br>[Learn how to find your WABA ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/whatsapp-business-account-api) | `"waba-90172398162498126"` |

#### Request body

```json
{
  "name": "sample_cpr_template",
  "language": "en",
  "category": "[MARKETING|UTILITY]",
  "components": [
     {
      "type": "HEADER",
      "text": "Support of Order No: {{1}}",
      "example": {
        "body_text": [
          [
            "ON-12345"
          ]
        ]
      }
    },
    {
      "type": "BODY",
      "text": "We would like to call you to help support your query on Order No: {{1}} for the item {{2}}.",
      "example": {
        "body_text": [
          [
            "ON-12345",
            "Avocados"
          ]
        ]
      }
    },
    {
      "type": "FOOTER",
      "text": "Talk to you soon!"
    },
    {
      "type": "call_permission_request"
    }
  ]
}
```

#### Body parameters

Creating and managing template messages can be done both through Cloud API and the Meta Business Suite interface.

When creating your call permission request template, ensure you configure `type` as `call_permission_request`.

[Learn more about creating and managing message templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `type`<br><br>_String_ | **Required**<br><br>The type of template message you are creating.<br><br>In this case, you are creating a `call_permission_request`. | `"call_permission_request"` |

#### Template status response

```https
{
  "id": "<ID>",
  "status": "<STATUS>",
  "category": "<CATEGORY>"
}
```

[_Learn more about template status response_](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#template-status)

#### Error response

Possible errors that can occur:

* Invalid WABA id
* Permissions/Authorization errors
* Template structure/component validation alerts

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

### Send message template

Use this endpoint to send a call permission request message template

The following is a simplified sample of the send template message request, however you can [learn more about how to send message templates here.](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)

#### Request syntax

```https
POST/<PHONE_NUMBER_ID>/messages
```

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_String_ | **Required**<br><br>The business phone number which you are sending a message from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api) | `+18762639988` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+13287759822", // The WhatsApp user who will receive the template message
  "recipient": "US.13491208655302741918",
  "type": "template",
  "template": {
    "name": "sample_cpr_template", // The call permission request template name
    "language": {
      "code": "en"
    },
    "components": [ // Body text parameters such as customer name and order number
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "text": "John Smith"
          },
          {
            "type": "text",
            "text": "order #1522"
          }
        ]
      }
    ]
  }
}
```

[Learn more about sending template messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)

**Note:** **Usernames and business-scoped user IDs:** When sending a call permission request template message, you can use the `recipient` field to identify the user by BSUID instead of a phone number; the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## Get current call permission state

Use this endpoint to get the call permission state for a business phone number with a single WhatsApp user. You can identify the user by their phone number (`user_wa_id`) or by their business-scoped user ID (`recipient`).

### Request syntax

```https
GET /<PHONE_NUMBER_ID>/call_permissions?user_wa_id=<CONSUMER_WHATSAPP_ID>
```

Or, using a BSUID:

```https
GET /<PHONE_NUMBER_ID>/call_permissions?recipient=<BSUID>
```

### Request parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_String_ | **Required**<br><br>The business phone number you are fetching permissions against.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api) | `+18762639988` |
| `<CONSUMER_WHATSAPP_ID>`<br><br>_Integer_ | **Required** (unless `recipient` is provided)<br><br>The phone number of the WhatsApp user who you are requesting call permissions from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api) | `+13057765456` |
| `recipient`<br><br>_String_ | **Optional**<br><br>The business-scoped user ID (BSUID) or parent BSUID of the WhatsApp user. Use this instead of `user_wa_id`.<br><br>[Learn more about business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) | `US.13491208655302741918` |

#### Response body

```https
{
  "messaging_product": "whatsapp",
  "permission": {
    "status": "temporary",
    "expiration_time": 1745343479
  },
  "actions": [
    {
      "action_name": "send_call_permission_request",
      "can_perform_action": true,
      "limits": [
        {
          "time_period": "PT24H",
          "max_allowed": 1,
          "current_usage": 0,
        },
        {
          "time_period": "P7D",
          "max_allowed": 2,
          "current_usage": 1,
        }
      ]
    },
    {
      "action_name": "start_call",
      "can_perform_action": false,
      "limits": [
        {
          "time_period": "PT24H",
          "max_allowed": 5,
          "current_usage": 5,
          "limit_expiration_time": 1745622600,
        }
      ]
    }
  ]
}
```

#### Response parameters

| Parameter | Description |
| --- | --- |
| `permission`<br><br>_JSON Object_ | The permission object contains two values:<br><br>`status` _(String)_ — The current status of the permission.<br><br>Can be either:<br><br>* `"no_permission"`<br>* `"temporary"`<br>* `"permanent"`<br><br>`expiration` _(Integer)_ — The Unix time at which the permission will expire in UTC timezone.<br><br>If the permission is permanent, this field won't be present. |
| `actions`<br><br>_JSON Object_ | A list of actions a business phone number may undertake to facilitate a call permission or a business initiated call.<br><br>Current actions are:<br><br>`send_call_permission_request`: Represents the action of sending new call permissions request messages to the WhatsApp user.<br><br>`start_call`: Represents the action of establishing a new call with the WhatsApp user. Establishing a new call means that the call was successfully picked up by the WhatsApp user.<br><br>For example, `send_call_permission_request` having a `can_perform_action` of `true` means that your business can send a call permission request to the WhatsApp user in question.<br><br>`can_perform_action` (_Boolean_) —<br><br>A flag indicating whether the action can be performed now, taking into account all limits. |
| `limits`<br><br>_JSON Object_ | A list of time-bound restrictions for the given `action_name`.<br><br>Each `action_name` has 1 or more restrictions depending on the timeframe.<br><br>For example, a business can only send 2 permission requests in a 24-hour period.<br><br>`limits` contains the following fields:<br><br>`time_period` (_String_) — The span of time in which the limit applies, represented in the ISO 8601 format.<br><br>`max_allowed` (_Integer_) — The maximum number of actions allowed within the specified time period.<br><br>`current_usage` (_Integer_) — The current number of actions the business has taken within the specified time period.<br><br>`limit_expiration_time` (_Integer_) — The Unix time at which the limit will expire in UTC timezone.<br><br>If `current_usage` is under the max allowed for the limit, this field won't be present. |

#### Error response

Possible errors that can occur:

* Invalid `phone-number-id`
* If the WhatsApp user phone number is uncallable, the API returns `no_permission`.
* Permissions/Authorization errors.
* Rate limit reached. A maximum of 100 requests in a 1 second window can be made to the API.
* Calling is not enabled for the business phone number.

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

**Note:** **Usernames and business-scoped user IDs:** When querying call permission state, you can use the `recipient` parameter to identify the user by BSUID instead of a phone number; the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## User call permission reply webhook

WhatsApp delivers this webhook whenever a user selects or updates their calling permissions. The webhook could be in response to a call permission request sent by the business, or the user could be proactively making a decision.

The webhook fields values change depending on the circumstances of the user permission decision:

* the user accepts or rejects the request
* the user approves permission by responding to a request or by calling the business
* the user permission is an automatic callback permission in response to a user-initiated call
* the user permission is automatically revoked in response to 4 consecutive unanswered business-initiated calls

Lastly, the user can grant permanent calling permission to the business, which is represented in the `is_permanent` parameter.

**Note:** No webhook is sent when a temporary permission expires. The `expiration_timestamp` field included in the accepted permission webhook indicates the time this permission will expire. Alternatively the current permission state can be queried from the [get current call permission state](#get-current-call-permission-state) endpoint.

#### Webhook sample

```https
{
. . .

"messages": [{
    "from": "{customer_phone_number}",
    "from_user_id": "<BSUID>",
    "from_parent_user_id": "<PARENT_BSUID>",
    "id": "wamid.sH0kFlaCGg0xcvZbgmg90lHrg2dL",
    "timestamp": "{timestamp}",
    "context": {
          "from": "{customer_phone_number}",
          "id": "wamid.gBGGFlaCmZ9plHrf2Mh-o"
    },
    "interactive": {
       "type":  "call_permission_reply",
        "call_permission_reply": {
            "response":"accept",
            "is_permanent":false,
            "expiration_timestamp": "{timestamp}",
            "response_source": "user_action"
       }
    }
 ],
. . .
}
```

#### Webhook values

| Placeholder | Description |
| --- | --- |
| `customer_phone_number`<br><br>_String_ | The phone number of the WhatsApp user. May be omitted if the user has adopted a username and the phone number cannot be included. |
| `from_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user. |
| `from_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `context.id`<br><br>_String_ | Can be either of two values<br><br>* Message ID of the permission request message sent by the business to the WhatsApp user. Shows when a permission decision is made by the user in response to a call permission request.<br>* Call ID of the missed call placed by the business to the WhatsApp user. Shows when callback permission is enabled in settings and the user calls the business. |
| `response`<br><br>_String_ | The WhatsApp user's response to the call permission request message<br><br>Can be `accept` or `reject` |
| `is_permanent`<br><br>_Boolean_ | Indicates if the permission is permanent or not. For temporary permission this will always be false. |
| `expiration_timestamp`<br><br>_String_ | Time in seconds when this call permission expires if the WhatsApp user approved it |
| `response_source`<br><br>_String_ | The source of this permission<br><br>Possible values for accepted call permissions are:<br><br>* `user_action`: User approved or rejected the permission<br>* `automatic`: An automatic permission approval due to the WhatsApp user initiating the call |

**Note:** **Usernames and business-scoped user IDs:** Call permission reply webhooks may include `from_user_id` and `from_parent_user_id` to identify the user by BSUID; the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### Webhook sample scenarios

| Scenario | Webhook sample |
| --- | --- |
| The WhatsApp user approves a temporary call permission from a call permission request message | ```https
{
. . .

"messages": [{
    "from": "{customer_phone_number}",
    "from_user_id": "<BSUID>",
    "from_parent_user_id": "<PARENT_BSUID>",
    "id": "wamid.sH0kFlaCGg0xcvZbgmg90lHrg2dL",
    "timestamp": "1767168000",
    "context": {
          "from": "{customer_phone_number}",
          "id": "wamid.gBGGFlaCmZ9plHrf2Mh-o"
    },
    "interactive": {
       "type":  "call_permission_reply",
        "call_permission_reply": {
            "response":"accept",
            "is_permanent":false,
            "expiration_timestamp": "1768550400",
            "response_source": "user_action"
       }
    }
 ],
. . .
}
``` |
| The WhatsApp user approves a permanent call permission from a call permission request message | ```https
{
. . .

"messages": [{
    "from": "{customer_phone_number}",
    "from_user_id": "<BSUID>",
    "from_parent_user_id": "<PARENT_BSUID>",
    "id": "wamid.sH0kFlaCGg0xcvZbgmg90lHrg2dL",
    "timestamp": "1767168000",
    "context": {
          "from": "{customer_phone_number}",
          "id": "wamid.gBGGFlaCmZ9plHrf2Mh-o"
    },
    "interactive": {
       "type":  "call_permission_reply",
        "call_permission_reply": {
            "response":"accept",
            "is_permanent":true,
            "response_source": "user_action"
       }
    }
 ],
. . .
}
``` |
| The WhatsApp user approves a permanent call permission from the business profile | ```https
{
. . .

"messages": [{
    "from": "{customer_phone_number}",
    "from_user_id": "<BSUID>",
    "from_parent_user_id": "<PARENT_BSUID>",
    "id": "wamid.sH0kFlaCGg0xcvZbgmg90lHrg2dL",
    "timestamp": "1767168000",
    "interactive": {
       "type":  "call_permission_reply",
        "call_permission_reply": {
            "response":"accept",
            "is_permanent":true,
            "response_source": "user_action"
       }
    }
 ],
. . .
}
``` |
| The WhatsApp user rejects a call permission after receiving a call permission request message | ```https
{
. . .

"messages": [{
    "from": "{customer_phone_number}",
    "from_user_id": "<BSUID>",
    "from_parent_user_id": "<PARENT_BSUID>",
    "id": "wamid.sH0kFlaCGg0xcvZbgmg90lHrg2dL",
    "timestamp": "1767168000",
    "context": {
          "from": "{customer_phone_number}",
          "id": "wamid.gBGGFlaCmZ9plHrf2Mh-o"
    },
    "interactive": {
       "type":  "call_permission_reply",
        "call_permission_reply": {
            "response":"reject",
            "response_source": "user_action"
       }
    }
 ],
. . .
}
``` |
| An automatic temporary callback permission is granted to the business when the WhatsApp user calls the business | ```https
{
. . .

"messages": [{
    "from": "{customer_phone_number}",
    "from_user_id": "<BSUID>",
    "from_parent_user_id": "<PARENT_BSUID>",
    "id": "wamid.sH0kFlaCGg0xcvZbgmg90lHrg2dL",
    "timestamp": "1767168000",
    "context": {
          "from": "{customer_phone_number}",
          "id": "wacid.gBGGF4lasdnlasdHrf2Mh-o"
    },
    "interactive": {
       "type":  "call_permission_reply",
        "call_permission_reply": {
            "response":"accept",
            "is_permanent":false,
            "expiration_timestamp": "1768550400",
            "response_source": "automatic"
       }
    }
 ],
. . .
}
``` |
| A call permission is automatically revoked when a business makes 4 consecutive unanswered calls to the WhatsApp user | ```https
{
. . .

"messages": [{
    "from": "{customer_phone_number}",
    "from_user_id": "<BSUID>",
    "from_parent_user_id": "<PARENT_BSUID>",
    "id": "wamid.sH0kFlaCGg0xcvZbgmg90lHrg2dL",
    "timestamp": "1767168000",
    "interactive": {
       "type":  "call_permission_reply",
        "call_permission_reply": {
            "response":"reject",
            "response_source": "automatic"
       }
    }
 ],
. . .
}
``` |
# User-initiated calls



## Overview

The Calling API supports receiving calls made by WhatsApp users to your business.

Your business dictates when calls can be received by [configuring business calling hours and holiday unavailability](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#parameter-details).
**Warning:** **Consumer device eligibility**

Currently, the WhatsApp Business Calling API can accept calls from a consumer's primary and companion iPhone or Android phones.

A **primary device** is the consumer's main device, typically a mobile phone, which holds the authoritative state for the user's account. It has full access to messaging history and core functionalities. There is exactly one primary device per user account at any given time.

**Companion devices** are additional devices registered to the user's account that can operate alongside the primary device. Examples include web clients, desktop apps, tablets, and smart glasses. Companion devices have access to some or all messaging history and core features but are limited compared to the primary device. For Cloud API Calling, **only iPhone and Android phone companion devices are supported for user-initiated calls**.

**Callback permission functionality on companion devices**

For businesses that have the [callback setting](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#configure-update-business-phone-number-calling-settings) enabled, this functionality is not supported on companion devices yet.

## Prerequisites

Before you get started with user-initiated calling, ensure that:

* [Subscribe](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks) to the **calls** webhook field
* [Enable Calling API features on your business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings)

### Call sequence diagram

## User-initiated calling flow

### Part 1: A WhatsApp user calls your business from their client app

When a WhatsApp user calls your business, a Call Connect webhook will be triggered with an `SDP Offer`:

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "366634483210360", // WhatsApp Business Account ID associated with the business phone number
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": { // ID and display number for the business phone number placing the call (caller)
              "phone_number_id": "436666719526789",
              "display_phone_number": "13175551399",
            },
            "contacts": [
              {
                "profile": {
                  "name": "<USER_DISPLAY_NAME>",
                  "username": "<USERNAME>"
                },
                "wa_id": "<USER_PHONE_NUMBER>",
                "user_id": "<BSUID>",
                "parent_user_id": "<PARENT_BSUID>"
              }
            ],
            "calls": [
              {
                "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh", // The WhatsApp call ID
                "to": "16315553601", // The WhatsApp user's phone number (callee)
                "from": "13175551399",
                "from_user_id": "<BSUID>",
                "from_parent_user_id": "<PARENT_BSUID>",
                "event": "connect",
                "timestamp": "1671644824",
                "session": {
                  "sdp_type": "offer",
                  "sdp": "<<RFC 8866 SDP>>"
                }
              }
            ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

**Note:** **Usernames and business-scoped user IDs:** The Call Connect webhook may include `from_user_id`, `from_parent_user_id`, and contact-level `user_id`, `parent_user_id`, and `username` fields, and the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

### Part 2: Your business pre-accepts the call (recommended)

When you pre-accept an inbound call, you allow the calling media connection to be established before attempting to send call media through the connection.

Pre-accepting calls is recommended because it facilitates faster connection times and avoids [audio clipping issues](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting#audio-clipping-issue-and-solution).

To pre-accept, use the [Calls API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api) with the `call_id` from the previous webhook, an `action` of `pre-accept`, and an `SDP Answer`:

```https
POST <PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "pre_accept",
  "session": {
     "sdp_type": "answer"
     "sdp": "<<RFC 8866 SDP>>"
  }
}
```

If there are no errors, you'll receive a success response:

```https
{
  "success" : true
}
```

### Part 3: Your business accepts the call after the WebRTC connection is made

Once the WebRTC connection is made on your end, you can accept the call.

Once you accept the call, wait until you receive a `200 OK` back from the endpoint. Media will begin flowing immediately since the connection was established prior to call connect.

Use the [Calls API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api) with the following request body to accept the call:

```https
POST <PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "accept",
  "session" : {
      "sdp_type" : "answer",
      "sdp" : "<<RFC 8866 SDP>>"
   },
}
```

### Part 4: Your business or the WhatsApp user terminates the call

Either the business or the WhatsApp user can terminate the call at any time.

Use the [Calls API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api) with the following request body to terminate the call:

```https
POST <PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action" : "terminate"
}
```

If there are no errors, you'll receive a success response:

```https
{
  "success" : true
}
```

When either the business or the WhatsApp user terminates the call, you receive a Call Terminate webhook:

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "366634483210360", // WhatsApp Business Account ID associated with the business phone number
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": { // ID and display number for the business phone number placing the call (caller)
              "phone_number_id": "436666719526789"
              "display_phone_number": "13175551399",

            },
            "contacts": [
              {
                "profile": {
                  "name": "<USER_DISPLAY_NAME>",
                  "username": "<USERNAME>"
                },
                "wa_id": "<USER_PHONE_NUMBER>",
                "user_id": "<BSUID>",
                "parent_user_id": "<PARENT_BSUID>"
              }
            ],
            "calls": [
              {
                "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
                "to": "16315553601", // The WhatsApp user's phone number (callee)
                "from": "13175551399", // The business phone number placing the call (caller)
                "from_user_id": "<BSUID>",
                "from_parent_user_id": "<PARENT_BSUID>",
                "event": "terminate",
                "direction": "USER_INITIATED",
                "timestamp": "1749197480",
                "status": ["Failed", "Completed"],
                "start_time": "1671644824", // Call start UNIX timestamp
                "end_time": "1671644944", // Call end UNIX timestamp
                "duration": 480 // Call duration in seconds
              }
            ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

**Note:** **Usernames and business-scoped user IDs:** The Call Terminate webhook may include `from_user_id`, `from_parent_user_id`, and contact-level `user_id`, `parent_user_id`, and `username` fields, and the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## Endpoints for user-initiated calling

### Pre-accept call

When you pre-accept an inbound call, you allow the calling media connection to be established before attempting to send call media through the connection.

When you then call the accept call endpoint, media begins flowing immediately since the connection has already been established.

Pre-accepting calls is recommended because it facilitates faster connection times and avoids [audio clipping issues](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting#audio-clipping-issue-and-solution).

There is about 30 to 60 seconds after the [Call Connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-connect-webhook) is sent for the business to accept the phone call. If the business does not respond, the call is terminated on the WhatsApp user side with a "Not Answered" notification and a [Terminate Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-terminate-webhook) is delivered back to you.

**Warning:** **Note:** Since the WebRTC connection is established before calling the [Accept Call endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#accept-call), make sure to flow the call media only after you receive a 200 OK response back.

If call media flows too early, the caller will miss the first few words of the call. If call media flows too late, callers will hear silence.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are using Calling API features from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "pre_accept",
  "session" : {
      "sdp_type" : "answer",
      "sdp" : "<<RFC 8866 SDP>>"
   }
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Optional**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"pre_accept"` |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#sdp-overview-and-sample-sdp-structures) | ```https
"session" :
{
"sdp_type" : "offer",
"sdp" : "<<RFC 8866 SDP>>"
}
``` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call-id`
* Invalid `phone-number-id`
* Error related to your payment method
* Invalid Connection info, for example, SDP, or ICE
* Accept/Reject an already In Progress/Completed/Failed call
* Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

### Accept call

Use this endpoint to connect to a call by providing a call agent's SDP.

You have about 30 to 60 seconds after the [Call Connect Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-connect-webhook) is sent to accept the phone call. If your business does not respond, the call is terminated on the WhatsApp user side with a "Not Answered" notification and a [Terminate Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-terminate-webhook) is delivered back to you.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are using Calling API features from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "accept",
  "session" : {
      "sdp_type" : "answer",
      "sdp" : "<<RFC 8866 SDP>>"
   },
   "biz_opaque_callback_data": "random_string"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Optional**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"accept"` |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#sdp-overview-and-sample-sdp-structures) | ```https
"session" :
{
"sdp_type" : "offer",
"sdp" : "<<RFC 8866 SDP>>"
}
``` |
| `biz_opaque_callback_data`<br><br>_String_ | **Optional**<br><br>An arbitrary string you can pass in that is useful for tracking and logging purposes.<br><br>Any app subscribed to the "calls" webhook field on your WhatsApp Business account can receive this string, as it is included in the `calls` object within the subsequent [Terminate webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-terminate-webhook) payload.<br><br>Cloud API does not process this field, it just returns it as part of the [Terminate webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-terminate-webhook).<br><br>Maximum 512 characters | `"8huas8d80nn"` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call-id`
* Invalid `phone-number-id`
* Error related to your payment method
* Invalid Connection info, for example, SDP, or ICE
* Accept/Reject an already In Progress/Completed/Failed call
* Permissions/Authorization errors
* SDP answer provided in accept does not match the SDP answer given in the [Pre-Accept endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#pre-accept-call) for the same `call-id`

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

### Reject call

Use this endpoint to reject a call.

You have about 30 to 60 seconds after the [Call Connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-connect-webhook) is sent to accept the phone call. If the business does not respond, the call is terminated on the WhatsApp user side with a "Not Answered" notification and a [Terminate Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-terminate-webhook) is delivered back to you.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are using Calling API features from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "reject"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Optional**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"reject"` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call-id`
* Invalid `phone-number-id`
* Accept/Reject an already In Progress/Completed/Failed call
* Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

### Terminate call

Use this endpoint to terminate an active call.

This must be done even if there is an `RTCP BYE` packet in the media path. Ending the call this way also ensures pricing is more accurate.

When the WhatsApp user terminates the call, you do not have to call this endpoint. Once the call is successfully terminated, a [Call Terminate Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-terminate-webhook) will be sent to you.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are using Calling API features from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "terminate"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Optional**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"terminate"` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call-id`
* Invalid `phone-number-id`
* Accept/Reject an already In Progress/Completed/Failed call
* Reject call is already in progress
* Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Webhooks for user-initiated calling

With all Calling API webhooks, there is a `"calls"` object inside the `"value"` object of the webhook response. The `"calls"` object contains metadata about the call that is used to action on each call received by your business.

To receive Calling API webhooks, subscribe to the calls webhook field.

[Learn more about Cloud API webhooks here](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)

### Call Connect webhook

A webhook notification is sent in near real-time when a call initiated by your business is ready to be connected to the WhatsApp user (an `SDP Answer`).

Critically, the webhook contains information required to establish a call connection via WebRTC.

Once you receive the Call Connect webhook, you can apply the `SDP Answer` received in the webhook to your WebRTC stack in order to initiate the media connection.

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "16315553601",
              "phone_number_id": "<PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<USER_DISPLAY_NAME>",
                  "username": "<USERNAME>"
                },
                "wa_id": "16315553602",
                "user_id": "<BSUID>",
                "parent_user_id": "<PARENT_BSUID>"
              }
            ],
            "calls": [
              {
                "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
                "to": "16315553601",
                "from": "16315553602",
                "from_user_id": "<BSUID>",
                "from_parent_user_id": "<PARENT_BSUID>",
                "event": "connect",
                "timestamp": "1671644824",
                "direction": "USER_INITIATED",
                "deeplink_payload": "deeplink_payload",
                "cta_payload": "cta_payload",
                "session": {
                  "sdp_type": "offer",
                  "sdp": "<<RFC 8866 SDP>>"
                }
              }
            ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

#### Webhook values for `"calls"`

| Placeholder | Description |
| --- | --- |
| `id`<br><br>_String_ | A unique ID for the call |
| `to`<br><br>_String_ | The number being called (callee) |
| `from`<br><br>_String_ | The number of the caller. May be omitted if the user has adopted a username and the phone number cannot be included. |
| `from_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user. |
| `from_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `event`<br><br>_String_ | The calling event that this webhook is notifying the subscriber of |
| `timestamp`<br><br>_String_ | The UNIX timestamp of the webhook event |
| `direction`<br><br>_String_ | The direction of the call being made.<br><br>Can contain either:<br><br>`BUSINESS_INITIATED`, for calls initiated by your business.<br><br>`USER_INITIATED`, for calls initiated by a WhatsApp user. |
| `deeplink_payload`<br><br>_String_ | Arbitrary string specified in `biz_payload` query param on a call deeplink. Will only be returned if call was initiated from a deeplink with such param.<br><br>See [Call Button Messages and Deep Links<br>](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#send-payload-data-in-call-deeplink) for more details. |
| `cta_payload`<br><br>_String_ | Arbitrary string specified in `payload` field on a call button. Will only be returned if call was initiated from a call button with payload.<br><br>See [Call Button Messages and Deep Links<br>](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#send-interactive-message-with-a-whatsapp-call-button) for more details. |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#sdp-overview-and-sample-sdp-structures) |
| `contacts`<br><br>_JSON object_ | Profile information of the user.<br><br>Contains the following values:<br><br>`profile.name` — The WhatsApp profile name of the user.<br><br>`profile.username` — **Optional.** The username of the user, if the user has adopted a username.<br><br>`wa_id` — The WhatsApp ID of the user. May be omitted if the user has adopted a username and the phone number cannot be included.<br><br>`user_id` — The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user.<br><br>`parent_user_id` — **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |

**Note:** **Usernames and business-scoped user IDs:** The Call Connect webhook may include `from_user_id`, `from_parent_user_id`, and contact-level `user_id`, `parent_user_id`, and `username` fields, and the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

### Call Terminate webhook

A webhook notification is sent whenever the call has been terminated for any reason, such as when the WhatsApp user hangs up, or when the business uses the [Calls API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api) with an action of `terminate` or `reject`.

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
              "messaging_product": "whatsapp",
              "metadata": {
                   "display_phone_number": "16505553602",
                   "phone_number_id": "<PHONE_NUMBER_ID>",
              },
               "contacts": [
                {
                    "profile": {
                        "name": "<USER_DISPLAY_NAME>",
                        "username": "<USERNAME>"
                    },
                    "wa_id": "16315553602",
                    "user_id": "<BSUID>",
                    "parent_user_id": "<PARENT_BSUID>"
                }
              ],
               "calls": [
                {
                    "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
                    "to": "16315553601",
                    "from": "16315553602",
                    "from_user_id": "<BSUID>",
                    "from_parent_user_id": "<PARENT_BSUID>",
                    "event": "terminate"
                    "direction": "USER_INITIATED",
                    "deeplink_payload": "deeplink_payload",
                    "cta_payload": "cta_payload",
                    "biz_opaque_callback_data": "random_string",
                    "timestamp": "1671644824",
                    "status" : [FAILED | COMPLETED],
                    "start_time" : "1671644824",
                    "end_time" : "1671644944",
                    "duration" : 120
                }
              ],
              "errors": [
                {
                    "code": INT_CODE,
                    "message": "ERROR_TITLE",
                    "href": "ERROR_HREF",
                    "error_data": {
                        "details": "ERROR_DETAILS"
                    }
                }
              ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

#### Webhook values for `"calls"`

| Placeholder | Description |
| --- | --- |
| `id`<br><br>_String_ | A unique ID for the call |
| `to`<br><br>_String_ | The number being called (callee) |
| `from`<br><br>_String_ | The number of the caller. May be omitted if the user has adopted a username and the phone number cannot be included. |
| `from_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user. |
| `from_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `event`<br><br>_String_ | The calling event that this webhook is notifying the subscriber of |
| `timestamp`<br><br>_String_ | The UNIX timestamp of the webhook event |
| `direction`<br><br>_String_ | The direction of the call being made.<br><br>Can contain either:<br><br>`BUSINESS_INITIATED`, for calls initiated by your business.<br><br>`USER_INITIATED`, for calls initiated by a WhatsApp user. |
| `deeplink_payload`<br><br>_String_ | Arbitrary string specified in `biz_payload` query param on a call deeplink. Will only be returned if call was initiated from a deeplink with such param.<br><br>See [Call Button Messages and Deep Links<br>](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#send-payload-data-in-call-deeplink) for more details. |
| `cta_payload`<br><br>_String_ | Arbitrary string specified in `payload` field on a call button. Will only be returned if call was initiated from a call button with payload.<br><br>See [Call Button Messages and Deep Links<br>](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#send-interactive-message-with-a-whatsapp-call-button) for more details. |
| `start_time`<br><br>_String_ | The UNIX timestamp of when the call started.<br><br>Only present when the call was picked up by the other party. |
| `end_time`<br><br>_String_ | The UNIX timestamp of when the call ended.<br><br>Only present when the call was picked up by the other party. |
| `duration`<br><br>_Integer_ | Duration of the call in seconds.<br><br>Only present when the call was picked up by the other party. |
| `biz_opaque_callback_data`<br><br>_String_ | Arbitrary string your business passes into the call for tracking and logging purposes.<br><br>Will only be returned if provided through an [Initiate Call request](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#initiate-call) or [Accept Call request](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#accept-call) |
| `errors.code`<br><br>_Integer_ | The `errors` object is present only for failed calls when there is error information available. Code is one of the [calling error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting#calling-error-codes) |
| `contacts`<br><br>_JSON object_ | Profile information of the user.<br><br>Contains the following values:<br><br>`profile.name` — The WhatsApp profile name of the user.<br><br>`profile.username` — **Optional.** The username of the user, if the user has adopted a username.<br><br>`wa_id` — The WhatsApp ID of the user. May be omitted if the user has adopted a username and the phone number cannot be included.<br><br>`user_id` — The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user.<br><br>`parent_user_id` — **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |

**Note:** **Usernames and business-scoped user IDs:** The Call Terminate webhook may include `from_user_id`, `from_parent_user_id`, and contact-level `user_id`, `parent_user_id`, and `username` fields, and the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## Dual tone multi frequency (DTMF) support

**Warning:** **The dialpad provided by the Calling API only supports DTMF use cases.**

It does not support consumer-to-consumer calls and does not change any other calling behaviors. For example, the dialpad cannot be used to dial a number and initiate a call or message on WhatsApp.

WhatsApp Business Calling API supports DTMF tones, with the intention to enable Solution Partner applications to support IVR-based systems.

WhatsApp users can press tone buttons on their client app and these DTMF tones are injected into the WebRTC RTP stream established as a part of the VoIP connection.

Our WebRTC stream conforms to [RFC 4733](https://datatracker.ietf.org/doc/html/rfc4733) for the transfer of DTMF Digits via RTP Payload.

There is no webhook for conveying DTMF digits.

### DTMF clock rate

Only 8000 clock rate is supported in our SDPs. For user-initiated calls, our SDP offer includes only 8000 clock rate. For business-initiated calls, your SDP offer should have 8000 clock rate. Even if it is absent, the API still proceeds with 8000 clock rate against payload type 126.

The RTP packets representing DTMF events will use the same timestamp base and sequence number base as the regular audio packets. So you don't have to worry about differing clock rates between audio packets and DTMF packets. The [duration field](https://datatracker.ietf.org/doc/html/rfc4733#section-2.3.5) of the DTMF packet is calculated using 8000 clock units.

The API does not support 48000 clock rate for DTMF.

### Sending DTMF digits on consumer WhatsApp client

WhatsApp client applications are enhanced to have a dialpad for calls with CloudAPI business phone numbers. The WhatsApp user can press the buttons on the dialpad and send DTMF tones.

## SDP overview and sample SDP structures

Session Description Protocol (SDP) is a text-based format used to describe the characteristics of multimedia sessions, such as voice and video calls, in real-time communication applications. SDP provides a standardized way to convey information about the session's media streams, including the type of media, codecs, protocols, and other parameters necessary for establishing and managing the session.

In the context of WebRTC, SDP is used to negotiate the media parameters between the sender and receiver, enabling them to agree on the specifics of the media exchange.

[View SDP sample structures for user-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#sdp-overview-and-sample-sdp-structures)

# Call recording


## Overview

The Calling API can record the audio of business-initiated calls (BIC) and user-initiated calls (UIC) you make through the WhatsApp Business Cloud API. When you opt a call into recording, both participants hear a short legally required announcement before the recording begins. After the call ends, you receive a webhook with a media ID you can use to download the finished recording.

Recording is opt-in on a per-call basis — you decide at the time you initiate or accept each call whether it should be recorded.

Recording and [call transcription](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-transcription/) are independent features. You can enable either one on its own, both together, or neither. They are configured and priced separately, each has its own request object, and each delivers its result in its own webhook event. Enabling recording does not produce a transcript, and enabling transcription does not produce an audio recording. See [Using recording with transcription](#using-recording-with-transcription) for what changes when you enable both on the same call.

## Prerequisites

Before you record a call, make sure:

* Your business phone number has [Calling API enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings).
* Your app is [subscribed to the `calls` webhook field](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks).
* You have obtained an open conversation or [call permission from the WhatsApp user](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions) (for business-initiated calls).

## Enable recording on a business-initiated call

Add a `recording` object to your [business-initiated call request body](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#part-2-your-business-initiates-a-new-call-to-the-whatsapp-user):

```html
POST /<PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "to": "14085551234",
  "recipient": "US.13491208655302741918",
  "action": "connect",
  "session": {
    "sdp_type": "offer",
    "sdp": "<<RFC 8866 SDP>>"
  },
  "recording": {
    "status": "ENABLED",
    "purpose": "quality assurance",
    "announcement_language": "en_US"
  }
}
```

**Note:** **Usernames and business-scoped user IDs:** The `recipient` field lets you identify the WhatsApp user by their BSUID instead of, or in addition to, their phone number in `to`. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## Enable recording on a user-initiated call

Add the same `recording` object when you accept an incoming call:

```html
POST /<PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V",
  "action": "accept",
  "session": {
    "sdp_type": "answer",
    "sdp": "<<RFC 8866 SDP>>"
  },
  "recording": {
    "status": "ENABLED",
    "purpose": "quality assurance",
    "announcement_language": "en_US"
  }
}
```

To accept an incoming call without recording it, either omit the `recording` field entirely or send it with `"status": "DISABLED"`.

## Announcements and consent

Before any audio is recorded, the Calling API mixes a spoken announcement into both your business and the WhatsApp user audio streams. The announcement is generated from the `purpose` string you provide and the `announcement_language` you select, for example:

> _"The audio of this call will be recorded for the following purpose: <your purpose string>."_

The recording starts only after the announcement has finished playing. A participant who does not consent can decline by terminating the call before or during the announcement.

The `purpose` field is mandatory whenever `status` is `ENABLED`. Calls submitted with recording enabled but without a purpose are rejected with a request error.

## `recording` object reference

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | _String_ | Yes | `ENABLED` to record the call, `DISABLED` to explicitly opt out. |
| `purpose` | _String_ | Yes, when `status` is `ENABLED` | The purpose of the recording, spoken to both participants as part of the announcement. Maximum 250 characters. Provide the text in the language you specified in `announcement_language`. |
| `announcement_language` | _String_ | Yes, when `status` is `ENABLED` | Locale code for the language of the spoken announcement, for example `en_US` or `es`. See [Supported announcement languages](#supported-announcement-languages). |

## Supported announcement languages

The following `announcement_language` values have a localized announcement. The Calling API speaks the matching phrase, followed by your `purpose` string, to both participants before recording begins.

| Language | `announcement_language` | Recording announcement |
|---|---|---|
| English | `en` (also `en_US`, `en_AU`, `en_CA`, `en_GB`, `en_IN`, `en_NZ`) | The audio of this call will be recorded for the following purpose: |
| Dutch | `nl` | De audio van dit gesprek wordt voor het volgende doeleinde opgenomen: |
| French | `fr` | L'audio de cet appel sera enregistré aux fins suivantes : |
| German | `de` | Dieser Anruf wird zu folgenden Zwecken aufgezeichnet: |
| Hindi | `hi` | इस कॉल के ऑडियो को इस उद्देश्य के लिए रिकॉर्ड किया जाएगा: |
| Italian | `it` | L'audio di questa chiamata verrà registrato per il seguente scopo: |
| Kannada | `kn` | ಈ ಕರೆಯ ಆಡಿಯೊವನ್ನು ಈ ಕೆಳಗಿನ ಉದ್ದೇಶಕ್ಕಾಗಿ ರೆಕಾರ್ಡ್ ಮಾಡಲಾಗುತ್ತದೆ: |
| Portuguese (Brazil) | `pt` | O áudio desta ligação será gravado para a seguinte finalidade: |
| Spanish (Latin America) | `es` | El audio de esta llamada se grabará con el siguiente propósito: |
| Spanish (Spain) | `es_ES` | El audio de esta llamada se grabará con el fin siguiente: |
| Telugu | `te` | ఈ కాల్ ఆడియో‌ను క్రింది అవసరం కోసం రికార్డ్ చేయడం జరుగుతుంది: |
| Vietnamese | `vi` | Âm thanh của cuộc gọi này sẽ được ghi lại cho mục đích sau: |

## Using recording with transcription

Recording and [transcription](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-transcription/) are fully independent. The `recording` and `transcription` objects are separate request fields, so you choose each one independently on a per-call basis:

* Send only `recording` to receive an audio recording and no transcript.
* Send only `transcription` to receive a transcript and no audio recording.
* Send both objects to receive both an audio recording and a transcript.
* Omit both (or set both to `DISABLED`) to receive neither.

When you enable both on the same call, participants hear a single combined announcement instead of two:

> _"The audio of this call will be recorded and transcribed for the following purpose: <your purpose string>."_

The combined announcement is localized using the same `announcement_language` values as the individual announcements:

| Language | `announcement_language` | Combined announcement |
|---|---|---|
| English | `en` (also `en_US`, `en_AU`, `en_CA`, `en_GB`, `en_IN`, `en_NZ`) | The audio of this call will be recorded and transcribed for the following purpose: |
| Dutch | `nl` | De audio van dit gesprek wordt opgenomen en getranscribeerd voor het volgende doeleinde: |
| French | `fr` | L'audio de cet appel sera enregistré et transcrit aux fins suivantes : |
| German | `de` | Dieser Anruf wird zu folgenden Zwecken aufgezeichnet und transkribiert: |
| Hindi | `hi` | इस कॉल के ऑडियो को इस उद्देश्य के लिए रिकॉर्ड और ट्रांसक्राइब किया जाएगा: |
| Italian | `it` | L'audio di questa chiamata verrà registrato e trascritto per il seguente scopo: |
| Kannada | `kn` | ಈ ಕರೆಯ ಆಡಿಯೋವನ್ನು ರೆಕಾರ್ಡ್ ಮಾಡಲಾಗುತ್ತದೆ ಮತ್ತು ಕೆಳಗಿನ ಉದ್ದೇಶಕ್ಕಾಗಿ ಲಿಪ್ಯಂತರಿಸಲಾಗುತ್ತದೆ: |
| Portuguese (Brazil) | `pt` | O áudio desta ligação será gravado e transcrito para a seguinte finalidade: |
| Spanish (Latin America) | `es` | El audio de esta llamada se grabará y transcribirá con el siguiente propósito: |
| Spanish (Spain) | `es_ES` | El audio de esta llamada se grabará y transcribirá con este fin: |
| Telugu | `te` | ఈ కాల్ ఆడియో క్రింది అవసరం కోసం రికార్డ్ చేసి, ట్రాన్‌స్క్రైబ్ చేయడం జరుగుతుంది: |
| Vietnamese | `vi` | Âm thanh của cuộc gọi này sẽ được ghi âm và chép lời cho mục đích sau: |

When both objects are present, the `announcement_language` and `purpose` from the `recording` object are used for this combined announcement, and the corresponding values in the `transcription` object are ignored. You still receive a separate webhook for each enabled feature: a [`call_recording_available`](#recording-available-webhook) event for the recording and a [`call_transcription_available`](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-transcription/#transcription-available-webhook) event for the transcript.

## Recording-available webhook

After the call ends and post-processing finishes (typically under one minute), the Calling API sends a `call_recording_available` event under the existing `calls` webhook field:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WABA_ID>",
      "changes": [
        {
          "field": "calls",
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>",
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>"
            },
            "calls": [
              {
                "id": "wacid.HBgLMTQxMjYxMzYyNTMVAgASGCBGO...",
                "from": "<USER_PHONE_NUMBER>",
                "from_user_id": "<BSUID>",
                "from_parent_user_id": "<PARENT_BSUID>",
                "timestamp": "1728932177",
                "event": "call_recording_available",
                "call_recording": {
                  "type": "audio",
                  "audio": {
                    "id": "1002764438271669",
                    "sha256": "Y9vvGyeo3n76ptkXu3CwDBsnzbRFqpjHskQdMGSVqas=",
                    "mime_type": "audio/ogg; codecs=opus",
                    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
                  }
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

### `call_recording` fields

| Field | Type | Description |
| --- | --- | --- |
| `type` | _String_ | Media type of the recording. Currently always `audio`. |
| `audio.id` | _String_ | Media asset ID. Use the [Media API](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media) to [retrieve the media URL](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#retrieve-media-url) for download. |
| `audio.sha256` | _String_ | Base64-encoded SHA-256 hash of the recording. Use it to verify the downloaded file's integrity. |
| `audio.mime_type` | _String_ | MIME type of the recording, for example `audio/ogg; codecs=opus`. |
| `audio.url` | _String_ | A short-lived download URL. Issue an authenticated GET request with your access token to download the asset. |

**Note:** **Usernames and business-scoped user IDs:** The `from_user_id` and `from_parent_user_id` fields identify the WhatsApp user by their BSUID; the `from` phone number may be omitted if the user has adopted a username. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## Download the recording

Recordings use the same download flow as [media messages](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#retrieve-media-url):

1. The `url` returned in the webhook is valid for 5 minutes. Issue an authenticated GET request with your access token to download the file directly.
2. If the URL has expired, use the [Media API](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media) to [retrieve a fresh media URL](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#retrieve-media-url) with the `audio.id`.

## Retention

Recordings remain available for download for **7 days** after the `call_recording_available` webhook is delivered. After that period, the media ID expires and the underlying file is deleted. Download and persist the recording to your own storage within the retention window if you need to keep it long-term.

## Errors

The following request errors are specific to call recording. See [Cloud API error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/) for the full list.

| Scenario | Description |
| --- | --- |
| Missing `purpose` | `recording.status` is `ENABLED` but `purpose` is omitted or empty. |
| `purpose` too long | `purpose` exceeds 250 characters. |
| Invalid `announcement_language` | `announcement_language` is not a supported locale code. |
| Invalid `status` | `status` is not one of `ENABLED` or `DISABLED`. |

# Call transcription


## Overview

The Calling API can transcribe the audio of business-initiated calls (BIC) and user-initiated calls (UIC) you make through the WhatsApp Business Cloud API. When you opt a call into transcription, both participants hear a short legally required announcement before transcription begins. After the call ends, you receive a webhook with a media ID you can use to download the finished transcript as a JSON document.

Transcription is opt-in on a per-call basis — you decide at the time you initiate or accept each call whether it should be transcribed.

Transcription and [call recording](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-recording/) are independent features. You can enable either one on its own, both together, or neither. They are configured and priced separately, each has its own request object, and each delivers its result in its own webhook event. Enabling transcription does not produce an audio recording, and enabling recording does not produce a transcript. See [Using transcription with recording](#using-transcription-with-recording) for what changes when you enable both on the same call.

## Prerequisites

Before you transcribe a call, make sure:

* Your business phone number has [Calling API enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings).
* Your app is [subscribed to the `calls` webhook field](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks).
* You have obtained an open conversation or [call permission from the WhatsApp user](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions) (for business-initiated calls).

## Enable transcription on a business-initiated call

Add a `transcription` object to your [business-initiated call request body](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#part-2-your-business-initiates-a-new-call-to-the-whatsapp-user):

```html
POST /<PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "to": "14085551234",
  "recipient": "US.13491208655302741918",
  "action": "connect",
  "session": {
    "sdp_type": "offer",
    "sdp": "<<RFC 8866 SDP>>"
  },
  "transcription": {
    "status": "ENABLED",
    "purpose": "quality assurance",
    "announcement_language": "en_US"
  }
}
```

**Note:** **Usernames and business-scoped user IDs:** The `recipient` field lets you identify the WhatsApp user by their BSUID instead of, or in addition to, their phone number in `to`. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## Enable transcription on a user-initiated call

Add the same `transcription` object when you accept an incoming call:

```html
POST /<PHONE_NUMBER_ID>/calls
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V",
  "action": "accept",
  "session": {
    "sdp_type": "answer",
    "sdp": "<<RFC 8866 SDP>>"
  },
  "transcription": {
    "status": "ENABLED",
    "purpose": "quality assurance",
    "announcement_language": "en_US"
  }
}
```

To accept an incoming call without transcribing it, either omit the `transcription` field entirely or send it with `"status": "DISABLED"`.

## Announcements and consent

Before any audio is transcribed, the Calling API mixes a spoken announcement into both your business and the WhatsApp user audio streams. The announcement is generated from the `purpose` string you provide and the `announcement_language` you select, for example:

> _"The audio of this call will be transcribed for the following purpose: <your purpose string>."_

Transcription starts only after the announcement has finished playing. A participant who does not consent can decline by terminating the call before or during the announcement.

The `purpose` field is mandatory whenever `status` is `ENABLED`. Calls submitted with transcription enabled but without a purpose are rejected with a request error.

## `transcription` object reference

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | _String_ | Yes | `ENABLED` to transcribe the call, `DISABLED` to explicitly opt out. |
| `purpose` | _String_ | Yes, when `status` is `ENABLED` | The purpose of the transcription, spoken to both participants as part of the announcement. Maximum 250 characters. Provide the text in the language you specified in `announcement_language`. |
| `announcement_language` | _String_ | Yes, when `status` is `ENABLED` | Locale code for the language of the spoken announcement, for example `en_US` or `es`. See [Supported announcement languages](#supported-announcement-languages). |

## Supported announcement languages

The following `announcement_language` values have a localized announcement. The Calling API speaks the matching phrase, followed by your `purpose` string, to both participants before transcription begins.

| Language | `announcement_language` | Transcription announcement |
|---|---|---|
| English | `en` (also `en_US`, `en_AU`, `en_CA`, `en_GB`, `en_IN`, `en_NZ`) | The audio of this call will be transcribed for the following purpose: |
| French | `fr` | L'audio de cet appel sera transcrit aux fins suivantes : |
| German | `de` | Dieser Anruf wird zu folgenden Zwecken transkribiert: |
| Hindi | `hi` | इस कॉल के ऑडियो को इस उद्देश्य के लिए ट्रांसक्राइब किया जाएगा: |
| Italian | `it` | L'audio di questa chiamata verrà trascritto per il seguente scopo: |
| Kannada | `kn` | ಈ ಕರೆಯ ಆಡಿಯೋವನ್ನು ಈ ಕೆಳಗಿನ ಉದ್ದೇಶಕ್ಕಾಗಿ ಲಿಪ್ಯಂತರಿಸಲಾಗುತ್ತದೆ: |
| Portuguese (Brazil) | `pt` | O áudio desta ligação será transcrito para a seguinte finalidade: |
| Spanish | `es` | El audio de esta llamada se transcribirá con el siguiente propósito: |
| Telugu | `te` | ఈ కాల్ ఆడియో క్రింది ప్రయోజనం కోసం ట్రాన్‌స్క్రైబ్ చేయడం జరుగుతుంది: |
| Vietnamese | `vi` | Âm thanh của cuộc gọi này sẽ được chép lời cho mục đích sau: |

The `announcement_language` field also accepts `nl` and `es_ES`. These values are valid, but until a localized transcription announcement is available they play the English announcement.

## Using transcription with recording

Transcription and [recording](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-recording/) are fully independent. The `transcription` and `recording` objects are separate request fields, so you choose each one independently on a per-call basis:

* Send only `transcription` to receive a transcript and no audio recording.
* Send only `recording` to receive an audio recording and no transcript.
* Send both objects to receive both a transcript and an audio recording.
* Omit both (or set both to `DISABLED`) to receive neither.

When you enable both on the same call, participants hear a single combined announcement instead of two:

> _"The audio of this call will be recorded and transcribed for the following purpose: <your purpose string>."_

When both objects are present, the `announcement_language` and `purpose` from the `recording` object are used for this combined announcement, and the corresponding values in the `transcription` object are ignored. You still receive a separate webhook for each enabled feature: a [`call_recording_available`](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-recording/#recording-available-webhook) event for the recording and a [`call_transcription_available`](#transcription-available-webhook) event for the transcript.

## Transcription-available webhook

After the call ends and post-processing finishes (typically under one minute), the Calling API sends a `call_transcription_available` event under the existing `calls` webhook field:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WABA_ID>",
      "changes": [
        {
          "field": "calls",
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>",
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>"
            },
            "calls": [
              {
                "id": "wacid.HBgLMTQxMjYxMzYyNTMVAgASGCBGO...",
                "from": "<USER_PHONE_NUMBER>",
                "from_user_id": "<BSUID>",
                "from_parent_user_id": "<PARENT_BSUID>",
                "timestamp": "1728932177",
                "event": "call_transcription_available",
                "call_transcript": {
                  "document": {
                    "id": "1002764438271669",
                    "sha256": "Y9vvGyeo3n76ptkXu3CwDBsnzbRFqpjHskQdMGSVqas=",
                    "mime_type": "application/json",
                    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
                  }
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

### `call_transcript` fields

| Field | Type | Description |
| --- | --- | --- |
| `document.id` | _String_ | Media asset ID. Use the [Media API](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media) to [retrieve the media URL](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#retrieve-media-url) for download. |
| `document.sha256` | _String_ | Base64-encoded SHA-256 hash of the transcript document. Use it to verify the downloaded file's integrity. |
| `document.mime_type` | _String_ | MIME type of the transcript document. Currently always `application/json`. |
| `document.url` | _String_ | A short-lived download URL. Issue an authenticated GET request with your access token to download the asset. |

**Note:** **Usernames and business-scoped user IDs:** The `from_user_id` and `from_parent_user_id` fields identify the WhatsApp user by their BSUID; the `from` phone number may be omitted if the user has adopted a username. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

## Transcript language

You do not specify a transcription language in the request. The Calling API automatically detects the spoken language of the call, transcribes it, and reports the detected language in the `transcript.language` field of the transcript document (see [Transcript document format](#transcript-document-format)). This detected language is an ISO 639 language code such as `en` and is determined from the audio — it is independent of the `announcement_language` you set for the spoken announcement.

The set of languages that can be automatically detected and transcribed is evolving constantly as the underlying speech models improve, so this list changes over time. The languages currently supported include:

Afrikaans, Albanian, Arabic, Azerbaijani, Bengali, Bulgarian, Burmese, Cebuano, Chinese, Croatian, Czech, Danish, Dutch, English, Finnish, French, German, Greek, Guarani, Gujarati, Hebrew, Hindi, Hungarian, Indonesian, Italian, Japanese, Javanese, Kannada, Korean, Macedonian, Malay, Malayalam, Marathi, Norwegian, Persian, Polish, Portuguese, Punjabi, Romanian, Russian, Serbian, Sinhala, Slovak, Slovenian, Spanish, Swahili, Swedish, Tagalog (Filipino), Tamil, Telugu, Thai, Turkish, Urdu, and Vietnamese.

If a call is spoken in a language that isn't currently supported, you still receive the `call_transcription_available` webhook, but the returned transcript may be empty.

## Transcript document format

The downloaded transcript is a JSON document with two top-level objects: `metadata` (information about the processed audio) and `transcript` (the transcribed content, including a flat `text` rendering, the detected `language`, an overall `confidence`, and time-stamped `segments` with word-level detail).

Each segment is attributed to the speaker who produced it and the channel it was spoken on — channel `0` is your business and channel `1` is the WhatsApp user — so speaker attribution stays accurate even when participants talk over each other. The full conversation is also available as a single string in `transcript.text`, with each segment prefixed by its speaker label, for example `[Business]` or `[Customer]`.

```json
{
  "metadata": {
    "processed_at": "2026-06-18T20:16:47Z",
    "audio": {
      "duration": 21.76,
      "sample_rate": 16000,
      "channels": 2,
      "audio_format": "stereo"
    }
  },
  "transcript": {
    "text": "[Business] Hello, how about you? [Customer] Hey, I'm good. How are you?",
    "language": "en",
    "duration": 21.76,
    "confidence": 0.83,
    "segments": [
      {
        "id": 1,
        "speaker": "Business",
        "channel": 0,
        "start": 1.16,
        "end": 2.44,
        "text": "Hello, how about you?",
        "confidence": 0.85,
        "words": [
          {
            "word": "Hello,",
            "start": 1.16,
            "end": 1.64,
            "confidence": 0.89,
            "lang": "en"
          },
          {
            "word": "how",
            "start": 1.64,
            "end": 1.8,
            "confidence": 0.99,
            "lang": "en"
          },
          {
            "word": "about",
            "start": 1.8,
            "end": 2.04,
            "confidence": 0.52,
            "lang": "en"
          },
          {
            "word": "you?",
            "start": 2.04,
            "end": 2.44,
            "confidence": 0.99,
            "lang": "en"
          }
        ]
      },
      {
        "id": 2,
        "speaker": "Customer",
        "channel": 1,
        "start": 3.66,
        "end": 5.74,
        "text": "Hey, I'm good. How are you?",
        "confidence": 0.85,
        "words": [
          {
            "word": "Hey,",
            "start": 3.66,
            "end": 4.46,
            "confidence": 0.60,
            "lang": "en"
          },
          {
            "word": "I'm",
            "start": 4.46,
            "end": 4.7,
            "confidence": 0.78,
            "lang": "en"
          },
          {
            "word": "good.",
            "start": 4.7,
            "end": 5.02,
            "confidence": 0.71,
            "lang": "en"
          },
          {
            "word": "How",
            "start": 5.02,
            "end": 5.18,
            "confidence": 0.99,
            "lang": "en"
          },
          {
            "word": "are",
            "start": 5.18,
            "end": 5.34,
            "confidence": 0.99,
            "lang": "en"
          },
          {
            "word": "you?",
            "start": 5.34,
            "end": 5.74,
            "confidence": 0.99,
            "lang": "en"
          }
        ]
      }
    ]
  }
}
```

### `metadata` fields

| Field | Type | Description |
| --- | --- | --- |
| `processed_at` | _String_ | ISO 8601 UTC timestamp of when transcription post-processing completed. |
| `audio.duration` | _Number_ | Duration of the processed call audio, in seconds. |
| `audio.sample_rate` | _Integer_ | Sample rate of the processed audio, in Hz. |
| `audio.channels` | _Integer_ | Number of audio channels. A two-party call has two channels. |
| `audio.audio_format` | _String_ | Format of the processed audio mix, for example `stereo`. |

### `transcript` fields

| Field | Type | Description |
| --- | --- | --- |
| `text` | _String_ | The full conversation as a single string. Each segment is prefixed with its speaker label in brackets, for example `[Business]` or `[Customer]`. |
| `language` | _String_ | The detected language of the call as an ISO 639 code, for example `en`. See [Transcript language](#transcript-language). |
| `duration` | _Number_ | Total duration of the transcribed audio, in seconds. |
| `confidence` | _Number_ | Overall confidence score for the transcript, from `0` to `1`. |
| `segments` | _Array_ | The ordered list of spoken segments. See [`segments` fields](#segments-fields). |

### `segments` fields

Each segment represents a continuous span of speech from one speaker.

| Field | Type | Description |
| --- | --- | --- |
| `id` | _Integer_ | Sequential identifier for the segment within the transcript. |
| `speaker` | _String_ | The speaker who produced the segment, either `Business` or `Customer`. |
| `channel` | _Integer_ | The audio channel the segment was spoken on. Channel `0` is the business; channel `1` is the WhatsApp user. |
| `start` | _Number_ | The start time of the segment, in seconds from the beginning of the call audio. |
| `end` | _Number_ | The end time of the segment, in seconds from the beginning of the call audio. |
| `text` | _String_ | The full transcribed text of the segment. |
| `confidence` | _Number_ | A confidence score from `0` to `1` for the segment transcription. |
| `words` | _Array_ | Word-level breakdown of the segment. Each entry contains `word` (_String_), `start` (_Number_), `end` (_Number_), `confidence` (_Number_), and `lang` (_String_, the ISO 639 code of the detected language for that word), where `start` and `end` are in seconds from the beginning of the call audio. |

## Download the transcript

Transcripts use the same download flow as [media messages](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#retrieve-media-url):

1. The `url` returned in the webhook is valid for 5 minutes. Issue an authenticated GET request with your access token to download the file directly.
2. If the URL has expired, use the [Media API](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media) to [retrieve a fresh media URL](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#retrieve-media-url) with the `document.id`.

## Retention

Transcripts remain available for download for **7 days** after the `call_transcription_available` webhook is delivered. After that period, the media ID expires and the underlying file is deleted. Download and persist the transcript to your own storage within the retention window if you need to keep it long-term.

## Errors

The following request errors are specific to call transcription. See [Cloud API error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/) for the full list.

| Scenario | Description |
| --- | --- |
| Missing `purpose` | `transcription.status` is `ENABLED` but `purpose` is omitted or empty. |
| `purpose` too long | `purpose` exceeds 250 characters. |
| Invalid `announcement_language` | `announcement_language` is not a supported locale code. |
| Invalid `status` | `status` is not one of `ENABLED` or `DISABLED`. |

# SIP Configuration Guide - WhatsApp Business Calling



**Warning:** When SIP is enabled, you **cannot use calling-related Graph API endpoints**. By default, **calling-related webhooks are not sent**, but you can enable webhook delivery for SIP calls to receive call lifecycle events.

## Overview

Session Initiation Protocol ([SIP](https://datatracker.ietf.org/doc/html/rfc3261)) is a signaling protocol used for initiating, maintaining, modifying, and terminating real-time communication sessions between two or more endpoints.

WhatsApp Business Calling API supports use of SIP as the signaling protocol instead of our Graph API endpoints.

### Before you get started

Before you get started with SIP call signaling, confirm the following:

* You meet overall [calling prerequisites](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling#step-1--prerequisites).
* Your app has messaging permissions for the business phone number you want to enable SIP for.
  * Test this by sending and receiving messages using Graph API messaging endpoints, then use the same app to configure your SIP server on the business phone number for calling.
  * Verify this by using the [health status API](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status) with `PHONE_NUMBER_ID`.
* Your app mode is "Live", not "Development".
* You have a standards-compliant third-party SIP server that supports [TLS](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#security) transport and digest authentication.

See [Signaling and media possible configurations](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling#signaling-and-media-possible-configurations) for more info.

## Calling flows using SIP

Before you start, make sure you have [enabled and configured SIP on the business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-update-sip-settings-on-business-phone-number). Meta generates a unique SIP user password for each business phone number + app combination. You will need this information and can retrieve it by using the [get Call Settings endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#get-phone-number-calling-settings--sip-).

### Security

* TLS transport is mandatory for SIP. Meta will present a valid server cert with subject name that covers our SIP domain wa.meta.vc.
Your SIP server should do the same as Meta ensures your cert is valid and subject name covers SIP domain you configured on the business phone number.
  * Meta does NOT support mutual TLS (aka mTLS). This means, when Meta takes the role of a TLS client, your TLS server should not request Client certificate. If you still request client cert, Meta will present a client certificate. However, the cert subject name would refer to a random dynamic host which will not pass certificate validation.
  * Meta adds `transport=TLS` to request URI as part of its SIP requests to your SIP server.
* For business initiated calls, SIP invite from your SIP server will be challenged using digest auth. See [business-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#business-initiated-calls) for more details.
* For user-initiated calls, we strongly recommend that you challenge the SIP INVITE request from Meta with digest auth for added security. See [user-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#user-initiated-calls) for more details.

### How to test if you have a valid TLS certificate

When a WhatsApp user calls a business, a common reason for your SIP server to **not** receive the SIP INVITE from Meta is the certificate validation error. You can use information here to confirm valid setup.

Run the command `openssl s_client -quiet -verify_hostname {hostname} -connect {hostname}:{port}` by properly substituting hostname and port with your values.

#### Example of valid server cert

```
$ openssl s_client -quiet -verify_hostname meta-voip.example.com -connect meta-voip.example.com:5061
Connecting to 64:ff9b::68f8:b0b8
depth=2 C=US, ST=New Jersey, L=Jersey City, O=The USERTRUST Network, CN=USERTrust RSA Certification Authority
verify return:1
depth=1 C=AT, O=ZeroSSL, CN=ZeroSSL RSA Domain Secure Site CA
verify return:1
depth=0 CN=example.com
verify return:1
```

#### Example of hostname:port not listening on TLS

```
openssl s_client -quiet -verify_hostname lb01.voice.usw2.pure.cloud -connect lb01.voice.usw2.pure.cloud:5060
Connecting to 34.211.206.63
009F0DFB01000000:error:0A000126:SSL routines::unexpected eof while reading:ssl/record/rec_layer_s3.c:693:
```

#### Example of invalid cert

```
$ openssl s_client -quiet -verify_hostname meta-inb.byoc.mypurecloud.com -connect meta-inb.byoc.mypurecloud.com:5061
Connecting to 64:ff9b::3652:f1c0
depth=0 jurisdictionC=US, jurisdictionST=California, businessCategory=Private Organization, serialNumber=1515861, C=US, ST=Indiana, L=Indianapolis, O=Genesys Cloud Services, Inc., CN=voice.mypurecloud.com
verify error:num=62:hostname mismatch
verify return:1
depth=2 C=US, O=DigiCert Inc, OU=www.digicert.com, CN=DigiCert High Assurance EV Root CA
verify return:1
depth=1 C=US, O=DigiCert Inc, OU=www.digicert.com, CN=DigiCert SHA2 Extended Validation Server CA
verify return:1
depth=0 jurisdictionC=US, jurisdictionST=California, businessCategory=Private Organization, serialNumber=1515861, C=US, ST=Indiana, L=Indianapolis, O=Genesys Cloud Services, Inc., CN=voice.mypurecloud.com
verify return:1
```

In this case, you can alter the certificate to match your hostname or [change your configured SIP server hostname](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-update-sip-settings-on-business-phone-number) to match your certificate.

### Business-initiated calls

#### Prerequisites

* You have the required call permission approval from the WhatsApp user
  * [Learn how to obtain user calling permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions)
* [Retrieve Meta generated SIP password](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#include-sip-user-password) and configure it on your SIP server, so it can respond to digest authentication challenge from Meta SIP servers

#### Calling flow

1. Send an initial [SIP INVITE](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#business-initiated-calls--with-webrtc-media-) to our servers. Our SIP domain is wa.meta.vc. To initiate a call to WhatsApp user with phone number 11234567890, the SIP request URI should be 'sip:+11234567890@wa.meta.vc;transport=tls'
  * This request fails with a 407 Proxy Authentication Required response.
1. Send a second [SIP INVITE](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#business-initiated-calls--with-webrtc-media-) with proper Authorization header as per [RFC 3261](https://datatracker.ietf.org/doc/html/rfc3261#section-22).
  * The Authorization field's `username` attribute must match the `from` header's user name which is the business phone number
  * The password is generated by Meta and you can retrieve it using [get Call Settings endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#get-phone-number-calling-settings--sip-)
  * The username portion of the from header must be the fully normalized business phone number
  * The domain name of the from header must match the SIP server you configured on the business phone number
  * The `SDP Offer` you include supports ICE, DTLS-SRTP, and OPUS (essentially WebRTC media)
1. Send the [SIP INVITE](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#business-initiated-calls--with-webrtc-media-) to the WhatsApp user number you want to call.

### User-initiated calls

#### Prerequisites

* If you plan to use SIP Digest Auth, [retrieve Meta generated SIP password](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#include-sip-user-password) and configure it on your SIP server, so it can respond to digest authentication challenge from Meta SIP servers

#### Calling flow

1. The WhatsApp user calls business phone number and is unaware of whether the business is using SIP or Graph API. In other words, the user experience is identical.
1. If the business phone number is SIP enabled, Meta sends a [SIP INVITE](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#user-initiated-calls--with-webrtc-media-) to the SIP server [configured on the business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-update-sip-settings-on-business-phone-number).
1. You respond with [SIP digest auth challenge](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#user-initiated-calls-with-digest-auth--with-sdes-media-) (recommended) or [SIP OK](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#user-initiated-calls--with-webrtc-media-) and pass in an SDP answer.

**Warning:** If you are not receiving SIP INVITE from Meta, refer to [SIP specific FAQ](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq#session-initiation-protocol--sip--faq) to troubleshoot further

[View sample SIP requests](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#sample-sip-requests)

[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)

[View example SDP structures](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#sdp-overview-and-sample-sdp-structures)

### Custom SIP headers

The following custom SIP headers are common to both business and user initiated calls.

| Header name | Metadata | Description |
| --- | --- | --- |
| x-wa-meta-call-duration | Optional; String | Call duration in seconds. This is present on SIP BYE requests from Meta for termination of an established call. |
| x-wa-meta-wacid | Optional; String | WhatsApp call ID. This is present on SIP INVITE request from Meta for a user-initiated call and SIP BYE requests from Meta for termination of an established call. |
| x-wa-meta-user-id | Optional; String | The WhatsApp user's business-scoped user ID (BSUID). Present on SIP messages from Meta (INVITE, 200 OK, BYE) when the business has BSUIDs enabled. See [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id). |
| x-wa-meta-parent-user-id | Optional; String | The WhatsApp user's parent BSUID, if parent BSUIDs are enabled for the business; otherwise omitted. See [Parent business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids). |
| x-wa-meta-username | Optional; String | The WhatsApp user's username, if they have adopted one; otherwise omitted. |

The following custom SIP headers are specific to user-initiated calls.

| Header name | Metadata | Description |
| --- | --- | --- |
| x-wa-meta-cta-payload | Optional; String | Present when user-initiates a call from call button that has business specified payload. [Learn more](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#send-interactive-message-with-a-whatsapp-call-button) |
| x-wa-meta-deeplink-payload | Optional; String | Present when user-initiates a call from call deeplink that has business specified payload. [Learn more](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#send-payload-data-in-call-deeplink) |

## Configure or update SIP settings on business phone number

Use this endpoint to update call settings configuration for an individual business phone number.

### Request syntax

```html
POST /<PHONE_NUMBER_ID>/settings
```

### Endpoint parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number for which you are updating Calling API settings.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

### Request body

```html
{
  "calling": {
    ... // other calling api settings
    "sip": {
      "status": "ENABLED",
      "webhook_delivery": "ENABLED",
      "servers": [
        {
          "hostname": SIP_SERVER_HOSTNAME
          "port": SIP_SERVER_PORT,
          "request_uri_user_params": {
            "KEY1": "VALUE1", // for cases like trunk groups (tgrp)
            "KEY2": "VALUE2",
          }
        }
      ]
    }
  },
  // Other non calling api feature configurations
}
```

### Body parameters

| Parameter | Description |
| --- | --- |
| `status`<br><br>_String_ | **Optional**<br><br>Enable or disable SIP call signaling for the given business phone number.<br><br>Default is `DISABLED`.<br><br>When `status` is `ENABLED`, this phone number exclusively uses SIP for call signaling and will not work with Graph APIs.<br><br>When `status` is set to `DISABLED`, the SIP `servers` values are not reset.<br><br>If you enable SIP on the same phone number again, the previously configured `servers` values will take effect.<br><br>You can configure both status and SIP servers in the same request. |
| `webhook_delivery`<br><br>_String_ | **Optional**<br><br>Enable or disable webhook delivery for SIP calls.<br><br>Default is `DISABLED`.<br><br>When set to `ENABLED`, SIP call lifecycle webhooks (`call_created` and `terminate`) will be sent to your configured webhook endpoint. This can allow your messaging subsystem to be aware of ongoing call events without your SIP infrastructure sharing that information directly.<br><br>Only applicable when `status` is `ENABLED`.<br><br>See [SIP Call Webhooks](#sip-call-webhooks) for details. |
| `servers`<br><br>_String_ | **Optional**<br><br>The SIP server routing configuration.<br><br>Each phone number can have only one SIP server configured. The `servers` field is an array for forward compatibility.<br><br>Meta previously allowed multiple apps each with their own SIP server but this setup will not work because Meta will terminate the call after receiving BYE from any of the SIP servers.<br><br>In the GET payload, if you see multiple SIP servers, it means you've used the POST API with different access tokens that belong to different apps.<br><br>The associated app is extracted from the access token used to make the API call.<br><br>To delete a previously configured SIP server, pass an empty array to this field. If you still see some servers remaining after you clear, those servers may belong to different apps, so you need to use the corresponding access tokens to clear them.<br><br>Note that at least one SIP server of any app must exist when SIP status is ENABLED. To clear servers for all applications being used with a business phone number, the SIP status should be DISABLED.<br><br>`hostname` — (_String_) **Required**<br><br>The host name of the SIP server.<br><br>Requests must use TLS.<br><br>`port` — (_String_) **Required**<br><br>The port within your SIP server that will accept requests.<br><br>Requests must use TLS.<br><br>Default port is 5061.<br><br>`request_uri_user_params` — (_String_) **Optional**<br><br>An optional field for passing any parameters you want included in the user portion of the request URI used in our SIP INVITE to your SIP server.<br><br>Max key/value size is 128 characters.<br><br>An example use case would be Trunk Groups ([RFC 4904](https://datatracker.ietf.org/doc/html/rfc4904)).<br><br>* sip:+1234567890@sip.example.com<br>* tgrp=wacall<br>* trunk-context=byoc.example.com<br><br>This example has two user parameters for tgrp, and trunk-context.<br><br>The effective SIP request URI line for this would be `sip:+1234567890;tgrp=wacall;trunk-context=byoc.example.com@sip.example.com` |

### Success response

```html
{
  "success": true
}
```

### Error response

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Get phone number calling settings (SIP)

Use this endpoint to check the configuration of your Calling API feature settings, including SIP values.

This endpoint can return information for other Cloud API feature settings.

### Request syntax

```html
GET /<PHONE_NUMBER_ID>/settings
```

### Endpoint parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number for which you are retrieving Calling API settings.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### App permission required

`whatsapp_business_management`: Advanced access is required to use the API for end business clients

### Response body

```html
{
  "calling": {
    "status": "ENABLED",
    "call_icon_visibility": "DEFAULT",
    "callback_permission_status": "ENABLED",
    "sip": {
      "status": "ENABLED",
      "servers": [
        {
          "app_id": <APP_ID_THAT_CONFIGURED_THIS_SIP_SERVER>,
          "hostname": "sip.example.com"
        }
      ]
    }
  }
}
```

### Include SIP user password

By default, the response body does not include the Meta generated SIP password. To include the password in the response body, add the optional SIP credentials query parameter in the GET request:

```html
GET /<PHONE_NUMBER_ID>/settings?include_sip_credentials=true
```

Where the response will look like this:

```html
{
  "calling": {
    "status": "ENABLED",
    "call_icon_visibility": "DEFAULT",
    "callback_permission_status": "ENABLED",
    "sip": {
      "status": "ENABLED",
      "servers": [
        {
          "app_id": <APP_ID_THAT_CONFIGURED_THIS_SIP_SERVER>,
          "hostname": "sip.example.com",
          "sip_user_password": "{SIP_USER_PASSWORD}"
        }
      ]
    }
  }
}
```

### Error response

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Reset SIP password
To make Meta generate a new SIP password, you would need to disable SIP, delete SIP server and add your SIP server back.

* [Fetch your SIP configuration with password](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#include-sip-user-password) to view your current password for your reference
* Disable and delete your SIP server

```curl
curl -X POST \
https://graph.facebook.com/{VERSION}/{PHONE_NUMBER_ID}/settings \
-H 'Authorization: Bearer {TOKEN}' \
-H 'Content-Type: application/json' \
-d '
{
  "calling": {
    "status": "DISABLED",
    "sip": {
      "status": "DISABLED",
      "servers": []
    }
  }
}'
{"success":true}
```

* Enable SIP and add your SIP server

```curl
curl -X POST \
https://graph.facebook.com/{VERSION}/{PHONE_NUMBER_ID}/settings \
-H 'Authorization: Bearer {TOKEN}' \
-H 'Content-Type: application/json' \
-d '
{
  "calling": {
    "status": "ENABLED",
    "sip": {
      "status": "ENABLED",
      "servers": [{"hostname":"sip.example.com"}],
    }
  }
}'
{"success":true}
```

* [Fetch your SIP configuration with password](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#include-sip-user-password) to note the new password

## SIP call webhooks

SIP calls now support webhooks — providing call lifecycle events to your webhook endpoint when you enable webhooks on a SIP-enabled number.

| Webhook | Description |
|---------|-------------|
| Call created | Sent when a SIP call is attempted |
| Call terminate | Sent when the call ends for any reason |

These webhooks apply to both business-initiated and user-initiated SIP calls.

### Prerequisites

To receive SIP call webhooks, you must:

1. [Subscribe](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint#configure-webhooks) to the **calls** webhook field
2. [Enable SIP on the business phone number](#configure-or-update-sip-settings-on-business-phone-number)
3. Enable webhook delivery for SIP calls by setting `webhook_delivery` to `ENABLED` in the [SIP settings](#configure-or-update-sip-settings-on-business-phone-number) (disabled by default)

### Call created webhook

A webhook notification is sent when a SIP call is attempted.

For the webhook payload structure and field descriptions, see the [Call created webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#call-created-webhook) section in the API and Webhook Reference.

**Note:** **Call ID mapping:** The `id` field in the webhook payload contains the WhatsApp Call ID (WACID), which is a unique identifier for the call (for example, `wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh`). This WACID can be correlated with the `x-wa-meta-wacid` custom SIP header in SIP signaling messages to map webhook events to specific SIP call sessions.

**Note:** SIP webhooks do not include SDP (Session Description Protocol) information because the SIP server handles the media. These webhooks are informational only, to keep your messaging system informed about call lifecycle events.

### Call terminate webhook

Sent when the call ends for any reason. The terminate webhook for SIP calls has the same structure as the standard call terminate webhook. See the [call terminate webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#call-terminate-webhook).

## Sample SIP requests

**Note:** **Usernames and business-scoped user IDs:** In SIP signaling, a WhatsApp user may be identified by their business-scoped user ID (BSUID) or parent BSUID instead of a phone number, and Meta includes the user's BSUID, parent BSUID, and username in the `x-wa-meta-user-id`, `x-wa-meta-parent-user-id`, and `x-wa-meta-username` SIP headers. The phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

### Business-initiated calls (with WebRTC media)

#### Initial SIP INVITE request

```
INVITE sip:+12195550714@wa.meta.vc;transport=tls SIP/2.0
Record-Route: <sip:+159.65.244.171:5061;transport=tls;lr;ftag=Kc9QZg4496maQ;nat=yes>
Via: SIP/2.0/TLS 159.65.244.171:5061;received=2803:6081:798c:93f8:5f9b:bfe8:300:0;branch=z9hG4bK0da2.36614b8977461b486ceabc004c723476.0;i=617261
Via: SIP/2.0/TLS 137.184.87.1:35181;rport=56533;received=137.184.87.1;branch=z9hG4bKQNa6meey5Dj2g
Max-Forwards: 69
From: <sip:+17125550259@meta-voip.example.com>;tag=Kc9QZg4496maQ
To: <sip:+12195550714@wa.meta.vc>
Call-ID: dc2c5b33-1b81-43ee-9213-afb56f4e56ba
CSeq: 96743476 INVITE
Contact: <sip:mod_sofia@137.184.87.1:35181;transport=tls;swrad=137.184.87.1~56533~3>
User-Agent: SignalWire
Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, MESSAGE, INFO, UPDATE, REGISTER, REFER, NOTIFY
Supported: timer, path, replaces
Allow-Events: talk, hold, conference, refer
Session-Expires: 600;refresher=uac
Min-SE: 90
Content-Type: application/sdp
Content-Disposition: session
Content-Length: 2427
X-Relay-Call-ID: dc2c5b33-1b81-43ee-9213-afb56f4e56ba
Remote-Party-ID: <sip:+17125550259@meta-voip.example.com>;party=calling;screen=yes;privacy=off
Content-Type: application/sdp
Content-Length:  2427

<<SDP omitted for brevity>>
```

In this example, the called WhatsApp user is identified by their phone number (`+12195550714`) in the request-URI and `To:` header. If the call targets a user by their BSUID or parent BSUID, the BSUID or parent BSUID appears in the request-URI and `To:` header instead of the phone number. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### 407 response from Meta

```
SIP/2.0 407 Proxy Authentication Required
Via: SIP/2.0/TLS 159.65.244.171:5061;received=2803:6081:798c:93f8:5f9b:bfe8:300:0;branch=z9hG4bK0da2.36614b8977461b486ceabc004c723476.0;i=617261
Via: SIP/2.0/TLS 137.184.87.1:35181;rport=56533;received=137.184.87.1;branch=z9hG4bKQNa6meey5Dj2g
Record-Route: <sip:+159.65.244.171:5061;transport=tls;lr;ftag=Kc9QZg4496maQ;nat=yes>
Call-ID: dc2c5b33-1b81-43ee-9213-afb56f4e56ba
From: <sip:+17125550259@meta-voip.example.com>;tag=Kc9QZg4496maQ
To: <sip:+12195550714@wa.meta.vc>;tag=z9hG4bK0da2.36614b8977461b486ceabc004c723476.0
CSeq: 96743476 INVITE
Proxy-Authenticate: Digest realm="wa.meta.vc",nonce="419ac2415577f8e1",opaque="440badfc05072367",algorithm=MD5,qop="auth"
```

#### Second SIP INVITE sent with authorization

```
INVITE sip:+12195550714@wa.meta.vc;transport=tls SIP/2.0
        Record-Route: <sip:+159.65.244.171:5061;transport=tls;lr;ftag=Kc9QZg4496maQ;nat=yes>
        Via: SIP/2.0/TLS 159.65.244.171:5061;received=2803:6081:798c:93f8:5f9b:bfe8:300:0;branch=z9hG4bK1da2.ed8900012befced853927008d619d374.0;i=617261
        Via: SIP/2.0/TLS 137.184.87.1:35181;rport=56533;received=137.184.87.1;branch=z9hG4bKry3yp9y12p8mc
        Max-Forwards: 69
        From: <sip:+17125550259@meta-voip.example.com>;tag=Kc9QZg4496maQ
        To: <sip:+12195550714@wa.meta.vc>
        Call-ID: dc2c5b33-1b81-43ee-9213-afb56f4e56ba
        CSeq: 96743477 INVITE
        Contact: <sip:mod_sofia@137.184.87.1:35181;transport=tls;swrad=137.184.87.1~56533~3>
        User-Agent: SignalWire
        Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, MESSAGE, INFO, UPDATE, REGISTER, REFER, NOTIFY
        Supported: timer, path, replaces
        Allow-Events: talk, hold, conference, refer
        Proxy-Authorization: Digest username="17125550259", realm="wa.meta.vc", nonce="419ac2415577f8e1", uri="sip:+12195550714@wa.meta.vc;transport=tls", response="blah", algorithm=MD5, cnonce="/mVZtYFCEj65YQJCrBEAAg", opaque="440badfc05072367", qop=auth, nc=00000001
        Session-Expires: 600;refresher=uac
        Min-SE: 90
        Content-Type: application/sdp
        Content-Disposition: session
        Content-Length: 2427
        X-Relay-Call-ID: dc2c5b33-1b81-43ee-9213-afb56f4e56ba
        Remote-Party-ID: <sip:+17125550259@meta-voip.example.com>;party=calling;screen=yes;privacy=off
        Content-Type: application/sdp
        Content-Length:  2427
        <<SDP omitted for brevity>>
```
#### Example error response
```
SIP/2.0 403 SIP server wa.meta.vc from INVITE does not match any SIP server configured for phone number id {ID}
        Via: SIP/2.0/TLS [2803:6080:c954:b533:ecfb:5cec:300:0]:39459;rport=39459;received=2803:6080:c954:b533:ecfb:5cec:300:0;branch=z9hG4bKPjf9f3d0bddb3dbe0c9b1e3b486f39784a;alias
        Via: SIP/2.0/TLS 148.72.155.236:5061;rport=30498;received=2803:6080:d014:8e40:ddbb:4ed7:300:0;branch=z9hG4bKPjfd270ec8-7aaf-4a65-b290-4bef3b50b7b7;alias
        Record-Route: <sip:onevc-sip-proxy-dev.fbinfra.net:8191;transport=tls;lr>
        Record-Route: <sip:wa.meta.vc;transport=tls;lr>
        Call-ID: 91578781-44f1-4268-9a7f-d7efec1abf72
        From: <sip:+17125550259@wa.meta.vc>;tag=3a63b370-a697-4a5a-82b4-e8105e23f176
        To: <sip:+12195550714@wa.meta.vc>;tag=e0d30a05-657b-47ec-a668-e05ca79f9f05
        CSeq: 15659 INVITE
        Allow: INVITE, ACK, BYE, CANCEL, NOTIFY, OPTIONS
        X-FB-External-Domain: wa.meta.vc
        Warning: 399 wa.meta.vc "SIP server wa.meta.vc from INVITE does not match any SIP server configured for phone number id {ID}"
        Content-Length: 0
        Content-Length:  0
```
#### SIP BYE

```
BYE sip:+5559800000693@wa.meta.vc;transport=tls;ob SIP/2.0
Via: SIP/2.0/TLS 137.184.4.155:5061;received=2803:6080:c074:cac:10ed:4b05:400:0;i=8d2dc2
Via: SIP/2.0/TLS 143.198.136.243:35181;rport=38087;received=143.198.136.243
Route: <sip:wa.meta.vc;transport=tls;lr>
Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
Max-Forwards: 69
From: <sip:+12145551869@meta-voip.example.com>;tag=NcKQ6mtDKSDQB
To: "5559800000693" <sip:+5559800000693@wa.meta.vc>;tag=92a01092-ee78-4870-865f-bc176203a6bd
Call-ID: outgoing:wacid.HBgPMjAwNzU2OTA0ODY5OTY1FRIAEhggMjQ4QzUwOUQ1REQ0NDUwNENEQzRFMTgwRTNGQjAwNjEcGAsxMjE0NTU1MTg2ORUCAAA
CSeq: 98734935 BYE
User-Agent: SignalWire
Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, MESSAGE, INFO, UPDATE, REGISTER, REFER, NOTIFY
Supported: timer, path, replaces
Reason: Q.850;cause=16;text="NORMAL_CLEARING"
Content-Length: 0
X-Relay-Call-ID: b72c0c65-e319-41b3-afb7-19ebcca05d38
Content-Length:  0
```
#### SIP INVITE (with SDES)

```
INVITE sip:+12195550714@wa.meta.vc;transport=tls SIP/2.0
Record-Route: <sip:54.172.60.1:5061;transport=tls;lr;r2=on>
Record-Route: <sip:54.172.60.1;lr;r2=on>
CSeq: 2 INVITE
From: "12145551869" <sip:+12145551869@meta-voip.example.com>;tag=28460006_c3356d0b_5cdada8c-cbf0-4369-b02d-cc97d3c36f2b
To: <sip:+12195550714@wa.meta.vc>
Max-Forwards: 66
P-Asserted-Identity: <sip:+12145551869@meta-voip.example.com>
Min-SE: 120
Call-ID: f304a1d2cafb8139c1f9ff93a7733586@0.0.0.0
Contact: "12145551869" <sip:+12145551869@172.25.10.217:5060;transport=udp>
Allow: INVITE, ACK, CANCEL, OPTIONS, BYE, REFER, NOTIFY
Via: SIP/2.0/TLS 54.172.60.1:5061;received=2803:6080:f934:8894:7eb5:24f9:300:0;branch=z9hG4bK1e5a.0da2ace9cc912d9e5f2595ca4acb9847.0
Via: SIP/2.0/UDP 172.25.10.217:5060;rport=5060;branch=z9hG4bK5cdada8c-cbf0-4369-b02d-cc97d3c36f2b_c3356d0b_54-457463274351249162
Supported: timer
User-Agent: Twilio Gateway
Proxy-Authorization: Digest username="12145551869", realm="wa.meta.vc", nonce="2a487cb01d4ed43b", uri="sip:+12195550714@wa.meta.vc;transport=tls", response="3f58df7af575b948625aeffd51bf9060", algorithm=MD5, cnonce="b338deb7f0e004e66353e26d34ad62b7", opaque="725a06fb2cd89a32", qop=auth, nc=00000002
Content-Type: application/sdp
X-Twilio-CallSid: CA93eac6be615da5e6836c7059e9555348
Content-Length: 422
Content-Type: application/sdp
Content-Length:   422

v=0
o=root 1185414872 1185414872 IN IP4 172.18.155.180
s=Twilio Media Gateway
c=IN IP4 168.86.138.232
t=0 0
m=audio 19534 RTP/SAVP 107 0 8 101
a=crypto:**************************************************************************
a=rtpmap:0 PCMU/8000
a=rtpmap:107 opus/48000/2
a=fmtp:107 useinbandfec=1
a=rtpmap:8 PCMA/8000
a=rtpmap:101 telephone-event/8000
a=fmtp:101 0-16
a=ptime:20
a=maxptime:20
a=sendrecv
```

#### SIP OK (with SDES)

```
SIP/2.0 200 OK
Via: SIP/2.0/TLS 54.172.60.1:5061;received=2803:6080:f934:8894:7eb5:24f9:300:0;branch=z9hG4bK1e5a.0da2ace9cc912d9e5f2595ca4acb9847.0
Via: SIP/2.0/UDP 172.25.10.217:5060;rport=5060;branch=z9hG4bK5cdada8c-cbf0-4369-b02d-cc97d3c36f2b_c3356d0b_54-457463274351249162
Record-Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
Record-Route: <sip:wa.meta.vc;transport=tls;lr>
Record-Route: <sip:54.172.60.1:5061;transport=tls;lr;r2=on>
Record-Route: <sip:54.172.60.1;lr;r2=on>
Call-ID: f304a1d2cafb8139c1f9ff93a7733586@0.0.0.0
From: "12145551869" <sip:+12145551869@meta-voip.example.com>;tag=28460006_c3356d0b_5cdada8c-cbf0-4369-b02d-cc97d3c36f2b
To: <sip:+12195550714@wa.meta.vc>;tag=0d185053-2615-46c7-8ff2-250bda494cf1
CSeq: 2 INVITE
Allow: INVITE, ACK, BYE, CANCEL, NOTIFY, OPTIONS
Supported: timer
X-FB-External-Domain: wa.meta.vc
Contact: <sip:+12195550714@wa.meta.vc;transport=tls;ob;X-FB-Sip-Smc-Tier=collaboration.sip_gateway.sip.prod>;isfocus
Content-Type: application/sdp
Content-Length:   645

v=0
o=- 1746657286595 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE audio
a=msid-semantic: WMS 42da9643-cb50-4eca-95d3-ca41b3f1f4bb
m=audio 3480 RTP/SAVP 107 101
c=IN IP4 157.240.19.130
a=rtcp:9 IN IP4 0.0.0.0
a=mid:audio
a=sendrecv
a=msid:42da9643-cb50-4eca-95d3-ca41b3f1f4bb WhatsAppTrack1
a=rtcp-mux
a=crypto:**************************************************************************
a=rtpmap:107 opus/48000/2
a=fmtp:107 maxaveragebitrate=20000;maxplaybackrate=16000;minptime=20;sprop-maxcapturerate=16000;useinbandfec=1
a=rtpmap:101 telephone-event/8000
a=maxptime:20
a=ptime:20
a=ssrc:1238967757 cname:WhatsAppAudioStream1
```

Meta's 200 OK response also includes `x-wa-meta-user-id`, `x-wa-meta-parent-user-id`, and `x-wa-meta-username` headers identifying the WhatsApp user. When Meta sends a SIP BYE to terminate a call, it includes the same headers. See [Custom SIP headers](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#custom-sip-headers) for details.

### User-initiated calls (with WebRTC media)

#### SIP INVITE
```
INVITE sip:+17015558857@meta-voip.example.com;transport=tls SIP/2.0
Via: SIP/2.0/TLS [2803:6080:e888:51aa:d4a4:c5e0:300:0]:33819;rport=33819;received=2803:6080:e888:51aa:d4a4:c5e0:300:0;branch=z9hG4bKPjNvs.IZBnUa1W4l8oHPpk3SUMmcx3MMcE;alias
Max-Forwards: 70
From: "12195550714" <sip:+12195550714@wa.meta.vc>;tag=bbf1ad6e-79bb-4d9c-8a2c-094168a10bea
To: <sip:+17015558857@meta-voip.example.com>
Contact: <sip:+12195550714@wa.meta.vc;transport=tls;ob>;isfocus
Call-ID: outgoing:wacid.HBgLMTIxOTU1NTA3MTQVAgASGCAzODg1NTE5NEU1NTBEMTc1RTFFQUY5NjNCQ0FCRkEzRhwYCzE3MDE1NTU4ODU3FQIAAA==
CSeq: 2824 INVITE
Route: <sip:onevc-sip-proxy-dev.fbinfra.net:8191;transport=tls;lr>
X-FB-External-Domain: wa.meta.vc
Allow: INVITE, ACK, BYE, CANCEL, NOTIFY, OPTIONS
User-Agent: Facebook SipGateway
Content-Type: application/sdp
Content-Length: 1028

v=0
o=- 1741113186367 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE audio
a=msid-semantic: WMS 632a909f-1060-4369-96a4-7bd03e291ee7
a=ice-lite
m=audio 3480 UDP/TLS/RTP/SAVPF 111 126
c=IN IP4 57.144.135.35
a=rtcp:9 IN IP4 0.0.0.0
a=candidate:1775469887 1 udp 2122260223 57.144.135.35 3480 typ host generation 0 network-cost 50
a=candidate:3355715111 1 udp 2122262783 2a03:2880:f343:131:face:b00c:0:699c 3480 typ host generation 0 network-cost 50
a=ice-ufrag:RmDDkfzkwbexPfbC
a=ice-pwd:*************************
a=fingerprint:********************************************************************************************************
a=setup:actpass
a=mid:audio
a=sendrecv
a=msid:632a909f-1060-4369-96a4-7bd03e291ee7 WhatsAppTrack1
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=rtcp-fb:111 transport-cc
a=fmtp:111 maxaveragebitrate=20000;maxplaybackrate=16000;minptime=20;sprop-maxcapturerate=16000;useinbandfec=1
a=rtpmap:126 telephone-event/8000
a=maxptime:20
a=ptime:20
a=ssrc:849255537 cname:WhatsAppAudioStream1
```

In this example, the calling WhatsApp user is identified by their phone number (`+12195550714`) in the `From:` and `Contact:` headers. If the user has a BSUID or parent BSUID, it may appear instead of the phone number.

Meta includes the following custom headers on this INVITE to identify the WhatsApp user:

* `x-wa-meta-user-id` — The user's BSUID.
* `x-wa-meta-parent-user-id` — The user's parent BSUID, if parent BSUIDs are enabled; otherwise omitted.
* `x-wa-meta-username` — The user's username, if they have adopted one; otherwise omitted.

#### SIP BYE
```
BYE sip:+5559800000693@wa.meta.vc;transport=tls;ob SIP/2.0
Via: SIP/2.0/TLS 137.184.4.155:5061;received=2803:6080:c074:cac:10ed:4b05:400:0;i=8d2dc2
Via: SIP/2.0/TLS 143.198.136.243:35181;rport=38087;received=143.198.136.243
Route: <sip:wa.meta.vc;transport=tls;lr>
Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
Max-Forwards: 69
From: <sip:+12145551869@meta-voip.example.com>;tag=NcKQ6mtDKSDQB
To: "5559800000693" <sip:+5559800000693@wa.meta.vc>;tag=92a01092-ee78-4870-865f-bc176203a6bd
Call-ID: outgoing:wacid.HBgPMjAwNzU2OTA0ODY5OTY1FRIAEhggMjQ4QzUwOUQ1REQ0NDUwNENEQzRFMTgwRTNGQjAwNjEcGAsxMjE0NTU1MTg2ORUCAAA
CSeq: 98734935 BYE
User-Agent: SignalWire
Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, MESSAGE, INFO, UPDATE, REGISTER, REFER, NOTIFY
Supported: timer, path, replaces
Reason: Q.850;cause=16;text="NORMAL_CLEARING"
Content-Length: 0
X-Relay-Call-ID: b72c0c65-e319-41b3-afb7-19ebcca05d38
Content-Length:  0
```
#### SIP INVITE (with SDES)
```
INVITE sip:+12145551869@meta-voip.example.com;transport=tls SIP/2.0
            Via: SIP/2.0/TLS [2803:6080:f948:9597::]:57363;rport;branch=z9hG4bKPj3a9f2ad89e4a3df61408aa84f7d9a63e;alias
            Record-Route: <sip:wa.meta.vc;transport=tls;lr>
            Record-Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
            Via: SIP/2.0/TLS [2803:6080:f948:9597:d33c:e00:400:0]:5061;branch=z9hG4bKPj3a9f2ad89e4a3df61408aa84f7d9a63e
            Via: SIP/2.0/TLS [2803:6080:f948:9597:1ac5:cdf8:300:0]:63057;rport=63057;received=2803:6080:f948:9597:1ac5:cdf8:300:0;branch=z9hG4bKPj-phic0sbns27DiP0OlrxRxgLtNg4mio7;alias
            Max-Forwards: 69
            From: "12195550714" <sip:+12195550714@wa.meta.vc>;tag=8a0f7e65-6e9e-4801-bf92-85c3ef2485d9
            To: <sip:+12145551869@meta-voip.example.com>
            Contact: <sip:+12195550714@wa.meta.vc;transport=tls;ob>;isfocus
            Call-ID: outgoing:wacid.HBgLMTIxOTU1NTA3MTQVAgASGCA4QkY1MTJCQkNFNTgxMEVFRERFRTUzNTFERkE1MDU0MhwYCzEyMTQ1NTUxODY5FQIAAA
            CSeq: 31159 INVITE
            X-FB-External-Domain: wa.meta.vc
            Allow: INVITE, ACK, BYE, CANCEL, NOTIFY, OPTIONS
            User-Agent: Facebook SipGateway
            Content-Type: application/sdp
            Content-Length:   645

v=0
o=- 1746659966980 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE audio
a=msid-semantic: WMS 07092115-d151-427e-8722-26c70936b104
m=audio 3480 RTP/SAVP 111 126
c=IN IP4 157.240.19.130
a=rtcp:9 IN IP4 0.0.0.0
a=mid:audio
a=sendrecv
a=msid:07092115-d151-427e-8722-26c70936b104 WhatsAppTrack1
a=rtcp-mux
a=crypto:**************************************************************************
a=rtpmap:111 opus/48000/2
a=fmtp:111 maxaveragebitrate=20000;maxplaybackrate=16000;minptime=20;sprop-maxcapturerate=16000;useinbandfec=1
a=rtpmap:126 telephone-event/8000
a=maxptime:20
a=ptime:20
a=ssrc:1615009994 cname:WhatsAppAudioStream1
```

Meta's INVITE also includes `x-wa-meta-user-id`, `x-wa-meta-parent-user-id`, and `x-wa-meta-username` headers identifying the WhatsApp user. The user in the `From:` and `Contact:` headers may be identified by a BSUID or parent BSUID instead of a phone number.

#### SIP OK (with SDES)
```
SIP/2.0 200 OK
            CSeq: 31159 INVITE
            Call-ID: outgoing:wacid.HBgLMTIxOTU1NTA3MTQVAgASGCA4QkY1MTJCQkNFNTgxMEVFRERFRTUzNTFERkE1MDU0MhwYCzEyMTQ1NTUxODY5FQIAAA
            From: "12195550714" <sip:+12195550714@wa.meta.vc>;tag=8a0f7e65-6e9e-4801-bf92-85c3ef2485d9
            To: <sip:+12145551869@meta-voip.example.com>;tag=66596922_c3356d0b_fee164be-566a-4679-a80d-5bfdf1d0aa9e
            Via: SIP/2.0/TLS 157.240.229.209:5061;rport=51830;received=69.171.251.115;branch=z9hG4bKPj3a9f2ad89e4a3df61408aa84f7d9a63e;alias
            Via: SIP/2.0/TLS [2803:6080:f948:9597:d33c:e00:400:0]:5061;branch=z9hG4bKPj3a9f2ad89e4a3df61408aa84f7d9a63e
            Via: SIP/2.0/TLS [2803:6080:f948:9597:1ac5:cdf8:300:0]:63057;rport=63057;received=2803:6080:f948:9597:1ac5:cdf8:300:0;branch=z9hG4bKPj-phic0sbns27DiP0OlrxRxgLtNg4mio7;alias
            Record-Route: <sip:54.172.60.1:5060;lr;r2=on;twnat=sip:69.171.251.115:51830>
            Record-Route: <sip:54.172.60.1:5061;transport=tls;lr;r2=on;twnat=sip:69.171.251.115:51830>
            Record-Route: <sip:wa.meta.vc;transport=tls;lr>
            Record-Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
            Server: Twilio
            Contact: <sip:+172.25.16.223:5060>
            Allow: INVITE, ACK, CANCEL, OPTIONS, BYE, REFER, NOTIFY
            Content-Type: application/sdp
            X-Twilio-CallSid: CAb0d74508fe5fcdf6ec70ea3cf4e9b90b
            Content-Length: 446
            Content-Type: application/sdp
            Content-Length:   446

v=0
o=root 1353670385 1353670385 IN IP4 172.18.164.24
s=Twilio Media Gateway
c=IN IP4 168.86.138.176
t=0 0
m=audio 15822 RTP/SAVP 111 126
a=rtpmap:111 opus/48000/2
a=fmtp:111 maxplaybackrate=16000;sprop-maxcapturerate=16000;maxaveragebitrate=20000;useinbandfec=1
a=rtpmap:126 telephone-event/8000
a=fmtp:126 0-16
a=crypto:**************************************************************************
a=ptime:20
a=maxptime:20
a=sendrecv
```

### User-initiated calls with digest auth (with SDES media)
Meta SIP server supports digest auth for user-initiated calls. Your SIP server should respond with digest auth challenge,
and Meta will resend the SIP INVITE with challenge response. The username used for digest auth is the (normalized) business
phone number and the password is generated by Meta and retrievable using the [get Call settings endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#include-sip-user-password).

#### First INVITE request from Meta
```
INVITE sip:+12145551869@meta-voip.example.com;transport=tls SIP/2.0
Via: SIP/2.0/TLS [2803:6080:f948:9597::]:47237;rport;branch=z9hG4bKPj1e6c665db16b3ecacf32cadb4497fe77;alias
Record-Route: <sip:wa.meta.vc;transport=tls;lr>
Record-Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
Via: SIP/2.0/TLS [2803:6080:f948:9597:7253:922a:400:0]:5061;branch=z9hG4bKPj1e6c665db16b3ecacf32cadb4497fe77
Via: SIP/2.0/TLS [2803:6080:f8bc:9272:e488:9927:400:0]:58279;rport=58279;received=2803:6080:f8bc:9272:e488:9927:400:0;branch=z9hG4bKPjr33j97A1mx5J8HWHEy2zIgqZYCCIb4Fb;alias
Max-Forwards: 69
From: "12195550714" <sip:+12195550714@wa.meta.vc>;tag=ece2da15-39e7-4983-ac65-e312f325d94a
To: <sip:+12145551869@meta-voip.example.com>
Contact: <sip:+12195550714@wa.meta.vc;transport=tls;ob>;isfocus
Call-ID: outgoing:wacid.HBgLMTIxOTU1NTA3MTQVAgASGCA2MUI2QUY0MDRCMTUyOTM4QkE5ODEwN0ZGQTAwODkxORwYCzEyMTQ1NTUxODY5FQIAFRoA
CSeq: 9989 INVITE
X-FB-External-Domain: wa.meta.vc
Allow: INVITE, ACK, BYE, CANCEL, NOTIFY, OPTIONS
User-Agent: Facebook SipGateway
Content-Type: application/sdp
Content-Length:   643

v=0
o=- 1750716867913 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE audio
a=msid-semantic: WMS 4e37b099-8aef-45d0-be4f-1cde2ca5a37d
m=audio 3480 RTP/SAVP 111 126
c=IN IP4 57.144.219.49
a=rtcp:9 IN IP4 0.0.0.0
a=mid:audio
a=sendrecv
a=msid:4e37b099-8aef-45d0-be4f-1cde2ca5a37d WhatsAppTrack1
a=rtcp-mux
a=crypto:**************************************************************************
a=rtpmap:111 opus/48000/2
a=fmtp:111 maxaveragebitrate=20000;maxplaybackrate=16000;minptime=20;sprop-maxcapturerate=16000;useinbandfec=1
a=rtpmap:126 telephone-event/8000
a=maxptime:20
a=ptime:20
a=ssrc:215879358 cname:WhatsAppAudioStream1
```

Meta's INVITE includes `x-wa-meta-user-id`, `x-wa-meta-parent-user-id`, and `x-wa-meta-username` headers identifying the WhatsApp user. The user in the `From:` and `Contact:` headers may be identified by a BSUID or parent BSUID instead of a phone number.

#### 407 Response from partner SIP server
```
SIP/2.0 407 Proxy Authentication required
CSeq: 9989 INVITE
Call-ID: outgoing:wacid.HBgLMTIxOTU1NTA3MTQVAgASGCA2MUI2QUY0MDRCMTUyOTM4QkE5ODEwN0ZGQTAwODkxORwYCzEyMTQ1NTUxODY5FQIAFRoA
From: "12195550714" <sip:+12195550714@wa.meta.vc>;tag=ece2da15-39e7-4983-ac65-e312f325d94a
To: <sip:+12145551869@meta-voip.example.com>;tag=45065608_c3356d0b_16001fd8-76d2-45f0-bb35-e0441d6dc4a2
Via: SIP/2.0/TLS 31.13.66.215:5061;rport=62080;received=69.171.251.112;branch=z9hG4bKPj1e6c665db16b3ecacf32cadb4497fe77;alias
Via: SIP/2.0/TLS [2803:6080:f948:9597:7253:922a:400:0]:5061;branch=z9hG4bKPj1e6c665db16b3ecacf32cadb4497fe77
Via: SIP/2.0/TLS [2803:6080:f8bc:9272:e488:9927:400:0]:58279;rport=58279;received=2803:6080:f8bc:9272:e488:9927:400:0;branch=z9hG4bKPjr33j97A1mx5J8HWHEy2zIgqZYCCIb4Fb;alias
Contact: <sip:+172.25.58.54:5060>
Proxy-Authenticate: Digest realm="sip.twilio.com",nonce="eyOam_8-l5FVugxsyxFRjnlxq9vy1TjQIMB3mBfJuAvB5gV4",opaque="4a6a068be2ca2032a57912b9a2a6adf7",qop="auth"
Content-Length: 0
Content-Length:  0
```
#### Second INVITE with authorization from Meta
```
INVITE sip:+12145551869@meta-voip.example.com;transport=tls SIP/2.0
Via: SIP/2.0/TLS 31.13.66.215:5061;rport;branch=z9hG4bKPj16be0694dc6763eb66de5ec5f262db03;alias
Record-Route: <sip:wa.meta.vc;transport=tls;lr>
Record-Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
Via: SIP/2.0/TLS [2803:6080:f948:9597:7253:922a:400:0]:5061;branch=z9hG4bKPj16be0694dc6763eb66de5ec5f262db03
Via: SIP/2.0/TLS [2803:6080:f8bc:9272:e488:9927:400:0]:58279;rport=58279;received=2803:6080:f8bc:9272:e488:9927:400:0;branch=z9hG4bKPjYp9LqI0D8zJ.wly5wyMyVaH9fUwIU921;alias
Max-Forwards: 69
From: "12195550714" <sip:+12195550714@wa.meta.vc>;tag=ece2da15-39e7-4983-ac65-e312f325d94a
To: <sip:+12145551869@meta-voip.example.com>
Contact: <sip:+12195550714@wa.meta.vc;transport=tls;ob>;isfocus
Call-ID: outgoing:wacid.HBgLMTIxOTU1NTA3MTQVAgASGCA2MUI2QUY0MDRCMTUyOTM4QkE5ODEwN0ZGQTAwODkxORwYCzEyMTQ1NTUxODY5FQIAFRoA
CSeq: 9990 INVITE
X-FB-External-Domain: wa.meta.vc
Allow: INVITE, ACK, BYE, CANCEL, NOTIFY, OPTIONS
User-Agent: Facebook SipGateway
Proxy-Authorization: Digest username="12145551869", realm="sip.twilio.com", nonce="eyOam_8-l5FVugxsyxFRjnlxq9vy1TjQIMB3mBfJuAvB5gV4", uri="sip:+12145551869@meta-voip.example.com", response="b28ed6b8bf1418e3c6eca05ef8c7a0b1", cnonce="TY2SszvYCKitUCBlVLpGiPKMQfmBbj", opaque="4a6a068be2ca2032a57912b9a2a6adf7", qop=auth, nc=00000001
Content-Type: application/sdp
Content-Length:   643

v=0
o=- 1750716867913 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE audio
a=msid-semantic: WMS 4e37b099-8aef-45d0-be4f-1cde2ca5a37d
m=audio 3480 RTP/SAVP 111 126
c=IN IP4 57.144.219.49
a=rtcp:9 IN IP4 0.0.0.0
a=mid:audio
a=sendrecv
a=msid:4e37b099-8aef-45d0-be4f-1cde2ca5a37d WhatsAppTrack1
a=rtcp-mux
a=crypto:**************************************************************************
a=rtpmap:111 opus/48000/2
a=fmtp:111 maxaveragebitrate=20000;maxplaybackrate=16000;minptime=20;sprop-maxcapturerate=16000;useinbandfec=1
a=rtpmap:126 telephone-event/8000
a=maxptime:20
a=ptime:20
a=ssrc:215879358 cname:WhatsAppAudioStream1
```
####  SIP OK from partner SIP server
```
SIP/2.0 200 OK
CSeq: 9990 INVITE
Call-ID: outgoing:wacid.HBgLMTIxOTU1NTA3MTQVAgASGCA2MUI2QUY0MDRCMTUyOTM4QkE5ODEwN0ZGQTAwODkxORwYCzEyMTQ1NTUxODY5FQIAFRoA
From: "12195550714" <sip:+12195550714@wa.meta.vc>;tag=ece2da15-39e7-4983-ac65-e312f325d94a
To: <sip:+12145551869@meta-voip.example.com>;tag=29360930_c3356d0b_4933dc58-f035-4597-b075-04b19e552329
Via: SIP/2.0/TLS 31.13.66.215:5061;rport=62080;received=69.171.251.112;branch=z9hG4bKPj16be0694dc6763eb66de5ec5f262db03;alias
Via: SIP/2.0/TLS [2803:6080:f948:9597:7253:922a:400:0]:5061;branch=z9hG4bKPj16be0694dc6763eb66de5ec5f262db03
Via: SIP/2.0/TLS [2803:6080:f8bc:9272:e488:9927:400:0]:58279;rport=58279;received=2803:6080:f8bc:9272:e488:9927:400:0;branch=z9hG4bKPjYp9LqI0D8zJ.wly5wyMyVaH9fUwIU921;alias
Record-Route: <sip:54.172.60.0:5060;lr;r2=on;twnat=sip:69.171.251.112:62080>
Record-Route: <sip:54.172.60.0:5061;transport=tls;lr;r2=on;twnat=sip:69.171.251.112:62080>
Record-Route: <sip:wa.meta.vc;transport=tls;lr>
Record-Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
Contact: <sip:+172.25.43.84:5060>
Allow: INVITE, ACK, CANCEL, OPTIONS, BYE, REFER, NOTIFY
Content-Type: application/sdp
X-Twilio-CallSid: CAd4d6e59a356c4d1b0ee85323b2d9dab5
Content-Length: 444
Content-Type: application/sdp
Content-Length:   444

v=0
o=root 477560318 477560318 IN IP4 172.18.156.61
s=Twilio Media Gateway
c=IN IP4 168.86.137.174
t=0 0
m=audio 12710 RTP/SAVP 111 126
a=rtpmap:111 opus/48000/2
a=fmtp:111 maxplaybackrate=16000;sprop-maxcapturerate=16000;maxaveragebitrate=20000;useinbandfec=1
a=rtpmap:126 telephone-event/8000
a=fmtp:126 0-16
a=crypto:**************************************************************************
a=ptime:20
a=maxptime:20
a=sendrecv
```

## Configure SDES for SRTP key exchange

The Secure Real-time Transport Protocol (SRTP) key exchange is a cryptographic protocol used to securely exchange encryption keys between two parties over an insecure communication channel.

You can configure SRTP key exchange to one of two options:

* DTLS (default) — Industry-standard encrypted key exchange. Recommended.
* SDES — Plain text key is included in the SDP which is sent over secure signaling protocol like SIP or Graph API. When SDES is used, there is no need for STUN, ICE, and DTLS which could help shorten the call setup time.

### Configure/update SRTP key exchange protocol

#### Request syntax

```html
POST /<PHONE_NUMBER_ID>/settings
```

#### Endpoint parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number for which you are updating Calling API settings.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```html
{
  "calling": {
    "status": "ENABLED",
    "call_icon_visibility": "DEFAULT"
  . . .
    "srtp_key_exchange_protocol": "DTLS (default) | SDES",
  . . .
  }
. . .
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `srtp_key_exchange_protocol`<br><br>_String_ | **Optional**<br><br>Enable or disable use of SRTP key exchange protocol.<br><br>Possible values are `SDES` and `DTLS`.<br><br>Default is `DTLS`.<br><br>Note: Meta still expects the business side to send the first SRTP packet for both user and business initiated calls. | `"SDES"` |

#### Success response

```html
{
  "success": true
}
```

### Error response

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

### Get SRTP key exchange protocol

#### Request syntax

```html
POST /<PHONE_NUMBER_ID>/settings
```

#### Endpoint parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number for which you are updating Calling API settings.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Response body

```html
{
  "calling": {
    "status": "ENABLED",
    "call_icon_visibility": "DEFAULT"
  . . .
    "srtp_key_exchange_protocol": "DTLS | SDES",
  . . .
  }
. . .
}
```

#### Response parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `srtp_key_exchange_protocol`<br><br>_String_ | The type of SRTP key exchange protocol configured for the business phone number queried.<br><br>Possible values are `SDES` and `DTLS`.<br><br>Default is `DTLS`.<br><br>**Note: If this field has not been explicitly set, it will not be returned.** | `"SDES"` |

#### Error response

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## IP addresses

The IP addresses used for SIP configuration are the same as those listed for the Webhooks in the [Cloud API Webhooks IP Addresses section](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview#ip-addresses).

This reference is solely to indicate the IP addresses to allow-list for SIP traffic. By default, when SIP is enabled, calling-related webhooks are not sent. You must explicitly enable [SIP call webhooks](#sip-call-webhooks) to receive call lifecycle events.

## Troubleshooting

For additional SIP-specific questions and answers, see the [SIP FAQ](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq#session-initiation-protocol--sip--faq), and for SIP-specific errors and solutions, see [SIP Errors](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting#sip-errors).
# Send WhatsApp Call Button Messages and Deep Links



## Overview

After you adopt Cloud API Calling features, you can raise awareness with your customers in two core ways:

* Send them a message with a WhatsApp call button
* Embed a calling deep link into your brand surfaces (website, application, and so on)

## Send interactive message with a WhatsApp call button

Use this endpoint to send a free-form interactive message with a WhatsApp call button during a [customer service window](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#customer-service-windows) or an [open conversation window](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#opening-conversations).

When a WhatsApp user clicks the call button, the click initiates a WhatsApp call to the business number that sent the message.

WhatsApp sends a standard [message status webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) in response to this message send.

#### Request syntax

```html
POST <PHONE_NUMBER_ID>/messages
```

| Placeholder | Description | Sample value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number from which you are sending messages.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api) | `+12784358810` |

#### Request body

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "14085551234",
  "recipient": "US.13491208655302741918",
  "type": "interactive",
  "interactive" : {
    "type" : "voice_call",
    "body" : {
      "text": "You can call us on WhatsApp now for faster service!"
    },
    "action": {
      "name": "voice_call",
      "parameters": {
        "display_text": "Call on WhatsApp",
        "ttl_minutes": 100,
        "payload": "payload data"
      }
    }
  }
}
```

#### Body parameters

[Learn more about sending interactive free form messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)

| Parameter | Description | Sample value |
| --- | --- | --- |
| `to`<br><br>_Integer_ | **Required** (unless `recipient` is provided)<br><br>The phone number of the WhatsApp user you are messaging.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api) | `"17863476655"` |
| `recipient`<br><br>_String_ | **Optional**<br><br>The WhatsApp user's business-scoped user ID (BSUID) or parent BSUID. Use this instead of, or in addition to, `to`. If you include both, `to` takes precedence.<br><br>[Learn more about business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) | `"US.13491208655302741918"` |
| `type`<br><br>_String_ | **Required**<br><br>The type of interactive message you are sending.<br><br>In this case, you are sending a `voice_call`.<br><br>[Learn more about interactive messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api) | `"voice_call"` |
| `action`<br><br>_String_ | **Required**<br><br>The action of your interactive message.<br><br>Must be `voice_call`. | `"voice_call"` |
| `parameters`<br><br>_JSON Object_ | **Optional**<br><br>Optional parameters for the WhatsApp calling button sent to the user.<br><br>Contains three values: `display_text`, `ttl_minutes`, and `payload`.<br><br>`display_text` — (_String_) **Optional**<br><br>The display text on the WhatsApp calling button sent to the user.<br><br>Default is `Call Now`.<br><br>Max length: 20 characters.<br><br>`ttl_minutes` — (_Integer_) **Optional**<br><br>Time to live for the call-to-action (CTA) button in minutes.<br><br>Must be between 1 and 43200 (30 days).<br><br>Default value is 10080 (7 days).<br><br>`payload` — (_String_) **Optional**<br><br>An arbitrary string, useful for tracking.<br><br>Any app subscribed to the `calls` webhook field on the WhatsApp Business account can get this string. The string is included in the `connect` and `terminate` webhook payloads under the `cta_payload` field.<br><br>Cloud API does not process the `cta_payload` field; it returns the value in webhook payloads.<br><br>Maximum 512 characters.<br><br>Payload is only available to WhatsApp clients starting on version 2.25.27. | ```html
"parameters": {
"display_text": "Call on WhatsApp",
"ttl_minutes": 100,
"payload": "payload data"
}
``` |

**Note:** **Usernames and business-scoped user IDs:** The `recipient` field lets you identify the WhatsApp user by their BSUID instead of, or in addition to, their phone number in `to`. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### Success response

[Learn more about messaging success responses](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)

#### Error response

Possible errors:

If you send this message to users on older app versions, Cloud API returns an error webhook with error code `131026`.

[View general Cloud API error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Create and send WhatsApp call button template message

Use these endpoints to create and send a WhatsApp call button template message.

Once your call button template message is created, you can send a message to a WhatsApp user, inviting them to call your business.

[Learn more about creating and managing message templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)

### Create call button message template

Use this endpoint to create a call button message template.

#### Request syntax

```html
POST /<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates
```

| Parameter | Description | Sample value |
| --- | --- | --- |
| `<WHATSAPP_BUSINESS_ACCOUNT_ID>`<br><br>_String_ | **Required**<br><br>Your WhatsApp Business account ID.<br><br>[Learn how to find your WABA ID](https://developers.facebook.com/documentation/business-messaging/whatsapp/whatsapp-business-accounts) | `"waba-90172398162498126"` |

#### Request body

```html
{
  "name": "<NAME>",
  "category": "<CATEGORY>",
  "language": "<LANGUAGE>",
  "components": [
    {
      "type": "BODY",
      "text": "You can call us on WhatsApp now for faster service!"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "voice_call",
          "text": "Call Now",
          "ttl_minutes": 1440
        },
        {
          "type": "URL",
          "text": "Contact Support",
          "url": "https://www.luckyshrub.com/support"
        }
      ]
    }
  ]
}
```

#### Body parameters

You can create and manage template messages through both Cloud API and the Meta Business Suite interface.

When creating your call button template, ensure you configure `type` as `voice_call`.

[Learn more about creating and managing message templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)

| Parameter | Description | Sample value |
| --- | --- | --- |
| `type`<br><br>_String_ | **Required**<br><br>The type of template message you are creating.<br><br>In this case, you are creating a `voice_call`. | `"voice_call"` |
| `text`<br><br>_String_ | **Optional**<br><br>The display text on the WhatsApp calling button sent to the user.<br><br>Default is `Call Now`.<br><br>Max length: 20 characters. | `"Call Now"` |
| `ttl_minutes`<br><br>_Integer_ | **Optional**<br><br>Time to live for the CTA button in minutes.<br><br>Must be between 1440 (1 day) and 43200 (30 days).<br><br>You can override this value when sending the message. | `1440` |

#### Success response

```html
{
  "id": "<ID>",
  "status": "<STATUS>",
  "category": "<CATEGORY>"
}
```

[_Learn more about messaging success responses_](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)

#### Error response

Possible errors:

* Invalid `whatsapp-business-account-id`
* Permissions/Authorization errors
* Template structure/component validation alerts

[View general Cloud API error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)


### Send call button message template

Use this endpoint to **send** a call button message template.

The following is a simplified sample of the send template message request. You can also [learn more about how to send message templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview).

#### Request syntax

```html
POST /<PHONE_NUMBER_ID>/messages
```

| Parameter | Description | Sample value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_String_ | **Required**<br><br>The business phone number from which you are sending messages.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api) | `+18762639988` |

#### Request body

```json
{
  "to": "14085551234",
  "recipient": "US.13491208655302741918",
  "messaging_product": "whatsapp",
  "type": "template",
  "recipient_type": "individual",
  "template": {
    "name": "wa_voice_call",
    "language": {
      "code": "en"
    },
    "components": [
      {
        "type": "button",
        "sub_type" : "voice_call",
        "parameters": [
          {
            "type": "ttl_minutes",
            "ttl_minutes": 100
          },
          {
            "type": "payload",
            "payload": "payload data"
          }
        ]
      }
    ]
  }
}
```

#### Request parameters

| Parameter | Description | Sample value |
| --- | --- | --- |
| `recipient`<br><br>_String_ | **Optional**<br><br>The WhatsApp user's business-scoped user ID (BSUID) or parent BSUID. Use this instead of, or in addition to, `to`. If you include both, `to` takes precedence.<br><br>[Learn more about business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) | `"US.13491208655302741918"` |
| `ttl_minutes`<br><br>_Integer_ | **Optional**<br><br>Time to live for the CTA button in minutes.<br><br>Must be between 1 and 43200 (30 days).<br><br>Default value is 10080 (7 days). | `10800` |
| `payload`<br><br>_String_ | **Optional**<br><br>An arbitrary string, useful for tracking.<br><br>Any app subscribed to the `calls` webhook field on the WhatsApp Business account can get this string. The string is included in the `connect` and `terminate` webhook payloads under the `cta_payload` field.<br><br>Cloud API does not process this field; it returns the value in webhook payloads.<br><br>Maximum 512 characters.<br><br>Payload is only available to WhatsApp clients starting on version 2.25.27. | `payload data` |

**Note:** **Usernames and business-scoped user IDs:** The `recipient` field lets you identify the WhatsApp user by their BSUID instead of, or in addition to, their phone number in `to`. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### Success response

[Learn more about messaging success responses](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)

## Calling deep links

Calling deep links are hyperlinks that route WhatsApp users to call your business.

The process to create a calling deep link is similar to a [chat deep link](https://faq.whatsapp.com/5913398998672934/?locale=en_US), except the format for the call deep link is `wa.me/call/<BUSINESS_PHONE_NUMBER>`

Deep links are not supported on WhatsApp desktop clients.

### Embed calling deep links

You can use calling deep links to advertise WhatsApp calling for your business.

Use these links anywhere calling is useful, such as your website, primary application, or a QR code to be shared.

### Send calling deep links

You can also send messages to WhatsApp users with a calling deep link.

Since deep links can be made per business phone number, you can use calling deep links to prompt WhatsApp users to contact a different phone number with voice enabled.

The `wa.me/call/<BUSINESS_PHONE_NUMBER>` format is easy to copy, paste, and send, and does not require you to make a template in Meta Business Suite.

### Send payload data in call deep link

You can also send a payload with the deep link. You can use the `biz_payload` query string when sending the call deep link to any user (`wa.me/call/<BUSINESS_PHONE_NUMBER>?biz_payload=payload`).

When a user calls using the provided deep link with the `biz_payload`, any app subscribed to the `calls` webhook field on the WhatsApp Business account can get this string. The string is included in the `connect` and `terminate` webhook payloads under the `deeplink_payload` field.

Payload in call deep link is only available to WhatsApp clients starting on version 2.25.27.
# Integration Patterns



## Possible high-level approaches

| Approach | Number setup | Solution Partner responsibilities | Calling Tech Provider responsibilities | End business responsibilities |
| --- | --- | --- | --- | --- |
| **Message Solution Partner capable of Calling** | Extend an existing messaging number for calling, or use a new number. | * Messaging Solution Partner reuses their app and subscribes it to calls webhooks. You can also create a new calling-specific app, but this is [not recommended](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-patterns#single-app-vs--multiple-apps)<br>* Process calls webhooks and coordinate with real-time media infra<br>* Make calls related Graph API calls similar to messaging Graph API calls | Not applicable because there is only a single partner involved. | * Enable and use calling<br>* Continue paying the Solution Partner, who now bills for calling usage |
| [**Multi-solution Conversation**](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/multi-solution-conversations) | Single number independently operated by both messaging Solution Partner and Calling Solution Partner or TP | * Messaging Solution Partner does no changes | * Calling Solution Partner or TP hosts ES on their own website pointing to their own app<br>* Gets the business to go through their ES | * Onboard using calling partner's ES<br>* Pay the bills to Messaging Solution Partner like before<br>* For Calling partner incurred activity, pay the bill to calling partner if they are a Solution Partner or to Meta if they are not a Solution Partner |
| Exclusive Calling ISV | New number for calling | Not applicable because there is no messaging Solution Partner | * Calling ISV hosts Embedded Signup (ES) on their website pointing to their own app<br>* Gets the business to go through their ES<br>* If ISV is a tech provider or partner, Meta bills the business directly. ISV and the business figure out their own billing<br>* If ISV is a Solution Partner, they can extend their credit line to the business | * Onboard using ES on TP<br>* If ISV is Tech Provider or Partner, pay Meta directly<br>  * This requires the business to have a direct payment relation with Meta. Setting up this relation may take several weeks<br>* If ISV is Solution Partner, pay the bill from Solution Partner |
| [Multi-platform solution](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/multi-partner-solutions) using Calling ISV registered as Tech Provider (TP) | New calling exclusive number serviced (**only**) by Calling TP | * Solution Partner and TP work together to create or approve a multi-partner solution. Solution Partner and TP have their own apps<br>* Work out Messaging Solution Partner <> Calling ISV commercial relation<br>* Extend credit line to end business<br>* Can receive messages or calls but cannot send messages or calls because you can select only one of the two partners to send messages or calls in a multi-platform solution | * Solution Partner and TP work together to create or approve a multi-partner solution. Solution Partner and TP have their own apps<br>* Work out Messaging Solution Partner <> Calling ISV commercial relation<br>* Onboard businesses using ES pointing to created solution<br>* Send or receive messages or calls | * Onboard using ES on TP<br>* The business is informed about TP in ES<br>* Pay the bill from Solution Partner |

## Multi-solution conversations (MSC)

Multi-solution Conversations allow multiple solutions on the same phone number, localizing messaging and calling in a single chat thread.

[Learn more about Multi-Solution Conversations](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/multi-solution-conversations)

## Integrating using a third party calling provider detailed design

The following logical architecture illustrates how to integrate WhatsApp Business Calling using a third party (3p) calling provider.

In this scenario, you would use the 3p vendor internally, and that 3p vendor would not be visible to Meta. This pattern is similar to any other SaaS service you may be using.

The diagram also illustrates how this architecture can be optionally extended to integrate with the SIP infrastructure on your side.

**Warning:** **Our terms disallow use of PSTN on _any_ leg of the WhatsApp call in the overall call flow.**

Even if you bridge WA call into the SIP world, you must ensure it still stays exclusively on VoIP and never touches the PSTN. SIP trunk by itself is not disallowed because technically a SIP trunk can be used without any PSTN at all.

## Single app vs. multiple apps

This section covers guidelines and considerations for reusing your existing messaging app for calling vs. creating a new app specifically for Calling API features.

To integrate with the WhatsApp Calling API, you need to call [Graph API endpoints](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform#whatsapp-cloud-api) and process Webhooks from Meta. This [requires you to have an app](https://developers.facebook.com/docs/development/create-an-app), and almost always, you should already have an app that is used for messaging.

You can reuse an existing app which is used for [Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview) and for a messaging use case.

In this setup, the Webhook Callback URI is the same for both message and call related webhooks, but the webhook payload can be used to distinguish between the two categories of functions (messaging and calling). Hence you can still forward Calling API specific webhooks to a calls related component from your main webhook business logic.

Reusing the same app offers the following benefits:

* Reduced operational overhead (for example, app review, ongoing maintenance)
* Simplified footprint on Meta
* Equality between the app used for Embedded Signup and the one used for invoking Graph APIs and receiving webhooks
* There would be no impact to existing functionality by reusing that app for calling. You need to ensure the webhook server gracefully handles calls-related webhooks.

Having separate apps is still supported, see the [Get Started FAQ](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq#getting-started-faq) for details.

## Guidelines for media path integration

The WhatsApp Business Calling VoIP stack is designed to be compatible with WebRTC. However, to ensure smooth integration with the WhatsApp protocol, Meta restricts the supported functionalities. As a result, the following requirements and recommendations apply.

### Mandatory requirements

If any mandatory requirement is unmet, the call will fail. This failure can occur either during the call signaling phase, leading to a rejected call, or during the media packet decoding phase.

* Use only the supported codecs.
* For Opus, set the media clock rate to 48 kHz.
* For Opus, use a `ptime` of 20 ms.
* Audio must use a single SSRC. The Meta relay server overwrites the SSRC of all business audio packets to a fixed SSRC before these packets reach the WA client. WA clients handle only one audio source from their peers. Using multiple SSRCs causes undefined behavior. This undefined behavior includes severe media corruption, audio glitches, and likely total media failure.
* Set the DTMF clock rate to 8 kHz.

### Recommendations

While the following aspects are not mandatory, they are recommended to achieve high call quality and reliability.

* **ICE Process**
  * Our VoIP stack is ICE-LITE, so it is recommended that Solution Partners' VoIP stack is ICE-FULL. ([RFC 5245 Section 2.7](https://datatracker.ietf.org/doc/html/rfc5245#section-2.7))
  * Solution Partners' VoIP stack should initiate the ICE process by sending STUN connectivity checks.
  * Solution Partners' VoIP stack should assume the ICE CONTROLLING role, as Meta will only assume the CONTROLLED role.
  * Use regular nomination instead of aggressive nomination. ([RFC 5245 Section 8.1.1.2](https://datatracker.ietf.org/doc/html/rfc5245#section-8.1.1.2))
  * Wait for the ICE process to complete before nominating the candidate and starting DTLS.
  * Do not switch the candidate in the middle of the call.
* **DTLS**
  * Use ECDH keys for the DTLS certificates to prevent packet fragmentation during transmission.
  * Solution Partner should act as a DTLS client. ([RFC 6347 Section 4.2](https://datatracker.ietf.org/doc/html/rfc6347#section-4.2))
* **Media**
  * WhatsApp might not always send the first RTP media packet. Your media server's media egress should not wait for WhatsApp media ingress. If it does, there is a chance of deadlock where each side is waiting for the other to start media transmission.
* **Addressing Audio Clipping**
  * See [Audio clipping](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting#audio-clipping-issue-and-solution) for details.
# Integration Examples



This guide explains integration of common VoIP platforms with WhatsApp Business Calling API.

**Note:** This guide is for information purposes only with no support or warranties of any kind from Meta or any vendor. There are many ways to integrate and the guide explains just one way exclusively for illustrative purposes.

## Asterisk using SIP

### Overview

This guide explains how to set up [WhatsApp Business Calling API](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling) using SIP signaling with [Asterisk](https://www.asterisk.org/), an open-source PBX (Private Branch Exchange). You'll learn how to configure your Asterisk server, connect SIP phones, and handle both incoming and outgoing WhatsApp calls.

#### User-initiated calls

* The WhatsApp user dials the business number.
* The call is received by Asterisk and routed through an IVR, prompting the user to enter an extension, registered to the same Asterisk server.
* The call is then connected to the specified extension.

#### Business-initiated calls

* The business agent/user registers with Asterisk using SIP credentials (see "[Configuring a VoIP Phone](#configuring-a-voip-phone)" section).
* The business user dials the b2c-sip (business to consumer) extension, which is handled by an IVR. The IVR prompts for the WhatsApp number to call.
* The call is then connected to the WhatsApp user.

The WA to Asterisk leg uses SDES for media encryption key exchange and Opus for audio codec.

The Asterisk to SIP UA leg uses SDES for media encryption key exchange and Opus or G.711 for audio codec.

### Prerequisites

* Asterisk Deployment: Asterisk is deployed (for example, on a public cloud instance)
* Operating System: Any OS compatible with Asterisk. For example, CentOS 9
* Domain: Asterisk server is reachable via a public domain with valid certificate
* WhatsApp Business API: A WhatsApp Business phone number is registered and calling is enabled.
* SIP Support: [SIP is enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-update-sip-settings-on-business-phone-number) on the WhatsApp Business Number
* SDES: [SDES is enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-sdes-for-srtp-key-exchange-protocol) on the WhatsApp Business Number

### Building and installing Asterisk

Refer to the [Asterisk build and install guide](https://docs.asterisk.org/Getting-Started/Installing-Asterisk/Installing-Asterisk-From-Source/Building-and-Installing-Asterisk/).

This guide was tested using Asterisk version 22.5.2.

### Asterisk configuration

These configuration files are placed under /etc/asterisk/

#### extensions.conf

Replace the following placeholders with actual values

1. {wa-business-phone-number}: WhatsApp Business Phone Number
1. {asterisk-sip-server-dns}: DNS name of your Asterisk SIP server
1. incoming_welcome: incoming_welcome.wav (not provided) place this file under /var/lib/asterisk/sounds
1. outgoing_welcome: outgoing_welcome.wav (not provided) place this file under /var/lib/asterisk/sounds

```https
[c2b-sub-dial]
exten => s,1,NoOp()
  same => n,Read(Digits,incoming_welcome,0,,5, 500)
  same => n,Dial(PJSIP/${Digits})
  same => n,Hangup()

[whatsapp]
exten => _10XX,1,NoOp()
  same => n,Dial(PJSIP/${EXTEN})
  same => n,Hangup()

;Extension for B2C business call through Meta SIP gateway
exten => b2c-sip,1,NoOp()
  same => n,Read(Digits,outgoing_welcome,0,,5, 500)
  same => n,Dial(PJSIP/whatsapp/sip:${Digits}@wa.meta.vc)

;Extension to handle incoming invite requests from Meta SIP gateway to <wa-business-phone-number>@<asterisk-sip-server-dns>
exten => _+<wa-business-phone-number>,1,Goto(c2b-sub-dial,s,1)
```

#### pjsip.conf

Replace the following placeholders with actual values

1. {wa-business-phone-number} : the business phone number
2. {local-net}: local network of the Asterisk server
3. {external-media-address}: Public IP of the Asterisk server media
4. {external-signaling-address}: Public IP of the Asterisk server signaling
5. {sip-ua-password}: Chosen SIP User Agent password
6. {domain-name}: domain name assigned to the Asterisk server

Certificate files should be placed under
/var/lib/asterisk/certs/fullchain.cer
/var/lib/asterisk/certs/cer.key

```https
[transport-tls]
type=transport
protocol=tls
bind=0.0.0.0:5061
cert_file=/var/lib/asterisk/certs/fullchain.cer
priv_key_file=/var/lib/asterisk/certs/cer.key
method=sslv23
allow_wildcard_certs=yes
external_media_address={external-media-address}
;External address for SIP signalling
external_signaling_address={external-signaling-address}
;Network to consider local used for NAT purposes
local_net={local-net}

[sdes_endpointtemplate](!)
type=endpoint
context=whatsapp
disallow=all
allow=OPUS
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=no
media_use_received_transport=yes
media_encryption=sdes

[authtemplate](!)
type=auth
auth_type=userpass
password={sip-ua-password}

[aortemplate](!)
type=aor
max_contacts=1
remove_existing=yes

[aoridentitytemplate](!)
type=identify
match_header=X-FB-External-Domain: wa.meta.vc

;SDES users
[1000](sdes_endpointtemplate)
auth=1000_auth
aors=1000

[1000_auth](authtemplate)
username=1000

[1000](aortemplate)

[1000](aoridentitytemplate)
endpoint=1000

[1001](sdes_endpointtemplate)
auth=1001_auth
aors=1001

[1001_auth](authtemplate)
username=1001

[1001](aortemplate)

[1001](aoridentitytemplate)
endpoint=1001

[1002](sdes_endpointtemplate)
auth=1002_auth
aors=1002

[1002_auth](authtemplate)
username=1002

[1002](aortemplate)

[1002](aoridentitytemplate)
endpoint=1002

[1003](sdes_endpointtemplate)
auth=1003_auth
aors=1003

[1003_auth](authtemplate)
username=1003

[1003](aortemplate)

[1003](aoridentitytemplate)
endpoint=1003

[1004](sdes_endpointtemplate)
auth=1004_auth
aors=1004

[1004_auth](authtemplate)
username=1004

[1004](aortemplate)

[1004](aoridentitytemplate)
endpoint=1004

[1005](sdes_endpointtemplate)
auth=1005_auth
aors=1005

[1005_auth](authtemplate)
username=1005

[1005](aortemplate)

[1005](aoridentitytemplate)
endpoint=1005

;This endpoint maps to an IVR for C2B calls
[c2b-sip](sdes_endpointtemplate)

[c2b-sip](aortemplate)

[c2b-sip]
type=identify
endpoint=c2b-sip
match_header=X-FB-External-Domain: wa.meta.vc

;special endpoint for Meta SIP Gateway integration
;This endpoint maps to an IVR for B2C calls
[b2c-sip](sdes_endpointtemplate)

[b2c-sip](aortemplate)

[whatsapp](sdes_endpointtemplate)
type=endpoint
transport=transport-tls
disallow=all
allow=opus,ulaw,alaw
aors=whatsapp
from_user={wa-business-phone-number}
from_domain={domain-name}
outbound_auth=whatsapp

[whatsapp]
type=aor
contact=sip:wa.meta.vc

[whatsapp]
type=identify
endpoint=whatsapp

[whatsapp]
type=auth
auth_type=digest
password={meta-sip-user-password}
username={wa-business-phone-number}
realm=*
```

#### rtp.conf

```https
[general]
; Hostname or address for the STUN server used for determining the external
; IP address and port an RTP session can be reached at. The port number is
; optional. If omitted default value of 3478 will be used. This option is
; disabled by default. Name resolution occurs at load time, and if DNS is
; used, name resolution will occur repeatedly after the TTL expires.
;
; for example stundaddr=mystun.server.com:3478
;
stunaddr=stun.l.google.com:19302

rtpstart=10000
rtpend=60000
```

### Configuring a VoIP phone

Download and install a softphone client (for example, [Linphone](https://www.linphone.org/en/download)) for testing both business-initiated and user-initiated calls.

#### Account setup

1. Select an extension to register as a SIP UA (extensions 1001–1005).
2. Open Preferences.
3. Under "SIP Accounts," click "Add account."
4. Enter the following details:
   * SIP Address: for example, sip:1001@{asterisk-sip-server-dns}
   * SIP Server Address: for example, sip:{asterisk-sip-server-dns};transport=tls
   * Transport: TLS
   * Disable ICE
   * Enable AVPF
   * Disable "Publish presence information"
5. Confirm and save the account.
6. Enter the password when prompted (that is, {sip-ua-password})
7. Once connected, return to Preferences and select the "Audio" tab. Enable all audio codecs.
8. In the "Calls and Chat" tab:
   * Select "Encryption"
   * Choose "SRTP-SDES"
   * Enable "Encryption is mandatory"
   * Confirm settings

### Final checklist

* Double-check all configuration files for correct numbers, passwords, and domain names.
* Make sure your firewall allows SIP (5061/TLS) and RTP (10000-20000) ports.
* For more details on SIP password setup, see the [WhatsApp Cloud API documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip).

### Troubleshooting

#### Cannot register SIP UA

Confirm that the SIP URL is correct and the domain is pointing to the Asterisk server. Run `host {domain-name}` to verify that the IP address points to the Asterisk server.

#### Not receiving ACK from Meta OR Business audio stops around 30s OR Meta returns 404 response to BYE

For a user initiated call, Meta sends a `SIP INVITE` to your SIP server which then responds with `200 OK`. Meta acks your `200 OK` with an `ACK` but you never receive this ACK. So your SIP server keeps resending the `200 OK` and ultimately the SIP dialog is terminated due to ACK timeout (typically 32s).

The most likely cause for this problem is incorrect `Record-Route` headers in your `200 OK` to Meta. The `200 OK` response is supposed to not modify the `Record-Route` headers included in the original Meta's `INVITE`. Your SIP server can add new `Record-Route` headers but cannot modify those present in our `INVITE`.

The solution to this problem is to change `rewrite_contact=yes` to `rewrite_contact=no` on the WhatsApp endpoint configuration in pjsip.conf file. After this make sure your `200 OK` has following headers as the last 2 in the list of `Record-Route` headers

This problem is hard to detect or diagnose. Even with this bug, the call will get connected and media will flow in both directions but around 32s later, your SIP server will terminate the call which won't be propagated to WhatsApp client because your BYE request has incorrect `Route` headers. So WA user stops hearing business audio around 32s.

```https
Record-Route: <sip:wa.meta.vc;transport=tls;lr>
Record-Route: <sip:onevc-sip-proxy.fbinfra.net:8191;transport=tls;lr>
```

## FreeSWITCH using SIP

### Overview

This guide explains how to set up [WhatsApp Business Calling API](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling) using SIP signaling with [FreeSWITCH](https://signalwire.com/freeswitch), an open-source communication framework. You'll learn how to configure your FreeSWITCH server, connect SIP phones, and handle both user-initiated and business-initiated WhatsApp calls.

#### User-initiated calls

* The WhatsApp user dials the business number.
* The call is received by FreeSWITCH and routed through an IVR, which prompts the user to enter an agent's extension registered on the same FreeSWITCH server.
* Once the extension is entered, the call is connected to the specified recipient agent.

#### Business-initiated calls

* The business agent or user registers with FreeSWITCH using SIP credentials (see the [Configuring a VoIP Phone](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples#configuring-a-voip-phone) section for details).
* The business user dials the b2c-sip (business-to-consumer) extension, which is managed by an IVR. The IVR then prompts for the WhatsApp number to call.
* After the number is entered, the call is connected to the WhatsApp user via SIP.

The WA to FreeSWITCH leg uses SDES for media encryption key exchange with Opus as the audio codec. FreeSWITCH - SIP UA leg uses SDES for media encryption key exchange with Opus or G.711 audio codecs.

### Prerequisites

* FreeSWITCH Deployment: FreeSWITCH is deployed (for example, on a public cloud instance)
* Operating System: Any OS compatible with FreeSWITCH. For example, CentOS 9
* Domain: FreeSWITCH server is reachable via a public domain with a valid certificate
* WhatsApp Business API: A WhatsApp Business phone number is registered and [calling is enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings).
* SIP Support: [SIP is enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-update-sip-settings-on-business-phone-number) on the WhatsApp Business Number
  * Note: FreeSWITCH is configured to listen on 5081 for TLS
* SDES: [SDES is enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#configure-sdes-for-srtp-key-exchange-protocol) on the WhatsApp Business Number

### Building and installing FreeSWITCH

Refer to the [FreeSWITCH installation guide](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Installation/).

This guide was tested using FreeSWITCH version 1.10.12. FreeSWITCH uses sofia (an open-source SIP user agent library). Sofia v1.13.17 was used for this guide.

#### FreeSWITCH configuration
These configuration files are placed under /usr/share/freeswitch/etc/freeswitch

**wa-biz-api-dialplan.xml**

Place the dial plan under /usr/share/freeswitch/etc/freeswitch/dialplan/default/wa-biz-api-dialplan.xml

```https
<include>
 <extension name="c2b_calls_sip_ivr">
   <!--Dial plan is selected if the SIP request is coming from Meta-->
   <condition field="${sip_from_host}" expression="^wa.meta.vc$">
     <!--Verify the IP from where the request is coming, compare the IP with the Meta allowlisted IPs-->
     <action application="check_acl" data="${network_addr} whatsapp_allow normal_clearing"/>
     <!--Enable encrypted media using SDES-->
     <action application="set" data="rtp_secure_media=true"/>
     <action application="answer"/>
     <!--Add silence stream for  1 sec so that the media path is established between whatsapp and freeswitch to avoid audio clipping-->
     <action application="playback" data="silence_stream://1000"/>
     <action application="play_and_get_digits" data="2 5 3 7000 # $${base_dir}/sounds/incoming_welcome.wav  $${base_dir}/sounds/incoming_invalid.wav extension \d+"/>
     <!--While the call is being bridged, play a ringtone for the caller-->
     <action application="set" data="ringback=%(2000, 4000, 440.0, 480.0)"/>
     <!--Offer G711 and Opus for FreeSWITCH-SIP UA leg -->
     <action application="export" data="nolocal:absolute_codec_string=PCMA,PCMU,OPUS@48000h@20i"/>
     <action application="bridge" data="user/${extension}"/>
     <action application="hangup"/>
   </condition>
 </extension>
 <extension name="b2c_calls_ivr">
   <condition field="destination_number" expression="^b2c-sip$">
     <!--Enable encrypted media using SDES-->
     <action application="set" data="rtp_secure_media=true"/>
     <action application="answer"/>
     <action application="playback" data="silence_stream://1000"/>
     <action application="set" data="caller_id_check=${caller_id_number}"/>
     <action application="play_and_get_digits" data="2 12 3 20000 # $${base_dir}/sounds/outgoing_welcome.wav $${base_dir}/sounds/outgoing_invalid.wav whatsapp_number \d+"/>
     <action application="log" data="INFO [whatsapp_number] is ${whatsapp_number}"/>
     <!--While the call is being bridged, play a ringtone for the caller-->
     <action application="set" data="ringback=%(2000, 4000, 440.0, 480.0)"/>
     <!--Offer only OPUS-->
     <action application="export" data="nolocal:absolute_codec_string=OPUS@48000h@20i,OPUS@8000h@20i"/>
     <!--Bridge the call by calling META SIP with the WA Number-->
     <action application="bridge" data="sofia/gateway/whatsapp/+${whatsapp_number}"/>
     <action application="hangup"/>
   </condition>
 </extension>
</include>
```

Audio files should be placed under /usr/share/freeswitch/sounds (not provided)

* `incoming_welcome.wav`
* `Incoming_invalid.wav`
* `outgoing_welcome.wav`
* `outgoing_invalid.wav`

**whatsapp.xml**

This file configures the WhatsApp gateway, copy the file to `/usr/share/freeswitch/etc/freeswitch/sip_profiles/external/whatsapp.xml`

```https
<!--Gateway configuration for Meta SIP-->
<!--replace {phone-number},{meta-sip-password} and {domain-name} before starting FreeSWITCH-->
<include>
 <gateway name="whatsapp">
   <param name="username" value="{phone-number}"/>
   <param name="password" value="{meta-sip-password}"/>
   <param name="register" value="false"/>
   <param name="realm" value="wa.meta.vc"/>
   <param name="from-user" value="{phone-number}"/>
   <param name="from-domain" value="{domain-name}"/>
 </gateway>
</include>
```

Replace the following placeholders with actual values

1. {phone-number}: WhatsApp Business Phone Number
1. {meta-sip-password}: SIP password issued by Meta. For more details on SIP password setup, see the [WhatsApp Cloud API documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#include-sip-user-password).
1. {domain-name}: DNS name of your FreeSWITCH SIP server

**acl.conf.xml**

Open `/usr/share/freeswitch/etc/freeswitch/autoload_configs/acl.conf.xml`

Add the following list under `network-lists` element

```https
<!--IP addresses from Meta that are allowed to send SIP requests via the gateway. Keep this up to date-->
   <list name="whatsapp_allow" default="deny">
     <node type="allow" cidr="31.13.24.0/21"/>
     <node type="allow" cidr="31.13.64.0/18"/>
     <node type="allow" cidr="45.64.40.0/22"/>
     <node type="allow" cidr="57.141.0.0/21"/>
     <node type="allow" cidr="57.141.8.0/22"/>
     <node type="allow" cidr="57.141.12.0/23"/>
     <node type="allow" cidr="57.144.0.0/14"/>
     <node type="allow" cidr="66.220.144.0/20"/>
     <node type="allow" cidr="69.63.176.0/20"/>
     <node type="allow" cidr="69.171.224.0/19"/>
     <node type="allow" cidr="74.119.76.0/22"/>
     <node type="allow" cidr="102.132.96.0/20"/>
     <node type="allow" cidr="103.4.96.0/22"/>
     <node type="allow" cidr="129.134.0.0/16"/>
     <node type="allow" cidr="147.75.208.0/20"/>
     <node type="allow" cidr="157.240.0.0/16"/>
     <node type="allow" cidr="163.70.128.0/17"/>
     <node type="allow" cidr="163.77.128.0/17"/>
     <node type="allow" cidr="173.252.64.0/18"/>
     <node type="allow" cidr="179.60.192.0/22"/>
     <node type="allow" cidr="185.60.216.0/22"/>
     <node type="allow" cidr="185.89.216.0/22"/>
     <node type="allow" cidr="204.15.20.0/22"/>
   </list>
```

**vars.xml**

Modify /usr/share/freeswitch/etc/freeswitch/vars.xml

```https
Add line <X-PRE-PROCESS cmd="set" data="rtp_secure_media=mandatory"/> under <include>

Replace
  <X-PRE-PROCESS cmd="set" data="default_password=1234"/>
with (substitute {sip_ua_password} with your password)
  <X-PRE-PROCESS cmd="set" data="default_password={sip-ua-password}"/>

Replace
  <X-PRE-PROCESS cmd="set" data="domain=$${local_ip_v4}"/>
with (substitute {domain-name} with your FreeSWITCH SIP server DNS)
  <X-PRE-PROCESS cmd="set" data="domain={domain-name}"/>

Replace
  <X-PRE-PROCESS cmd="stun-set" data="external_sip_ip=stun:stun.freeswitch.org"/>
with (substitute {external-ip} with your FreeSWITCH public ip)
  <X-PRE-PROCESS cmd="set" data="external_sip_ip={external-ip}"/>

Replace
  <X-PRE-PROCESS cmd="stun-set" data="external_rtp_ip=stun:stun.freeswitch.org"/>
with (substitute {external-ip} with your FreeSWITCH public ip)
  <X-PRE-PROCESS cmd="stun-set" data="external_rtp_ip={external-ip}"/>
```

**internal.xml**

Modify `/usr/share/freeswitch/etc/freeswitch/sip_profiles/internal.xml`
Look for:

```https
<param name="sip-trace" value="no"/>
```

Replace it with

```https
<param name="sip-trace" value="yes"/>
```

**external.xml**
Modify `/usr/share/freeswitch/etc/freeswitch/sip_profiles/external.xml`

```https
Replace
  <param name="sip-trace" value="no"/>
with
  <param name="sip-trace" value="yes"/>

Replace
  <param name="tls" value="$${external_ssl_enable}"/>
with
  <param name="tls" value="true"/>

Replace
  <!--<param name="tls-cert-dir" value=""/>-->
with
  <param name="tls-cert-dir" value="/usr/share/freeswitch/etc/freeswitch/certs"/>
```

Make sure certificates are placed under /usr/share/freeswitch/etc/freeswitch/certs

### Final checklist

* Double-check all configuration files for correct numbers, passwords, and domain names.
* Make sure your firewall allows SIP (5081/TLS) and RTP (10000-20000) ports.
* For more details on SIP password setup, see the [WhatsApp Cloud API documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip#include-sip-user-password).

### Troubleshooting

#### Cannot register SIP UA

Confirm that the SIP URL is correct and the domain is pointing to the FreeSWITCH server. Run `host {domain-name}` to verify that the IP address points to the FreeSWITCH server.

#### Trace SIP messages

Start CLI (`/usr/share/freeswitch/bin/fs_cli`) to view SIP messages

## FreeSWITCH using Graph API with Janus

### Overview

This guide explains how to set up [WhatsApp Business Calling API](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling) using [WhatsApp Cloud API signaling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls) with [FreeSWITCH](https://signalwire.com/freeswitch), an open-source communication framework and [Janus](https://janus.conf.meetecho.com/), a general-purpose WebRTC server. You'll learn how to configure your FreeSWITCH server, connect SIP phones, and handle both incoming and outgoing WhatsApp calls.

#### User-initiated calls

* The WhatsApp user dials the business number.
* The call is received by Webhook server which forwards it to FreeSWITCH server via Janus SIP plugin.
* The call is received by FreeSWITCH and routed through an IVR, prompting the user to enter an extension, registered to the same FreeSWITCH server.
* The call is then connected to the specified extension.

#### Business-initiated calls

* The business agent/user registers with FreeSWITCH using SIP credentials (see "[Configuring a VoIP Phone](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples#configuring-a-voip-phone)" section).
* The business user dials the b2c-sip (business to consumer) extension, which is handled by an IVR. The IVR prompts for the WhatsApp number to call.
* FreeSWITCH bridges the call to extension registered to Janus SIP plugin which translates it to an API request to Meta
* The call is then connected to the WhatsApp user.

The Janus server sits between WA and FreeSWITCH and converts media from WA (WebRTC compliant with DTLS key exchange) to FreeSWITCH negotiated media (SDES key exchange).

FreeSWITCH - SIP UA will be using SDES for media encryption key exchange and opus or G711 for audio codec.

### Prerequisites

* FreeSWITCH Deployment: FreeSWITCH is deployed (for example, on a public cloud instance)
* Janus Deployment: Can be deployed on the same machine as FreeSWITCH
* Operating System: Any OS compatible with FreeSWITCH. For example, CentOS 9
* Domain: FreeSWITCH server and Webhook server are reachable via a public domain with valid certificate
* WhatsApp Business API: A WhatsApp Business phone number is registered and [calling is enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings).
* Webhooks: Configure Webhook callback URL pointing to domain name of the Webhook server

### Integration with Cloud API signaling

You will need to implement an integration module which sits between WA and Janus and translates Cloud API Signalling messages to Janus SIP plugin messages and vice versa.

You will need

1. A webhook server to receive calls webhook events from Meta
2. A Graph API module to send call messages to Meta
3. An implementation of [Janus SIP plugin](https://janus.conf.meetecho.com/docs/sip) to connect to Janus. The Janus plugin implementation will connect to FreeSWITCH using extension 1000 which is reserved for bridging

Business initiated calls

1. The module will receive a SIP INVITE via Janus SIP plugin on extension 1000. The SIP INVITE is converted to a [Graph API request](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#initiate-call). The SDP received in the SIP INVITE is sent verbatim as the SDP offer to WA via the Graph API call
2. When the call is accepted by the WA user, an accepted webhook is received. On receiving the webhook, the Janus SIP Plugin accepts the SIP INVITE passing the answer SDP in the [connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#call-connect-webhook)

User Initiated calls

1. The webhook server receives an incoming call via a webhook message containing the offer SDP. On receiving the call invite, the Janus SIP plugin sends an invite to FreeSWITCH via extension 1000. The destination extension is **c2b-sip.**
2. When the Janus SIP plugin receives the SIP 200 OK, a Graph API accept call request is sent to Meta to accept the incoming call by passing the SDP received as part of SIP answer

### Building and installing Janus

Refer to [https://github.com/meetecho/janus-gateway](https://github.com/meetecho/janus-gateway)
This guide was tested using version 1.2.3.

### Janus configuration

**janus.jcfg**

Modify janus.jcfg which can be found at /usr/share/janus/etc/janus/janus.jcfg
Set `nat_1_1_mapping` to the public IP of the Janus Server

To start Janus

```https
/usr/share/janus/bin/janus  --debug-level=6 --libnice-debug=on -S stun.l.google.com:19302 --log-file=/var/log/janus.log --config=/usr/share/janus/etc/janus/janus.jcfg
```

### Building and installing FreeSWITCH

Refer to [https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Installation/](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Installation/)

This guide was tested using FreeSWITCH version 1.10.12. FreeSWITCH uses sofia (an open-source SIP user agent library). Sofia v1.13.17 was used for this guide.

**FreeSWITCH Configuration**
These configuration files are placed under /usr/share/freeswitch/etc/freeswitch

**wa-biz-api-dialplan.xml**

Place the dial plan under /usr/share/freeswitch/etc/freeswitch/dialplan/default/wa-biz-api-dialplan.xml

```https
<include>
 <extension name="c2b_calls_ivr">
   <condition field="destination_number" expression="^c2b-sip$">
     <action application="set" data="rtp_secure_media=true"/>
     <action application="answer"/>
     <!--Add silence stream for  1 sec so that the media path is established between whatsapp and freeswitch to avoid audio clipping. TODO: Investigate if silence can be removed-->
     <action application="playback" data="silence_stream://1000"/>
     <action application="play_and_get_digits" data="2 5 3 7000 # $${base_dir}/sounds/incoming_welcome.wav  $${base_dir}/sounds/incoming_invalid.wav extension \d+"/>
     <!--While the call is being bridged, play a ringtone for the caller-->
     <action application="set" data="ringback=%(2000, 4000, 440.0, 480.0)"/>
     <!--WA calls bridged via Janus through extension 1000 only support OPUS. However, the callee might be restricted to other codecs for example G722-->
     <!--Therefore , don't restrict to OPUS for C2B calls and offer more codecs to the caller. Transcoding between OPUS and the negotiated codec by the caller-->
     <!--will happen in freeswitch-->
     <action application="export" data="nolocal:absolute_codec_string=PCMA,PCMU,OPUS@48000h@20i,G722"/>
     <action application="bridge" data="user/${extension}"/>
     <action application="hangup"/>
   </condition>
 </extension>

 <extension name="b2c_calls_ivr">
   <condition field="destination_number" expression="^b2c-sip$">
     <action application="set" data="rtp_secure_media=true"/>
     <action application="answer"/>
     <action application="playback" data="silence_stream://1000"/>
     <action application="set" data="caller_id_check=${caller_id_number}"/>
     <action application="log" data="INFO [caller id ] is ${caller_id_check}"/>
     <action application="play_and_get_digits" data="2 12 3 20000 # $${base_dir}/sounds/outgoing_welcome.wav $${base_dir}/sounds/outgoing_invalid.wav whatsapp_number \d+"/>
     <action application="log" data="INFO [whatsapp_number] is ${whatsapp_number}"/>
     <!--Add the whatsapp number entered by the user as a custom SIP header, Janus will use this WA user number in API request to Meta-->
     <action application="export" data="sip_h_X-WhatsApp-Number=${whatsapp_number"/>
     <!--While the call is being bridged, play a ringtone for the caller-->
     <action application="set" data="ringback=%(2000, 4000, 440.0, 480.0)"/>
     <!--WA calls bridged via Janus through extension 1000 only support OPUS. However, the caller might be restricted to other codecs for example G722-->
     <!--Therefore , don't restrict to OPUS for B2C calls and let caller select other codecs-->
     <!--However, force transcoding to OPUS by only offering OPUS to Janus-->
     <action application="export" data="nolocal:absolute_codec_string=OPUS@48000h@20i,PCMU,PCMA"/>
     <!--Bridge the call to extension 1000 to which capi-calling is registered via Janus to route calls to WhatsApp-->
     <action application="bridge" data="user/1000"/>
     <action application="hangup"/>
   </condition>
 </extension>
</include>
```

Audio files should be placed under /usr/share/freeswitch/sounds (not provided)

* `incoming_welcome.wav`
* `Incoming_invalid.wav`
* `outgoing_welcome.wav`
* `outgoing_invalid.wav`

**internal.xml**

Modify `/usr/share/freeswitch/etc/freeswitch/sip_profiles/internal.xml`
Look for:

```https
<param name="sip-trace" value="no"/>
```

Replace it with

```https
<param name="sip-trace" value="yes"/>
```

### Configuring a VoIP phone

Refer to the [earlier section](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples#configuring-a-voip-phone)

### Final checklist

* Double-check all configuration files for correct numbers, passwords, and domain names.
* Make sure your firewall allows SIP (5061/TLS) and RTP (10000-20000) ports.
* For more details on SIP password setup, see the [WhatsApp Cloud API documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip).

### Troubleshooting

#### Cannot register SIP UA

Confirm that the SIP URL is correct and the domain is pointing to the FreeSWITCH server. Run `host {domain-name}` to verify that the IP address points to the FreeSWITCH server.

#### Trace SIP messages

Start CLI (`/usr/share/freeswitch/bin/fs_cli`) to view SIP messages

## Asterisk using Graph API with RtpEngine

### Overview

This guide explains how to set up [WhatsApp Business Calling API](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling) using [WhatsApp Cloud API signaling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls) with [Asterisk](https://www.asterisk.org/), an open-source PBX (Private Branch Exchange) and [RtpEngine](https://github.com/sipwise/rtpengine), an open-source proxy used for relaying, manipulating, and controlling RTP streams. You'll learn how to configure your Asterisk server, connect SIP phones, and handle both incoming and outgoing WhatsApp calls.

#### User-initiated calls

* The WhatsApp user dials the business number.
* The call is received by the Webhook server which after bridging media using RtpEngine, forwards it to Asterisk using SIP.
* The call is received by Asterisk and routed through an IVR, prompting the user to enter an extension, registered to the same Asterisk server.
* The call is then connected to the specified extension.

#### Business-initiated calls

* The business agent/user registers with Asterisk using SIP credentials (see "[Configuring a VoIP Phone](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples#configuring-a-voip-phone)" section).
* The business user dials the b2c-sip (business to consumer) extension, which is handled by an IVR. The IVR prompts for the WhatsApp number to call.
* Asterisk bridges the call to extension registered by the integration module (see "Integration with Cloud API Signalling")
* On receiving the call, the integration module bridges the media using RtpEngine and then translates it to an API request to Meta
* The call is then connected to the WhatsApp user.

RtpEngine acts as a media proxy and sits between the media stream of WA (WebRTC compliant with DTLS key exchange) and Asterisk (SDES key exchange).

### Prerequisites

* Asterisk Deployment: Asterisk is deployed (for example, on a public cloud instance)
* RtpEngine Deployment: Can be deployed on the same machine as Asterisk
* Operating System: Any OS compatible with Asterisk and RtpEngine. For example, CentOS 9
* Domain: Asterisk server and Webhook server are reachable via a public domain with valid certificate
* WhatsApp Business API: A WhatsApp Business phone number is registered and [calling is enabled](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings).
* Webhooks: Configure Webhook callback URL pointing to domain name of the Webhook server

### Integration with Cloud API signaling

You will need to implement an integration module that acts as a bridge between WhatsApp and Asterisk. This module will:

* Translate Cloud API Signaling messages from WhatsApp to SIP for Asterisk, and vice versa
* Use SIP signaling for communication between the SIP UA inside the module and Asterisk
* Bridge the media between WhatsApp and Asterisk via RtpEngine

You will need following components, which are part of the integration module for the purpose of this setup

1. Webhook Server: Receives call webhook events from Meta (WhatsApp Cloud API)
2. Graph API client: Sends call-related requests to Meta using the Graph API
3. SIP User Agent (UA) such as PJSIP: Connects to Asterisk using extension 1000, which is reserved for bridging calls between WhatsApp and Asterisk.
4. RtpEngineClient: To control RtpEngine via [ng control protocol](https://rtpengine.readthedocs.io/en/latest/ng_control_protocol.html) for bridging media

Business initiated calls

* Business agent registered to the same Asterisk server dials b2c-sip extension to initiate a call to WhatsApp user
* The extension prompts the business agent to enter WA user's phone number
* Asterisk sends a SIP INVITE request to extension 1000 with a custom header containing the dialed WA user phone number
* The SIP UA inside the module would've registered at extension 1000 and hence receives the SIP INVITE from Asterisk
* The SDP included in the SIP INVITE is sent to RtpEngine which returns a new SDP
* The new SDP is included in the [Graph API request](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#initiate-call) to initiate a new call
* When the WhatsApp user accepts the call, an "accepted" webhook is received
* Upon receiving this webhook, the answer SDP received in the webhook is sent to RtpEngine which returns a new SDP
* The SIP UA accepts the original SIP INVITE (step 3), passing along the new SDP received from RtpEngine
* The call is now bridged between WA user, RtpEngine, and Asterisk

User Initiated calls

* The webhook server inside the module receives an [incoming call webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#call-connect-webhook) from Meta, which includes the offer SDP
* Upon receiving this call invite, the SDP included in the offer is sent to RtpEngine which returns a new SDP
* The SIP UA inside the module sends a SIP INVITE to Asterisk using extension 1000 passing the new SDP from RtpEngine in the SIP INVITE. The destination extension is c2b-sip.
* The extension prompts WA user to dial the extension of the business agent to connect to
* Asterisk dials the specified extension and waits for an answer
* After the agent answers the call, Asterisk sends SIP 200 OK to the SIP UA extension 1000 inside the module. The SDP in SIP 200 OK is sent to RtpEngine which returns a new SDP
* A Graph API request is sent to Meta to [accept the incoming call](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls#accept-call), with the new SDP received from RtpEngine

### Building and installing Asterisk

Refer to the [Asterisk build and install guide](https://docs.asterisk.org/Getting-Started/Installing-Asterisk/Installing-Asterisk-From-Source/Building-and-Installing-Asterisk/).

This guide was tested using Asterisk version 22.5.2.

### Building and installing RtpEngine

Refer to [https://github.com/sipwise/rtpengine](https://github.com/sipwise/rtpengine) to build and install RtpEngine
This guide was tested using RtpEngine version 13.3.1.4.

Refer to the [RtpEngine ng control protocol documentation](https://rtpengine.readthedocs.io/en/latest/ng_control_protocol.html) for details on ng control protocol

To start RtpEngine run

```https
/usr/bin/rtpengine --listen-ng={local-ip}:22222 --interface={local-ip}\!{public-ip} -f -E
```

Replace

1. {local-ip} with the local IP of the RtpEngine server
2. {public-ip} with the public IP of the RtpEngine server

**Asterisk Configuration**
These configuration files are placed under /etc/asterisk/

**extensions.conf**

Replace the following placeholders with actual values

1. incoming_welcome: incoming_welcome.wav (not provided) place this file under /var/lib/asterisk/sounds
2. outgoing_welcome: outgoing_welcome.wav (not provided) place this file under /var/lib/asterisk/sounds

```https
[handler]
;Set headers on callee channel
exten => addheader,1,Set(PJSIP_HEADER(add,X-WhatsApp-Number)=${DIGITS})
same => n,Return()

[default]
exten => _10XX,1,NoOp()
same => n,Dial(PJSIP/${EXTEN})
same => n,Hangup()

exten => b2c-sip,1,NoOp()
same => n,Read(Digits,outgoing_welcome,0,,5, 500)
same => n, Set(GLOBAL(DIGITS)=${Digits})
;Before starting a business initiated call, add customer WA header to store the WA user number captured from agent entered digits (DTMF)
same => n,Dial(PJSIP/1000,,b(handler^addheader^1))
same => n,Hangup()

exten => c2b-sip,1,NoOp()
same => n,Read(Digits,incoming_welcome,0,,5, 500)
same => n,Dial(PJSIP/${Digits})
same => n,Hangup()
```

**pjsip.conf**

Replace the following placeholders with actual values

1. {external-media-address}: Public IP of the Asterisk server for media
2. {external-signaling-address}: Public IP of the Asterisk server for signaling
3. {local-net}: local network of the Asterisk server
4. {sip-ua-password}: Chosen SIP User Agent password

Note:

Extension 1000 is used to bridge WA calls with Asterisk see section **Integration with Cloud API Signaling**

```https
[global]
type=global
debug=yes ; Enable/Disable SIP debug logging.  Valid options include yes|no

[transport-tcp]
type=transport
protocol=tcp
bind=0.0.0.0
;External IP address to use in RTP handling
external_media_address={external-media-address}
;External address for SIP signalling
external_signaling_address={external-signaling-address}
;Network to consider local used for NAT purposes
local_net={local-net}

[endpointtemplate](!)
type=endpoint
context=default
disallow=all
allow=OPUS,g722,g729,ulaw
;No audio if direct_media is set to yes
direct_media=no
rtp_symmetric=yes
use_avpf=yes
media_encryption=sdes
media_use_received_transport=yes
rtcp_mux=yes

[authtemplate](!)
type=auth
auth_type=userpass
password={sip-ua-password}

[aortemplate](!)
type=aor
max_contacts=1
remove_existing=yes

[1000](endpointtemplate)
disallow=all
;extension 1000 is used by RtpEngine to bridge whatsapp calls
;WhatsApp only support OPUS
allow=OPUS
auth=1000_auth
aors=1000

[1000_auth](authtemplate)
username=1000

[1000](aortemplate)

[1001](endpointtemplate)
auth=1001_auth
aors=1001

[1001_auth](authtemplate)
username=1001

[1001](aortemplate)

[1002](endpointtemplate)
auth=1002_auth
aors=1002

[1002_auth](authtemplate)
username=1002

[1002](aortemplate)

[1003](endpointtemplate)
auth=1003_auth
aors=1003

[1003_auth](authtemplate)
username=1003

[1003](aortemplate)

[1004](endpointtemplate)
auth=1004_auth
aors=1004

[1004_auth](authtemplate)
username=1004

[1004](aortemplate)

[1005](endpointtemplate)
auth=1005_auth
aors=1005

[1005_auth](authtemplate)
username=1005

[1005](aortemplate)
```

### Configuring a VoIP phone

Refer to the [earlier section](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples#configuring-a-voip-phone)

### Final checklist

* Double-check all configuration files for correct numbers, passwords, and domain names.
* Make sure your firewall allows SIP (5060/TCP) and RTP (10000-20000) ports.
* For more details on SIP password setup, see the [WhatsApp Cloud API documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip).

### Troubleshooting

#### Cannot register SIP UA

Confirm that the SIP URL is correct and the domain is pointing to the Asterisk server. Run `host {domain-name}` to verify that the IP address points to the Asterisk server.

## Asterisk with built-in WebRTC using Graph API

This approach is similar to [Asterisk using Graph API with RtpEngine
](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples#asterisk-using-graph-api-with-rtpengine) except that it uses the built-in WebRTC support in Asterisk and hence does not require RtpEngine.

The RtpEngineClient component is hence not required in this approach.

In terms of configuration and setup, only difference is the configuration of extension 1000 which is given below.

```
...
; Rest of content omitted for brevity

[1000](endpointtemplate)
disallow=all
;extension 1000 is used by SIP UA of the integration module to bridge WhatsApp calls
;WhatsApp only support OPUS
allow=OPUS
auth=1000_auth
aors=1000
dtls_auto_generate_cert=yes
webrtc=yes
; Setting webrtc=yes is a shortcut for setting the following options:
; use_avpf=yes
; media_encryption=dtls
; dtls_verify=fingerprint
; dtls_setup=actpass
; ice_support=yes
; media_use_received_transport=yes
; rtcp_mux=yes

```
# API and Webhook Reference



## Calling API endpoints

### Configure or update calling settings

Use the [Settings API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/settings-api#post-version-phone-number-id-settings) and pass in Calling API parameters to configure settings on a business phone number you designate in the request syntax.

#### Request syntax

```https
POST /<PHONE_NUMBER_ID>/settings
```

#### Endpoint parameters

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number for which you are updating Calling API settings. | `+12784358810` |

#### Request body

```curl
{
  "calling": {
    "status": "ENABLED",
    "call_icon_visibility": "DEFAULT",
    "call_hours": {
      "status": "ENABLED",
      "timezone_id": "America/Manaus",
      "weekly_operating_hours": [
        {
          "day_of_week": "MONDAY",
          "open_time": "0400",
          "close_time": "1020"
        },
        {
          "day_of_week": "TUESDAY",
          "open_time": "0108",
          "close_time": "1020"
        }
      ],
      "holiday_schedule": [
        {
          "date": "2026-01-01",
          "start_time": "0000",
          "end_time": "2359"
        }
      ]
    },
    "callback_permission_status": "ENABLED",
    "sip": {
      "status": "ENABLED | DISABLED (default)",
      "servers": [
        {
          "hostname": SIP_SERVER_HOSTNAME,
          "port": SIP_SERVER_PORT,
          "request_uri_user_params": {
            "KEY1": "VALUE1",
            "KEY2": "VALUE2"
          }
        }
      ]
    }
  }
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `status`<br><br>_String_ | **Optional**<br><br>Enable or disable the Calling API for the given business phone number. | `"ENABLED"`<br><br>`"DISABLED"` |
| `call_icon_visibility`<br><br>_String_ | **Optional**<br><br>Configure whether the WhatsApp call button icon displays for users when chatting with the business.<br><br>[View call icon visibility behavior details in the Parameter details section](#configure-call-settings-parameter-details) | [View call icon visibility behavior details below](#configure-call-settings-parameter-details) |
| `call_hours`<br><br>_JSON object_ | **Optional**<br><br>Allows you to specify and trigger call settings for incoming calls based on your timezone, business operating hours, and holiday schedules.<br><br>Any previously configured values in `call_hours` will be replaced with the values passed in the request body of this API call.<br><br>[View call hours behavior details in the Parameter details section](#configure-call-settings-parameter-details) | [View call hours behavior details below](#configure-call-settings-parameter-details) |
| `callback_permission_status`<br><br>_String_ | **Optional**<br><br>Configure whether a WhatsApp user is prompted with a call permission request after calling your business.<br><br>Note: The call permission request is triggered from either a missed or connected call.<br><br>[View callback permission status behavior details in the Parameter details section ](#configure-call-settings-parameter-details) | `"ENABLED"`<br><br>`"DISABLED"` |
| `sip`<br><br>_JSON object_ | **Optional**<br><br>Configure call signaling via signal initiation protocol (SIP).<br><br>**Note: When SIP is enabled, you cannot use calling related endpoints and will not receive calling related webhooks.**<br><br>[Learn how to configure and use SIP call signaling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip) | ```curl
"sip": {
   "status": "ENABLED \| DISABLED (default)",
   "servers": [// one server per app]
     {
       "hostname": SIP_SERVER_HOSTNAME
       "port": SIP_SERVER_PORT,
       "request_uri_user_params": {
         "KEY1": "VALUE1", // for cases like TGRP
         "KEY2": "VALUE2",
       }
     }
   ]
 }
``` |

#### Parameter details: Calling status {#configure-call-settings-parameter-details}

When the `status` parameter is set to `"ENABLED"`, calling features are enabled for the business phone number. WhatsApp client applications render the call button icon in both the business chat and business chat profile.

When the `status` parameter is set to `"DISABLED"`, calling features are **disabled**, and both the business chat and business chat profile **do not display the call button icon.**

Updates to `status` update the call button icon in existing business chats in near real-time when the business phone number is in the WhatsApp user's contacts.

Otherwise, updates are near real-time for a limited number of users in conversation with the business, and are eventually updated for the rest of the conversations.

#### Parameter details: Call button icon visibility

When Calling API features are enabled for a business number, you can still choose whether to show the call button icon or not by using the `call_icon_visibility` parameter. Note: Disabling call button icon visibility **does not** disable a WhatsApp user's ability to make unsolicited calls to your business.

The behavior for supported options is as follows:

`DEFAULT`

The call button icon appears in the chat menu bar and the business info page, allowing for unsolicited calls to the business by WhatsApp users.

`DISABLE ALL`

The call button icon is hidden in the chat menu bar and the business info page, and all other entry points external to the chat are also disabled. WhatsApp users cannot make unsolicited calls to the business.

Your business can still [send interactive messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#send-interactive-message-with-a-whatsapp-call-button) or [template messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-button-messages-deep-links#create-and-send-whatsapp-call-button-template-message) with a Calling API CTA button.

##### Callback permissions

Calling a WhatsApp user requires explicit permission from the user. One way to obtain calling permissions is to request permission when a WhatsApp user calls your business.

You can configure the call permission UI to automatically show in the WhatsApp user's client app when they call your business number. The user may change their permission selection at any time.

#### Call hours

With the `call_hours` setting, you can specify the timezone, business operating hours, and holiday schedules that will be enforced for all user-initiated calls.

Configuring this setting restricts calls only to available weekly hours you configure. User-initiated calls are unavailable outside of the weekly hours and holiday schedules you set.

The WhatsApp client app shows users an option to chat with the business, or request a callback, if `callback_permission_status` is `ENABLED`. The user also sees the next available calling slot on the option screen.

```curl
"call_hours": {
  "status": "ENABLED",
  "timezone_id": "America/Manaus",
  "weekly_operating_hours": [
    {
      "day_of_week": "MONDAY",
      "open_time": "04:00",
      "close_time": "10:20"
    },
    {
      "day_of_week": "TUESDAY",
      "open_time": "01:08",
      "close_time": "10:20"
    }
  ],
  "holiday_schedule": [
    {
      "date": "2026-01-01",
      "start_time": "00:00",
      "end_time": "23:59"
    }
  ]
}
```

| Parameter | Description | Sample Values |
| --- | --- | --- |
| `status`<br><br>_String_ | **Required**<br><br><br>Enable or disable the call hours for your business.<br><br>If call hours are disabled, your business is considered open 24 hours a day, 7 days a week. | `"ENABLED"`<br><br>`"DISABLED"` |
| `timezone_id`<br><br>_String_ | **Required**<br><br>The timezone your business operates in.<br><br>[Learn more about supported values for `timezone_id`](https://developers.facebook.com/docs/facebook-business-extension/fbe/reference#time-zones) | `"America/Menominee"`<br><br>`"Asia/Singapore"` |
| `weekly_operating_hours`<br><br>_List of JSON objects_ | **Required**<br><br>The operating hours schedule for each day of the week.<br><br>Each entry is a JSON object with three key-value pairs:<br><br>`day_of_week` — (_Enum_) **[Required]**<br><br>The day of the week.<br><br>Can take one of seven values: `"MONDAY"`, `"TUESDAY"`, `"WEDNESDAY"`, `"THURSDAY"`, `"FRIDAY"`, `"SATURDAY"`, `"SUNDAY"`<br><br>`open_time` \| `close_time` — (_Integer_) **[Required]**<br><br>Opening and closing times represented in 24 hour format, for example `"1130"` = 11:30AM<br><br>* A maximum of two entries is allowed per day of the week<br>* `open_time` must be before `close_time`<br>* Overlapping entries not allowed | ```curl
{
"day_of_week": "MONDAY",
"open_time": "0400",
"close_time": "1020"
},
{
"day_of_week":"TUESDAY",
"open_time": "0108",
"close_time": "1020"
}
...
``` |
| `holiday_schedule`<br><br>_String_ | **Optional**<br><br>An optional override to the weekly schedule.<br><br>Up to 20 overrides can be specified.<br><br>Note: If `holiday_schedule` is not passed in the request, then the existing `holiday_schedule` will be deleted and replaced with an empty schedule.<br><br>`date` — (_String_) **[Required]**<br><br>Date for which you want to specify the override.<br><br>YYYY-MM-DD format.<br><br>`open_time` \| `close_time` — (_Integer_) **[Required]**<br><br>Opening and closing times represented in 24 hour format, for example, `"1130"` = 11:30AM<br><br>* A maximum of two entries is allowed per day of the week<br>* `open_time` must be before `close_time`<br>* Overlapping entries not allowed | ```curl
{
"date": "2026-01-01",
"start_time": "0000",
"end_time": "2359",
}
...
``` |

#### Success response

```curl
{
  "success": true
}
```

#### Error response

Possible errors that can occur:

* Permissions/Authorization errors
* Invalid status
* Invalid schedule for `call_hours`
* Holiday given in `call_hours` is a past date
* Timezone is invalid in `call_hours`
* `weekly_operating_hours` in `call_hours` cannot be empty
* Date format in `holiday_schedule` for call_hours is invalid
* More than 2 entries not allowed in `weekly_operating_hours` schedule in `call_hours`
* Overlapping schedule in `call_hours` is not allowed

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting).

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).

### Get phone number calling settings

Use the [Settings API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/settings-api#get-version-phone-number-id-settings) to retrieve Calling API settings on an individual business phone number you designate in the request syntax.

This endpoint can return information for other Cloud API feature settings.

#### Request syntax

```https
POST /<PHONE_NUMBER_ID>/settings
```

#### Endpoint parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number for which you are getting Calling API settings.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### App permission required

`whatsapp_business_management`: Advanced access is required to use the API for end business clients

#### Response body

```curl
{
  "calling": {
    "status": "ENABLED",
    "call_icon_visibility": "DEFAULT",
    "call_hours": {
      "status": "ENABLED",
      "timezone_id": "America/Manaus",
      "weekly_operating_hours": [
        {
          "day_of_week": "MONDAY",
          "open_time": "0400",
          "close_time": "1020"
        },
        {
          "day_of_week": "TUESDAY",
          "open_time": "0108",
          "close_time": "1020"
        }
      ],
      "holiday_schedule": [
        {
          "date": "2026-01-01",
          "start_time": "0000",
          "end_time": "2359"
        }
      ]
    },
    "callback_permission_status": "ENABLED",
    "sip": {
      "status": "ENABLED | DISABLED (default)",
      "servers": [
        {
          "hostname": SIP_SERVER_HOSTNAME,
          "port": SIP_SERVER_PORT,
          "request_uri_user_params": {
            "KEY1": "VALUE1",
            "KEY2": "VALUE2"
          }
        }
      ]
    }
  }
}
```

#### Include SIP user password

To include SIP user credentials in the response body, add the SIP credentials query parameter to the POST request:

```https
POST /<PHONE_NUMBER_ID>/settings?include_sip_credentials=true
```

Where the response will look like this:

```curl
{
  "calling": {
    ... // other calling api settings
    "sip": {
      "status": "ENABLED",
      "servers": [
        {
          "hostname": "sip.example.com",
          "sip_user_password": "{SIP_USER_PASSWORD}"
        }
      ]
    }
  }
}
```

#### Response details

The `GET /<PHONE_NUMBER_ID>/settings` endpoint returns Calling API settings, along with other configuration information for your WhatsApp Business phone number.

[Learn more about Calling API settings and their values](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings#body-parameters)

#### Error response

Possible errors that can occur:

* Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

### Pre-accept call

When you pre-accept an inbound call, you allow the calling media connection to be established before attempting to send call media through the connection.

When you then call the accept call endpoint, media begins flowing immediately since the connection has already been established.

Pre-accepting calls is recommended because it facilitates faster connection times and avoids [audio clipping issues](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting#audio-clipping-issue-and-solution).

There is about 30 to 60 seconds after the [Call Connect webhook](#call-connect-webhook) is sent for the business to accept the phone call. If the business does not respond, the call is terminated on the WhatsApp user side with a "Not Answered" notification and a [Terminate Webhook](#call-terminate-webhook) is delivered back to you.

**Warning:** **Note:** Since the WebRTC connection is established before calling the [Accept Call endpoint](#accept-call), make sure to flow the call media only after you receive a 200 OK response back.

If call media flows too early, the caller will miss the first few words of the call. If call media flows too late, callers will hear silence.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are using Calling API features from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "pre_accept",
  "session" : {
      "sdp_type" : "answer",
      "sdp" : "<<RFC 8866 SDP>>"
   }
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Optional**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"pre_accept"` |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](#sdp-overview-and-sample-sdp-structures) | ```https
"session" :
{
"sdp_type" : "offer",
"sdp" : "<<RFC 8866 SDP>>"
}
``` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call-id`
* Invalid `phone-number-id`
* Error related to your payment method
* Invalid Connection info, for example, `sdp`, `ice`
* Accept/Reject an already In Progress/Completed/Failed call
* Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting).

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).

### Accept call

Use this endpoint to connect to a call by providing a call agent's SDP.

You have about 30 to 60 seconds after the [Call Connect Webhook](#call-connect-webhook) is sent to accept the phone call. If your business does not respond, the call is terminated on the WhatsApp user side with a "Not Answered" notification and a [Terminate Webhook](#call-terminate-webhook) is delivered back to you.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are using Calling API features from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "accept",
  "session" : {
      "sdp_type" : "answer",
      "sdp" : "<<RFC 8866 SDP>>"
   },
   "biz_opaque_callback_data": "random_string"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Optional**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"accept"` |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](#sdp-overview-and-sample-sdp-structures) | ```https
"session" :
{
"sdp_type" : "offer",
"sdp" : "<<RFC 8866 SDP>>"
}
``` |
| `biz_opaque_callback_data`<br><br>_String_ | **Optional**<br><br>An arbitrary string you can pass in that is useful for tracking and logging purposes.<br><br>Any app subscribed to the "calls" webhook field on your WhatsApp Business account can receive this string, as it is included in the `calls` object within the subsequent [Terminate webhook](#call-terminate-webhook) payload.<br><br>Cloud API does not process this field, it just returns it as part of the [Terminate webhook](#call-terminate-webhook).<br><br>Maximum 512 characters | `"8huas8d80nn"` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call-id`
* Invalid `phone-number-id`
* Error related to your payment method
* Invalid Connection info, for example, `sdp`, `ice`, or other connection parameters
* Accept/Reject an already In Progress/Completed/Failed call
* Permissions/Authorization errors
* SDP answer provided in accept does not match the SDP answer given in the [Pre-Accept endpoint](#pre-accept-call) for the same `call-id`

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting).

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).

### Reject call

Use this endpoint to reject a call.

You have about 30 to 60 seconds after the [Call Connect webhook](#call-connect-webhook) is sent to accept the phone call. If the business does not respond, the call is terminated on the WhatsApp user side with a "Not Answered" notification and a [Terminate Webhook](#call-terminate-webhook) is delivered back to you.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are using Calling API features from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "reject"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Optional**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"reject"` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call-id`
* Invalid `phone-number-id`
* Accept/Reject an already In Progress/Completed/Failed call
* Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting).

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).

### Initiate call

Use this endpoint to initiate a call to a WhatsApp user by providing a phone number and a WebRTC call offer.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Placeholder | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number from which you are initiating a new call.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+12784358810` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "to": "14085551234",
  "recipient": "US.13491208655302741918",
  "action": "connect",
  "session": {
    "sdp_type": "offer",
    "sdp": "<<RFC 8866 SDP>>"
  },
  "biz_opaque_callback_data": "0fS5cePMok"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `to`<br><br>_Integer_ | **Required** (unless `recipient` is provided)<br><br>The phone number being called (callee). You can identify the user by their phone number here, by their business-scoped user ID (BSUID) in `recipient`, or both. | `"17863476655"` |
| `recipient`<br><br>_String_ | **Optional**<br><br>The WhatsApp user's business-scoped user ID (BSUID) or parent BSUID. Use this instead of, or in addition to, `to`. If you include both `to` and `recipient`, `to` takes precedence.<br><br>[Learn more about business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) | `US.13491208655302741918` |
| `action`<br><br>_String_ | **Required**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"connect"` |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](#sdp-overview-and-sample-sdp-structures) | ```https
"session" :
{
"sdp_type" : "offer",
"sdp" : "<<RFC 8866 SDP>>"
}
``` |
| `biz_opaque_callback_data`<br><br>_String_ | **Optional**<br><br>An arbitrary string you can pass in that is useful for tracking and logging purposes.<br><br>Any app subscribed to the "calls" webhook field on your WhatsApp Business account can receive this string, as it is included in the `calls` object within the subsequent [Call Terminate Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#call-terminate-webhook) payload.<br><br>Cloud API does not process this field.<br><br>Maximum 512 characters | `"0fS5cePMok"` |

**Note:** **Usernames and business-scoped user IDs:** You can call a WhatsApp user using their phone number (`to`) and/or their business-scoped user ID (`recipient`). If you include both, `to` takes precedence. For details on usernames and BSUIDs, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "calls" : [{
     "id" : "wacid.ABGGFjFVU2AfAgo6V",
   }]
}
```

#### Error response

Possible errors that can occur:

* Invalid `phone-number-id`
* Permissions/Authorization errors
* Request format validation errors, for example, connection info, `sdp`, `ice`
* SDP validation errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting).

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).

### Terminate call

Use this endpoint to terminate an active call.

This must be done even if there is an `RTCP BYE` packet in the media path. Ending the call this way also ensures pricing is more accurate.

When the WhatsApp user terminates the call, you do not have to call this endpoint. Once the call is successfully terminated, a [Call Terminate Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#call-terminate-webhook) will be sent to you.

#### Request syntax

```https
POST <PHONE_NUMBER_ID>/calls
```

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_Integer_ | **Required**<br><br>The business phone number which you are terminating a call from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `18274459827` |

#### Request body

```https
{
  "messaging_product": "whatsapp",
  "call_id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
  "action": "terminate"
}
```

#### Body parameters

| Parameter | Description | Sample Value |
| --- | --- | --- |
| `call_id`<br><br>_String_ | **Required**<br><br>The ID of the phone call.<br><br>For inbound calls, you receive a call ID from the [Call Connect webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#call-connect-webhook) when a WhatsApp user initiates the call. | `"wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh"` |
| `action`<br><br>_String_ | **Required**<br><br>The action being taken on the given call ID.<br><br>Values can be `connect` \| `pre_accept` \| `accept` \| `reject` \| `terminate` | `"terminate"` |

#### Success response

```https
{
  "messaging_product": "whatsapp",
  "success" : true
}
```

#### Error response

Possible errors that can occur:

* Invalid `call id`
* Invalid `phone-number-id`
* The WhatsApp user has already terminated the call
* Reject call is already in progress
* Permissions/Authorization errors

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting).

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).

### Get current call permission state

Use this endpoint to get the call permission state for a business phone number with a single WhatsApp user. You can identify the user by their phone number (`user_wa_id`) or by their business-scoped user ID (`recipient`).

#### Request syntax

```https
GET /<PHONE_NUMBER_ID>/call_permissions?user_wa_id=<CONSUMER_WHATSAPP_ID>
```

Or, identify the user by their business-scoped user ID (BSUID) or parent BSUID:

```https
GET /<PHONE_NUMBER_ID>/call_permissions?recipient=<BSUID>
```

**Note:** **Usernames and business-scoped user IDs:** You can identify the WhatsApp user by their phone number (`user_wa_id`) or their business-scoped user ID (`recipient`). For details on usernames and BSUIDs, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### Request parameters
| Parameter | Description | Sample Value |
| --- | --- | --- |
| `<PHONE_NUMBER_ID>`<br><br>_String_ | **Required**<br><br>The business phone number you are fetching permissions against.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+18762639988` |
| `<CONSUMER_WHATSAPP_ID>`<br><br>_Integer_ | **Required** (unless `recipient` is provided)<br><br>The phone number of the WhatsApp user who you are requesting call permissions from.<br><br>[Learn more about formatting phone numbers in Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) | `+13057765456` |
| `recipient`<br><br>_String_ | **Optional**<br><br>The business-scoped user ID (BSUID) or parent BSUID of the WhatsApp user you are requesting call permissions from. Use this instead of `user_wa_id`.<br><br>[Learn more about business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) | `US.13491208655302741918` |

#### Response body

```https
{
  "messaging_product": "whatsapp",
  "permission": {
    "status": "temporary",
    "expiration_time": 1745343479
  },
  "actions": [
    {
      "action_name": "send_call_permission_request",
      "can_perform_action": true,
      "limits": [
        {
          "time_period": "PT24H",
          "max_allowed": 1,
          "current_usage": 0,
        },
        {
          "time_period": "P7D",
          "max_allowed": 2,
          "current_usage": 1,
        }
      ]
    },
    {
      "action_name": "start_call",
      "can_perform_action": false,
      "limits": [
        {
          "time_period": "PT24H",
          "max_allowed": 5,
          "current_usage": 5,
          "limit_expiration_time": 1745622600,
        }
      ]
    }
  ]
}
```

#### Response parameters

| Parameter | Description |
| --- | --- |
| `permission`<br><br>_JSON Object_ | The permission object contains two values:<br><br>`status` _(String)_ — The current status of the permission.<br><br>Can be either:<br><br>* `"no_permission"`<br>* `"temporary"`<br><br>`expiration` _(Integer)_ — The Unix time at which the permission will expire in UTC timezone. |
| `actions`<br><br>_JSON Object_ | A list of actions a business phone number may undertake to facilitate a call permission or a business initiated call.<br><br>Current actions are:<br><br>`send_call_permission_request`: Represents the action of sending new call permissions request messages to the WhatsApp user.<br><br>`start_call`: Represents the action of establishing a new call with the WhatsApp user. Establishing a new call means that the call was successfully picked up by the WhatsApp user.<br><br>For example, `send_call_permission_request` having a `can_perform_action` of `true` means that your business can send a call permission request to the WhatsApp user in question.<br><br>`can_perform_action` (_Boolean_) —<br><br>A flag indicating whether the action can be performed now, taking into account all limits. |
| `limits`<br><br>_JSON Object_ | A list of time-bound restrictions for the given `action_name`.<br><br>Each `action_name` has one or more restrictions depending on the timeframe.<br><br>For example, your business can send only 2 permission requests in a 24-hour period.<br><br>`limits` contains the following fields:<br><br>`time_period` (_String_) — The span of time in which the limit applies, represented in the ISO 8601 format.<br><br>`max_allowed` (_Integer_) — The maximum number of actions allowed within the specified time period.<br><br>`current_usage` (_Integer_) — The current number of actions your business has taken within the specified time period.<br><br>`limit_expiration_time` (_Integer_) — The Unix time at which the limit will expire in UTC timezone.<br><br>If `current_usage` is under the max allowed for the limit, this field won't be present. |

#### Error response

Possible errors that can occur:

* Invalid `phone-number-id`
* If the WhatsApp user's phone number is uncallable, the API response will be `no_permission`.
* Permissions/Authorization errors.
* Rate limit reached. A maximum of 5 requests in a one-second window can be made to the API.
* Calling is not enabled for the business phone number.

[View Calling API Error Codes and Troubleshooting for more information](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting)

[View general Cloud API Error Codes here](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)

## Calling API Webhooks

### Call Connect webhook

WhatsApp sends a webhook notification in near real-time when a call initiated by your business is ready to be connected to the WhatsApp user (an `SDP Answer`).

Critically, the webhook contains information required to establish a call connection via WebRTC.

Once you receive the Call Connect webhook, you can apply the `SDP Answer` received in the webhook to your WebRTC stack in order to initiate the media connection.

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "16315553601",
              "phone_number_id": "<PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<CALLEE_NAME>",
                  "username": "<USERNAME>"
                },
                "wa_id": "16315553602",
                "user_id": "<BSUID>",
                "parent_user_id": "<PARENT_BSUID>"
              }
            ],
            "calls": [
              {
                "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
                "to": "16315553601",
                "to_user_id": "<BSUID>",
                "to_parent_user_id": "<PARENT_BSUID>",
                "from": "16315553602",
                "event": "connect",
                "timestamp": "1671644824",
                "direction": "BUSINESS_INITIATED",
                "session": {
                  "sdp_type": "answer",
                  "sdp": "<<RFC 8866 SDP>>"
                }
              }
            ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

#### Webhook values for `"calls"`

| Placeholder | Description |
| --- | --- |
| `id`<br><br>_String_ | A unique ID for the call |
| `to`<br><br>_String_ | The number being called (callee). May be omitted if the user has adopted a username and the phone number cannot be included. |
| `to_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids) of the WhatsApp user. |
| `to_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `from`<br><br>_String_ | The number of the caller |
| `event`<br><br>_String_ | The calling event that this webhook is notifying the subscriber of |
| `timestamp`<br><br>_String_ | The UNIX timestamp of the webhook event |
| `direction`<br><br>_String_ | The direction of the call being made.<br><br>Can contain either:<br><br>`BUSINESS_INITIATED`, for calls initiated by your business.<br><br>`USER_INITIATED`, for calls initiated by a WhatsApp user. |
| `session`<br><br>_JSON object_ | **Optional**<br><br>Contains the session description protocol (SDP) type and description language.<br><br>Requires two values:<br><br>`sdp_type` — (_String_) **Required**<br><br>"offer", to indicate SDP offer<br><br>`sdp` — (_String_) **Required**<br><br>The SDP info of the device on the other end of the call. The SDP must be compliant with [RFC 8866](https://datatracker.ietf.org/doc/html/rfc8866).<br><br>[Learn more about Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc8866.html)<br><br>[View example SDP structures](#sdp-overview-and-sample-sdp-structures) |
| `contacts`<br><br>_JSON object_ | Profile information of the callee.<br><br>`name` — The WhatsApp profile name of the callee.<br><br>`username` — **Optional.** The username of the callee, if the user has adopted a username.<br><br>`wa_id` — The WhatsApp ID of the callee. May be omitted if the user has adopted a username and the phone number cannot be included.<br><br>`user_id` — The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids) of the callee.<br><br>`parent_user_id` — **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the callee. Only included if parent BSUIDs are enabled. |

### Call created webhook

WhatsApp sends a webhook notification when a SIP call is attempted. This applies to both business-initiated and user-initiated SIP calls. For non-SIP calls using the Graph API, see the [Call Connect webhook](#call-connect-webhook) instead.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "16315553601",
              "phone_number_id": "<PHONE_NUMBER_ID>"
            },
            "contacts": [
              {
                "profile": {
                  "name": "<CALLEE_NAME>",
                  "username": "<USERNAME>"
                },
                "wa_id": "16315553602",
                "user_id": "<BSUID>",
                "parent_user_id": "<PARENT_BSUID>"
              }
            ],
            "calls": [
              {
                "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
                "to": "16315553601",
                "to_user_id": "<BSUID>",
                "to_parent_user_id": "<PARENT_BSUID>",
                "from": "16315553602",
                "event": "call_created",
                "timestamp": "1671644824",
                "direction": "BUSINESS_INITIATED"
              }
            ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

#### Webhook values for `"calls"`

The field descriptions are the same as those in the [Call Connect webhook](#call-connect-webhook) section above, with the exception that SIP call webhooks do not include the `session` object since call signaling is handled via SIP rather than WebRTC.

### Call status webhook

This webhook is sent during the following calling events:

1. Ringing: When the WhatsApp user's client device begins ringing
1. Accepted: When the WhatsApp user accepts the call
1. Rejected: When the call is rejected by the WhatsApp user

The Webhook structure here is similar to the Status webhooks used for the Cloud API messages.

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
              "messaging_product": "whatsapp",
              "metadata": {
                   "display_phone_number": "16315553601",
                   "phone_number_id": "<PHONE_NUMBER_ID>",
              },
              "statuses": [{
                    "id": "wacid.ABGGFjFVU2AfAgo6V",
                    "timestamp": "1671644824",
                    "type": "call"
                    "status": "[RINGING|ACCEPTED|REJECTED]",
                    "recipient_id": "163155536021",
                    "recipient_user_id": "<BSUID>",
                    "recipient_parent_user_id": "<PARENT_BSUID>",
                    "biz_opaque_callback_data": "random_string",
               }]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

[_Learn more about Cloud API status webhooks_](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)

#### Webhook values for `"statuses"`

| Placeholder | Description |
| --- | --- |
| `id`<br><br>_String_ | A unique ID for the call |
| `timestamp`<br><br>_String_ | The UNIX timestamp of the webhook event |
| `recipient_id`<br><br>_String_ | The phone number of the WhatsApp user receiving the call. May be omitted if the user has adopted a username and the phone number cannot be included. |
| `recipient_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids) of the WhatsApp user receiving the call. |
| `recipient_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user receiving the call. Only included if parent BSUIDs are enabled. |
| `status`<br><br>_String_ | The current call status.<br><br>Possible values:<br><br>`RINGING`: Business initiated call is ringing the user<br><br>`ACCEPTED`: Business initiated call is accepted by the user<br><br>`REJECTED`: Business initiated call is rejected by the user |
| `biz_opaque_callback_data`<br><br>_String_ | Arbitrary string your business passes into the call for tracking and logging purposes.<br><br>Will only be returned if provided through [Initiate New Call API requests](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls#initiate-a-new-call) |

### Call terminate webhook

WhatsApp sends a webhook notification whenever the call has been terminated for any reason, such as when the WhatsApp user hangs up, or when the business calls the `POST /<PHONE_NUMBER_ID>/calls` endpoint with an action of `terminate` or `reject`.

```https
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
              "messaging_product": "whatsapp",
              "metadata": {
                   "display_phone_number": "16505553602",
                   "phone_number_id": "<PHONE_NUMBER_ID>",
              },
               "contacts": [
                {
                    "profile": {
                        "name": "<CALLEE_NAME>",
                        "username": "<USERNAME>"
                    },
                    "wa_id": "16315553601",
                    "user_id": "<BSUID>",
                    "parent_user_id": "<PARENT_BSUID>"
                }
              ],
               "calls": [
                {
                    "id": "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
                    "to": "16315553601",
                    "to_user_id": "<BSUID>",
                    "to_parent_user_id": "<PARENT_BSUID>",
                    "from": "16315553602",
                    "event": "terminate"
                    "direction": "BUSINESS_INITIATED",
                    "biz_opaque_callback_data": "random_string",
                    "timestamp": "1671644824",
                    "status" : [FAILED | COMPLETED],
                    "start_time" : "1671644824",
                    "end_time" : "1671644944",
                    "duration" : 120
                }
              ],
              "errors": [
                {
                    "code": INT_CODE,
                    "message": "ERROR_TITLE",
                    "href": "ERROR_HREF",
                    "error_data": {
                        "details": "ERROR_DETAILS"
                    }
                }
              ]
          },
          "field": "calls"
        }
      ]
    }
  ]
}
```

#### Webhook values for `"calls"`

| Placeholder | Description |
| --- | --- |
| `id`<br><br>_String_ | A unique ID for the call |
| `to`<br><br>_String_ | The number being called (callee). May be omitted if the user has adopted a username and the phone number cannot be included. |
| `to_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids) of the WhatsApp user. |
| `to_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `from`<br><br>_String_ | The number of the caller |
| `event`<br><br>_String_ | The calling event that this webhook is notifying the subscriber of |
| `timestamp`<br><br>_String_ | The UNIX timestamp of the webhook event |
| `direction`<br><br>_String_ | The direction of the call being made.<br><br>Can contain either:<br><br>`BUSINESS_INITIATED`, for calls initiated by your business.<br><br>`USER_INITIATED`, for calls initiated by a WhatsApp user. |
| `start_time`<br><br>_String_ | The UNIX timestamp of when the call started.<br><br>Only present when the call was picked up by the other party. |
| `end_time`<br><br>_String_ | The UNIX timestamp of when the call ended.<br><br>Only present when the call was picked up by the other party. |
| `duration`<br><br>_Integer_ | Duration of the call in seconds.<br><br>Only present when the call was picked up by the other party. |
| `biz_opaque_callback_data`<br><br>_String_ | Arbitrary string your business passes into the call for tracking and logging purposes.<br><br>Will only be returned if provided through [New Call API requests](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#initiate-call) or [Accept Call requests](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference#accept-call) |

### User calling permission request webhook

This webhook is sent back after requesting user calling permissions.

The webhook changes depending on if the user:

* accepts or rejects the request
* gives permission by responding to a request or by calling the business

**Note:** **Usernames and business-scoped user IDs:** This webhook also includes the WhatsApp user's business-scoped user ID in `from_user_id` (and `from_parent_user_id` if parent BSUIDs are enabled), and the user's phone number may be omitted. For details, see [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id).

#### Webhook sample

```https
{
. . .

"messages": [{
    "from": "{customer_phone_number}",
    "from_user_id": "<BSUID>",
    "from_parent_user_id": "<PARENT_BSUID>",
    "id": "wamid.sH0kFlaCGg0xcvZbgmg90lHrg2dL",
    "timestamp": "{timestamp}",
    "context": {
          "from": "{customer_phone_number}",
          "id": "wacid.gBGGFlaCmZ9plHrf2Mh-o"
    },
    "interactive": {
       "type":  "call_permission_reply",
        "call_permission_reply": {
            "response":"accept",
            "is_permanent":false,
            "expiration_timestamp": "{timestamp}",
            "response_source": "[user_action|automatic]"
       }
    }
 ],
. . .
}
```

#### Webhook values

| Placeholder | Description |
| --- | --- |
| `customer_phone_number`<br><br>_String_ | The phone number of the customer. May be omitted if the user has adopted a username and the phone number cannot be included. |
| `from_user_id`<br><br>_String_ | The [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#business-scoped-user-id) of the WhatsApp user. |
| `from_parent_user_id`<br><br>_String_ | **Optional.** The [parent BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#parent-business-scoped-user-ids) of the WhatsApp user. Only included if parent BSUIDs are enabled. |
| `context.id`<br><br>_String_ | Can be either of two values<br><br>* Message ID of the permission request message sent by the business to the customer number. Shows when a permission decision is made by the user in response to a call permission request.<br>* Call ID of the missed call placed by the business to the customer number. Shows when callback permission is enabled in settings and the user calls the business. |
| `response`<br><br>_String_ | The WhatsApp user's response to the call permission request message<br><br>Can be `accept` or `reject` |
| `expiration_timestamp`<br><br>_String_ | Time in seconds when this call permission expires if the WhatsApp user approved it |
| `response_source`<br><br>_String_ | The source of this permission<br><br>Possible values for accepted call permissions are:<br><br>* `user_action`: User approved or rejected the permission<br>* `automatic`: An automatic permission approval due to the WhatsApp user initiating the call |

## SDP overview and sample SDP structures

Session Description Protocol (SDP) is a text-based format that describes multimedia session characteristics, such as voice and video calls, in real-time communication applications. SDP provides a standardized way to convey information about the session's media streams, including the type of media, codecs, protocols, and other parameters necessary for establishing and managing the session.

In the context of WebRTC, SDP is used to negotiate the media parameters between the sender and receiver, enabling them to agree on the specifics of the media exchange.

### Business-initiated sample SDP structures

#### Sample SDP offer structure

```https
v=0
o=- 3626166318745852955 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS d8b26053-4474-4eb7-b3c3-c93d6c8c9b2e
m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 110 126
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:4g1c
a=ice-pwd:qY/Bb+jQzg5ICn6X4fhJQetk
a=ice-options:trickle
a=fingerprint:sha-256 35:47:24:24:9F:93:C4:3E:DB:37:7F:BB:ED:F8:20:B5:AD:AC:DC:35:C2:7D:67:EE:6C:35:54:DF:A6:00:5C:4A
a=setup:actpass
a=mid:0
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid
a=sendrecv
a=msid:d8b26053-4474-4eb7-b3c3-c93d6c8c9b2e 5b4d3d96-ea9b-44a8-87e6-11a1ad21a3bc
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=rtcp-fb:111 transport-cc
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:63 red/48000/2
a=fmtp:63 111/111
a=rtpmap:9 G722/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:110 telephone-event/48000
a=rtpmap:126 telephone-event/8000
a=ssrc:2220762577 cname:w/zwpg3jXNiTFTdZ
a=ssrc:2220762577 msid:d8b26053-4474-4eb7-b3c3-c93d6c8c9b2e 5b4d3d96-ea9b-44a8-87e6-11a1ad21a3bc
```

#### Sample SDP answer structure

```https
v=0
o=- 741807839102053725 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS 798a9670-c0d6-47a8-925e-5f082ef4d8a0
a=ice-lite
m=audio 3482 UDP/TLS/RTP/SAVPF 111 9 0 8 110 126
c=IN IP4 31.13.65.130
a=rtcp:9 IN IP4 0.0.0.0
a=candidate:2754936280 1 udp 2113937151 31.13.65.130 3482 typ host generation 0 network-cost 50 ufrag JHqAXFH4HcAY/8
a=candidate:1581496399 1 udp 2113939711 2a03:2880:f211:d1:face:b00c:0:699c 3482 typ host generation 0 network-cost 50 ufrag JHqAXFH4HcAY/8
a=ice-ufrag:JHqAXFH4HcAY/8
a=ice-pwd:dNNMmR8wUcGezvfBZOO0Qgcwl2m86GP/
a=ice-options:trickle
a=fingerprint:sha-256 9C:97:5C:4C:A9:BE:9E:2F:06:94:F5:BB:38:2C:A1:29:B5:69:B8:FA:94:10:56:1D:0B:5D:80:28:C1:FD:F0:F6
a=setup:active
a=mid:0
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=sendrecv
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=rtcp-fb:111 transport-cc
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:9 G722/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:110 telephone-event/48000
a=rtpmap:126 telephone-event/8000
a=ssrc:3407645770 cname:bg8KQDoIk2UJa6sf
a=ssrc:3407645770 msid:798a9670-c0d6-47a8-925e-5f082ef4d8a0 audio#nuxVMf9EAJX
a=ssrc:3407645770 mslabel:798a9670-c0d6-47a8-925e-5f082ef4d8a0
a=ssrc:3407645770 label:audio#nuxVMf9EAJX
```

### User-initiated sample SDP structures

#### Sample SDP offer structure

```https
v=0
o=- 7602563789789945080 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE audio
a=msid-semantic: WMS 6932bc1c-db1a-4abe-b437-0c4168be8a13
a=ice-lite
m=audio 40012 UDP/TLS/RTP/SAVPF 111 126
c=IN IP4 31.13.65.60
a=rtcp:9 IN IP4 0.0.0.0
a=candidate:1972637320 1 udp 2113937151 31.13.65.60 40012 typ host generation 0 network-cost 50 ufrag 6k2qP1R6kBfI/2
a=candidate:1652262791 1 udp 2113939711 2a03:2880:f211:cf:face:b00c:0:6443 40012 typ host generation 0 network-cost 50 ufrag 6k2qP1R6kBfI/2
a=ice-ufrag:6k2qP1R6kBfI/2
a=ice-pwd:UApvJw3NcwFRDvIMKdM0vWCdlXah25E9
a=fingerprint:sha-256 1B:B6:6B:40:A5:0B:8C:75:0D:8C:CB:90:2F:99:74:1E:26:45:AE:AF:45:C1:51:60:8F:73:C9:2D:10:6D:8A:88
a=setup:actpass
a=mid:audio
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=sendrecv
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=rtcp-fb:111 transport-cc
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:126 telephone-event/8000
a=ssrc:4208138518 cname:gAXq2V9TKltrnapv
a=ssrc:4208138518 msid:6932bc1c-db1a-4abe-b437-0c4168be8a13 audio#R5wfXFcdmT6
a=ssrc:4208138518 mslabel:6932bc1c-db1a-4abe-b437-0c4168be8a13
a=ssrc:4208138518 label:audio#R5wfXFcdmT6
```

#### Sample SDP answer structure

```https
v=0
o=- 2822644248144643933 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE audio
a=msid-semantic: WMS eb909cf0-87f0-4358-a4c9-7861680d9431
m=audio 9 UDP/TLS/RTP/SAVPF 111 126
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:X1ho
a=ice-pwd:7fJSbV2N5qWiA5QiDKwK3vuh
a=fingerprint:sha-256 2E:35:9F:21:9E:63:72:E5:42:74:76:2D:B3:70:F7:CB:24:14:9B:14:52:71:05:48:DA:4D:67:31:09:58:2A:ED
a=setup:active
a=mid:audio
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=sendrecv
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=rtcp-fb:111 transport-cc
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:126 telephone-event/8000
a=ssrc:330833028 cname:EDc1JutBl8rwHQc2
a=ssrc:330833028 msid:eb909cf0-87f0-4358-a4c9-7861680d9431 ea478c16-d9f7-493c-8cec-19bfac750a36
```

## Sample cURL requests

#### New call

```https
curl -i -X POST 'https://graph.facebook.com/v14.0/1234567890/calls' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAADUMAze4GIBO1B7B.....<REPLACE_WITH_YOUR_TOKEN>' \
-d '{
   "messaging_product": "whatsapp",
   "to": "14085550000",
   "recipient": "US.13491208655302741918",
   "session": {
       "sdp": "v=0\r\no=- 7669997803033704573 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS 3c28addc-03b7-4170-b5cd-535bfe767e75\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 110 126\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:6O0H\r\na=ice-pwd:TYCbtfOrBMPpfxFRgSbYnuTI\r\na=ice-options:trickle\r\na=fingerprint:sha-256 9F:45:2C:A8:C3:C0:CC:9B:59:4F:D1:02:56:52:FA:36:00:BE:C0:79:87:B3:D9:9C:3E:BF:60:98:25:B4:26:FC\r\na=setup:active\r\na=mid:0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\na=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\na=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\r\na=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid\r\na=sendrecv\r\na=msid:3c28addc-03b7-4170-b5cd-535bfe767e75 38c455bc-3727-4129-b336-8cd2c6a68486\r\na=rtcp-mux\r\na=rtcp-rsize\r\na=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:63 red/48000/2\r\na=fmtp:63 111/111\r\na=rtpmap:9 G722/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:110 telephone-event/48000\r\na=rtpmap:126 telephone-event/8000\r\na=ssrc:2430753100 cname:MPddPt/R2ioP4vCm\r\na=ssrc:2430753100 msid:3c28addc-03b7-4170-b5cd-535bfe767e75 38c455bc-3727-4129-b336-8cd2c6a68486\r\n",
       "sdp_type": "answer"
   }
}'
```

#### Terminate call

```https
curl -i -X POST 'https://graph.facebook.com/v14.0/1234567890/calls' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAADUMAze4GIBO1B7B.....<REPLACE_WITH_YOUR_TOKEN>' \
-d '{
   "messaging_product": "whatsapp",
   "action": "terminate",
   "call_id": "wacid.HBgLMTY1MDMxMzM5NzQVAgARGCBFRjNEODRBM0Q3NDZDM0Q0QzI4MzAwQjZBRkZGODM3NhwYCzEyMjQ1NTU0NDg5FQIAAA"
}'
```

#### Accept call

```https
curl -i -X POST 'https://graph.facebook.com/v14.0/1234567890/calls' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAADUMAze4GIBO1B7B.....<REPLACE_WITH_YOUR_TOKEN>' \
-d '{
 "messaging_product": "whatsapp",
 "to": "14085550000",
 "action": "accept",
 "call_id": "wacid.HBgLMTY1MDMxMzM5NzQVAgASGCA5ODkyMDk2RkM2NUM1QTYwRkM4NjFDQzk0NkQwNDBCRRwYCzEyMjQ1NTU0NDg5FQIAAA==",
 "session": {
     "sdp": "v=0\r\no=- 7669997803033704573 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS 3c28addc-03b7-4170-b5cd-535bfe767e75\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 110 126\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:6O0H\r\na=ice-pwd:TYCbtfOrBMPpfxFRgSbYnuTI\r\na=ice-options:trickle\r\na=fingerprint:sha-256 9F:45:2C:A8:C3:C0:CC:9B:59:4F:D1:02:56:52:FA:36:00:BE:C0:79:87:B3:D9:9C:3E:BF:60:98:25:B4:26:FC\r\na=setup:active\r\na=mid:0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\na=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\na=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\r\na=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid\r\na=sendrecv\r\na=msid:3c28addc-03b7-4170-b5cd-535bfe767e75 38c455bc-3727-4129-b336-8cd2c6a68486\r\na=rtcp-mux\r\na=rtcp-rsize\r\na=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:63 red/48000/2\r\na=fmtp:63 111/111\r\na=rtpmap:9 G722/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:110 telephone-event/48000\r\na=rtpmap:126 telephone-event/8000\r\na=ssrc:2430753100 cname:MPddPt/R2ioP4vCm\r\na=ssrc:2430753100 msid:3c28addc-03b7-4170-b5cd-535bfe767e75 38c455bc-3727-4129-b336-8cd2c6a68486\r\n",
     "sdp_type": "answer"
 }
}'
```

#### New call (using legacy connection param)

```https
curl -i -X POST 'https://graph.facebook.com/v14.0/123456789/calls' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer EAADUMAze4GIBO1B7B.....<REPLACE_WITH_YOUR_TOKEN>' \
-d '{
   "messaging_product": "whatsapp",
   "to": "14085550000",
   "connection": {
       "webrtc": {
           "sdp": "{\"sdp\":\"v=0\\r\\no=- 6314352886888624490 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\na=group:BUNDLE 0\\r\\na=extmap-allow-mixed\\r\\na=msid-semantic: WMS ccd3f422-8d7d-49c9-936c-a152979ee4fa\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 110 126\\r\\nc=IN IP4 0.0.0.0\\r\\na=rtcp:9 IN IP4 0.0.0.0\\r\\na=ice-ufrag:/PSS\\r\\na=ice-pwd:buBIz+JlbmakiCT7JdJIq/j0\\r\\na=ice-options:trickle\\r\\na=fingerprint:sha-256 43:08:34:16:67:E3:D9:A2:F5:AA:6A:AE:03:97:C8:D5:B8:F2:4B:40:79:C8:1A:44:53:69:4B:9C:89:88:D7:22\\r\\na=setup:active\\r\\na=mid:0\\r\\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\\r\\na=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\\r\\na=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\\r\\na=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid\\r\\na=sendrecv\\r\\na=msid:ccd3f422-8d7d-49c9-936c-a152979ee4fa 4e58b2a9-c864-4752-8f4f-23f9ced35971\\r\\na=rtcp-mux\\r\\na=rtcp-rsize\\r\\na=rtpmap:111 opus/48000/2\\r\\na=rtcp-fb:111 transport-cc\\r\\na=fmtp:111 minptime=10;useinbandfec=1\\r\\na=rtpmap:63 red/48000/2\\r\\na=fmtp:63 111/111\\r\\na=rtpmap:9 G722/8000\\r\\na=rtpmap:0 PCMU/8000\\r\\na=rtpmap:8 PCMA/8000\\r\\na=rtpmap:110 telephone-event/48000\\r\\na=rtpmap:126 telephone-event/8000\\r\\na=ssrc:3354317731 cname:zgqSj/r4rlErlW23\\r\\na=ssrc:3354317731 msid:ccd3f422-8d7d-49c9-936c-a152979ee4fa 4e58b2a9-c864-4752-8f4f-23f9ced35971\\r\\n\",\"type\":\"offer\"}"
       }
   }
}'
```

## Sample call connect webhook

#### Call connect webhook

```https
{
   "entry": [
       {
           "changes": [
               {
                   "field": "calls",
                   "value": {
                       "calls": [
                           {
                               "session": {
                                   "sdp_type": "answer",
                                   "sdp": "v=0\r\no=- 8076734947255960322 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS 68a296ba-41cc-41db-8edb-3ddf4dbbb483\r\na=ice-lite\r\nm=audio 3482 UDP/TLS/RTP/SAVPF 111 9 0 8 110 126\r\nc=IN IP4 31.13.65.130\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=candidate:2754936280 1 udp 2113937151 31.13.65.130 3482 typ host generation 0 network-cost 50 ufrag kv6Jn8vBmEds/8\r\na=candidate:1581496399 1 udp 2113939711 2a03:2880:f211:d1:face:b00c:0:699c 3482 typ host generation 0 network-cost 50 ufrag kv6Jn8vBmEds/8\r\na=ice-ufrag:kv6Jn8vBmEds/8\r\na=ice-pwd:OhY8sT7v6PJe3bbs0Yx2TC/oPb5oatnK\r\na=ice-options:trickle\r\na=fingerprint:sha-256 46:14:2B:31:B1:9D:AF:15:81:E2:EF:45:B1:2B:96:3D:64:0E:63:F1:CC:9A:BD:88:D6:32:8F:E9:2A:13:3A:38\r\na=setup:active\r\na=mid:0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\na=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\na=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\r\na=sendrecv\r\na=rtcp-mux\r\na=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:9 G722/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:110 telephone-event/48000\r\na=rtpmap:126 telephone-event/8000\r\na=ssrc:433528572 cname:VBDcSNi/cg1Wg6D3\r\na=ssrc:433528572 msid:68a296ba-41cc-41db-8edb-3ddf4dbbb483 audio#wx3mq6BITjB\r\na=ssrc:433528572 mslabel:68a296ba-41cc-41db-8edb-3ddf4dbbb483\r\na=ssrc:433528572 label:audio#wx3mq6BITjB\r\n"
                               },
                               "from": "15551112222",
                               "connection": {
                                   "webrtc": {
                                       "sdp": "{\"sdp\":\"v=0\\r\\no=- 8076734947255960322 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\na=group:BUNDLE 0\\r\\na=extmap-allow-mixed\\r\\na=msid-semantic: WMS 68a296ba-41cc-41db-8edb-3ddf4dbbb483\\r\\na=ice-lite\\r\\nm=audio 3482 UDP/TLS/RTP/SAVPF 111 9 0 8 110 126\\r\\nc=IN IP4 31.13.65.130\\r\\na=rtcp:9 IN IP4 0.0.0.0\\r\\na=candidate:2754936280 1 udp 2113937151 31.13.65.130 3482 typ host generation 0 network-cost 50 ufrag kv6Jn8vBmEds/8\\r\\na=candidate:1581496399 1 udp 2113939711 2a03:2880:f211:d1:face:b00c:0:699c 3482 typ host generation 0 network-cost 50 ufrag kv6Jn8vBmEds/8\\r\\na=ice-ufrag:kv6Jn8vBmEds/8\\r\\na=ice-pwd:OhY8sT7v6PJe3bbs0Yx2TC/oPb5oatnK\\r\\na=ice-options:trickle\\r\\na=fingerprint:sha-256 46:14:2B:31:B1:9D:AF:15:81:E2:EF:45:B1:2B:96:3D:64:0E:63:F1:CC:9A:BD:88:D6:32:8F:E9:2A:13:3A:38\\r\\na=setup:active\\r\\na=mid:0\\r\\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\\r\\na=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\\r\\na=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\\r\\na=sendrecv\\r\\na=rtcp-mux\\r\\na=rtpmap:111 opus/48000/2\\r\\na=rtcp-fb:111 transport-cc\\r\\na=fmtp:111 minptime=10;useinbandfec=1\\r\\na=rtpmap:9 G722/8000\\r\\na=rtpmap:0 PCMU/8000\\r\\na=rtpmap:8 PCMA/8000\\r\\na=rtpmap:110 telephone-event/48000\\r\\na=rtpmap:126 telephone-event/8000\\r\\na=ssrc:433528572 cname:VBDcSNi/cg1Wg6D3\\r\\na=ssrc:433528572 msid:68a296ba-41cc-41db-8edb-3ddf4dbbb483 audio#wx3mq6BITjB\\r\\na=ssrc:433528572 mslabel:68a296ba-41cc-41db-8edb-3ddf4dbbb483\\r\\na=ssrc:433528572 label:audio#wx3mq6BITjB\\r\\n\",\"type\":\"answer\"}"
                                   }
                               },
                               "id": "wacid.HBgLMTY1MDMxMzM5NzQVAgARGCAwQTJCRDYwNkEzQUNCQUVCMEFGMzYzRTYxNjMxMDdFMxwYCzE0MDg1NTUyODk5FQIAAA==",
                               "to": "16501230000",
                               "to_user_id": "<BSUID>",
                               "to_parent_user_id": "<PARENT_BSUID>",
                               "event": "connect",
                               "timestamp": "1724467313",
                               "direction": "BUSINESS_INITIATED"
                           }
                       ],
                       "contacts": [
                           {
                               "profile": {
                                   "name": "<CALLEE_NAME>",
                                   "username": "<USERNAME>"
                               },
                               "wa_id": "16501230000",
                               "user_id": "<BSUID>",
                               "parent_user_id": "<PARENT_BSUID>"
                           }
                       ],
                       "metadata": {
                           "phone_number_id": "105615555715855",
                           "display_phone_number": "15551112222"
                       },
                       "messaging_product": "whatsapp"
                   }
               }
           ],
           "id": "112735964992110"
       }
   ],
   "object": "whatsapp_business_account"
}
```
