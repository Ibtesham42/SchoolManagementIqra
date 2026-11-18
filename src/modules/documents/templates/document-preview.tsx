import { Document, Text } from "@react-pdf/renderer";
import type { SchoolBranding } from "../branding";
import { KeyValueRows, LetterheadPage, SignatureLine, styles } from "./letterhead";

/**
 * Sample document used by Settings > "Preview document (PDF)" to check branding before real documents
 * (ID cards, certificates, receipts, report cards) exist. Contains no personal data.
 */
export function DocumentPreview({ branding, generatedAt, extraParagraphs = 0 }: { branding: SchoolBranding; generatedAt: Date; extraParagraphs?: number }) {
  const filler =
    "This paragraph shows how body text flows across pages. Long documents such as report cards and certificates repeat the school header and footer on every page, and page numbers are added automatically.";
  return (
    <Document title={`${branding.name} — Document preview`} author={branding.name} subject="Document branding preview" creator="School ERP" producer="School ERP" language="en-IN">
      <LetterheadPage branding={branding} title="Document preview" reference={`${branding.shortCode ?? "SCHOOL"}/PREVIEW`} generatedAt={generatedAt}>
        <Text style={styles.paragraph}>
          This is a preview of the school letterhead used for all generated documents. The header above comes from Settings &gt; School profile;
          the footer shows when the document was generated, in the school&apos;s time zone.
        </Text>
        <Text style={styles.h2}>Example details</Text>
        <KeyValueRows
          rows={[
            ["Document type", "Branding preview"],
            ["School code", branding.shortCode ?? "Not set"],
            ["Time zone", branding.timezone],
            ["Logo", branding.logo ? "Configured" : "Not uploaded"],
          ]}
        />
        {Array.from({ length: extraParagraphs }, (_, i) => (
          <Text key={i} style={styles.paragraph}>
            {filler}
          </Text>
        ))}
        <SignatureLine label="Principal" />
      </LetterheadPage>
    </Document>
  );
}
