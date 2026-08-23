/**
 * Mints a local development identity and prints its cookie, for the HTTP
 * harnesses that need an authenticated caller.
 *
 *   npx tsx scripts/ci/local-identity.ts [email]
 *
 * Imports the real `localSignIn` and `signLocalIdentity` rather than restating
 * the HMAC here, so the cookie this prints is exactly the cookie the app would
 * have issued — if the signing scheme changes, this changes with it.
 *
 * Only usable where local development auth is active. With a Supabase project
 * configured, `localAuthEnabled()` returns false and this exits non-zero rather
 * than minting something the app would reject.
 */
import {
  LOCAL_COOKIE,
  localAuthEnabled,
  localSignIn,
  signLocalIdentity,
} from '../../src/lib/auth/session';
import { closePool } from '../../src/lib/db/pg';

const email = process.argv[2] ?? 'ci-harness@example.test';

async function main() {
  if (!localAuthEnabled()) {
    console.error(
      'local development auth is not enabled here — cannot mint an identity.\n' +
        'This is expected against a real Supabase project; use a Supabase session cookie instead.',
    );
    process.exit(1);
  }
  const user = await localSignIn(email, 'CI Harness');
  process.stdout.write(`${LOCAL_COOKIE}=${signLocalIdentity(user.id)}\n`);
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error(e);
    await closePool();
    process.exit(1);
  });
