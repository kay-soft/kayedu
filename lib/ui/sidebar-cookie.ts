/**
 * Whether the sidebar is collapsed to an icon rail (docs/04-design-system.md
 * §5 "Sidebar"). A UI preference, not a security concern, so it is a plain
 * (non-httpOnly) cookie the client writes directly on toggle — no Server
 * Action round trip.
 *
 * Just the constant here, deliberately with no `next/headers` import: this
 * file is imported from both the client (`components/shell/app-shell.tsx`,
 * to write the cookie) and server layouts (to read it before the first
 * paint, which is what avoids the flash of an expanded sidebar snapping
 * shut). `next/headers` is server-only, so reading the cookie lives inline
 * in each layout instead of a shared server helper that would drag that
 * import into the client bundle.
 */
export const SIDEBAR_COLLAPSED_COOKIE = "kayedu_sidebar_collapsed";
