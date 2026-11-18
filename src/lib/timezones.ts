/**
 * IANA time zone helpers (G7 bug B1).
 *
 * `Intl.supportedValuesOf("timeZone")` returns ICU's canonical IDs, some of which are the OLD IANA
 * names (e.g. "Asia/Calcutta", not "Asia/Kolkata"). Building the settings dropdown from that list
 * alone meant the stored "Asia/Kolkata" matched no option and the browser silently pre-selected the
 * first one ("Africa/Abidjan"). These helpers map legacy names to current ones, keep the stored
 * value selectable, and give the server one canonical spelling to store.
 */

/** Legacy name → current IANA name, for the links ICU still reports under the old spelling. */
export const LEGACY_TIME_ZONE_ALIASES: Readonly<Record<string, string>> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Thimbu": "Asia/Thimphu",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Asia/Macao": "Asia/Macau",
  "Asia/Ujung_Pandang": "Asia/Makassar",
  "Asia/Chongqing": "Asia/Shanghai",
  "Asia/Chungking": "Asia/Shanghai",
  "Asia/Harbin": "Asia/Shanghai",
  "Asia/Kashgar": "Asia/Urumqi",
  "Asia/Tel_Aviv": "Asia/Jerusalem",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "Africa/Asmera": "Africa/Asmara",
  "Atlantic/Jan_Mayen": "Arctic/Longyearbyen",
};

/** True if this runtime can format dates in `tz` (accepts current and legacy names). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The spelling to store and show: legacy aliases → current name; anything else unchanged.
 * Returns null for a value the runtime does not recognise (callers must reject, never substitute).
 */
export function canonicalTimeZone(value: string): string | null {
  const tz = value.trim();
  if (!isValidTimeZone(tz)) return null;
  const current = LEGACY_TIME_ZONE_ALIASES[tz];
  return current && isValidTimeZone(current) ? current : tz;
}

/**
 * Dropdown options: the runtime's zones with legacy names replaced by current ones, de-duplicated
 * and sorted — plus the stored value, always, so the browser can never fall back to another
 * option. A stored value the runtime doesn't know is kept as-is (saving it is then rejected with a
 * clear error instead of being replaced silently).
 */
export function timeZoneOptions(stored: string | null | undefined, available: readonly string[] = Intl.supportedValuesOf("timeZone")): string[] {
  const set = new Set<string>();
  for (const tz of available) set.add(LEGACY_TIME_ZONE_ALIASES[tz] ?? tz);
  set.add("UTC");
  const selected = stored ? (canonicalTimeZone(stored) ?? stored.trim()) : "";
  if (selected) set.add(selected);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** The value the dropdown should pre-select for a stored setting (canonical when valid). */
export function selectedTimeZone(stored: string | null | undefined, fallback = "Asia/Kolkata"): string {
  if (!stored) return fallback;
  return canonicalTimeZone(stored) ?? stored.trim();
}
