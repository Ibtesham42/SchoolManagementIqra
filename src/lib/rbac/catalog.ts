/**
 * Permission catalog and default role grants — the single source for seeding.
 * Mirrors docs/AUTHENTICATION_AND_RBAC.md §3–4. Super Admin can edit non-system roles at runtime;
 * re-seeding only adds missing permissions/roles and never overwrites edited grants.
 */
export const PERMISSIONS = {
  // Users & roles
  "user.read": "View user accounts",
  "user.manage": "Create, edit, deactivate users and assign roles",
  "role.manage": "Edit roles and their permissions",
  // Settings
  "settings.read": "View school settings",
  "settings.manage": "Change school settings",
  "session.manage": "Manage academic sessions",
  "template.manage": "Manage document and ID card templates",
  // CMS
  "cms.read": "View website content in the CMS",
  "cms.edit": "Edit website content drafts",
  "cms.publish": "Publish website content",
  "enquiry.read": "View admission enquiries",
  "enquiry.manage": "Update admission enquiries",
  // Admissions & students
  "admission.read": "View admissions",
  "admission.create": "Create admissions",
  "admission.approve": "Approve admissions and override duplicate warnings",
  "student.read": "View student records",
  "student.create": "Create students",
  "student.update": "Edit student records",
  "student.delete": "Soft-delete student records",
  "student.sensitive.read": "View Aadhaar and medical information",
  "student.document.read": "View student documents",
  "student.document.manage": "Upload, replace, verify and remove student and admission documents",
  "student.promote": "Promote students",
  "student.transfer": "Transfer or withdraw students",
  "discipline.manage": "Record discipline incidents",
  // Roll numbers
  "rollnumber.generate": "Preview and generate draft roll numbers",
  "rollnumber.finalize": "Finalize roll numbers",
  "rollnumber.correct": "Correct finalized roll numbers",
  // Documents
  "idcard.generate": "Generate ID cards",
  "document.generate": "Generate school documents",
  "document.revoke": "Revoke issued documents (they then fail public verification)",
  "certificate.issue": "Issue certificates",
  // HR
  "employee.read": "View employee records",
  "employee.manage": "Create and edit employees",
  "employee.sensitive.read": "View employee PAN/bank details",
  // Phase 3A (ADR-036, H6/H8): personal tier (date of birth, personal contact, address, emergency contact,
  // documents) is separate from the staff directory; documents and photo are managed separately.
  "employee.personal.read": "View employee personal details and documents",
  "employee.document.manage": "Upload, verify and remove employee documents and photos",
  "leave.request": "Request leave",
  "leave.approve": "Approve or reject leave",
  // Attendance
  "attendance.student.mark": "Mark student attendance",
  "attendance.student.read": "View student attendance",
  "attendance.employee.mark": "Mark employee attendance",
  "attendance.employee.read": "View employee attendance",
  // Payroll
  "payroll.read": "View payroll and salaries",
  "payroll.prepare": "Prepare payroll runs",
  "payroll.approve": "Approve payroll runs",
  "payroll.pay": "Record salary payments",
  "salary.structure.manage": "Manage salary structures",
  "salary.self.read": "View own salary slips",
  // Fees
  "fee.structure.manage": "Manage fee structures and generate invoices",
  "fee.read": "View fees and invoices",
  "fee.collect": "Collect fee payments",
  "fee.concession.manage": "Manage concessions and scholarships",
  "fee.refund": "Cancel receipts and refund payments",
  "fee.report": "View fee reports",
  "fee.pay.online": "Pay fees online",
  // Transport
  "transport.read": "View transport",
  "transport.manage": "Manage vehicles, routes and stops",
  "transport.assign": "Assign students to routes",
  // Academics
  "academic.read": "View classes and sections",
  "academic.manage": "Manage classes, sections, subjects and allocations",
  "timetable.read": "View timetables",
  "timetable.manage": "Manage timetables",
  "exam.manage": "Manage examinations",
  "marks.enter": "Enter marks",
  "marks.approve": "Approve marks",
  "result.read": "View results",
  "result.publish": "Publish results",
  "reportcard.generate": "Generate report cards",
  // Phase 4C (owner decision 2026-11-20): homework for allocated subjects.
  "homework.manage": "Post and manage homework",
  // Library & inventory
  "library.read": "View library",
  "library.manage": "Manage library catalogue",
  "library.issue": "Issue and return books",
  "inventory.read": "View inventory",
  "inventory.manage": "Manage inventory",
  // Import/export
  "import.run": "Run data imports",
  "export.run": "Run data exports",
  // Chatbot
  "chatbot.manage": "Manage chatbot knowledge and settings",
  "chatbot.analytics": "View chatbot analytics",
  // Notices for portal users
  "notice.read": "View internal notices",
  // System
  "audit.read": "View audit logs",
  "backup.manage": "Manage backups",
  "integration.manage": "Configure integrations",
  "notification.send": "Send notifications",
  "usage.read": "View free-tier usage and limits",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export type Scope = "ALL" | "ASSIGNED" | "SELF" | "CHILDREN";

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function moduleOf(key: PermissionKey): string {
  return key.split(".")[0];
}

type Grant = PermissionKey | [PermissionKey, Scope];

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  isSystem?: boolean;
  grants: Grant[];
}

const READ_ACADEMIC: Grant[] = [
  "student.read",
  "admission.read",
  "employee.read",
  "attendance.student.read",
  "attendance.employee.read",
  "timetable.read",
  "result.read",
  "fee.read",
  "transport.read",
  "library.read",
  "inventory.read",
  "notice.read",
  "academic.read",
];

/**
 * Phase 3A M3b — "My profile" (owner decision H7, approved 2026-11-18): staff roles read their OWN employee record
 * (directory + personal tier) at SELF scope = AuthContext.employeeId. Never Parent or Student. Roles that already
 * read the directory at ALL (Vice Principal, Librarian) get only the personal tier at SELF — one scope per
 * permission per role (role_permission primary key).
 */
const MY_PROFILE: Grant[] = [["employee.read", "SELF"], ["employee.personal.read", "SELF"]];
const MY_PERSONAL: Grant[] = [["employee.personal.read", "SELF"]];
/**
 * Phase 3B M4 — "My attendance" (owner decision L9, approved 2026-11-18): staff roles without the ALL grant read
 * their OWN attendance at SELF scope = AuthContext.employeeId (staff-attendance.service). Never Parent or Student.
 */
const MY_ATTENDANCE: Grant[] = [["attendance.employee.read", "SELF"]];
/** Phase 3C (owner decision Q, approved 2026-11-19): senior staff see their OWN salary slips too. */
const MY_SLIPS: Grant[] = [["salary.self.read", "SELF"]];

const TEACHER: Grant[] = [
  ["student.read", "ASSIGNED"],
  ["attendance.student.mark", "ASSIGNED"],
  ["attendance.student.read", "ASSIGNED"],
  ["marks.enter", "ASSIGNED"],
  ["result.read", "ASSIGNED"],
  // Phase 4C (owner 2026-11-20): homework for the subjects the teacher is allocated in each section.
  ["homework.manage", "ASSIGNED"],
  "timetable.read",
  "leave.request",
  ["salary.self.read", "SELF"],
  "library.read",
  "notice.read",
  // ASSIGNED = the section(s) the teacher is class teacher of (academic.policy; TeacherAllocation in Phase 4).
  ["academic.read", "ASSIGNED"],
  ...MY_PROFILE,
  ...MY_ATTENDANCE,
];

export const ROLES: RoleDefinition[] = [
  {
    key: "SUPER_ADMIN",
    name: "Super Admin",
    description: "Complete system-level control. System role; cannot be edited or deleted.",
    isSystem: true,
    grants: ALL_PERMISSION_KEYS,
  },
  {
    key: "SCHOOL_ADMIN",
    name: "School Admin",
    description: "Day-to-day administration within the modules allowed by Super Admin.",
    grants: [
      // School-level settings and academic sessions (owner decision 2026-11-09). System-level authority
      // (users, roles, backups, chatbot/AI, audit) stays with Super Admin.
      "user.read", "settings.read", "settings.manage", "session.manage", "cms.read", "cms.edit", "cms.publish", "enquiry.read", "enquiry.manage",
      "admission.read", "admission.create", "admission.approve",
      "student.read", "student.create", "student.update", "student.delete", "student.document.read",
      "student.document.manage", "student.promote", "student.transfer", "rollnumber.generate", "idcard.generate", "document.generate",
      "employee.read", "attendance.student.read", "attendance.employee.read", "fee.read", "transport.read",
      // Phase 3A (owner decisions Q1, H6, H8 — 2026-11-10): School Admin manages staff records and documents.
      "employee.manage", "employee.personal.read", "employee.document.manage",
      ...MY_SLIPS,
      // Phase 4 (owner decisions AC11, AC12 — 2026-11-19): exams and report cards.
      "exam.manage", "reportcard.generate",
      // Phase 4C (owner 2026-11-20): homework for every section.
      "homework.manage",
      "academic.read", "academic.manage", "timetable.read", "timetable.manage", "library.read", "inventory.read",
      "import.run", "export.run", "notice.read", "notification.send",
    ],
  },
  {
    key: "PRINCIPAL",
    name: "Principal",
    description: "Academic head with approval authority.",
    grants: [
      // admission.approve: Principal and School Admin approve admissions (owner decision D2, 2026-11-10).
      ...READ_ACADEMIC, "admission.approve", "student.sensitive.read", "student.document.read", "leave.approve", "marks.approve",
      "result.publish", "rollnumber.finalize", "rollnumber.correct", "certificate.issue", "document.revoke", "payroll.read",
      "payroll.approve", "fee.report", "cms.read", "cms.publish", "audit.read", "enquiry.read", "notification.send",
      // Phase 3A (H6): staff personal details (read only).
      "employee.personal.read",
      ...MY_SLIPS,
      // Phase 4 (AC11, AC12): exams and report cards.
      "exam.manage", "reportcard.generate",
    ],
  },
  {
    key: "VICE_PRINCIPAL",
    name: "Vice Principal",
    description: "Supports the Principal; no payroll approval or audit access.",
    grants: [
      ...READ_ACADEMIC, "student.sensitive.read", "student.document.read", "leave.approve", "marks.approve",
      "result.publish", "rollnumber.finalize", "certificate.issue", "fee.report", "cms.read", "enquiry.read",
      ...MY_PERSONAL, ...MY_SLIPS,
    ],
  },
  {
    key: "ACCOUNTANT",
    name: "Accountant",
    description: "Fees, payments and payroll processing.",
    grants: [
      "fee.structure.manage", "fee.read", "fee.collect", "fee.concession.manage", "fee.refund", "fee.report",
      "payroll.read", "payroll.prepare", "payroll.pay", "student.read", "transport.read", "export.run",
      "leave.request", ["salary.self.read", "SELF"], "notice.read", ...MY_PROFILE, ...MY_ATTENDANCE,
    ],
  },
  {
    key: "HR_MANAGER",
    name: "HR Manager",
    description: "Employees, leave, staff attendance and salary structures.",
    grants: [
      "employee.read", "employee.manage", "employee.sensitive.read", "employee.personal.read", "employee.document.manage",
      "leave.approve", "leave.request",
      "attendance.employee.mark", "attendance.employee.read", "salary.structure.manage", "payroll.prepare",
      "payroll.read", ["salary.self.read", "SELF"], "export.run", "notice.read",
    ],
  },
  {
    key: "ADMISSION_OFFICER",
    name: "Admission Officer",
    description: "Enquiries, admissions and student onboarding documents.",
    grants: [
      "admission.read", "admission.create", "student.read", "student.create", "student.update",
      "student.document.read", "enquiry.read", "enquiry.manage", "rollnumber.generate", "idcard.generate",
      "document.generate", "leave.request", ["salary.self.read", "SELF"], "notice.read",
      // Admissions need the class/section list (ADR-034).
      "academic.read",
      // Prepares and submits applications with their documents; never approves them (D2, maker-checker).
      "student.document.manage",
      ...MY_PROFILE,
      ...MY_ATTENDANCE,
    ],
  },
  { key: "TEACHER", name: "Teacher", description: "Access limited to assigned classes and subjects.", grants: TEACHER },
  {
    key: "CLASS_TEACHER",
    name: "Class Teacher",
    description: "Teacher with responsibility for a section.",
    // Phase 4 (AC12): report cards for the own section only (ASSIGNED — academic policy).
    grants: [...TEACHER, ["discipline.manage", "ASSIGNED"], ["student.update", "ASSIGNED"], ["reportcard.generate", "ASSIGNED"]],
  },
  {
    key: "TRANSPORT_MANAGER",
    name: "Transport Manager",
    description: "Vehicles, routes, stops and student allocation.",
    grants: [
      "transport.read", "transport.manage", "transport.assign", ["student.read", "ASSIGNED"],
      "leave.request", ["salary.self.read", "SELF"], "notice.read", ...MY_PROFILE, ...MY_ATTENDANCE,
    ],
  },
  {
    key: "LIBRARIAN",
    name: "Librarian",
    description: "Library catalogue, issues and returns.",
    grants: [
      "library.read", "library.manage", "library.issue", "student.read", "employee.read",
      "leave.request", ["salary.self.read", "SELF"], "notice.read", ...MY_PERSONAL, ...MY_ATTENDANCE,
    ],
  },
  {
    key: "PARENT",
    name: "Parent",
    description: "Access to linked children's records only.",
    grants: [
      ["student.read", "CHILDREN"], ["attendance.student.read", "CHILDREN"], ["fee.read", "CHILDREN"],
      ["fee.pay.online", "CHILDREN"], ["result.read", "CHILDREN"], ["timetable.read", "CHILDREN"], "notice.read",
    ],
  },
  {
    key: "STUDENT",
    name: "Student",
    description: "Access to own records only.",
    grants: [
      ["student.read", "SELF"], ["attendance.student.read", "SELF"], ["result.read", "SELF"],
      ["timetable.read", "SELF"], ["library.read", "SELF"], ["fee.read", "SELF"], "notice.read",
    ],
  },
];

export function normalizeGrant(grant: Grant): { key: PermissionKey; scope: Scope } {
  return Array.isArray(grant) ? { key: grant[0], scope: grant[1] } : { key: grant, scope: "ALL" };
}

/**
 * S-08 (2026-11-10): the scopes each permission may be granted with. "ALL" (except "*.self.*" keys); a narrower scope only
 * where the catalog's own default roles use it — those are the scopes the owning module implements (or, for
 * portal scopes not built yet, refuses). Every other service treats a narrower scope like ALL, so offering it
 * in the role editor would silently grant everything. A module that starts honouring a new scope must list
 * it here (and get a policy + tests) before roles can be given it.
 */
export const ALLOWED_SCOPES: Readonly<Record<PermissionKey, readonly Scope[]>> = (() => {
  // "*.self.*" permissions (own salary slip) mean SELF by definition — never all records.
  const out = Object.fromEntries(ALL_PERMISSION_KEYS.map((k) => [k, new Set<Scope>(k.includes(".self.") ? [] : ["ALL"])])) as Record<PermissionKey, Set<Scope>>;
  // The system Super Admin role holds everything at ALL by construction and can't be edited — not a signal.
  for (const role of ROLES) if (!role.isSystem) for (const g of role.grants) {
    const { key, scope } = normalizeGrant(g);
    out[key].add(scope);
  }
  const order: Scope[] = ["ALL", "ASSIGNED", "CHILDREN", "SELF"];
  return Object.fromEntries(Object.entries(out).map(([k, set]) => [k, order.filter((s) => set.has(s))])) as unknown as Record<PermissionKey, readonly Scope[]>;
})();

export function isScopeAllowed(key: PermissionKey, scope: Scope): boolean {
  return ALLOWED_SCOPES[key].includes(scope);
}
