<script lang="ts">
  import { spriteImage, SPRITE_PIXELS } from './spriteCanvas';

  /**
   * One agent's generated pixel character, as a standalone element - the
   * same image the Office canvas blits, so an agent looks identical
   * wherever it appears.
   *
   * Drawn into its own canvas rather than served as an `<img>`: the
   * character is generated at runtime from the agent id (./sprite.ts), so
   * there is no file to point an `<img>` at.
   */
  let {
    agentId,
    scale = 1,
    label = undefined,
  }: {
    agentId: string;
    /** Whole-number multiple of the character's rasterised size (48px). Fractional values would put its pixels off the grid. */
    scale?: number;
    label?: string | undefined;
  } = $props();

  let canvasEl = $state<HTMLCanvasElement | undefined>(undefined);

  const size = $derived(SPRITE_PIXELS * scale);

  $effect(() => {
    const canvas = canvasEl;
    if (!canvas) return;
    const image = spriteImage(agentId, 0);
    const ctx = canvas.getContext('2d');
    if (!image || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Off, so scaling up the already-rasterised character keeps its pixel
    // edges instead of blurring them into a smudge.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  });
</script>

<canvas
  bind:this={canvasEl}
  width={size}
  height={size}
  style="width: {size}px; height: {size}px"
  role={label ? 'img' : 'presentation'}
  aria-label={label}
></canvas>
