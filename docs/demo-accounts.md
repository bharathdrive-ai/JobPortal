# TalentHub demo accounts

These accounts exist in `data/users.json` for demonstrating the prototype.
Only salted password hashes are stored in that file; the passwords below are
recorded here so testers can sign in. **This file is not deployed** (only
`public/` is published), but it is visible to anyone who can read the repository.
Do not reuse these passwords anywhere else, and replace them before any real use.

| Role (code)       | Sign in with (user ID or email)          | Password       |
|-------------------|------------------------------------------|----------------|
| Job Seeker (JS)   | `sneha.kulkarni` / sneha.kulkarni@talenthub.example | `Seeker#2026!` |
| Job Seeker (JS)   | `rohan.verma` / rohan.verma@talenthub.example       | `Seeker#2026!` |
| Job Poster (JP)   | `priya.raman` / priya.raman@talenthub.example       | `Poster#2026!` |
| Admin (AD)        | `arjun.mehta` / arjun.mehta@talenthub.example       | `Admin#2026!`  |

## Adding or changing an account

1. Create the password hash:
   ```bash
   npm run hash-password -- "a-strong-password"
   ```
2. Add (or update) the user in `data/users.json`, pasting the printed `password` object.
   Use a role code from the `roles` list: `JS`, `JP` or `AD`.
3. Commit and push. The build validates the file and rejects plain-text passwords.

Accounts created with **Create account** on the sign-in page are saved only in that
browser. An Admin can copy them as JSON from *Administration → User accounts* and
add them to `data/users.json` to make them available everywhere.
