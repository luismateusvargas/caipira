import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OmniSearchModal } from '../features/search/OmniSearchModal';
import { App } from '../App';
import { fakeApi } from './fixtures';

afterEach(cleanup);

// jsdom has no canvas; the graph draws nothing but still mounts.
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

describe('OmniSearchModal', () => {
  it('searches symbols, files and facts and opens the chosen one with the keyboard', async () => {
    const api = fakeApi();
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<OmniSearchModal open api={api} workspaceId={1} onPick={onPick} onClose={onClose} />);

    const input = screen.getByRole('combobox', { name: 'Search symbols, files and facts' });
    fireEvent.change(input, { target: { value: 'User' } });

    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.querySelector('.omni__title')?.textContent)).toEqual([
      'UserStore.addUser', 'src/store.ts', 'addUser must stay idempotent', 'Users live in memory'
    ]);
    expect(api.searchSymbols).toHaveBeenCalledWith(1, 'User', expect.any(AbortSignal));
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[2]?.id);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onPick).toHaveBeenCalledWith({ type: 'fact', factId: 41 });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<OmniSearchModal open api={fakeApi()} workspaceId={1} onPick={vi.fn()} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    render(<OmniSearchModal open={false} api={fakeApi()} workspaceId={1} onPick={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('App', () => {
  it('opens the omni search with Ctrl+K and inspects the picked symbol', async () => {
    const api = fakeApi();
    render(<App api={api} />);

    await screen.findByRole('application', { name: /Graph with 4 nodes/ });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Search symbols, files and facts' });
    fireEvent.change(input, { target: { value: 'addUser' } });
    await screen.findByRole('option', { name: /UserStore\.addUser/ });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('table', { name: 'Receives' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens the omni search with Cmd+K', async () => {
    render(<App api={fakeApi()} />);

    await screen.findByRole('application');
    fireEvent.keyDown(window, { key: 'K', metaKey: true });

    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
