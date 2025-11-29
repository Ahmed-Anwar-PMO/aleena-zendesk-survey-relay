# CSAT <> Zendesk Follow Up (Google Apps Script)

This project connects your CSAT survey responses in Google Sheets with Zendesk, so you can:

- Automatically detect which **agent** is responsible for a ticket.
- Write the agent’s name into a specific column in the **Form Responses** sheet.
- (Optional) Apply **follow-up logic** in Zendesk for very low CSAT scores (tags, status update, internal note).

It’s meant to save you from manually checking Zendesk every time a customer fills a survey.

---

## How it works (high level)

1. Customer fills in a **CSAT / survey form** that includes a Zendesk ticket number.
2. Responses land in a **Google Sheet** (Form Responses).
3. An Apps Script trigger runs on new/edited rows.
4. For each row:
   - It reads the **ticket ID** from the sheet.
   - Calls the **Zendesk API** to fetch ticket data, comments, and audits.
   - Determines the **responsible agent** (e.g., based on who sent the most public replies, or ticket solver/assignee as fallback).
   - Writes that agent’s name into the **CSAT Agent** column.
   - If the rating is very low and there’s a customer comment, it can
