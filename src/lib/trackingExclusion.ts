/**
 * Internal-traffic exclusion for analytics.
 *
 * Visits from the internal team should never be recorded. A visit is excluded when:
 *   1. The browser opted out via `?notrack=1` (remembered in localStorage), or
 *   2. The device timezone is in the Philippines (catches the team even behind a VPN,
 *      since a VPN changes the IP address but not the device clock).
 *
 * `?notrack=0` forces tracking back on for this browser (useful for QA from Manila).
 * Call it before loading or firing any tracker.
 */

const OPT_OUT_KEY = 'sienvi_notrack';
const EXCLUDED_TIMEZONES = ['Asia/Manila'];

export function isTrackingExcluded(): boolean {
  if (typeof window === 'undefined') return true;

  try {
    const param = new URLSearchParams(window.location.search).get('notrack');
    if (param === '1' || param === '0') localStorage.setItem(OPT_OUT_KEY, param);

    const stored = localStorage.getItem(OPT_OUT_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // localStorage unavailable (private mode) — fall through to the timezone check
  }

  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return EXCLUDED_TIMEZONES.includes(timeZone);
  } catch {
    return false;
  }
}
