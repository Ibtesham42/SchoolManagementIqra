import { Document, Text, View } from "@react-pdf/renderer";
import type { SchoolBranding } from "../branding";
import { COLORS, KeyValueRows, LetterheadPage, styles } from "./letterhead";

/**
 * Phase 6A-M3 (ADR-046) — the parent portal activation slip, one page per guardian (handed out at PTM / admission
 * or sent home in a sealed envelope). It carries only the guardian's name, the children it is for, the username and
 * the one-time code — never a date of birth, phone number (unless it IS the username) or password. The code is
 * shown once: the database keeps only its hash, so a lost slip means a new slip.
 */
export interface ActivationSlip {
  guardianName: string;
  children: string[];
  username: string;
  /** Formatted "ABCD-EFGH-JKMN". */
  code: string;
  /** School-local date (YYYY-MM-DD) after which the code no longer works. */
  expiresOn: string;
  /** Phase 6C-M4 (P14): a student's own account — `guardianName` is then the student's name; the slip goes to the parent. */
  kind?: "GUARDIAN" | "STUDENT";
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "UTC" });
const codeBox = { fontFamily: "Courier-Bold", fontSize: 20, letterSpacing: 2, textAlign: "center" as const, borderWidth: 1.5, borderColor: COLORS.text, paddingVertical: 8, marginVertical: 10 };

export function ActivationSlipsDocument({ branding, slips, activateUrl, consentVersion, generatedAt }: { branding: SchoolBranding; slips: ActivationSlip[]; activateUrl: string; consentVersion: string | null; generatedAt: Date }) {
  return (
    <Document title={`${branding.name} — Portal activation`} author={branding.name} subject="Portal activation" creator="School ERP" producer="School ERP" language="en-IN">
      {slips.map((s, i) => (
        <LetterheadPage key={`${s.username}-${i}`} branding={branding} title={s.kind === "STUDENT" ? "Student portal — activation slip" : "Parent portal — activation slip"} generatedAt={generatedAt}>
          <Text style={styles.paragraph}>
            {s.kind === "STUDENT"
              ? `Confidential. For the parent / guardian of ${s.guardianName}: you decide whether and when to give this to your child. Keep it safe and do not share the code.`
              : `Confidential. For ${s.guardianName} only. Keep this slip safe and do not share the code.`}
          </Text>
          <KeyValueRows
            rows={[
              [s.kind === "STUDENT" ? "Student" : "Parent / guardian", s.guardianName],
              ...(s.kind === "STUDENT" ? [] : ([["For", s.children.length ? s.children.join(", ") : "—"]] as [string, string][])),
              ["Username", s.username],
              ["Code valid until", day(s.expiresOn)],
            ]}
          />
          <Text style={{ ...styles.h2, marginTop: 14 }}>Activation code</Text>
          <Text style={codeBox}>{s.code}</Text>
          <Text style={styles.h2}>How to activate</Text>
          <View>
            {[
              `1. Open ${activateUrl || "the school portal's activation page"} on your phone or computer.`,
              s.kind === "STUDENT" ? "2. Enter the username and the activation code above, and the student's date of birth." : "2. Enter the username and the activation code above, and your child's date of birth.",
              "3. Read the privacy notice, agree, and choose your own password (at least 10 characters).",
              "4. From then on, sign in with your username and your password.",
            ].map((line) => (
              <Text key={line} style={styles.paragraph}>
                {line}
              </Text>
            ))}
          </View>
          <Text style={{ ...styles.paragraph, color: COLORS.muted }}>
            The code works once, and only until the date above. If it is lost or has expired, ask the school office for a new slip; the old code then stops working.
            {consentVersion ? ` Privacy notice version ${consentVersion}.` : ""}
          </Text>
        </LetterheadPage>
      ))}
    </Document>
  );
}
