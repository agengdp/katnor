// Inbox was merged into Chat's "Needs your decision" panel - this
// redirect keeps old links/bookmarks working instead of 404ing.
import { redirect } from '@sveltejs/kit';

export function load() {
  throw redirect(302, '/chat');
}
