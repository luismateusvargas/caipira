import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { isAbortError, toApiError } from './client';
import type { ApiError } from './client';

/** A request's lifecycle as the UI renders it. */
export type RequestState<T> =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: ApiError };

/** A request's state plus a way to run it again. */
export interface RequestHandle<T> {
  state: RequestState<T>;
  /** True while a reload runs behind data that is still shown. */
  refreshing: boolean;
  reload: () => void;
}

/** Options for {@link useRequest}. */
export interface RequestOptions<T> {
  /** Marks a successful answer as empty. */
  isEmpty?: (data: T) => boolean;
  /** Bumping it reloads the same key while keeping its data on screen. */
  revision?: number;
}

interface Settled<T> {
  key: string;
  run: string;
  state: RequestState<T>;
}

const neverEmpty = () => false;

/**
 * Loads data for `key` and reloads whenever it changes. A newer key or a
 * reload aborts the request in flight, so a stale answer never overwrites a
 * newer one. A reload of the same key keeps showing the previous data.
 * @param key Identifies the inputs; null means there is nothing to load.
 * @param load Performs the request, honouring the signal.
 * @param options Emptiness test and external revision.
 * @returns The current state and a reload callback.
 */
export function useRequest<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  options: RequestOptions<T> = {}
): RequestHandle<T> {
  const [token, setToken] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const revision = options.revision ?? 0;
  const isEmpty = options.isEmpty ?? neverEmpty;
  const run = useEffectEvent((signal: AbortSignal) => load(signal));
  const classify = useEffectEvent((data: T): RequestState<T> => (isEmpty(data) ? { status: 'empty' } : { status: 'ready', data }));

  useEffect(() => {
    if (key === null) return undefined;
    const controller = new AbortController();
    const runId = `${token}:${revision}`;
    run(controller.signal).then(
      data => {
        if (!controller.signal.aborted) setSettled({ key, run: runId, state: classify(data) });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setSettled({ key, run: runId, state: { status: 'error', error: toApiError(error) } });
      }
    );
    return () => controller.abort();
  }, [key, token, revision]);

  const reload = useCallback(() => setToken(value => value + 1), []);

  if (key === null) return { state: { status: 'empty' }, refreshing: false, reload };
  if (settled && settled.key === key && settled.run === `${token}:${revision}`) return { state: settled.state, refreshing: false, reload };
  if (settled && settled.key === key && settled.state.status === 'ready') return { state: settled.state, refreshing: true, reload };
  return { state: { status: 'loading' }, refreshing: false, reload };
}
