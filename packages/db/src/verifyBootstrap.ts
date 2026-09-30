/**
 * An integration check for the first-run bootstrap, run against a real
 * Postgres in CI (see .github/workflows/ci.yml's `db` job).
 *
 * This exists because the pieces it covers cannot be unit-tested in any
 * useful way and were shipped unverified:
 *
 *   - `createFirstUser` is the security boundary of the browser setup
 *     wizard. It is the only thing stopping a second person from claiming
 *     an install, and it leans on `pg_advisory_xact_lock` inside a drizzle
 *     transaction - a path nothing else in this codebase uses. A mock
 *     cannot tell you whether that lock actually serialises anything; only
 *     a real database can.
 *   - `ensureCompanyBootstrap` claims to be idempotent. Running it twice
 *     against a real database is the only way to find out.
 *   - `db:post-migrate` enables pgvector and installs the event-notify
 *     trigger. Both are plain SQL side effects with no other test.
 *
 * Deliberately a script rather than a vitest file: `pnpm test` runs
 * everywhere, including machines and CI jobs with no Postgres, and a suite
 * that silently skips its most important assertions when a database is
 * missing is worse than one that is never claimed to have run.
 *
 * Run with DATABASE_URL pointing at a THROWAWAY database. It deletes rows.
 */
import { client, db } from './client.js';
import {
  createFirstUser,
  ensureCompanyBootstrap,
  needsSetup,
  SetupAlreadyCompleteError,
} from './bootstrap.js';
import * as agentRepo from './repositories/agent.js';
import { channel, company, user } from './schema/index.js';
import { sql } from 'drizzle-orm';

let failures = 0;
let checks = 0;

function check(condition: boolean, description: string): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${description}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main() {
  section('post-migrate side effects');
  {
    const extensions = await db.execute(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    check([...extensions].length === 1, 'pgvector extension is installed');

    const triggers = await db.execute(
      sql`select tgname from pg_trigger where tgname = 'katnor_event_notify'`,
    );
    check([...triggers].length === 1, 'event-notify trigger is installed');

    // The whole point of pgvector here is the `<=>` distance operator the
    // knowledge search runs. Exercising it proves the extension is not just
    // present but usable, which "extension exists" alone does not.
    const distance = await db.execute(sql`select ('[1,0]'::vector <=> '[0,1]'::vector) as d`);
    const row = [...distance][0] as { d: unknown } | undefined;
    check(Number(row?.d) === 1, 'vector distance operator works');
  }

  section('a fresh install needs setup');
  {
    await db.delete(user);
    check(await needsSetup(), 'needsSetup() is true with no user rows');
  }

  section('ensureCompanyBootstrap is idempotent');
  {
    const first = await ensureCompanyBootstrap('Verify Co');
    check(first.companyName === 'Verify Co', 'company is created with the given name');

    const second = await ensureCompanyBootstrap('A Different Name');
    check(second.companyCreated === false, 'a second run does not create another company');
    check(second.ceoCreated === false, 'a second run does not create another CEO');
    check(
      second.companyId === first.companyId,
      'a second run returns the same company row, not a new one',
    );
    check(
      second.generalChannelId === first.generalChannelId,
      'a second run reuses the same #general channel',
    );

    const companies = await db.select().from(company);
    check(companies.length === 1, 'exactly one company row exists');

    const systemAgents = (await agentRepo.list()).filter((a) => a.is_system);
    check(systemAgents.length === 1, 'exactly one system agent exists');

    const generalChannels = (await db.select().from(channel)).filter((c) => c.kind === 'general');
    check(generalChannels.length === 1, 'exactly one #general channel exists');
  }

  section('the first account can be created, and only once');
  {
    const owner = await createFirstUser({
      name: 'Verify Owner',
      email: '  Verify.Owner@Example.COM  ',
      password: 'correct horse battery staple',
    });
    check(
      owner.email === 'verify.owner@example.com',
      'the email is trimmed and lowercased on the way in',
    );
    check(owner.password_hash.includes(':'), 'the password is stored as a salt:hash pair');
    check(
      !owner.password_hash.includes('correct horse'),
      'the raw password is not stored anywhere in the row',
    );
    check((await needsSetup()) === false, 'needsSetup() is false once an account exists');

    let rejected = false;
    try {
      await createFirstUser({
        name: 'Second Owner',
        email: 'second@example.com',
        password: 'another password entirely',
      });
    } catch (err) {
      rejected = err instanceof SetupAlreadyCompleteError;
    }
    check(rejected, 'a second createFirstUser is refused with SetupAlreadyCompleteError');
    check((await db.select().from(user)).length === 1, 'still exactly one user row');
  }

  section('concurrent setup attempts cannot produce two owners');
  {
    // The reason `createFirstUser` holds an advisory lock at all. Without
    // it, at READ COMMITTED every one of these would see zero rows and
    // every one would insert - different emails, so the unique constraint
    // does not save it. They are fired together, on separate pooled
    // connections, which is as close to the real race as this can get.
    await db.delete(user);

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_unused, i) =>
        createFirstUser({
          name: `Racer ${i}`,
          email: `racer-${i}@example.com`,
          password: 'a sufficiently long password',
        }),
      ),
    );

    const won = attempts.filter((a) => a.status === 'fulfilled');
    const lost = attempts.filter(
      (a) => a.status === 'rejected' && a.reason instanceof SetupAlreadyCompleteError,
    );
    const broke = attempts.filter(
      (a) => a.status === 'rejected' && !(a.reason instanceof SetupAlreadyCompleteError),
    );

    for (const failure of broke) {
      console.error('  unexpected rejection:', (failure as PromiseRejectedResult).reason);
    }

    check(won.length === 1, `exactly one of 5 concurrent attempts succeeded (got ${won.length})`);
    check(
      lost.length === 4,
      `the other 4 were refused as already-complete (got ${lost.length}, ${broke.length} failed otherwise)`,
    );
    check((await db.select().from(user)).length === 1, 'exactly one user row after the race');
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await client.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[verifyBootstrap] failed:', err);
  await client.end({ timeout: 1 });
  process.exit(1);
});
