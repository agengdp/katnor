// @katnor/eval - PLAN.md Phase 5's eval harness: a small set of scripted
// company tasks with graded outcomes (./tasks.ts), run against the real
// agent-run loop (./runner.ts, invoked via `pnpm start`) rather than a
// mock. Not consumed as a library by any other package - this barrel
// exists only for consistency with every other package in the monorepo.
export * from './types.js';
export * from './tasks.js';
