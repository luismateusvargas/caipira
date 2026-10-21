import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { FACT_CATEGORIES, isFactCategory } from '../../api/schemas';
import type { FactCategory } from '../../api/schemas';
import { toApiError } from '../../api/client';

/** What the form collects. */
export interface FactDraft {
  kind: FactCategory;
  title: string;
  body: string;
  summary: string;
}

/** Props for {@link FactForm}. */
export interface FactFormProps {
  /** Accessible name of the form. */
  legend: string;
  /** Label of the submit button. */
  submitLabel: string;
  /** Values to start from, for superseding an existing fact. */
  initial?: Partial<FactDraft> | undefined;
  /** Shown above the fields, such as what the fact will be anchored to. */
  note?: string | undefined;
  /** Saves the fact; a rejection is shown and the entered values are kept. */
  onSubmit: (draft: FactDraft) => Promise<void>;
  onCancel: () => void;
}

/** A form for recording or superseding a fact. */
export function FactForm({ legend, submitLabel, initial, note, onSubmit, onCancel }: FactFormProps) {
  const id = useId();
  const [draft, setDraft] = useState<FactDraft>({
    kind: initial?.kind ?? 'decision',
    title: initial?.title ?? '',
    body: initial?.body ?? '',
    summary: initial?.summary ?? ''
  });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const titleError = draft.title.trim() === '' ? 'A title is required.' : null;
  const bodyError = draft.body.trim() === '' ? 'Describe the fact and its reasoning.' : null;

  const update = <K extends keyof FactDraft>(key: K, value: FactDraft[K]) => setDraft(current => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (titleError || bodyError) return;
    setSaving(true);
    setServerError(null);
    try {
      await onSubmit({ ...draft, title: draft.title.trim(), body: draft.body.trim(), summary: draft.summary.trim() });
    } catch (error) {
      setServerError(toApiError(error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="fact-form" aria-label={legend} onSubmit={event => void submit(event)} noValidate>
      {note && <p className="fact-form__note">{note}</p>}
      <div className="field">
        <label htmlFor={`${id}-kind`}>Kind</label>
        <select id={`${id}-kind`} value={draft.kind} onChange={event => { if (isFactCategory(event.target.value)) update('kind', event.target.value); }}>
          {FACT_CATEGORIES.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          value={draft.title}
          maxLength={200}
          aria-invalid={touched && titleError !== null}
          aria-describedby={touched && titleError ? `${id}-title-error` : undefined}
          onChange={event => update('title', event.target.value)}
        />
        {touched && titleError && <p id={`${id}-title-error`} className="field__error">{titleError}</p>}
      </div>
      <div className="field">
        <label htmlFor={`${id}-summary`}>Summary <span className="field__hint">(one line, optional)</span></label>
        <input id={`${id}-summary`} value={draft.summary} maxLength={500} onChange={event => update('summary', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-body`}>Body</label>
        <textarea
          id={`${id}-body`}
          rows={4}
          value={draft.body}
          aria-invalid={touched && bodyError !== null}
          aria-describedby={touched && bodyError ? `${id}-body-error` : undefined}
          onChange={event => update('body', event.target.value)}
        />
        {touched && bodyError && <p id={`${id}-body-error`} className="field__error">{bodyError}</p>}
      </div>
      {serverError && <p className="field__error" role="alert">{serverError}</p>}
      <div className="fact-form__actions">
        <button type="button" className="button button--ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="button button--primary" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  );
}
