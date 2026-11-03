// @ts-check
/**
 * Fixed vocabularies used by the classifier. Changing any list changes results, so every
 * change here is a behaviour change: bump the plugin version and note it in the README.
 */

/** Callees whose first argument is a module specifier. */
export const MODULE_FUNCTIONS = new Set([
  'require',
  'require.resolve',
  'import.meta.resolve',
  'vi.mock',
  'vi.doMock',
  'vi.unmock',
  'vi.importActual',
  'vi.importMock',
  'jest.mock',
  'jest.doMock',
  'jest.unmock',
  'jest.requireActual',
  'jest.requireMock',
]);

/** Last callee segment of class-name / style helpers: every literal inside is styling. */
export const STYLING_FUNCTIONS = new Set(['clsx', 'cn', 'cx', 'classNames', 'classnames', 'twMerge', 'twJoin', 'cva', 'tv', 'css']);

/** JSX attributes whose values are styling. */
export const STYLING_ATTRIBUTES = new Set(['className', 'class', 'style', 'sx', 'css', 'tw']);

/** Callees whose literals define routes (the definition site, not a usage). */
export const ROUTE_DEFINITION_FUNCTIONS = new Set([
  'createFileRoute',
  'createLazyFileRoute',
  'createRoute',
  'createRootRoute',
  'createRootRouteWithContext',
  'createLazyRoute',
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
]);

/** Last callee segment of i18next APIs whose arguments are keys or namespaces (ADR-FE-004). */
export const I18N_FUNCTIONS = new Set([
  't',
  'useTranslation',
  'withTranslation',
  'getFixedT',
  'changeLanguage',
  'loadNamespaces',
  'loadLanguages',
  'hasLoadedNamespace',
]);

/** JSX attributes that carry translation keys or namespaces. */
export const I18N_ATTRIBUTES = new Set(['i18nKey', 'ns', 'tOptions']);

/** Objects whose methods are logging calls. */
export const LOG_OBJECTS = new Set(['console', 'logger', 'log', 'Logger', 'LOGGER', '_logger', 'logging']);

/** Logging method names. */
export const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal', 'log', 'critical']);

/** Fully-qualified callees that log or report a developer message. */
export const LOG_FUNCTIONS = new Set(['Sentry.captureMessage', 'Sentry.addBreadcrumb']);

/** Assertion helpers whose 2nd+ arguments are developer messages. */
export const ASSERT_FUNCTIONS = new Set(['invariant', 'assert', 'warning', 'assertNever', 'assertIsDefined']);

/** JSX attributes whose literal value is user-visible text (ADR-FE-004). */
export const UI_TEXT_ATTRIBUTES = new Set([
  'placeholder',
  'title',
  'alt',
  'label',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'helperText',
  'tooltip',
  'description',
  'caption',
  'heading',
  'subtitle',
  'emptyText',
  'emptyMessage',
  'errorMessage',
  'confirmText',
  'cancelText',
  'okText',
  'submitText',
  'loadingText',
]);

/** Callees whose first argument is user-visible text (ADR-FE-004). */
export const UI_TEXT_FUNCTIONS = new Set([
  'toast',
  'toast.success',
  'toast.error',
  'toast.info',
  'toast.warning',
  'toast.warn',
  'toast.loading',
  'toast.message',
  'toast.promise',
  'enqueueSnackbar',
  'alert',
  'window.alert',
  'confirm',
  'window.confirm',
  'prompt',
  'window.prompt',
]);

/** Keys of an options object passed to a UI text function whose values are user-visible text. */
export const UI_TEXT_OPTION_KEYS = new Set(['loading', 'success', 'error', 'title', 'description', 'message']);

/** Markup-only JSX attributes: structural identifiers or HTML/SVG-defined values. */
export const MARKUP_ATTRIBUTES = new Set([
  'key',
  'ref',
  'id',
  'htmlFor',
  'name',
  'form',
  'role',
  'slot',
  'tabIndex',
  'type',
  'autoComplete',
  'inputMode',
  'enterKeyHint',
  'rel',
  'target',
  'method',
  'encType',
  'dir',
  'lang',
  'loading',
  'decoding',
  'crossOrigin',
  'referrerPolicy',
  'spellCheck',
  'draggable',
  'width',
  'height',
  'colSpan',
  'rowSpan',
  'scope',
  'wrap',
  'autoCapitalize',
  'accept',
  'sizes',
  'media',
  'as',
  'viewBox',
  'fill',
  'stroke',
  'strokeWidth',
  'strokeLinecap',
  'strokeLinejoin',
  'fillRule',
  'clipRule',
  'd',
  'xmlns',
  'testId',
]);

/** Route-definition attribute on <Route>. */
export const ROUTE_ELEMENT = 'Route';

/** Last callee segment of TanStack Query APIs whose first argument may be a raw key array (ADR-FE-002). */
export const QUERY_KEY_ARGUMENT_METHODS = new Set([
  'getQueryData',
  'setQueryData',
  'getQueryState',
  'getQueriesData',
  'setQueriesData',
  'invalidateQueries',
  'refetchQueries',
  'cancelQueries',
  'resetQueries',
  'removeQueries',
  'prefetchQuery',
  'ensureQueryData',
  'useQuery',
  'useInfiniteQuery',
  'useSuspenseQuery',
  'isFetching',
]);

/** Object property that holds a TanStack Query key (ADR-FE-002). */
export const QUERY_KEY_PROPERTY = 'queryKey';

/** DOM event names: standard only as the first argument of add/removeEventListener. */
export const DOM_EVENTS = new Set([
  'abort',
  'beforeunload',
  'blur',
  'change',
  'click',
  'contextmenu',
  'copy',
  'cut',
  'dblclick',
  'drag',
  'dragend',
  'dragenter',
  'dragleave',
  'dragover',
  'dragstart',
  'drop',
  'error',
  'focus',
  'focusin',
  'focusout',
  'hashchange',
  'input',
  'keydown',
  'keypress',
  'keyup',
  'load',
  'message',
  'mousedown',
  'mouseenter',
  'mouseleave',
  'mousemove',
  'mouseout',
  'mouseover',
  'mouseup',
  'offline',
  'online',
  'orientationchange',
  'pagehide',
  'pageshow',
  'paste',
  'pointercancel',
  'pointerdown',
  'pointerenter',
  'pointerleave',
  'pointermove',
  'pointerup',
  'popstate',
  'resize',
  'scroll',
  'storage',
  'submit',
  'touchcancel',
  'touchend',
  'touchmove',
  'touchstart',
  'transitionend',
  'unload',
  'visibilitychange',
  'wheel',
]);

/** Protocol- or platform-defined values: never magic in any context. */
export const STANDARD_VALUES = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'application/json',
  'application/pdf',
  'application/octet-stream',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'text/html',
  'text/csv',
  'image/png',
  'image/jpeg',
  'utf-8',
  'utf8',
  'UTF-8',
  'NFC',
  'NFD',
  'NFKC',
  'NFKD',
  '2d',
  'webgl',
  'webgl2',
  'bitmaprenderer',
  'Content-Type',
  'Authorization',
  'Accept',
  'Bearer ${…}',
  'Enter',
  'Escape',
  'Esc',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Shift',
  'Control',
  'Alt',
  'Meta',
]);

/** Well-known credential formats. A match is reported as V-SECRET and the value is redacted. */
export const SECRET_PATTERNS = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/,
];

/** Placeholder used for `${…}` substitutions in template literal values. */
export const PLACEHOLDER = '${…}';
