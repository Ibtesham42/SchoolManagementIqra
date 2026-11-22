import { Document, Text, View } from "@react-pdf/renderer";
import type { SchoolBranding } from "../branding";
import { COLORS, KeyValueRows, LetterheadPage, SignatureLine, styles } from "./letterhead";

/**
 * Fee receipt (Phase 5B-M2, FC14), rendered from the payment's SNAPSHOT — later fee, name or class changes never change
 * it. Built-in Helvetica can only draw WinAnsi characters (no rupee sign, KI-051), so amounts read "Rs.". The snapshot
 * is a whitelist (no Aadhaar, medical data, guardian phone or address). The first print is the ORIGINAL; later prints
 * say DUPLICATE; a non-counting office view says OFFICE COPY; a cancelled receipt says CANCELLED on every copy.
 */
export interface FeeReceiptLine {
  invoiceNo: string;
  session: string;
  installment: string;
  description: string;
  amount: string;
}

export interface FeeReceiptData {
  receiptNo: string;
  paidOn: string;
  student: { name: string; studentCode: string; className: string; sectionCode: string };
  method: string;
  reference: string | null;
  bankName: string | null;
  instrumentDate: string | null;
  lines: FeeReceiptLine[];
  amount: string;
  amountInWords: string | null;
  collectedBy: string | null;
}

/** ORIGINAL / DUPLICATE: counted prints by fee collectors; COPY: a non-counting view for other receipt readers. */
export type ReceiptCopy = "ORIGINAL" | "DUPLICATE" | "COPY";

const stamp = { fontFamily: "Helvetica-Bold", fontSize: 12, textAlign: "center" as const, borderWidth: 1.5, borderColor: COLORS.text, paddingVertical: 4, marginBottom: 10, letterSpacing: 2 };

export function FeeReceiptDocument({ branding, receipt, copy, cancelled, generatedAt }: { branding: SchoolBranding; receipt: FeeReceiptData; copy: ReceiptCopy; cancelled: boolean; generatedAt: Date }) {
  const payment = [receipt.method, receipt.reference, receipt.bankName, receipt.instrumentDate ? `dated ${receipt.instrumentDate}` : null].filter(Boolean).join(" · ");
  return (
    <Document title={`${branding.name} — Fee receipt ${receipt.receiptNo}`} author={branding.name} subject="Fee receipt" creator="School ERP" producer="School ERP" language="en-IN">
      <LetterheadPage branding={branding} title="Fee receipt" reference={receipt.receiptNo} generatedAt={generatedAt}>
        {cancelled && <Text style={stamp}>CANCELLED — NOT VALID</Text>}
        {copy === "DUPLICATE" && <Text style={stamp}>DUPLICATE</Text>}
        {copy === "COPY" && <Text style={stamp}>OFFICE COPY — NOT FOR ISSUE</Text>}
        <KeyValueRows
          rows={[
            ["Receipt no.", receipt.receiptNo],
            ["Date of payment", receipt.paidOn],
            ["Student", `${receipt.student.name} (${receipt.student.studentCode})`],
            ["Class", `${receipt.student.className} ${receipt.student.sectionCode}`.trim()],
            ["Paid by", payment],
          ]}
        />
        <Text style={styles.h2}>Paid towards</Text>
        {receipt.lines.map((l, i) => (
          <View key={`${l.invoiceNo}-${i}`} style={styles.row} wrap={false}>
            <Text style={{ ...styles.rowLabel, width: "72%", color: COLORS.text }}>
              {l.description} — {l.installment}, {l.session} ({l.invoiceNo})
            </Text>
            <Text style={{ ...styles.rowValue, width: "28%", textAlign: "right" }}>Rs. {l.amount}</Text>
          </View>
        ))}
        <View style={{ ...styles.row, borderBottomWidth: 1 }} wrap={false}>
          <Text style={{ ...styles.rowLabel, width: "72%", fontFamily: "Helvetica-Bold", color: COLORS.text }}>Total received</Text>
          <Text style={{ ...styles.rowValue, width: "28%", textAlign: "right", fontFamily: "Helvetica-Bold" }}>Rs. {receipt.amount}</Text>
        </View>
        {receipt.amountInWords && <Text style={{ ...styles.paragraph, marginTop: 8 }}>{receipt.amountInWords}</Text>}
        {receipt.collectedBy && <Text style={styles.paragraph}>Received by: {receipt.collectedBy}</Text>}
        <SignatureLine label="Authorised signatory" />
      </LetterheadPage>
    </Document>
  );
}
