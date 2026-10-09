<script lang="ts">
  import { charBaseFor, spritePath } from '$lib/office/officeLayout';

  /**
   * One agent's character as a standalone element - the sprite used in
   * the side panel, the decision popup, and the activity log, so an
   * agent looks identical everywhere outside the 3D room.
   */
  let {
    agentId,
    isCeo = false,
    height = 64,
    label = undefined,
  }: {
    agentId: string;
    /** CEOs use the distinct assistant sprite, matching the floor. */
    isCeo?: boolean;
    /** Rendered height in px - width follows the sprite's own aspect. */
    height?: number;
    label?: string | undefined;
  } = $props();

  const src = $derived(spritePath(charBaseFor(agentId, isCeo), 'front-left'));
</script>

<img
  {src}
  alt={label ?? ''}
  role={label ? 'img' : 'presentation'}
  draggable="false"
  style="height: {height}px; width: auto; image-rendering: pixelated;"
/>
