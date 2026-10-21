import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { KnowledgeBoard } from '../features/knowledge/KnowledgeBoard';
import type { KnowledgeBoardProps } from '../features/knowledge/KnowledgeBoard';
import { ApiError } from '../api/client';
import type { ExploreApi } from '../api/client';
import { factListSchema } from '../api/schemas';
import { RAW_FACTS, fakeApi } from './fixtures';

afterEach(cleanup);

function renderBoard(api: ExploreApi, overrides: Partial<KnowledgeBoardProps> = {}) {
  const props: KnowledgeBoardProps = {
    api,
    workspaceId: 1,
    revision: 0,
    highlightFactId: null,
    anchor: null,
    onJumpTo: vi.fn(),
    onFactsChanged: vi.fn(),
    ...overrides
  };
  render(<KnowledgeBoard {...props} />);
  return props;
}

async function card(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title });
  const article = heading.closest('article');
  if (!article) throw new Error(`no card for ${title}`);
  return article;
}

describe('KnowledgeBoard', () => {
  it('lists facts with drift, trust and evidence links', async () => {
    const api = fakeApi();
    const props = renderBoard(api);

    const drifted = await card('addUser must stay idempotent');
    expect(within(drifted).getByText('NEEDS REVIEW')).toBeTruthy();
    expect(within(drifted).getByText('35%')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('1 NEEDS REVIEW');

    fireEvent.click(within(drifted).getByRole('button', { name: /UserStore\.addUser/ }));
    fireEvent.click(within(drifted).getByRole('button', { name: 'src/store.ts' }));

    expect(props.onJumpTo).toHaveBeenNthCalledWith(1, 'symbol:7');
    expect(props.onJumpTo).toHaveBeenNthCalledWith(2, 'file:src/store.ts');
  });

  it('reaffirms a drifted fact and reloads', async () => {
    const api = fakeApi();
    const props = renderBoard(api);

    const drifted = await card('addUser must stay idempotent');
    fireEvent.click(within(drifted).getByRole('button', { name: /Reaffirm/ }));

    await waitFor(() => expect(props.onFactsChanged).toHaveBeenCalledTimes(1));
    expect(api.updateFact).toHaveBeenCalledWith(1, 41, { action: 'reaffirm' });
    await waitFor(() => expect(api.listFacts).toHaveBeenCalledTimes(2));
  });

  it('asks for confirmation before archiving', async () => {
    const api = fakeApi();
    renderBoard(api);

    const fact = await card('Users live in memory');
    fireEvent.click(within(fact).getByRole('button', { name: /Archive/ }));
    expect(api.updateFact).not.toHaveBeenCalled();
    fireEvent.click(within(fact).getByRole('button', { name: /Confirm archive/ }));

    await waitFor(() => expect(api.updateFact).toHaveBeenCalledWith(1, 42, { action: 'archive' }));
  });

  it('supersedes a fact with a prefilled replacement', async () => {
    const api = fakeApi();
    renderBoard(api);

    const fact = await card('Users live in memory');
    fireEvent.click(within(fact).getByRole('button', { name: /Supersede/ }));
    const form = within(fact).getByRole('form', { name: 'Supersede fact 42' });
    expect(within(form).getByLabelText<HTMLInputElement>('Title').value).toBe('Users live in memory');
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Users live in SQLite' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record replacement' }));

    await waitFor(() => expect(api.updateFact).toHaveBeenCalledWith(1, 42, {
      action: 'supersede', kind: 'decision', title: 'Users live in SQLite', body: 'No database for users yet.', summary: undefined
    }));
  });

  it('edits a fact in place with a prefilled form', async () => {
    const before = factListSchema.parse(RAW_FACTS);
    const after = { ...before, facts: before.facts.map(fact => (fact.id === 42 ? { ...fact, title: 'Users live in SQLite', summary: 'Users live in SQLite' } : fact)) };
    const listFacts = vi.fn<ExploreApi['listFacts']>().mockResolvedValueOnce(before).mockResolvedValue(after);
    const api = fakeApi({ listFacts });
    const props = renderBoard(api);

    const fact = await card('Users live in memory');
    fireEvent.click(within(fact).getByRole('button', { name: /^Edit/ }));
    const form = within(fact).getByRole('form', { name: 'Edit fact 42' });
    expect(within(form).getByLabelText<HTMLSelectElement>('Kind').value).toBe('decision');
    expect(within(form).getByLabelText<HTMLInputElement>('Title').value).toBe('Users live in memory');
    expect(within(form).getByLabelText<HTMLTextAreaElement>('Body').value).toBe('No database for users yet.');
    expect(within(fact).queryByRole('button', { name: /Supersede/ })).toBeNull();
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Users live in SQLite' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(props.onFactsChanged).toHaveBeenCalledTimes(1));
    expect(api.updateFact).toHaveBeenCalledTimes(1);
    expect(api.updateFact).toHaveBeenCalledWith(1, 42, {
      action: 'update', kind: 'decision', title: 'Users live in SQLite', body: 'No database for users yet.', summary: 'Users live in SQLite'
    });
    expect(api.createFact).not.toHaveBeenCalled();
    const edited = await card('Users live in SQLite');
    expect(within(edited).getByRole('button', { name: 'Show fact 42 in the graph' })).toBeTruthy();
    expect(within(edited).queryByRole('form')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Users live in memory' })).toBeNull();
  });

  it('cancels an edit without saving it', async () => {
    const api = fakeApi();
    const props = renderBoard(api);

    const fact = await card('Users live in memory');
    fireEvent.click(within(fact).getByRole('button', { name: /^Edit/ }));
    let form = within(fact).getByRole('form', { name: 'Edit fact 42' });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Discard me' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));

    expect(within(fact).queryByRole('form')).toBeNull();
    expect(within(fact).getByRole('heading', { name: 'Users live in memory' })).toBeTruthy();
    expect(api.updateFact).not.toHaveBeenCalled();
    expect(props.onFactsChanged).not.toHaveBeenCalled();
    fireEvent.click(within(fact).getByRole('button', { name: /^Edit/ }));
    form = within(fact).getByRole('form', { name: 'Edit fact 42' });
    expect(within(form).getByLabelText<HTMLInputElement>('Title').value).toBe('Users live in memory');
  });

  it('keeps the entered text when an edit fails', async () => {
    const updateFact = vi.fn<ExploreApi['updateFact']>()
      .mockRejectedValue(new ApiError('http', 'the workspace database is busy — retry shortly', 503, 'database_busy'));
    const api = fakeApi({ updateFact });
    const props = renderBoard(api);

    const fact = await card('Users live in memory');
    fireEvent.click(within(fact).getByRole('button', { name: /^Edit/ }));
    const form = within(fact).getByRole('form', { name: 'Edit fact 42' });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Users live in SQLite' } });
    fireEvent.change(within(form).getByLabelText('Body'), { target: { value: 'Moved to SQLite.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));

    expect((await within(form).findByRole('alert')).textContent).toContain('the workspace database is busy');
    expect(within(form).getByLabelText<HTMLInputElement>('Title').value).toBe('Users live in SQLite');
    expect(within(form).getByLabelText<HTMLTextAreaElement>('Body').value).toBe('Moved to SQLite.');
    expect(updateFact).toHaveBeenCalledWith(1, 42, expect.objectContaining({ action: 'update' }));
    expect(props.onFactsChanged).not.toHaveBeenCalled();
    expect(api.listFacts).toHaveBeenCalledTimes(1);
  });

  it('anchors a new fact to the graph selection', async () => {
    const api = fakeApi();
    renderBoard(api, { anchor: { label: 'src/store.ts', evidenceFiles: ['src/store.ts'], evidenceSymbols: [] } });

    fireEvent.click(await screen.findByRole('button', { name: /New fact/ }));
    expect(screen.getByLabelText<HTMLInputElement>(/Anchor to src\/store\.ts/).checked).toBe(true);
    const form = screen.getByRole('form', { name: 'Record a new fact' });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Store is the only writer' } });
    fireEvent.change(within(form).getByLabelText('Body'), { target: { value: 'Nothing else mutates users.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record fact' }));

    await waitFor(() => expect(api.createFact).toHaveBeenCalledWith(1, {
      kind: 'decision', title: 'Store is the only writer', body: 'Nothing else mutates users.', summary: undefined,
      evidenceFiles: ['src/store.ts'], evidenceSymbols: []
    }));
  });

  it('filters by text on the client and by category on the server', async () => {
    const api = fakeApi();
    renderBoard(api);

    await card('Users live in memory');
    fireEvent.change(screen.getByLabelText('Filter facts'), { target: { value: 'idempotent' } });
    expect(screen.queryByRole('heading', { name: 'Users live in memory' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'gotcha' } });

    await waitFor(() => expect(api.listFacts).toHaveBeenLastCalledWith(
      { workspaceId: 1, refresh: false, category: 'gotcha', state: 'open' }, expect.any(AbortSignal)));
  });
});
