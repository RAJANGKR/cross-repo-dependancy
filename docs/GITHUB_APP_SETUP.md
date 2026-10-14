# Private repositories with a GitHub App

DriftLock reads public repositories without any setup. To let people sign in and scan their **private** repositories, the backend needs a GitHub App. Users then decide, on GitHub, which repositories the App may read.

This guide covers registering the App, the settings DriftLock needs, and how to test, revoke and deploy it. Nothing here needs a secret in the source code: every credential goes in `backend/.env`, which is never committed.

## How it works

1. A visitor chooses **Sign in with GitHub**. GitHub asks them to authorize DriftLock. Signing in shares their public profile only.
2. DriftLock keeps the GitHub token on the backend, in a server-side session. The browser gets an HTTP-only cookie holding a random session id and the public profile, signed.
3. **Connect GitHub repositories** sends them to GitHub's installation page. They install the App on their account or an organization, choosing all repositories or selected ones. In an organization where they are not an owner, GitHub sends the request to an owner, and nothing is granted until it is approved.
4. GitHub sends them back to DriftLock's repository list, which shows only repositories that are both covered by the installation and visible to that user.
5. When a scan starts, the backend asks GitHub, with the user's own token, whether they can see each repository. For each private one it mints a GitHub App installation token narrowed to exactly that scan's repositories and to read-only permissions. The token expires within an hour and belongs to that scan alone.

Public repositories are always read the ordinary way. A signed-out scan of a private repository fails with "not found, or the repository is private"; it is never treated as an empty repository.

## 1. Register the App

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App** (for an organization: the organization's **Settings → Developer settings → GitHub Apps**).

| Field | Value for local development |
| --- | --- |
| GitHub App name | Anything unique, for example `DriftLock (yourname dev)`. Its URL name becomes `GITHUB_APP_SLUG`. |
| Homepage URL | `http://localhost:5173` |
| Callback URL | `http://localhost:8000/api/v1/auth/github/callback` |
| Expire user authorization tokens | Leave checked. DriftLock renews them with the refresh token. |
| Request user authorization (OAuth) during installation | Leave unchecked. Sign-in happens first in DriftLock. If you check it, set no Setup URL: DriftLock handles that variant too. |
| Setup URL | `http://localhost:8000/api/v1/auth/github/setup` |
| Redirect on update | Check it, so changing the App's repositories also returns to DriftLock. |
| Webhook | Uncheck **Active**. DriftLock does not use webhooks. |
| Where can this GitHub App be installed? | **Only on this account** while testing; **Any account** for other users and organizations. |

### Permissions: the minimum

Under **Repository permissions**, set only these:

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read-only | File trees, manifests, lockfiles, OpenAPI files and source archives. |
| Metadata | Read-only | Mandatory for every App; repository facts such as visibility and default branch. |

Leave every other permission at **No access**: no write access, no administration, no organization or account permissions. DriftLock never writes to a repository; its "Open pull request on GitHub" button sends the user to GitHub's own editor.

After **Create GitHub App**:

1. Note the **App ID** and the **Client ID**.
2. Under **Client secrets**, choose **Generate a new client secret** and copy it once.
3. Under **Private keys**, choose **Generate a private key**. A `.pem` file downloads. Keep it outside the repository, readable only by you.

## 2. Fill in `backend/.env`

Copy `backend/.env.example` to `backend/.env` if you have not, then fill in:

```
GITHUB_OAUTH_CLIENT_ID=<the App's Client ID>
GITHUB_OAUTH_CLIENT_SECRET=<the client secret you generated>
GITHUB_APP_ID=<the App ID>
GITHUB_APP_SLUG=<the App's URL name>
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/your-app.private-key.pem
SESSION_SECRET=<a long random string>
```

`GITHUB_APP_PRIVATE_KEY` can hold the PEM text on one line instead, with line breaks written as `\n`; use one or the other. `SESSION_SECRET` keeps sign-in cookies valid across restarts. Server-side sessions, and with them GitHub tokens, live in memory and still end when the backend restarts: users sign in again.

If `GITHUB_TOKEN` is set, give it no access to private repositories. DriftLock refuses to read a private repository with it, but there is no reason for it to have that access.

The backend needs `PyJWT[crypto]` (in `backend/requirements.txt`) to sign the App's tokens: `pip install -r backend/requirements.txt`.

## 3. Try the whole flow

1. Start the backend (`uvicorn app.main:app --reload --port 8000` in `backend/`) and the frontend (`npm run dev` in `frontend/`).
2. Open `http://localhost:5173`. The start page shows **Private repositories need your permission**. Choose **Sign in with GitHub** and authorize the App.
3. Choose **Choose from your repositories**, then **Connect GitHub repositories**. On GitHub, install the App and select a private test repository and a public one.
4. GitHub returns you to `http://localhost:5173/repositories?github_setup=install`. Both repositories are listed, with Private and Public labels.
5. Select both and choose **Scan 2 repositories**, or **Add to scan form** to set a branch, tag or commit first.
6. The scan reads the private repository's manifests, OpenAPI files and source code. Its results are visible to you only; another user, or a signed-out visitor, gets "not found" for that scan id.

To check refusal: sign in as a second GitHub user who cannot see the private repository, and paste its URL into the scan form. The scan is refused with "No access to a repository" before anything is read.

## 4. Remove access

- **One repository**: GitHub → **Settings → Applications → Installed GitHub Apps** → the App → **Configure** → remove it from **Selected repositories**. For an organization, the same under the organization's settings. DriftLock's **Manage repository access** link opens that page.
- **Everything**: on the same page, **Uninstall**. Running scans lose access at their next request and say so.
- **The user authorization**: GitHub → **Settings → Applications → Authorized GitHub Apps** → **Revoke**. The next DriftLock request asks the user to sign in again.
- **In DriftLock**: **Sign out** deletes the server-side session and the GitHub token with it.

## 5. Production

- Serve the backend and frontend over **HTTPS** only. Set `APP_ENV=production` so session cookies are marked `Secure`; they are `HttpOnly` and `SameSite=Lax` in every environment.
- In the App's settings, change the Callback URL to `https://<api host>/api/v1/auth/github/callback`, the Setup URL to `https://<api host>/api/v1/auth/github/setup` and the Homepage URL to the frontend's address. A GitHub App can list several callback URLs if you keep a local one.
- Set `CORS_ORIGINS` to the frontend's exact origin. Sign-in and installation return only to an origin in that list.
- Set the frontend's `VITE_API_BASE_URL` to the backend's HTTPS address.
- Keep the private key in your platform's secret store and point `GITHUB_APP_PRIVATE_KEY_PATH` at it, or put it in `GITHUB_APP_PRIVATE_KEY`. Rotate it from the App's settings page if it may have leaked.
- Sessions are kept in the backend process. Run one backend instance, or put sessions in a shared store before scaling out.

## What DriftLock keeps

| Data | Where | For how long |
| --- | --- | --- |
| The user's GitHub token and refresh token | Backend memory, in the session record | Until sign-out, session expiry (7 days), token refresh failure, or a backend restart. Never sent to the browser or logged. |
| Installation tokens | Backend memory, in one scan's HTTP client | That scan only; GitHub expires them within an hour. |
| Source archives and files of a private repository | Backend memory during the scan | Discarded when the scan ends. Never written to disk or to the cache. |
| Scan results: package names, versions, file paths, short code excerpts and contract findings | Backend memory | `SCAN_TTL_SECONDS` (2 hours by default). A scan that read a private repository is readable only by the user who started it. |
| Public upstream data (registry versions, release notes, advisories, public repository files) | SQLite cache (`CACHE_PATH`) | `CACHE_TTL_SECONDS`. Responses read with a private repository's token are never cached. |

Request URLs are not logged: GitHub's download links for private archives carry a short-lived token in the query string.
