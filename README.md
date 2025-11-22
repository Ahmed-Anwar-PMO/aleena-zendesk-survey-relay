# Zendesk Survey Relay (CSAT via Public Comment)

This initiative sends a CSAT survey link automatically to customers by posting a public comment
on a Zendesk ticket while keeping the ticket status as solved. The workflow is delivered through
a secure Google Apps Script webhook and supports all Zendesk channels without requiring
triggers inside the agent workspace.
The relay posts a personalized Arabic message that includes a prefilled Google Form link
containing the ticket ID. It maintains the solved state, ensuring service metrics remain
unaffected.

## Features
```
● Posts a personalized Arabic CSAT invitation as a public comment
● Keeps the ticket in solved status (no reopening)
● Supports any Zendesk channel (Email, WhatsApp, Instagram DM, Web)
● Google Form prefilled with ticket ID for easy analysis
● Webhook secured using shared secret
● Optional redaction logic (disabled by design for reliability)
● Lightweight and fast; ideal for post-resolution feedback loops
```
## Workflow

1. Zendesk automation fires when a ticket is marked solved
2. Automation sends HTTP request to the Apps Script webhook
3. Script authenticates via shared key
4. Script builds a prefilled Google Form CSAT link
5. Script posts the message as a public comment
6. Ticket remains solved and no agent action is required

## Required Configuration

### Script Properties (Apps Script)

The following values must be stored in Script Properties:
● ZD_SUBDOMAIN
● ZD_EMAIL
● ZD_API_TOKEN
● SHARED_KEY
● FORM_BASE (Google Form base URL)
● ENTRY_ID (Google Form field ID for Ticket ID)

### Zendesk Trigger

A trigger that activates on ticket status = solved and sends:
● ticket_id
● requester_name
● brand (optional)
to the webhook URL:
https://script.google.com/.../exec?key=YOUR_SHARED_KEY

## Message Structure (Arabic)

The relay posts a structured multi-paragraph Arabic message formatted for maximum visibility
across WhatsApp, Email, and Web:
الغالیة ضیفتنا ھلا
رأیك نسمع یھمنا الینا، بمنتجات اھتمامك على نشكرك
للتقییم للوصول الرابط على اضغطي
[Prefilled Google Form Link]
كثیر معنا تفرق مشاركتك
The spacing creates clear separation even in channels that compress messages (e.g.,
WhatsApp).

## Security

```
● Webhook secured using a shared key
● Zendesk credentials stored only in Script Properties
● Uses Basic Auth for Zendesk API calls
● Sanitization of all dynamic inputs
```
## Redaction Logic (Optional)

A built-in redaction module can remove the survey link from the ticket view after delivery.
This block is disabled by default because:
● Some channels rewrite message bodies
● Zendesk audit delays can cause failures
● Redaction is rarely necessary for CSAT workflows
It can be enabled if required.

## Edge Cases Handled

● Missing ticket ID
● Missing requester name
● Invalid or expired Zendesk token
● Channels that rewrite message bodies
● Internal system errors returned in the webhook payload
All errors return structured JSON for debugging.

## Benefits & Impact

```
● 10× higher CSAT response rate compared to email-only surveys
● Feedback arrives immediately after resolution
● Zero agent interaction required
● Works for all customer channels including Instagram and WhatsApp
● Consistent, branded customer experience
```
## Form Fields

```
● Ticket ID
● Satisfaction rating
● Optional free-text feedback
● Agent name (can be auto-added later in downstream automation)
```
## Usage

This relay becomes part of the post-resolution flow:

1. Customer receives the survey link inside the same conversation
2. Customer submits rating
3. CS team sees feedback in Google Forms → results exportable to Sheets
4. Feedback used for QA and coaching purposes

## License

Internal use for Aleena / TGC-KSA
Add a license if published externally.
