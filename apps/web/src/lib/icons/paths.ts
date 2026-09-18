/**
 * The icon set, as raw SVG path data on a 24x24 grid.
 *
 * Why hand-authored path data rather than an icon package: this repo is
 * built in an environment whose egress policy returns 403 for the npm
 * registry, and equally for unpkg, jsdelivr and raw.githubusercontent, so
 * neither an icon dependency nor its source SVGs can be fetched or
 * verified here. Guessing a package's exact export shape and shipping it
 * unverified would break the whole `apps/web` build; guessing at path data
 * from memory would ship icons that render as garbage. So these are drawn
 * on an explicit grid where every coordinate is chosen deliberately.
 *
 * They follow Lucide's drawing conventions exactly - 24x24 viewBox, 2px
 * stroke, round caps and joins, no fill - so swapping in real Lucide (or
 * any other stroke set on a 24-grid) later is a pure data change to this
 * file: nothing that consumes it needs to know.
 *
 * Path data, not `<rect>`/`<circle>` elements, deliberately: the Office
 * canvas renders the same icons through `new Path2D(d)` (see
 * ../office/iconCanvas.ts), which only accepts path data. One
 * representation keeps the sidebar and the canvas visually identical
 * instead of drifting into two icon sets.
 */

/** Every icon name this set defines. Exhaustive, so a typo is a type error rather than a blank square. */
export type IconName =
  | 'activity'
  | 'arrowLeft'
  | 'arrowRight'
  | 'ban'
  | 'barChart'
  | 'book'
  | 'building'
  | 'clipboard'
  | 'cpu'
  | 'diff'
  | 'dot'
  | 'externalLink'
  | 'factory'
  | 'fileText'
  | 'folder'
  | 'helpCircle'
  | 'image'
  | 'inbox'
  | 'layers'
  | 'lightbulb'
  | 'link'
  | 'lock'
  | 'logOut'
  | 'messageCircle'
  | 'messageSquare'
  | 'pencil'
  | 'presentation'
  | 'pullRequest'
  | 'replyArrow'
  | 'search'
  | 'server'
  | 'settings'
  | 'users'
  | 'wrench'
  | 'x';

/**
 * Icons whose shape only reads correctly when filled (`dot` is a solid
 * status bullet, not a ring). Everything else is stroke-only.
 */
export const FILLED_ICONS: ReadonlySet<IconName> = new Set<IconName>(['dot']);

export const ICON_PATHS: Record<IconName, readonly string[]> = {
  activity: ['M3 12H7L10 5L14 19L17 12H21'],

  arrowLeft: ['M19 12H5', 'M12 19L5 12L12 5'],

  arrowRight: ['M5 12H19', 'M12 5L19 12L12 19'],

  ban: ['M3 12A9 9 0 1 0 21 12A9 9 0 1 0 3 12Z', 'M5.6 5.6L18.4 18.4'],

  barChart: ['M3 20H21', 'M6 20V12', 'M12 20V5', 'M18 20V9'],

  book: ['M5 4A2 2 0 0 1 7 2H19V18H7A2 2 0 0 0 5 20Z', 'M5 20A2 2 0 0 0 7 22H19V18'],

  building: [
    'M5 3H13A1 1 0 0 1 14 4V21H4V4A1 1 0 0 1 5 3Z',
    'M14 10H19A1 1 0 0 1 20 11V21H14',
    'M2 21H22',
    'M7 7H8',
    'M10 7H11',
    'M7 11H8',
    'M10 11H11',
    'M8 21V17H10V21',
  ],

  clipboard: [
    'M8 4H6A1 1 0 0 0 5 5V20A1 1 0 0 0 6 21H18A1 1 0 0 0 19 20V5A1 1 0 0 0 18 4H16',
    'M9 2H15A1 1 0 0 1 16 3V5A1 1 0 0 1 15 6H9A1 1 0 0 1 8 5V3A1 1 0 0 1 9 2Z',
    'M9 11H15',
    'M9 15H13',
  ],

  cpu: [
    'M6 5H18A1 1 0 0 1 19 6V18A1 1 0 0 1 18 19H6A1 1 0 0 1 5 18V6A1 1 0 0 1 6 5Z',
    'M9 9H15V15H9Z',
    'M9 2V5',
    'M15 2V5',
    'M9 19V22',
    'M15 19V22',
    'M2 9H5',
    'M2 15H5',
    'M19 9H22',
    'M19 15H22',
  ],

  diff: ['M12 3V17', 'M5 10H19', 'M5 21H19'],

  dot: ['M12 8A4 4 0 1 0 12 16A4 4 0 1 0 12 8Z'],

  externalLink: [
    'M19 13V19A2 2 0 0 1 17 21H5A2 2 0 0 1 3 19V7A2 2 0 0 1 5 5H11',
    'M15 3H21V9',
    'M10 14L21 3',
  ],

  factory: ['M2 21H22', 'M3 21V12L9 16V12L15 16V9H18L21 21', 'M7 21V18H10V21'],

  fileText: [
    'M14 3H7A1 1 0 0 0 6 4V20A1 1 0 0 0 7 21H17A1 1 0 0 0 18 20V7Z',
    'M14 3V7H18',
    'M9 12H15',
    'M9 16H13',
  ],

  folder: ['M3 7A1 1 0 0 1 4 6H9L11 8H20A1 1 0 0 1 21 9V19A1 1 0 0 1 20 20H4A1 1 0 0 1 3 19Z'],

  helpCircle: [
    'M3 12A9 9 0 1 0 21 12A9 9 0 1 0 3 12Z',
    'M9.5 9.5A2.5 2.5 0 1 1 12 12.5V14',
    'M12 17.4V17.6',
  ],

  image: [
    'M4 4H20A1 1 0 0 1 21 5V19A1 1 0 0 1 20 20H4A1 1 0 0 1 3 19V5A1 1 0 0 1 4 4Z',
    'M8 7.5A1.5 1.5 0 1 0 11 7.5A1.5 1.5 0 1 0 8 7.5Z',
    'M21 16L16 11L6 20',
  ],

  inbox: ['M5 5H19L21 12V19A1 1 0 0 1 20 20H4A1 1 0 0 1 3 19V12Z', 'M3 12H8L9 15H15L16 12H21'],

  layers: ['M12 3L21 8L12 13L3 8Z', 'M3 12L12 17L21 12', 'M3 16L12 21L21 16'],

  lightbulb: [
    'M12 3A6 6 0 0 0 8 13.5C8.7 14.4 9 15.2 9 16V18H15V16C15 15.2 15.3 14.4 16 13.5A6 6 0 0 0 12 3Z',
    'M9 18H15',
    'M10 21H14',
  ],

  link: ['M9 17H7A5 5 0 0 1 7 7H9', 'M15 7H17A5 5 0 0 1 17 17H15', 'M8 12H16'],

  lock: [
    'M6 11H18A1 1 0 0 1 19 12V20A1 1 0 0 1 18 21H6A1 1 0 0 1 5 20V12A1 1 0 0 1 6 11Z',
    'M8 11V7A4 4 0 0 1 16 7V11',
  ],

  logOut: ['M9 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H9', 'M16 17L21 12L16 7', 'M21 12H9'],

  messageCircle: [
    'M21 11.5A8.5 8.5 0 0 1 12.5 20A8.5 8.5 0 0 1 8.4 19L3 20.5L4.5 15.1A8.5 8.5 0 0 1 12.5 3A8.5 8.5 0 0 1 21 11.5Z',
  ],

  messageSquare: [
    'M4 4H20A1 1 0 0 1 21 5V15A1 1 0 0 1 20 16H9L5 20V16H4A1 1 0 0 1 3 15V5A1 1 0 0 1 4 4Z',
  ],

  pencil: ['M17 3L21 7L8 20H4V16L17 3Z', 'M14.5 5.5L18.5 9.5'],

  presentation: [
    'M3 4H21',
    'M4 4V14A1 1 0 0 0 5 15H19A1 1 0 0 0 20 14V4',
    'M12 15V19',
    'M9 21L12 19L15 21',
  ],

  pullRequest: [
    'M3 18A3 3 0 1 0 9 18A3 3 0 1 0 3 18Z',
    'M15 6A3 3 0 1 0 21 6A3 3 0 1 0 15 6Z',
    'M6 15V9A3 3 0 0 1 9 6H14',
    'M12 4L14 6L12 8',
    'M18 9V15',
  ],

  replyArrow: ['M9 10L5 14L9 18', 'M20 4V11A3 3 0 0 1 17 14H5'],

  search: ['M11 4A7 7 0 1 0 11 18A7 7 0 1 0 11 4Z', 'M16 16L21 21'],

  server: [
    'M4 4H20A1 1 0 0 1 21 5V9A1 1 0 0 1 20 10H4A1 1 0 0 1 3 9V5A1 1 0 0 1 4 4Z',
    'M4 14H20A1 1 0 0 1 21 15V19A1 1 0 0 1 20 20H4A1 1 0 0 1 3 19V15A1 1 0 0 1 4 14Z',
    'M6.9 7H7.1',
    'M6.9 17H7.1',
  ],

  settings: [
    'M4 6H14',
    'M18 6H20',
    'M4 12H8',
    'M12 12H20',
    'M4 18H14',
    'M18 18H20',
    'M14 6A2 2 0 1 0 18 6A2 2 0 1 0 14 6Z',
    'M8 12A2 2 0 1 0 12 12A2 2 0 1 0 8 12Z',
    'M14 18A2 2 0 1 0 18 18A2 2 0 1 0 14 18Z',
  ],

  users: [
    'M6 7A3 3 0 1 0 12 7A3 3 0 1 0 6 7Z',
    'M3 20V19A5 5 0 0 1 8 14H10A5 5 0 0 1 15 19V20',
    'M16 4.5A3 3 0 0 1 16 10.5',
    'M17 14H18A4 4 0 0 1 22 18V20',
  ],

  wrench: [
    'M14.7 6.3A1 1 0 0 0 14.7 7.7L16.3 9.3A1 1 0 0 0 17.7 9.3L21.5 5.5A6 6 0 0 1 13.5 13.5L6.6 20.4A2.1 2.1 0 0 1 3.6 17.4L10.5 10.5A6 6 0 0 1 18.5 2.5L14.7 6.3Z',
  ],

  x: ['M6 6L18 18', 'M18 6L6 18'],
};
