import { Document, Text, View } from "@react-pdf/renderer";
import type { ReportCardSnapshot } from "@/modules/academic/results.rules";
import type { SchoolBranding } from "../branding";
import { KeyValueRows, LetterheadPage, SignatureLine, styles } from "./letterhead";

/**
 * Report card (Phase 4B-M6, AC15): scholastic results of ONE exam, rendered from the published SNAPSHOT — later marks or
 * grading-scale edits never change it. Built-in Helvetica prints WinAnsi characters only (KI-051). No verification
 * code yet (KI-090).
 */
const RESULT: Record<ReportCardSnapshot["total"]["result"], string> = { PASS: "Pass", FAIL: "Not passed", NO_RESULT: "No result" };
const cell = { fontSize: 9, paddingVertical: 3, paddingHorizontal: 2 } as const;
const W = { subject: "34%", part: "11%", total: "11%", grade: "11%" } as const;

function part(value: string | null, max: number, status: string) {
  if (max === 0) return "—";
  if (status === "ABSENT") return "AB";
  if (status === "EXEMPT") return "EX";
  return `${value ?? "—"}/${max}`;
}

export function ReportCardDocument({ branding, snapshot, remark, publishedAt, generatedAt }: { branding: SchoolBranding; snapshot: ReportCardSnapshot; remark: string | null; publishedAt: Date; generatedAt: Date }) {
  const s = snapshot;
  const rows: [string, string][] = [
    ["Student", `${s.student.name} (${s.student.code})`],
    ["Class / section", `${s.student.className} · ${s.student.sectionCode}${s.student.rollNumber !== null ? ` · Roll no. ${s.student.rollNumber}` : ""}`],
    ["Session", s.exam.session],
    ["Exam", `${s.exam.name}${s.exam.startDate ? ` (${s.exam.startDate}${s.exam.endDate && s.exam.endDate !== s.exam.startDate ? ` to ${s.exam.endDate}` : ""})` : ""}`],
    ["Published", publishedAt.toISOString().slice(0, 10)],
  ];
  return (
    <Document title={`${branding.name} — Report card — ${s.exam.name} — ${s.student.code}`} author={branding.name} subject="Report card" creator="School ERP" producer="School ERP" language="en-IN">
      <LetterheadPage branding={branding} title={`Report card — ${s.exam.name}`} reference={s.student.code} generatedAt={generatedAt}>
        <KeyValueRows rows={rows} />
        <Text style={{ ...styles.paragraph, marginTop: 10, fontFamily: "Helvetica-Bold" }}>Scholastic results</Text>
        <View style={{ ...styles.row, borderBottomWidth: 1 }} fixed>
          <Text style={{ ...cell, width: W.subject, fontFamily: "Helvetica-Bold" }}>Subject</Text>
          <Text style={{ ...cell, width: W.part, fontFamily: "Helvetica-Bold" }}>Theory</Text>
          <Text style={{ ...cell, width: W.part, fontFamily: "Helvetica-Bold" }}>Practical</Text>
          <Text style={{ ...cell, width: W.part, fontFamily: "Helvetica-Bold" }}>Internal</Text>
          <Text style={{ ...cell, width: W.total, fontFamily: "Helvetica-Bold" }}>Total</Text>
          <Text style={{ ...cell, width: W.grade, fontFamily: "Helvetica-Bold" }}>Grade</Text>
        </View>
        {s.subjects.map((r) => (
          <View key={r.code} style={styles.row} wrap={false}>
            <Text style={{ ...cell, width: W.subject }}>
              {r.name}
              {r.passed === false ? " *" : ""}
            </Text>
            <Text style={{ ...cell, width: W.part }}>{part(r.parts.theory, r.maxParts.theory, r.status)}</Text>
            <Text style={{ ...cell, width: W.part }}>{part(r.parts.practical, r.maxParts.practical, r.status)}</Text>
            <Text style={{ ...cell, width: W.part }}>{part(r.parts.internal, r.maxParts.internal, r.status)}</Text>
            <Text style={{ ...cell, width: W.total }}>{r.status === "EXEMPT" ? "EX" : `${r.obtained}/${r.max}`}</Text>
            <Text style={{ ...cell, width: W.grade }}>{r.grade ?? "—"}</Text>
          </View>
        ))}
        <View style={{ marginTop: 10 }}>
          <KeyValueRows
            rows={[
              ["Total", `${s.total.obtained} / ${s.total.max}${s.total.percent !== null ? ` (${s.total.percent} %)` : ""}`],
              ["Overall grade", s.total.grade ?? "—"],
              ["Result", RESULT[s.total.result]],
              ...(s.rank !== null ? ([["Rank in class", String(s.rank)]] as [string, string][]) : []),
              ["Attendance", s.attendance.percent !== null ? `${s.attendance.percent} % of ${s.attendance.marked} marked day(s)` : "Not recorded"],
              ["Grading scale", s.scale],
            ]}
          />
        </View>
        {s.subjects.some((r) => r.passed === false) && <Text style={{ ...styles.paragraph, fontSize: 8 }}>* Below the pass mark in this subject.</Text>}
        <Text style={{ ...styles.paragraph, marginTop: 8 }}>Class teacher&apos;s remark: {remark ?? "—"}</Text>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <SignatureLine label="Class teacher" />
          <SignatureLine label="Principal" />
        </View>
      </LetterheadPage>
    </Document>
  );
}
