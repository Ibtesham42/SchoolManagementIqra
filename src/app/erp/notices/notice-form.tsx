"use client";

import { useActionState, useState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createNoticeAction, updateNoticeAction } from "./actions";

type Audience = "FAMILIES" | "PARENTS" | "STAFF" | "ALL";
type Scope = "SCHOOL" | "CLASS" | "SECTION";

export interface NoticeFormDefaults {
  id?: string;
  version?: number;
  title: string;
  body: string;
  audience: Audience;
  scope: Scope;
  targetIds: string[];
  publishAt: string;
  showUntil: string;
}

const AUDIENCE_LABEL: Record<Audience, string> = { FAMILIES: "Families (parents and students)", PARENTS: "Parents only", STAFF: "Staff", ALL: "Families and staff" };
const SCOPE_LABEL: Record<Scope, string> = { SCHOOL: "Whole school", CLASS: "Some classes", SECTION: "Some sections" };

/**
 * Phase 6C-M1 — write (sessionId) or edit a draft (id + version). A class teacher (ASSIGNED) writes to the families of
 * their own sections only, so audience and scope are fixed for them. The server re-checks everything.
 */
export function NoticeForm({
  academicSessionId,
  manage,
  classes,
  sections,
  defaults,
  timeZone,
}: {
  academicSessionId?: string;
  manage: "ALL" | "ASSIGNED";
  classes: { id: string; name: string }[];
  sections: { id: string; code: string }[];
  defaults: NoticeFormDefaults;
  timeZone: string;
}) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateNoticeAction : createNoticeAction, initialState);
  // Controlled: React 19 resets uncontrolled fields after a form action, which would lose typed text on an error.
  const [title, setTitle] = useState(defaults.title);
  const [body, setBody] = useState(defaults.body);
  const [audience, setAudience] = useState<Audience>(manage === "ASSIGNED" && defaults.audience !== "PARENTS" ? "FAMILIES" : defaults.audience);
  const [scope, setScope] = useState<Scope>(manage === "ASSIGNED" ? "SECTION" : defaults.scope);
  const [targets, setTargets] = useState<string[]>(defaults.targetIds);
  const [publishAt, setPublishAt] = useState(defaults.publishAt);
  const [showUntil, setShowUntil] = useState(defaults.showUntil);
  const id = (f: string) => `notice-${defaults.id ?? "new"}-${f}`;
  const staffToo = audience === "STAFF" || audience === "ALL";
  const effectiveScope: Scope = staffToo ? "SCHOOL" : scope;
  const choices = effectiveScope === "CLASS" ? classes.map((c) => ({ id: c.id, label: c.name })) : effectiveScope === "SECTION" ? sections.map((s) => ({ id: s.id, label: s.code })) : [];
  const toggle = (v: string, on: boolean) => setTargets((t) => (on ? [...t, v] : t.filter((x) => x !== v)));
  const switchScope = (s: Scope) => {
    setScope(s);
    setTargets([]);
  };

  return (
    <form action={action} className="grid gap-4">
      {editing ? (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      ) : (
        <input type="hidden" name="academicSessionId" value={academicSessionId} />
      )}
      <TextField id={id("title")} label="Title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} required error={state.fieldErrors?.title} />
      <div className="grid gap-1.5">
        <label htmlFor={id("body")} className="text-sm font-medium">
          Notice
        </label>
        <textarea
          id={id("body")}
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          rows={8}
          required
          className="min-h-40 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm"
          aria-invalid={state.fieldErrors?.body ? true : undefined}
          aria-describedby={`${id("body")}-hint${state.fieldErrors?.body ? ` ${id("body")}-error` : ""}`}
        />
        <p id={`${id("body")}-hint`} className="text-xs text-muted-foreground">
          Plain text, up to 4,000 characters ({body.length} used). Line breaks are kept.
        </p>
        {state.fieldErrors?.body && (
          <p id={`${id("body")}-error`} className="text-sm text-destructive">
            {state.fieldErrors.body}
          </p>
        )}
      </div>

      {manage === "ALL" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField id={id("audience")} label="For" name="audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)} options={(["FAMILIES", "PARENTS", "STAFF", "ALL"] as const).map((a) => ({ value: a, label: AUDIENCE_LABEL[a] }))} error={state.fieldErrors?.audience} />
          {staffToo ? (
            <>
              <input type="hidden" name="scope" value="SCHOOL" />
              <p className="self-end text-sm text-muted-foreground">Notices for staff go to the whole school.</p>
            </>
          ) : (
            <SelectField id={id("scope")} label="Reach" name="scope" value={scope} onChange={(e) => switchScope(e.target.value as Scope)} options={(["SCHOOL", "CLASS", "SECTION"] as const).map((s) => ({ value: s, label: SCOPE_LABEL[s] }))} error={state.fieldErrors?.scope} />
          )}
        </div>
      ) : (
        <>
          <input type="hidden" name="scope" value="SECTION" />
          <SelectField id={id("audience")} label="For" name="audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)} options={(["FAMILIES", "PARENTS"] as const).map((a) => ({ value: a, label: AUDIENCE_LABEL[a] }))} hint="Families of the sections you are class teacher of." error={state.fieldErrors?.audience} />
        </>
      )}

      {choices.length > 0 || effectiveScope !== "SCHOOL" ? (
        <fieldset className="grid gap-2" aria-describedby={state.fieldErrors?.targetIds ? id("targets-error") : undefined}>
          <legend className="mb-1 text-sm font-medium">{effectiveScope === "CLASS" ? "Classes" : "Sections"}</legend>
          {choices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{effectiveScope === "CLASS" ? "No active classes." : "No sections to choose from in this session."}</p>
          ) : (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              {choices.map((c) => (
                <label key={c.id} className="flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm pointer-fine:min-h-9">
                  <input type="checkbox" name="targetIds" value={c.id} checked={targets.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} className="size-4" />
                  {c.label}
                </label>
              ))}
            </div>
          )}
          {state.fieldErrors?.targetIds && (
            <p id={id("targets-error")} className="text-sm text-destructive">
              {state.fieldErrors.targetIds}
            </p>
          )}
        </fieldset>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={id("publishAt")}
          label="Publish at (optional)"
          name="publishAt"
          type="datetime-local"
          value={publishAt}
          onChange={(e) => setPublishAt(e.target.value)}
          hint={`School time (${timeZone}). Empty = when you press Publish.`}
          error={state.fieldErrors?.publishAt}
        />
        <TextField id={id("showUntil")} label="Show until (optional)" name="showUntil" type="date" value={showUntil} onChange={(e) => setShowUntil(e.target.value)} hint="The last day readers see it." error={state.fieldErrors?.showUntil} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save draft" : "Save as draft"}
      </SubmitButton>
    </form>
  );
}
