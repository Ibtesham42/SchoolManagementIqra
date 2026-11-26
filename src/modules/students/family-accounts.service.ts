import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { emailAvailable, maskEmail, sendEmail } from "@/lib/email";
import { formatActivationCode } from "@/lib/auth/activation-code";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { renderPdf } from "@/lib/pdf/render";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { loadBranding } from "@/modules/documents/documents.service";
import { ActivationSlipsDocument, type ActivationSlip } from "@/modules/documents/templates/activation-slip";
import { activatePortalAccount } from "@/modules/identity/activation.service";
import type { ActivateAccountInput } from "@/modules/identity/activation.schemas";
import { USERNAME_PATTERN } from "@/modules/identity/identity.schemas";
import {
  createPortalAccountTx,
  issueActivationCodeTx,
  portalAccountOfTx,
  portalAccountsOfGuardiansTx,
  setPortalAccountActiveTx,
  usernameTakenTx,
  type PortalAccountRow,
} from "@/modules/identity/portal-accounts.tx";
import { getPortalSettings, getSchoolName, getSchoolTimezone } from "@/modules/settings/settings.public";
import { readPortalSettingsTx } from "@/modules/settings/settings.service";
import { deactivateOrphanedStudentAccountsTx } from "./student-accounts.tx";
import { forgetStudentNotifications } from "@/modules/notifications/notifications.service";
import { guardianAccountIds } from "./family-recipients.tx";
import type { GuardianSlipInput, SectionSlipsInput, StudentSlipInput } from "./family-accounts.schemas";

/**
 * Phase 6A-M3 (ADR-046) — parent portal accounts, issued by the school office (PHASE_6_PLAN.md §2.4, P2, P4–P6, P24).
 *
 * - `portal.account.manage` at ALL (School Admin; Super Admin) plus `student.read` at ALL (the screens list guardians).
 * - Lock order (§2.6): student(s) FOR UPDATE ORDER BY id → guardian(s) FOR UPDATE ORDER BY id → user (identity).
 * - Identity creates and changes only portal-only accounts and checks the PARENT role allowlist every time.
 * - Codes exist in plain text only in the returned slips (rendered to a PDF straight away, after the commit).
 *   A failed render after the commit loses the codes, not the accounts: the office prints a new slip.
 * - Username: the guardian's 10-digit mobile number when free; otherwise the office types one (single slip), and a
 *   section run lists that guardian as "needs a username" — never which account holds the number.
 */
/** Review 6A-M3b M2: how long a contact change by someone else blocks email invitations. */
export const RECENT_CONTACT_CHANGE_MS = 7 * 86_400_000;
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Bulk issuance: one section per transaction (§2.6). */
export const MAX_SECTION_STUDENTS = 80;

export function canManageFamilyAccess(ctx: AuthContext): boolean {
  return hasPermission(ctx, "portal.account.manage") && scopeFor(ctx, "portal.account.manage") === "ALL" && hasPermission(ctx, "student.read") && scopeFor(ctx, "student.read") === "ALL";
}

function assertManager(ctx: AuthContext) {
  if (authorize(ctx, "portal.account.manage") !== "ALL" || authorize(ctx, "student.read") !== "ALL") throw new ForbiddenError();
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

export type FamilyAccountStatus = "NONE" | "PENDING" | "EXPIRED" | "ACTIVE" | "DEACTIVATED";
export function familyAccountStatus(a: PortalAccountRow | null | undefined): FamilyAccountStatus {
  if (!a) return "NONE";
  if (!a.isActive) return "DEACTIVATED";
  if (a.pendingCodeExpiresAt && !a.activatedAt) return "PENDING";
  if (a.activatedAt) return "ACTIVE";
  return "EXPIRED";
}

/** The suggested username for a guardian: the 10-digit mobile number, if it is a valid username. */
export const suggestedUsername = (phone: string) => (/^\d{10}$/.test(phone) && USERNAME_PATTERN.test(phone) ? phone : null);

// ───────────────────────────── Reads ─────────────────────────────

/** "Family access" on the student profile: each guardian, whether the link is blocked, and the account state. */
export async function getFamilyAccess(ctx: AuthContext, studentId: string) {
  assertManager(ctx);
  const student = await prisma.student.findFirst({
    where: { id: studentId, deletedAt: null },
    select: {
      id: true,
      guardians: {
        where: { guardian: { deletedAt: null } },
        orderBy: [{ isPrimary: "desc" }, { guardianId: "asc" }],
        take: 10,
        select: { relation: true, isPrimary: true, portalAccess: true, guardian: { select: { id: true, name: true, phone: true, email: true } } },
      },
    },
  });
  if (!student) throw new NotFoundError("Student not found.");
  const accounts = await portalAccountsOfGuardiansTx(prisma, student.guardians.map((g) => g.guardian.id));
  return student.guardians.map((g) => {
    const a = accounts.get(g.guardian.id) ?? null;
    return {
      guardianId: g.guardian.id,
      name: g.guardian.name,
      relation: g.relation as string,
      isPrimary: g.isPrimary,
      portalAccess: g.portalAccess,
      suggestedUsername: suggestedUsername(g.guardian.phone),
      /** Review 6A-M3b M2: the full address — the office (student.read ALL) must see exactly where an invitation goes. */
      email: g.guardian.email,
      account: a ? { username: a.username, status: familyAccountStatus(a), codeExpiresAt: a.pendingCodeExpiresAt, activatedAt: a.activatedAt, everActivated: a.everActivated } : null,
    };
  });
}

/** "Portal accounts" for a section: each studying student's primary guardian and its account state. */
export async function listSectionFamilyAccess(ctx: AuthContext, sectionId: string) {
  assertManager(ctx);
  const section = await prisma.section.findUnique({ where: { id: sectionId }, select: { id: true, code: true, class: { select: { name: true } }, academicSession: { select: { name: true } } } });
  if (!section) throw new NotFoundError("Section not found.");
  const enrollments = await prisma.studentEnrollment.findMany({
    where: { sectionId, status: "ACTIVE", student: { deletedAt: null } },
    orderBy: [{ student: { fullNameNormalized: "asc" } }, { studentId: "asc" }],
    take: MAX_SECTION_STUDENTS + 1,
    select: { student: { select: { id: true, fullName: true, studentCode: true, guardians: { where: { isPrimary: true, guardian: { deletedAt: null } }, take: 1, select: { guardian: { select: { id: true, name: true } } } } } } },
  });
  if (enrollments.length > MAX_SECTION_STUDENTS) throw new ValidationError(`This section has more than ${MAX_SECTION_STUDENTS} students; issue slips per student.`);
  const guardianIds = enrollments.flatMap((e) => e.student.guardians.map((g) => g.guardian.id));
  const accounts = await portalAccountsOfGuardiansTx(prisma, guardianIds);
  return {
    section: { id: section.id, label: `${section.class.name} ${section.code}`, sessionName: section.academicSession.name },
    rows: enrollments.map((e) => {
      const g = e.student.guardians[0]?.guardian ?? null;
      const a = g ? accounts.get(g.id) : null;
      return { studentId: e.student.id, fullName: e.student.fullName, studentCode: e.student.studentCode, guardianName: g?.name ?? null, status: g ? familyAccountStatus(a) : null, username: a?.username ?? null };
    }),
  };
}

// ───────────────────────────── Slips ─────────────────────────────

async function lockStudents(tx: Tx, ids: string[]) {
  if (ids.length === 0) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM student WHERE id = ANY(${ids}) AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
  if (rows.length !== new Set(ids).size) throw new NotFoundError("Student not found.");
}

async function lockGuardians(tx: Tx, ids: string[]) {
  if (ids.length === 0) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM guardian WHERE id = ANY(${ids}) AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
  if (rows.length !== new Set(ids).size) throw new NotFoundError("Guardian not found.");
}

/**
 * Review 6C-M4 L1: lock the student's portal guardians (student → guardian → user, the order every path uses) so the
 * "an activated parent" condition can't change between the eligibility read and the slip / reactivation.
 */
async function lockStudentGuardiansTx(tx: Tx, studentId: string) {
  const links = await tx.studentGuardian.findMany({ where: { studentId, portalAccess: true, guardian: { deletedAt: null } }, take: 20, select: { guardianId: true } });
  await lockGuardians(tx, links.map((l) => l.guardianId));
}

/** Names of the children this guardian's account will see (the slip says whom it is for). */
async function childNamesTx(tx: Tx, guardianId: string): Promise<string[]> {
  const links = await tx.studentGuardian.findMany({
    where: { guardianId, portalAccess: true, student: { deletedAt: null, status: "ACTIVE" } },
    orderBy: { student: { fullNameNormalized: "asc" } },
    take: 20,
    select: { student: { select: { fullName: true } } },
  });
  return links.map((l) => l.student.fullName);
}

async function slipOf(tx: Tx, guardian: { id: string; name: string }, issued: { code: string; expiresAt: Date; username: string }, timeZone: string): Promise<ActivationSlip> {
  return { guardianName: guardian.name, children: await childNamesTx(tx, guardian.id), username: issued.username, code: formatActivationCode(issued.code), expiresOn: todayInTimeZone(timeZone, issued.expiresAt) };
}

/** One guardian of one student: create the account (if none) or print a new slip (reset). */
export async function issueGuardianSlip(ctx: AuthContext, input: GuardianSlipInput): Promise<ActivationSlip[]> {
  assertManager(ctx);
  const timeZone = await getSchoolTimezone();
  return prisma.$transaction(async (tx) => {
    await lockTimeout(tx);
    await lockStudents(tx, [input.studentId]);
    const link = await tx.studentGuardian.findUnique({
      where: { studentId_guardianId: { studentId: input.studentId, guardianId: input.guardianId } },
      select: { guardian: { select: { id: true, name: true, phone: true, deletedAt: true } } },
    });
    if (!link || link.guardian.deletedAt) throw new NotFoundError("Guardian not found.");
    await lockGuardians(tx, [input.guardianId]);
    const existing = await portalAccountOfTx(tx, { guardianId: input.guardianId });
    const actor = actorOf(ctx);
    // Review 6A-M3a L1: no credentials for a guardian who can't see any studying child (blocked, P24, or none left).
    if ((await childNamesTx(tx, input.guardianId)).length === 0) {
      throw new ValidationError("This guardian can't see any studying child in the portal (blocked or none), so no slip was printed.", [{ path: "guardianId", message: "No visible child." }]);
    }
    if (input.mode === "create") {
      if (existing) throw new ConflictError("This guardian already has a portal account. Use \"Print a new slip\" instead.");
      const username = input.username ?? suggestedUsername(link.guardian.phone);
      if (!username) throw new ValidationError("Enter a username for this account.", [{ path: "username", message: "Enter a username." }]);
      if (await usernameTakenTx(tx, username)) throw new ValidationError("That username is already taken. Choose another one.", [{ path: "username", message: "Already taken." }]);
      const { userId } = await createPortalAccountTx(tx, actor, { kind: "GUARDIAN", guardianId: input.guardianId, username, displayName: link.guardian.name });
      return [await slipOf(tx, link.guardian, await issueActivationCodeTx(tx, actor, userId, { reset: false }), timeZone)];
    }
    if (!existing) throw new NotFoundError("This guardian has no portal account yet.");
    return [await slipOf(tx, link.guardian, await issueActivationCodeTx(tx, actor, existing.id, { reset: true }), timeZone)];
  });
}

/**
 * Phase 6A-M3b (P4): an emailed invitation instead of a printed slip, for a guardian with an email address on file.
 * Creates the account if there is none (username as for slips); for an account never activated, a new code replaces
 * the old one. An ACTIVATED account is never re-opened by email (a stale address must not become a takeover path):
 * the office prints a new slip instead. Email availability (provider on, today's free-tier cap not used up) is
 * checked BEFORE any code is issued, so a printed slip isn't voided for an email that can't go out. The link
 * carries username and code in the URL FRAGMENT only (`/activate#u=…&code=…`). Sent after the commit; if sending
 * still fails, the office is told to print a slip (the emailed code is then unknown to anyone).
 */
export async function sendFamilyInvitation(ctx: AuthContext, input: { studentId: string; guardianId: string; username: string | null }): Promise<{ sent: boolean; to: string }> {
  assertManager(ctx);
  // Review 6A-M3b L7: never a relative link in an email.
  if (!/^https?:\/\//.test(process.env.APP_URL ?? "")) throw new ValidationError("Email invitations need the site address (APP_URL) to be configured. Print a slip instead.", [{ path: "email", message: "Email unavailable." }]);
  if (!(await emailAvailable())) throw new ValidationError("Email can't be sent right now (switched off, or today's limit is used up). Print a slip instead, or try tomorrow.", [{ path: "email", message: "Email unavailable." }]);
  const timeZone = await getSchoolTimezone();
  const issued = await prisma.$transaction(async (tx) => {
    await lockTimeout(tx);
    await lockStudents(tx, [input.studentId]);
    const link = await tx.studentGuardian.findUnique({
      where: { studentId_guardianId: { studentId: input.studentId, guardianId: input.guardianId } },
      select: { guardian: { select: { id: true, name: true, phone: true, email: true, deletedAt: true } } },
    });
    if (!link || link.guardian.deletedAt) throw new NotFoundError("Guardian not found.");
    if (!link.guardian.email) throw new ValidationError("This guardian has no email address on file.", [{ path: "email", message: "No email." }]);
    await lockGuardians(tx, [input.guardianId]);
    // Review 6A-M3b M2: an address (or number) changed recently by SOMEONE ELSE — e.g. a class teacher editing the
    // guardian — could point the invitation at the wrong mailbox. Check it with the parent and enter it yourself.
    const recent = await tx.auditLog.findMany({
      where: { action: "guardian.update", entityType: "Guardian", entityId: input.guardianId, at: { gte: new Date(Date.now() - RECENT_CONTACT_CHANGE_MS) } },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: 20,
      select: { actorId: true, after: true },
    });
    // The LATEST change of the email / mobile number counts: once the office saves the confirmed value itself, it may invite.
    const touchesContact = (after: unknown) => {
      const fields = (after as { fields?: unknown } | null)?.fields;
      return Array.isArray(fields) && (fields.includes("email") || fields.includes("phone"));
    };
    const latest = recent.find((r) => touchesContact(r.after));
    const changedByOther = !!latest && latest.actorId !== ctx.userId;
    if (changedByOther) throw new ConflictError("This guardian's email or mobile number was changed by someone else in the last 7 days. Confirm it with the parent and save it yourself, or print a slip instead.");
    if ((await childNamesTx(tx, input.guardianId)).length === 0) {
      throw new ValidationError("This guardian can't see any studying child in the portal (blocked or none), so no invitation was sent.", [{ path: "guardianId", message: "No visible child." }]);
    }
    const actor = actorOf(ctx);
    let userId: string;
    const existing = await portalAccountOfTx(tx, { guardianId: input.guardianId });
    if (existing) {
      // Review 6A-M3b M1: "ever activated", not "currently activated" — an office reset (e.g. a compromised mailbox)
      // must not be undone by an email to the address on file.
      if (existing.activatedAt || existing.everActivated) throw new ConflictError("This account has been activated before. To reset it, print a new slip and hand it over in person.");
      userId = existing.id;
    } else {
      const username = input.username ?? suggestedUsername(link.guardian.phone);
      if (!username) throw new ValidationError("Enter a username for this account.", [{ path: "username", message: "Enter a username." }]);
      if (await usernameTakenTx(tx, username)) throw new ValidationError("That username is already taken. Choose another one.", [{ path: "username", message: "Already taken." }]);
      userId = (await createPortalAccountTx(tx, actor, { kind: "GUARDIAN", guardianId: input.guardianId, username, displayName: link.guardian.name })).userId;
    }
    const slip = await slipOf(tx, link.guardian, await issueActivationCodeTx(tx, actor, userId, { reset: false, channel: "EMAIL" }), timeZone);
    return { slip, email: link.guardian.email };
  });

  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const schoolName = await getSchoolName();
  const link = `${appUrl}/activate#u=${encodeURIComponent(issued.slip.username)}&code=${encodeURIComponent(issued.slip.code)}`;
  try {
    const result = await sendEmail({
      to: issued.email,
      kind: "portal_invitation",
      subject: `${schoolName}: activate your parent portal account`,
      text: [
        `Dear ${issued.slip.guardianName},`,
        "",
        `${schoolName} has opened a parent portal account for you${issued.slip.children.length ? ` (${issued.slip.children.join(", ")})` : ""}.`,
        "",
        `Open this link to activate it before ${issued.slip.expiresOn}:`,
        link,
        "",
        `Username: ${issued.slip.username}`,
        `Activation code: ${issued.slip.code}`,
        "",
        "You will also need your child's date of birth. The code works once. If you did not expect this email, please tell the school office.",
      ].join("\n"),
    });
    return { sent: result.delivered, to: maskEmail(issued.email) };
  } catch (e) {
    console.error("portal invitation email failed", e instanceof Error ? e.name : "unknown");
    return { sent: false, to: maskEmail(issued.email) };
  }
}

/**
 * A section at once (bulk, idempotent): an account and a slip for each studying student's primary guardian without
 * one; with `reissuePending`, also a new code for accounts that were never activated. Activated and deactivated
 * accounts are never touched. Guardians whose mobile number is taken as a username are listed in `skipped`.
 */
export async function issueSectionSlips(ctx: AuthContext, input: SectionSlipsInput): Promise<{ slips: ActivationSlip[]; skipped: { studentName: string; reason: string }[] }> {
  assertManager(ctx);
  const timeZone = await getSchoolTimezone();
  return prisma.$transaction(
    async (tx) => {
      await lockTimeout(tx);
      const enrollments = await tx.studentEnrollment.findMany({
        where: { sectionId: input.sectionId, status: "ACTIVE", student: { deletedAt: null } },
        orderBy: { studentId: "asc" },
        take: MAX_SECTION_STUDENTS + 1,
        select: { studentId: true, student: { select: { fullName: true } } },
      });
      if (enrollments.length > MAX_SECTION_STUDENTS) throw new ValidationError(`This section has more than ${MAX_SECTION_STUDENTS} students; issue slips per student.`);
      await lockStudents(tx, enrollments.map((e) => e.studentId));
      const primaries = await tx.studentGuardian.findMany({
        where: { studentId: { in: enrollments.map((e) => e.studentId) }, isPrimary: true, guardian: { deletedAt: null } },
        select: { studentId: true, portalAccess: true, guardian: { select: { id: true, name: true, phone: true } } },
      });
      const byStudent = new Map(primaries.map((p) => [p.studentId, p]));
      // Review 6A-M3a L1: a primary guardian blocked from this student (P24) gets no account or slip from this run.
      const guardians = [...new Map(primaries.filter((p) => p.portalAccess).map((p) => [p.guardian.id, p.guardian])).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
      await lockGuardians(tx, guardians.map((g) => g.id));
      const accounts = await portalAccountsOfGuardiansTx(tx, guardians.map((g) => g.id));
      const actor = actorOf(ctx);
      const slips: ActivationSlip[] = [];
      const skipped: { studentName: string; reason: string }[] = [];
      const done = new Set<string>();
      for (const e of enrollments) {
        const link = byStudent.get(e.studentId);
        if (!link) {
          skipped.push({ studentName: e.student.fullName, reason: "No primary guardian recorded." });
          continue;
        }
        if (!link.portalAccess) {
          skipped.push({ studentName: e.student.fullName, reason: "Portal view blocked for the primary guardian." });
          continue;
        }
        const g = link.guardian;
        if (done.has(g.id)) continue; // siblings in the same section: one account, one slip
        done.add(g.id);
        const a = accounts.get(g.id);
        if (a) {
          if (input.reissuePending && a.isActive && !a.activatedAt) {
            slips.push(await slipOf(tx, g, await issueActivationCodeTx(tx, actor, a.id, { reset: false }), timeZone));
          }
          continue;
        }
        const username = suggestedUsername(g.phone);
        if (!username || (await usernameTakenTx(tx, username))) {
          skipped.push({ studentName: e.student.fullName, reason: "Needs a username (mobile number missing or already used). Issue this slip from the student's profile." });
          continue;
        }
        const { userId } = await createPortalAccountTx(tx, actor, { kind: "GUARDIAN", guardianId: g.id, username, displayName: g.name });
        slips.push(await slipOf(tx, g, await issueActivationCodeTx(tx, actor, userId, { reset: false }), timeZone));
      }
      await audit(tx, actor, { action: "portal.section_slips", entityType: "Section", entityId: input.sectionId, after: { slips: slips.length, skipped: skipped.length, reissuePending: input.reissuePending } });
      return { slips, skipped };
    },
    { timeout: 30_000 },
  );
}

/** The slips as one PDF (one page per guardian). CPU work — called after the issuing transaction committed. */
export async function renderActivationSlipsPdf(slips: ActivationSlip[]): Promise<Buffer> {
  const [branding, settings] = await Promise.all([loadBranding(), getPortalSettings()]);
  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
  return renderPdf(ActivationSlipsDocument({ branding, slips, activateUrl: `${appUrl}/activate`, consentVersion: settings.privacyNoticeVersion, generatedAt: new Date() }));
}

// ───────────────────────────── Block / deactivate ─────────────────────────────

/** P24: block (or allow) one guardian's portal view of one student. Takes effect at that account's next request. */
export async function setGuardianPortalAccess(ctx: AuthContext, input: { studentId: string; guardianId: string; portalAccess: boolean }) {
  assertManager(ctx);
  const changed = await prisma.$transaction(async (tx) => {
    await lockTimeout(tx);
    await lockStudents(tx, [input.studentId]);
    await lockGuardians(tx, [input.guardianId]);
    const link = await tx.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId: input.studentId, guardianId: input.guardianId } }, select: { portalAccess: true } });
    if (!link) throw new NotFoundError("Guardian not found.");
    if (link.portalAccess === input.portalAccess) return false;
    await tx.studentGuardian.update({ where: { studentId_guardianId: { studentId: input.studentId, guardianId: input.guardianId } }, data: { portalAccess: input.portalAccess } });
    await audit(tx, actorOf(ctx), { action: input.portalAccess ? "portal.link_allow" : "portal.link_block", entityType: "Student", entityId: input.studentId, before: { guardianId: input.guardianId, portalAccess: link.portalAccess }, after: { guardianId: input.guardianId, portalAccess: input.portalAccess } });
    // Review 6C-M4 M1: blocking the last consenting parent ends the child's own account too.
    if (!input.portalAccess) await deactivateOrphanedStudentAccountsTx(tx, actorOf(ctx), [input.studentId]);
    return true;
  });
  // Phase 6C-M2 (P24, plan R5): after a block, nothing about this child stays in that guardian's inbox either.
  if (changed && !input.portalAccess) {
    try {
      await forgetStudentNotifications(await guardianAccountIds(prisma, input.guardianId), input.studentId);
    } catch (e) {
      console.error("notifications (custody block) failed", e instanceof Error ? e.name : "unknown");
    }
  }
}

/** Deactivate or reactivate a guardian's portal account (reached from one of the guardian's students). */
export async function setFamilyAccountActive(ctx: AuthContext, input: { studentId: string; guardianId: string; active: boolean; reason: string }) {
  assertManager(ctx);
  return prisma.$transaction(async (tx) => {
    await lockTimeout(tx);
    await lockStudents(tx, [input.studentId]);
    const link = await tx.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId: input.studentId, guardianId: input.guardianId } }, select: { guardianId: true } });
    if (!link) throw new NotFoundError("Guardian not found.");
    await lockGuardians(tx, [input.guardianId]);
    const account = await portalAccountOfTx(tx, { guardianId: input.guardianId });
    if (!account) throw new NotFoundError("This guardian has no portal account.");
    const changed = await setPortalAccountActiveTx(tx, actorOf(ctx), account.id, input.active, input.reason);
    if (changed && !input.active) {
      // Review 6C-M4 M1: each child this parent consented for keeps an own account only while another parent still does.
      // Review L-C: only children whose own account is still on (left / historical links don't use up a bound).
      const children = await tx.studentGuardian.findMany({ where: { guardianId: input.guardianId, student: { deletedAt: null, account: { is: { isActive: true, deletedAt: null } } } }, select: { studentId: true } });
      await deactivateOrphanedStudentAccountsTx(tx, actorOf(ctx), children.map((c) => c.studentId));
    }
    return changed;
  });
}

// ───────────────────────────── Activation (public) ─────────────────────────────

/** Dates of birth that prove a portal account: a guardian's children it can see (studying), or a student's own. */
export async function familyDatesOfBirthTx(tx: Tx, person: { guardianId: string | null; studentId: string | null }): Promise<string[]> {
  if (person.guardianId) {
    const links = await tx.studentGuardian.findMany({
      where: { guardianId: person.guardianId, portalAccess: true, guardian: { deletedAt: null }, student: { deletedAt: null, status: "ACTIVE" } },
      take: 20,
      select: { student: { select: { dob: true } } },
    });
    return links.map((l) => iso(l.student.dob));
  }
  if (person.studentId) {
    const s = await tx.student.findFirst({ where: { id: person.studentId, deletedAt: null, status: "ACTIVE" }, select: { dob: true } });
    return s ? [iso(s.dob)] : [];
  }
  return [];
}

/** The /activate form: identity's activation with the family's dates of birth and the school's consent version. */
export async function activateFamilyAccount(input: ActivateAccountInput, meta: { ipHash: string; userAgent?: string }) {
  const settings = await getPortalSettings();
  return activatePortalAccount(input, meta, { datesOfBirth: familyDatesOfBirthTx, consentVersion: settings.privacyNoticeVersion ?? "1" });
}

// ───────────────────────────── Phase 6C-M4: student accounts (P14) ─────────────────────────────

/**
 * Why a student can't get an account now (null = eligible). P14: the school setting is on; the student is studying,
 * in a class at or above the setting's minimum level; and at least one guardian who may see the student has an
 * ACTIVATED account (DPDP: the parent consented first). Read inside the caller's lock when it matters.
 */
async function studentAccountProblemTx(tx: Tx | typeof prisma, studentId: string, settings: { studentAccounts: boolean; studentMinClassLevel: number }): Promise<string | null> {
  if (!settings.studentAccounts) return "Student accounts are turned off in Settings → Parent portal.";
  const s = await tx.student.findFirst({
    where: { id: studentId, deletedAt: null },
    select: {
      status: true,
      enrollments: { where: { status: "ACTIVE" }, orderBy: { academicSession: { startDate: "desc" } }, take: 1, select: { section: { select: { class: { select: { numericLevel: true, name: true } } } } } },
      guardians: { where: { portalAccess: true, guardian: { deletedAt: null, account: { is: { isActive: true, deletedAt: null, privacyConsentAt: { not: null } } } } }, take: 1, select: { guardianId: true } },
    },
  });
  if (!s) return "Student not found.";
  if (s.status !== "ACTIVE" || s.enrollments.length === 0) return "Only studying students can have an account.";
  const level = s.enrollments[0].section.class.numericLevel;
  if (level < settings.studentMinClassLevel) return `Student accounts start in Class ${settings.studentMinClassLevel} (Settings → Parent portal).`;
  if (s.guardians.length === 0) return "A parent must activate their own portal account first (they consent for their child).";
  return null;
}

/** The student's own account on "Family access": the setting, eligibility and the account state. */
export async function getStudentAccount(ctx: AuthContext, studentId: string) {
  assertManager(ctx);
  const settings = await getPortalSettings();
  const s = await prisma.student.findFirst({ where: { id: studentId, deletedAt: null }, select: { studentCode: true } });
  if (!s) throw new NotFoundError("Student not found.");
  const [problem, account] = await Promise.all([studentAccountProblemTx(prisma, studentId, settings), prisma.$transaction((tx) => portalAccountOfTx(tx, { studentId }))]);
  return {
    enabled: settings.studentAccounts,
    minClassLevel: settings.studentMinClassLevel,
    problem,
    suggestedUsername: USERNAME_PATTERN.test(s.studentCode.toLowerCase()) ? s.studentCode.toLowerCase() : null,
    account: account ? { username: account.username, status: familyAccountStatus(account), codeExpiresAt: account.pendingCodeExpiresAt, activatedAt: account.activatedAt } : null,
  };
}

/** Create the student's account and print its slip (given to the parent), or print a new slip (reset). */
export async function issueStudentSlip(ctx: AuthContext, input: StudentSlipInput): Promise<ActivationSlip[]> {
  assertManager(ctx);
  const timeZone = await getSchoolTimezone();
  return prisma.$transaction(async (tx) => {
    await lockTimeout(tx);
    await lockStudents(tx, [input.studentId]);
    await lockStudentGuardiansTx(tx, input.studentId);
    const settings = await readPortalSettingsTx(tx); // review 6C-M4 L3: never a stale per-instance copy
    // Under the student lock: eligibility (setting, studying, class level, an activated parent) for new AND reset slips.
    const problem = await studentAccountProblemTx(tx, input.studentId, settings);
    if (problem) throw new ValidationError(problem, [{ path: "studentId", message: problem }]);
    const student = await tx.student.findUniqueOrThrow({ where: { id: input.studentId }, select: { fullName: true, studentCode: true } });
    const existing = await portalAccountOfTx(tx, { studentId: input.studentId });
    const actor = actorOf(ctx);
    const slip = (issued: { code: string; expiresAt: Date; username: string }): ActivationSlip => ({ kind: "STUDENT", guardianName: student.fullName, children: [], username: issued.username, code: formatActivationCode(issued.code), expiresOn: todayInTimeZone(timeZone, issued.expiresAt) });
    if (input.mode === "create") {
      if (existing) throw new ConflictError("This student already has a portal account. Use \"Print a new slip\" instead.");
      const username = input.username ?? (USERNAME_PATTERN.test(student.studentCode.toLowerCase()) ? student.studentCode.toLowerCase() : null);
      if (!username) throw new ValidationError("Enter a username for this account.", [{ path: "username", message: "Enter a username." }]);
      if (await usernameTakenTx(tx, username)) throw new ValidationError("That username is already taken. Choose another one.", [{ path: "username", message: "Already taken." }]);
      const { userId } = await createPortalAccountTx(tx, actor, { kind: "STUDENT", studentId: input.studentId, username, displayName: student.fullName });
      return [slip(await issueActivationCodeTx(tx, actor, userId, { reset: false }))];
    }
    if (!existing) throw new NotFoundError("This student has no portal account yet.");
    return [slip(await issueActivationCodeTx(tx, actor, existing.id, { reset: true }))];
  });
}

/** Deactivate or reactivate the student's own account (reactivation only while eligible). */
export async function setStudentAccountActive(ctx: AuthContext, input: { studentId: string; active: boolean; reason: string }) {
  assertManager(ctx);
  return prisma.$transaction(async (tx) => {
    await lockTimeout(tx);
    await lockStudents(tx, [input.studentId]);
    if (input.active) await lockStudentGuardiansTx(tx, input.studentId);
    const settings = await readPortalSettingsTx(tx); // review 6C-M4 L3
    const account = await portalAccountOfTx(tx, { studentId: input.studentId });
    if (!account) throw new NotFoundError("This student has no portal account.");
    if (input.active) {
      const problem = await studentAccountProblemTx(tx, input.studentId, settings);
      if (problem) throw new ValidationError(problem);
    }
    return setPortalAccountActiveTx(tx, actorOf(ctx), account.id, input.active, input.reason);
  });
}

/**
 * P17 / plan §6 6C-M4: a student who leaves loses their OWN account in the same transaction as the leaving (status
 * change or promotion "left"). Call under the student's row lock (student → user, the provisioning order). Parents
 * keep their leaver window. Returns whether an account was deactivated.
 */
export async function deactivateStudentAccountOnLeavingTx(tx: Tx, actor: AuditActor, studentId: string): Promise<boolean> {
  const account = await portalAccountOfTx(tx, { studentId });
  if (!account || !account.isActive) return false;
  return setPortalAccountActiveTx(tx, actor, account.id, false, "student_left");
}
