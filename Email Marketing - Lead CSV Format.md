# Email Marketing — Lead List Format

How to prepare your CSV file before uploading it to the Email Marketing page.

## Required columns

Your file needs a header row (the first row) with column names. At minimum, you need an **Email** column.

| Name  | Email                    |
|-------|---------------------------|
| imran | imran.zia@hotmail.com     |

- **Email** (required) — one email address per row. The column can be named `Email`, `E-mail`, `Email Address`, `Work Email`, or `Contact Email` — it's detected automatically. If none of those match, the first column in the file is used.
- **Name** (optional, but recommended) — used to personalize your list. Accepted column names: `Name`, `Full Name`, `Customer Name`, or `First Name`.

## Saving the file

If you're working in Google Sheets (like the example above):

1. **File → Download → Comma Separated Values (.csv)**
2. Upload that downloaded `.csv` file on the Email Marketing page.

## What happens on upload

- Every row is checked for a valid email format automatically.
- Rows with a missing or invalid email are skipped and won't be sent to — you'll see a count of "valid emails" vs. skipped rows after uploading.
- Duplicate email addresses in the same file are only sent once.
- There's no strict row limit, but very large lists are sent in batches automatically (150 at a time) with a progress bar — don't close the tab until it says the send is finished.

## One row per lead

Each row is one recipient. There's no limit on how many rows you add beyond the batching behavior above.
