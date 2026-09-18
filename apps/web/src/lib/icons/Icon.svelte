<script lang="ts">
  import { FILLED_ICONS, ICON_PATHS, type IconName } from './paths';

  /**
   * Renders one icon from ./paths.ts.
   *
   * Sized in `em` rather than pixels so an icon always matches the text it
   * sits beside - a 1em icon next to `text-xs` and the same icon next to
   * `text-2xl` both look deliberate without either caller passing a size.
   *
   * Decorative by default (`aria-hidden`, no accessible name), because
   * every icon in this app sits next to its own visible text label. Pass
   * `label` only where the icon genuinely is the control - the Inbox
   * dismiss button, for instance - and it becomes an `img` role with that
   * name instead.
   */
  let {
    name,
    size = '1em',
    label = undefined,
    class: className = '',
  }: {
    name: IconName;
    size?: string;
    label?: string | undefined;
    class?: string;
  } = $props();

  const paths = $derived(ICON_PATHS[name]);
  const filled = $derived(FILLED_ICONS.has(name));
</script>

<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill={filled ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class="inline-block shrink-0 {className}"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
>
  {#each paths as d (d)}
    <path {d} />
  {/each}
</svg>
