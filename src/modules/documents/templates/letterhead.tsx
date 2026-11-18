import type { ReactNode } from "react";
import { Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatDateTime } from "@/lib/format";
import type { SchoolBranding } from "../branding";

/**
 * Shared A4 letterhead for every school document (letters, certificates, receipts, report cards).
 * Print-friendly: black text on white, thin rules, no background fills; header and footer repeat
 * on every page. ID cards will use their own CR80 page size but the same branding object.
 */
export const COLORS = { text: "#111111", muted: "#555555", rule: "#999999" } as const;

/**
 * Body text metrics. G7 B3: never put `lineHeight` on <Page> — with react-pdf 4.9 / layout 5.2 any
 * page-level lineHeight (unitless or "pt") pushes the absolutely positioned `fixed` footer thousands of
 * points below the page, so "Generated …" and "Page X of Y" never print. A unitless lineHeight is
 * resolved against the font size of the same style (default 18 pt), so each text style that needs it
 * sets both. Guarded by tests/unit/pdf-documents.test.ts (footer coordinates).
 */
const BODY_FONT_SIZE = 10.5;
const BODY_TEXT = { fontSize: BODY_FONT_SIZE, lineHeight: 1.4 } as const;

export const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 56, paddingHorizontal: 44, fontFamily: "Helvetica", fontSize: BODY_FONT_SIZE, color: COLORS.text },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: COLORS.rule, marginBottom: 18 },
  logo: { width: 54, height: 54, objectFit: "contain" },
  headerText: { flexGrow: 1, flexShrink: 1 },
  schoolName: { fontFamily: "Helvetica-Bold", fontSize: 16, lineHeight: 1.2 },
  headerLine: { fontSize: 8.5, color: COLORS.muted, marginTop: 1 },
  titleBlock: { marginBottom: 14 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 13, textAlign: "center", textTransform: "uppercase", letterSpacing: 0.5 },
  reference: { fontSize: 8.5, color: COLORS.muted, textAlign: "center", marginTop: 3 },
  footer: { position: "absolute", left: 44, right: 44, bottom: 22, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 0.5, borderTopColor: COLORS.rule, paddingTop: 5, fontSize: 7.5, color: COLORS.muted },
  paragraph: { ...BODY_TEXT, marginBottom: 8, textAlign: "justify" },
  h2: { fontFamily: "Helvetica-Bold", fontSize: 11, lineHeight: 1.4, marginTop: 6, marginBottom: 6 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#cccccc", paddingVertical: 4 },
  rowLabel: { ...BODY_TEXT, width: "35%", color: COLORS.muted },
  rowValue: { ...BODY_TEXT, width: "65%" },
  signatureBlock: { marginTop: 36, flexDirection: "row", justifyContent: "flex-end" },
  signature: { width: 180, borderTopWidth: 0.75, borderTopColor: COLORS.text, paddingTop: 4, textAlign: "center", fontSize: 9 },
});

export function LetterheadPage({
  branding,
  title,
  reference,
  generatedAt,
  children,
}: {
  branding: SchoolBranding;
  title: string;
  reference?: string;
  generatedAt: Date;
  children: ReactNode;
}) {
  return (
    <Page size="A4" style={styles.page} wrap>
      <View style={styles.header} fixed>
        {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt attribute */}
        {branding.logo && <Image src={branding.logo} style={styles.logo} />}
        <View style={styles.headerText}>
          <Text style={styles.schoolName}>{branding.name}</Text>
          {branding.affiliationLine && <Text style={styles.headerLine}>{branding.affiliationLine}</Text>}
          {branding.addressLines.map((line) => (
            <Text key={line} style={styles.headerLine}>
              {line}
            </Text>
          ))}
          {branding.contactLine && <Text style={styles.headerLine}>{branding.contactLine}</Text>}
        </View>
      </View>

      <View style={styles.titleBlock}>
        <Text style={styles.title}>{title}</Text>
        {reference && <Text style={styles.reference}>Ref: {reference}</Text>}
      </View>

      {children}

      <View style={styles.footer} fixed>
        <Text>
          {branding.name} · Generated {formatDateTime(generatedAt, branding.timezone)}
        </Text>
        <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </View>
    </Page>
  );
}

export function KeyValueRows({ rows }: { rows: [string, string][] }) {
  return (
    <View>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.row} wrap={false}>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={styles.rowValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

export function SignatureLine({ label }: { label: string }) {
  return (
    <View style={styles.signatureBlock} wrap={false}>
      <Text style={styles.signature}>{label}</Text>
    </View>
  );
}
