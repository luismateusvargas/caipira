import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SymbolInspectorDrawer } from '../features/inspector/SymbolInspectorDrawer';
import { symbolDetailSchema } from '../api/schemas';
import type { ExploreApi } from '../api/client';
import { RAW_SYMBOL_DETAIL, at, fakeApi } from './fixtures';

afterEach(cleanup);

function renderDrawer(api: ExploreApi) {
  const handlers = {
    onBlastRadiusChange: vi.fn<(active: boolean, depth: number) => void>(),
    onSelectSymbol: vi.fn<(symbolId: number) => void>(),
    onFactsChanged: vi.fn<() => void>(),
    onClose: vi.fn<() => void>()
  };
  render(
    <SymbolInspectorDrawer
      api={api}
      workspaceId={1}
      symbolId={7}
      revision={0}
      blastRadius={{ active: false, depth: 2 }}
      {...handlers}
    />
  );
  return handlers;
}

describe('SymbolInspectorDrawer', () => {
  it('shows the signature, what the symbol receives and what it returns', async () => {
    const api = fakeApi();

    renderDrawer(api);

    const receives = await screen.findByRole('table', { name: 'Receives' });
    const rows = within(receives).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
    expect(rows).toEqual([
      ['user', 'User', '—'],
      ['notify', 'boolean', 'false']
    ]);
    const returns = screen.getByRole('heading', { name: 'Returns' }).parentElement;
    expect(returns?.textContent).toContain('Promise<UserRecord>');
    expect(screen.getByText('async addUser(user: User, notify: boolean = false): Promise<UserRecord>')).toBeTruthy();
    expect(screen.getByText('typescript')).toBeTruthy();
    expect(screen.getByText('public')).toBeTruthy();
    expect(screen.getByText('src/store.ts:12')).toBeTruthy();
    expect(screen.getByText('Adds a user and returns the stored record.')).toBeTruthy();
    expect(api.getSymbol).toHaveBeenCalledWith(1, 7, expect.any(AbortSignal));
  });

  it('labels a symbol without a declared return type as void / inferred', async () => {
    const raw = { ...RAW_SYMBOL_DETAIL, symbol: { ...RAW_SYMBOL_DETAIL.symbol, return_type: null, params: [] } };
    const api = fakeApi({ getSymbol: vi.fn(async () => symbolDetailSchema.parse(raw)) });

    renderDrawer(api);

    expect(await screen.findByText('void / inferred')).toBeTruthy();
    expect(screen.getByText('No parameters.')).toBeTruthy();
  });

  it('links workspace types, callers and callees to the inspector', async () => {
    const api = fakeApi();
    const props = renderDrawer(api);

    const receives = await screen.findByRole('table', { name: 'Receives' });
    fireEvent.click(within(receives).getByRole('button', { name: 'User' }));
    fireEvent.click(screen.getByRole('button', { name: 'UserRecord' }));
    const callers = screen.getByRole('list', { name: 'Callers' });
    fireEvent.click(within(callers).getByRole('button', { name: 'createUser' }));
    const callees = screen.getByRole('list', { name: 'Callees' });
    fireEvent.click(within(callees).getByRole('button', { name: 'UserStore.count' }));

    expect(props.onSelectSymbol.mock.calls).toEqual([[2], [5], [3], [8]]);
    expect(within(callers).getByText('main')).toBeTruthy();
    expect(within(callers).queryByRole('button', { name: 'main' })).toBeNull();
    expect(within(receives).queryByRole('button', { name: 'boolean' })).toBeNull();
  });

  it('links a member callee the server resolved and leaves an ambiguous one static', async () => {
    const raw = {
      ...RAW_SYMBOL_DETAIL,
      callees: [
        { target_path: null, target_symbol: 'store.add', edge_kind: 'calls', line: 2, symbol_id: 11 },
        { target_path: null, target_symbol: 'other.remove', edge_kind: 'calls', line: 3, symbol_id: null }
      ]
    };
    const api = fakeApi({ getSymbol: vi.fn(async () => symbolDetailSchema.parse(raw)) });
    const props = renderDrawer(api);

    const callees = await screen.findByRole('list', { name: 'Callees' });
    fireEvent.click(within(callees).getByRole('button', { name: 'store.add' }));

    expect(props.onSelectSymbol.mock.calls).toEqual([[11]]);
    expect(within(callees).getByText('other.remove')).toBeTruthy();
    expect(within(callees).queryByRole('button', { name: 'other.remove' })).toBeNull();
  });

  it('toggles the blast radius focus', async () => {
    const api = fakeApi();
    const props = renderDrawer(api);

    fireEvent.click(await screen.findByRole('button', { name: /Focus Blast Radius/ }));
    fireEvent.change(screen.getByLabelText('Blast radius depth'), { target: { value: '3' } });

    expect(props.onBlastRadiusChange.mock.calls).toEqual([[true, 2], [false, 3]]);
  });

  it('shows attached facts, flags drift and reaffirms', async () => {
    const api = fakeApi();
    const props = renderDrawer(api);

    const facts = await screen.findByRole('heading', { name: 'Attached Facts' });
    const section = facts.closest('section');
    if (!section) throw new Error('no Attached Facts section');
    const items = within(section).getAllByRole('listitem');
    expect(items.map(item => item.querySelector('.attached-fact__title')?.textContent)).toEqual([
      'addUser must stay idempotent',
      'Users live in memory'
    ]);
    expect(within(at(items, 0)).getByText('NEEDS REVIEW')).toBeTruthy();
    expect(within(at(items, 1)).queryByText('NEEDS REVIEW')).toBeNull();

    fireEvent.click(within(at(items, 0)).getByRole('button', { name: /Reaffirm/ }));

    await waitFor(() => expect(props.onFactsChanged).toHaveBeenCalledTimes(1));
    expect(api.updateFact).toHaveBeenCalledWith(1, 41, { action: 'reaffirm' });
    await waitFor(() => expect(api.getSymbol).toHaveBeenCalledTimes(2));
  });

  it('attaches a new fact anchored to the symbol', async () => {
    const api = fakeApi();
    const props = renderDrawer(api);

    fireEvent.click(await screen.findByRole('button', { name: /Attach Fact/ }));
    const form = screen.getByRole('form', { name: 'Attach a fact to this symbol' });
    fireEvent.click(within(form).getByRole('button', { name: 'Attach fact' }));
    expect(within(form).getByText('A title is required.')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Kind'), { target: { value: 'gotcha' } });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Count is cached' } });
    fireEvent.change(within(form).getByLabelText('Body'), { target: { value: 'count() reads a cached length.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Attach fact' }));

    await waitFor(() => expect(props.onFactsChanged).toHaveBeenCalledTimes(1));
    expect(api.createFact).toHaveBeenCalledWith(1, {
      kind: 'gotcha', title: 'Count is cached', body: 'count() reads a cached length.', summary: undefined, evidenceSymbols: [7]
    });
  });

  it('shows a retryable error when the symbol cannot be loaded', async () => {
    const { ApiError } = await import('../api/client');
    const getSymbol = vi.fn<ExploreApi['getSymbol']>()
      .mockRejectedValueOnce(new ApiError('http', 'no symbol with id 7', 404, 'symbol_not_found'))
      .mockResolvedValueOnce(symbolDetailSchema.parse(RAW_SYMBOL_DETAIL));
    const api = fakeApi({ getSymbol });

    renderDrawer(api);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no longer in the index');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table', { name: 'Receives' })).toBeTruthy();
  });
});
