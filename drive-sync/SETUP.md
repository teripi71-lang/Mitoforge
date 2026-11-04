# Set up private Drive sync

This puts a copy of your MitoForge data in **your** Google Drive. The public GitHub repo never sees it. You do this once, in the Google account your coach can read.

You will end up with two things to paste into the app on your phone:

- a Web app URL that ends in `/exec`
- a long sync token (a password you choose)

Do not email those, do not put them in GitHub, and do not paste them into a chat.

## 1. Open the script editor

1. On a computer, sign in to the Google account that should store the data.
2. Open [script.google.com](https://script.google.com).
3. Click **New project**.
4. Name the project `MitoForge Drive Sync` (click the title "Untitled project" at the top left).

## 2. Paste the script

1. Select everything in the `Code.gs` file (the function `myFunction` that Google put there) and delete it.
2. Open `drive-sync/Code.gs` from this project and copy the whole file.
3. Paste it into the editor.
4. Click the save icon (or Ctrl+S / Cmd+S).

There is no token in that file. That is intentional.

## 3. Choose the sync token

This token is the password the phone sends. Anyone who has both the URL and the token can overwrite the sync file in your Drive, so make it long and random.

1. Click the gear icon, **Project settings**.
2. Under **Script properties**, click **Add script property**.
3. Property: `SYNC_TOKEN`
4. Value: a long random string (at least 20 characters). A password manager's random password is a good choice. Write it down somewhere private; you will paste it into the phone.
5. Click **Save script properties**.

Leave the property name exactly `SYNC_TOKEN`. Do not click **Run** on `doGet` or `doPost`. Those run when the phone calls the web app.

If you would rather have the script invent one: in the editor, choose the function `createSyncToken` in the function dropdown, click **Run**, approve access once (see the authorization steps below), then open **Executions** and copy the logged token. This only works while the property is empty. Do not run it again later; it will refuse so it does not rotate a token your phone is already using.

## 4. Deploy the web app

1. Click **Deploy** → **New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Description: `MitoForge sync`.
4. Execute as: **Me**.
5. Who has access: **Anyone**.
6. Click **Deploy**.

"Anyone" means Google will run the script without asking the visitor to sign in. The script still rejects every request that does not have your token. The files stay in your Drive.

## 5. Authorize it

Google shows this because the script is one you wrote, not one from a public app store.

1. Click **Authorize access**, then **Review permissions** if that button appears.
2. Choose the same Google account.
3. On the screen that says Google hasn't verified this app, click **Advanced**.
4. Click **Go to MitoForge Drive Sync (unsafe)**.
5. Read the permission. It should say the app wants to see, edit, create, and delete all of your Google Drive files. That is the normal Drive permission this script uses. It only creates and updates the `Mitoforge` folder.
6. Click **Allow**.

If you never see Allow, and instead see a message that your organization blocked the app, the Google Workspace admin has to allow Apps Script. A personal Gmail account does not need that.

## 6. Copy the URL

After Deploy finishes, copy the **Web app URL**. It looks like:

`https://script.google.com/macros/s/…………/exec`

Use the one that ends in `/exec`, not `/dev`.

## 7. Paste it into MitoForge

On the phone, open the installed MitoForge app (or the site).

1. Tap your name at the top to open the menu.
2. Tap **Drive Sync**.
3. Paste the Web app URL.
4. Paste the sync token.
5. Tap **Save**, then **Test**. It should say the connection worked.
6. Tap **Sync now**.

In Google Drive, open My Drive. There should be a folder named `Mitoforge` with a file named `MitoForge sync (latest).json`. That file is the backup your coach can read. Each day also gets `MitoForge sync YYYY-MM-DD.json`. Days older than 30 are moved to Drive trash.

After this, the app sends an update about 15 seconds after you change something, and again when you open it. Nothing is sent before the URL and token are saved. Turning **Turn off** stops sending. The token stays on the phone until you clear the site data.

## If you change the script later

Apps Script does not update a deployment by itself.

1. In the editor, click **Deploy** → **Manage deployments**.
2. Click the pencil on the web app.
3. Version: **New version**.
4. Click **Deploy**.

The `/exec` URL stays the same. You do not paste a new URL into the phone.

## What never gets uploaded

The phone sends the same backup as **Back Up My Data**: every value whose name starts with `mf_`. Your AI coach API key and this sync token are stored under different names and are not in that backup. The script also drops the token before it writes the Drive file.
