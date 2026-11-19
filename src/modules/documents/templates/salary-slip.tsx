import { Document, Text, View } from "@react-pdf/renderer";
import type { SchoolBranding } from "../branding";
import { KeyValueRows, LetterheadPage, SignatureLine, styles } from "./letterhead";

/**
 * Salary slip (Phase 3C P12), rendered from the slip SNAPSHOT — later salary or structure edits never change it.
 * Built-in Helvetica can only draw WinAnsi characters (no rupee sign, KI-051), so amounts read "Rs.". No PAN or bank details (KI-088).
 */
export interface SlipLine {
  name: string;
  amount: string;
}

export interface SalarySlipData {
  slipNo: string;
  month: string;
  employee: { code: string; name: string; designation: string; department: string };
  dayBasis: string;
  monthDays: number;
  offRollsDays: number;
  lopDays: string;
  paidDays: string;
  earnings: SlipLine[];
  deductions: SlipLine[];
  gross: string;
  totalDeductions: string;
  net: string;
  paidStatus: string;
}

function Lines({ title, lines, total, totalLabel }: { title: string; lines: SlipLine[]; total: string; totalLabel: string }) {
  return (
    <View style={{ width: "48%" }}>
      <Text style={styles.h2}>{title}</Text>
      {lines.map((l, i) => (
        <View key={`${l.name}-${i}`} style={styles.row} wrap={false}>
          <Text style={{ ...styles.rowLabel, width: "65%", color: "#111111" }}>{l.name}</Text>
          <Text style={{ ...styles.rowValue, width: "35%", textAlign: "right" }}>Rs. {l.amount}</Text>
        </View>
      ))}
      <View style={styles.row} wrap={false}>
        <Text style={{ ...styles.rowLabel, width: "65%", fontFamily: "Helvetica-Bold", color: "#111111" }}>{totalLabel}</Text>
        <Text style={{ ...styles.rowValue, width: "35%", textAlign: "right", fontFamily: "Helvetica-Bold" }}>Rs. {total}</Text>
      </View>
    </View>
  );
}

export function SalarySlipDocument({ branding, slip, generatedAt }: { branding: SchoolBranding; slip: SalarySlipData; generatedAt: Date }) {
  return (
    <Document title={`${branding.name} — Salary slip ${slip.month} — ${slip.employee.code}`} author={branding.name} subject="Salary slip" creator="School ERP" producer="School ERP" language="en-IN">
      <LetterheadPage branding={branding} title={`Salary slip — ${slip.month}`} reference={slip.slipNo} generatedAt={generatedAt}>
        <KeyValueRows
          rows={[
            ["Employee", `${slip.employee.name} (${slip.employee.code})`],
            ["Designation", slip.employee.designation],
            ["Department", slip.employee.department],
            ["Month", slip.month],
            ["Days", `${slip.paidDays} paid of ${slip.monthDays} (${slip.dayBasis})${slip.offRollsDays ? `; not on the rolls ${slip.offRollsDays}` : ""}`],
            ["Loss of pay (days)", slip.lopDays],
          ]}
        />
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
          <Lines title="Earnings" lines={slip.earnings} total={slip.gross} totalLabel="Gross" />
          <Lines title="Deductions" lines={slip.deductions} total={slip.totalDeductions} totalLabel="Total deductions" />
        </View>
        <View style={{ ...styles.row, marginTop: 12, borderBottomWidth: 1 }} wrap={false}>
          <Text style={{ ...styles.rowLabel, fontFamily: "Helvetica-Bold", color: "#111111" }}>Net pay</Text>
          <Text style={{ ...styles.rowValue, fontFamily: "Helvetica-Bold", textAlign: "right" }}>Rs. {slip.net}</Text>
        </View>
        <Text style={{ ...styles.paragraph, marginTop: 8 }}>Payment: {slip.paidStatus}</Text>
        <SignatureLine label="Authorised signatory" />
      </LetterheadPage>
    </Document>
  );
}
