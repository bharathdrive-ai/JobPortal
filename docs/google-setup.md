# Google Drive setup for TalentHub (personal Google account)

TalentHub will store resumes in a private folder in **your** Google Drive and keep the
shared applications register in a Google Sheet in that folder. These steps connect
your Google account to TalentHub. They can only be done by you, signed in to Google.

> **Never paste a client secret, refresh token or downloaded JSON file into chat,
> email or the GitHub repository.** They go only into Vercel's private settings.

**Time needed:** about 15 minutes. **Cost:** free (Google Drive and Sheets APIs have no charge at this usage).

---

## Part A — Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account that should own the resumes.
2. Click the project picker (top bar) → **New project**.
3. Name it `TalentHub` → **Create**, then make sure it is the selected project.

## Part B — Turn on the two APIs

4. Go to **APIs & Services → Library**.
5. Search for **Google Drive API** → open it → **Enable**.
6. Back in the Library, search for **Google Sheets API** → **Enable**.

## Part C — Set up the consent screen

7. Go to **APIs & Services → OAuth consent screen** (shown as **Google Auth Platform**). Click **Get started**.
8. **App information:** App name `TalentHub`, User support email = your Gmail address.
9. **Audience:** choose **External**.
10. **Contact information:** your Gmail address → agree to the policy → **Create**.
11. Open **Data access** → **Add or remove scopes** → tick only
    **`.../auth/drive.file`** — *"See, edit, create and delete only the specific Google Drive files you use with this app."* → **Update** → **Save**.
    - Don't add the full "Google Drive" scope. With `drive.file`, TalentHub can only see the folder and files it creates, never the rest of your Drive.
12. Open **Audience** → under *Publishing status* click **Publish app** → confirm.
    - Why: while an app is in *Testing*, Google expires its access after **7 days**, which would silently stop resume uploads. `drive.file` doesn't need Google's review, so publishing is immediate.
    - When you approve access later, Google will warn that the app isn't verified. That's expected for your own app: choose **Advanced → Go to TalentHub**.

## Part D — Create the OAuth client

13. Open **Clients** → **Create client**.
14. **Application type:** **Desktop app**. Name: `TalentHub setup` → **Create**.
15. Click **Download JSON** and save the file **outside** the project folder (for example in `Documents\TalentHub-secrets\`).
    - This file holds the client ID and secret. Keep it private.
    - It's used once, by a setup command (`npm run google-auth`, added in the Drive step), which opens your browser for you to approve access and then prints the values for Vercel.

✅ **When Parts A–D are done, tell me "Google setup done".** Don't send the file or its contents.

---

## Part E — Settings TalentHub will store on Vercel

These live in **Vercel → talenthub-jobportal → Settings → Environment Variables** (marked *Sensitive*). They are never committed to GitHub.

| Name | Needed for | Where the value comes from |
|---|---|---|
| `SESSION_SECRET` | Step 1 — server sign-in (now) | A random 64-character value, generated for you |
| `GOOGLE_CLIENT_ID` | Steps 2–3 | The JSON file from Part D |
| `GOOGLE_CLIENT_SECRET` | Steps 2–3 | The JSON file from Part D |
| `GOOGLE_REFRESH_TOKEN` | Steps 2–3 | Printed by `npm run google-auth` after you approve access |
| `DRIVE_ROOT_FOLDER_ID` | Step 3 | Created by the setup command (the `TalentHub Resumes` folder) |
| `REGISTER_SHEET_ID` | Step 2 | Created by the setup command (the applications register sheet) |

## Good to know

- **Storage:** resumes count toward your Google account's free 15 GB, shared with Gmail and Photos.
- **Visibility:** the folder stays private to your account. TalentHub fetches files on behalf of signed-in users after checking their role. It never shares Drive links.
- **Revoking access:** you can disconnect TalentHub at any time at <https://myaccount.google.com/permissions>. Uploads stop until you run the setup command again.
- **If you change your Google password**, Google may revoke the refresh token. Rerun `npm run google-auth` and update `GOOGLE_REFRESH_TOKEN` on Vercel.
- **Moving to Google Workspace later** (a company account) lets TalentHub use a Shared Drive and a service account instead. The rest of the app stays the same.
