import type { PublicSchoolProfile } from "@/modules/settings/settings.public";

/** Everything a document template needs to brand a page. Built from settings; no DB access here. */
export interface SchoolBranding {
  name: string;
  shortCode: string | null;
  /** e.g. "CBSE Affiliation No. 1234567" — omitted when not configured. */
  affiliationLine: string | null;
  addressLines: string[];
  contactLine: string | null;
  timezone: string;
  logo: { data: Buffer; format: "png" | "jpg" } | null;
}

/** Pure: turns the public school profile (+ optional logo bytes) into template branding. */
export function buildBranding(profile: PublicSchoolProfile, logo?: { bytes: Buffer; mimeType: string } | null): SchoolBranding {
  const a = profile.address;
  const addressLines = a
    ? [
        [a.line1, a.line2].filter(Boolean).join(", "),
        [a.city, a.district, a.state].filter(Boolean).join(", ") + (a.pinCode ? ` – ${a.pinCode}` : ""),
      ].filter((l) => l.trim().length > 0)
    : [];
  const contact = [profile.phones.join(" / "), profile.email, profile.website].filter((v): v is string => !!v && v.length > 0);
  const affiliation = [profile.board, profile.affiliationNo ? `Affiliation No. ${profile.affiliationNo}` : null].filter(Boolean).join(" · ");
  const logoFormat = logo?.mimeType === "image/png" ? "png" : logo?.mimeType === "image/jpeg" ? "jpg" : null;
  return {
    name: profile.name,
    shortCode: profile.shortCode,
    affiliationLine: affiliation || null,
    addressLines,
    contactLine: contact.length ? contact.join("  ·  ") : null,
    timezone: profile.timezone,
    logo: logo && logoFormat ? { data: logo.bytes, format: logoFormat } : null,
  };
}
