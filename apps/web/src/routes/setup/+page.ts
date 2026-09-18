// See settings/+page.ts's comment - same reasoning applies here. This page
// is also unreachable server-side in any useful form: everything it shows
// depends on `setup.status`, which is a client-side tRPC call.
export const ssr = false;
