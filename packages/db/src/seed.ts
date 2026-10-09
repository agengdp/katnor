/**
 * Idempotent first-run seed, for a CLI or scripted install.
 *
 * All of the actual work lives in ./bootstrap.ts, which the browser setup
 * wizard (apps/server's `setup.complete`) calls too - see that file for
 * why the two share one definition of "set up". This script is the thin
 * CLI wrapper: read env, call bootstrap, print what happened.
 *
 * The browser wizard is the easier path for a plain `docker compose up`:
 * start the stack, open the dashboard, and it walks you through the same
 * steps. This script stays for scripted and unattended installs, where
 * there is nobody to fill in a form.
 *
 * Run after `db:post-migrate`, e.g.:
 *   pnpm db:generate && pnpm db:migrate && pnpm db:post-migrate && pnpm db:seed
 */
import { client } from './client.js';
import {
  createFirstUserWithPasswordHash,
  ensureCompanyBootstrap,
  needsSetup,
  SetupAlreadyCompleteError,
} from './bootstrap.js';

async function main() {
  const result = await ensureCompanyBootstrap(process.env.COMPANY_NAME?.trim() || undefined);

  console.log(
    result.companyCreated
      ? `[seed] created company: "${result.companyName}" (${result.companyId})`
      : `[seed] company already exists: "${result.companyName}" (${result.companyId})`,
  );
  console.log(
    result.ceoCreated
      ? '[seed] created system agent: "Nadia Reyes" (CEO)'
      : '[seed] system agent already exists',
  );
  console.log(`[seed] #general channel ready: (${result.generalChannelId})`);

  // The single user account: a chicken-and-egg problem otherwise,
  // since the dashboard requires already being logged in. Single-user
  // install, so this one account is the only one there will ever be -
  // Settings only changes its passcode afterwards.
  if (!(await needsSetup())) {
    console.log('[seed] a user account already exists - skipping owner bootstrap.');
  } else {
    const ownerPasscodeHash = process.env.OWNER_PASSCODE_HASH?.trim();
    if (ownerPasscodeHash) {
      try {
        const owner = await createFirstUserWithPasswordHash({
          name: process.env.OWNER_NAME?.trim() || 'Owner',
          passwordHash: ownerPasscodeHash,
        });
        console.log(`[seed] created single user account: ${owner.name} (${owner.id})`);
      } catch (err) {
        // Only reachable if an account appeared between the check above
        // and the insert - e.g. somebody completing the browser wizard at
        // the same moment. Not an error worth failing the seed over: the
        // install ends up in exactly the intended state either way.
        if (!(err instanceof SetupAlreadyCompleteError)) throw err;
        console.log('[seed] a user account was created concurrently - skipping owner bootstrap.');
      }
    } else {
      console.warn(
        '[seed] OWNER_PASSCODE_HASH is not set - no user account created. ' +
          'Nobody can log in until one exists. Either set it in .env and re-run db:seed, or ' +
          'just open the dashboard in a browser and complete the setup wizard, which creates ' +
          'the same account without needing a pre-computed hash.',
      );
    }
  }

  await client.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[seed] failed:', err);
  await client.end({ timeout: 1 });
  process.exit(1);
});
