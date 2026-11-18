import Link from "next/link";
import { CalendarRange, FileText, Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { formatDateOnly } from "@/lib/format";
import { selectedTimeZone, timeZoneOptions } from "@/lib/timezones";
import { getSchoolSettings, listAcademicSessions } from "@/modules/settings/settings.service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { removeLogoAction } from "./actions";
import { DEFAULT_SECTION_CAPACITY } from "@/modules/academic/academic.rules";
import { CapacityForm } from "./capacity-form";
import { LogoForm } from "./logo-form";
import { ProfileForm, type ProfileDefaults } from "./profile-form";

export const metadata = { title: "Settings" };

type Address = { line1?: string; line2?: string | null; city?: string; district?: string | null; state?: string; pinCode?: string; country?: string } | null;
type Timings = { opensAt?: string; closesAt?: string; officeHours?: string | null } | null;

export default async function SettingsPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "settings.read")) return <NotPermitted />;
  const canManage = hasPermission(ctx, "settings.manage");
  const [settings, { sessions, currentId }] = await Promise.all([getSchoolSettings(ctx), listAcademicSessions(ctx)]);
  const address = (settings?.address as Address) ?? null;
  const timings = (settings?.timings as Timings) ?? null;
  const tz = selectedTimeZone(settings?.timezone);
  const current = sessions.find((s) => s.id === currentId);

  const defaults: ProfileDefaults = {
    name: settings?.name ?? "",
    shortCode: settings?.shortCode ?? "",
    affiliationNo: settings?.affiliationNo ?? "",
    board: settings?.board ?? "",
    email: settings?.email ?? "",
    website: settings?.website ?? "",
    phones: settings?.phones ?? [],
    line1: address?.line1 ?? "",
    line2: address?.line2 ?? "",
    city: address?.city ?? "",
    district: address?.district ?? "",
    state: address?.state ?? "",
    pinCode: address?.pinCode ?? "",
    country: address?.country ?? "India",
    timezone: tz,
    locale: settings?.locale ?? "en-IN",
    currency: settings?.currency ?? "INR",
    dateFormat: settings?.dateFormat ?? "DD/MM/YYYY",
    opensAt: timings?.opensAt ?? "08:00",
    closesAt: timings?.closesAt ?? "14:00",
    officeHours: timings?.officeHours ?? "",
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Settings" description={canManage ? "School identity used across the ERP, the website and every document." : "You can view these settings; a Super Admin can change them."} />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>School profile</h2>
          </CardTitle>
          <CardDescription>Shown in page headers and on every generated document.</CardDescription>
        </CardHeader>
        <CardContent>
          {canManage ? (
            <ProfileForm defaults={defaults} timeZones={timeZoneOptions(settings?.timezone)} />
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {[
                ["Name", defaults.name || "—"],
                ["Short code", defaults.shortCode || "—"],
                ["Board / affiliation", [defaults.board, defaults.affiliationNo].filter(Boolean).join(" · ") || "—"],
                ["Contact", [defaults.phones.join(", "), defaults.email].filter(Boolean).join(" · ") || "—"],
                ["Address", [defaults.line1, defaults.city, defaults.state, defaults.pinCode].filter(Boolean).join(", ") || "—"],
                ["Time zone", defaults.timezone],
                ["Language & region", `${defaults.locale} · ${defaults.currency} · ${defaults.dateFormat}`],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Logo</h2>
          </CardTitle>
          <CardDescription>PNG or JPEG, up to 800 KB. Square images work best. Used on the website and all documents.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings?.logoFileId ? (
            // eslint-disable-next-line @next/next/no-img-element -- served by our own file route, not next/image
            <img src={`/api/v1/files/${settings.logoFileId}`} alt="Current school logo" className="size-20 rounded-lg border object-contain p-1" />
          ) : (
            <div className="flex size-20 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">No logo</div>
          )}
          {canManage && (
            <div className="grid gap-3">
              <LogoForm />
              {settings?.logoFileId && (
                <ConfirmAction
                  label="Remove logo"
                  icon={<Trash2 aria-hidden="true" />}
                  variant="destructive"
                  title="Remove the school logo?"
                  description="Documents and pages will show the school name without a logo until a new one is uploaded."
                  confirmLabel="Remove"
                  action={removeLogoAction}
                  fields={{}}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Academic sessions</h2>
          </CardTitle>
          <CardDescription>
            {current ? (
              <>
                Current session: <Badge variant="outline">{current.name}</Badge> ({formatDateOnly(current.startDate)} – {formatDateOnly(current.endDate)})
              </>
            ) : (
              "No current session is set yet."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/erp/settings/sessions">
              <CalendarRange aria-hidden="true" /> Manage academic sessions
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Sections</h2>
          </CardTitle>
          <CardDescription>
            {canManage ? "Existing sections keep their own capacity when this changes." : `Default capacity for new sections: ${settings?.defaultSectionCapacity ?? DEFAULT_SECTION_CAPACITY}.`}
          </CardDescription>
        </CardHeader>
        {canManage && (
          <CardContent>
            <CapacityForm value={settings?.defaultSectionCapacity ?? DEFAULT_SECTION_CAPACITY} />
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Documents</h2>
          </CardTitle>
          <CardDescription>Preview the letterhead used for ID cards, certificates, receipts and report cards. Contains no personal data.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <a href="/api/v1/documents/preview" target="_blank" rel="noopener">
              <FileText aria-hidden="true" /> Preview document (PDF)
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
