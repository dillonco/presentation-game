import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeckContent } from '../../../shared/deck.js';
import { api, ApiError } from './api.js';

const SAVE_AFTER_MS = 600;
const RETRY_AFTER_MS = 5000;

export type SaveStatus = 'saved' | 'saving' | 'retrying' | 'signed_out' | 'conflict' | 'refused';

/** Saves shortly after each change, and keeps trying through a dropped connection. */
export function useAutosave(deckId: string, firstRevision: number, content: DeckContent) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const revision = useRef(firstRevision);
  const latest = useRef(content);
  const savedContent = useRef(content);
  const timer = useRef<number | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const stopped = useRef(false);

  latest.current = content;

  const isDirty = () => latest.current !== savedContent.current;

  const saveNow = useCallback((): Promise<void> => {
    if (running.current) return running.current;
    const work = (async () => {
      while (isDirty() && !stopped.current) {
        const sending = latest.current;
        setStatus('saving');
        try {
          revision.current = await api.saveDeck(deckId, revision.current, sending);
          savedContent.current = sending;
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            stopped.current = true;
            setStatus('conflict');
          } else if (error instanceof ApiError && (error.status === 400 || error.status === 403)) {
            setStatus('refused');
          } else {
            setStatus(error instanceof ApiError && error.status === 401 ? 'signed_out' : 'retrying');
            timer.current = window.setTimeout(() => void saveNow(), RETRY_AFTER_MS);
          }
          return;
        }
      }
      if (!stopped.current) setStatus('saved');
    })().finally(() => {
      running.current = null;
    });
    running.current = work;
    return work;
  }, [deckId]);

  useEffect(() => {
    if (!isDirty() || stopped.current) return;
    setStatus('saving');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveNow(), SAVE_AFTER_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [content, saveNow]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (isDirty()) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  /** Saves anything outstanding right away. True once the latest version is safely stored. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    await saveNow();
    return !isDirty();
  }, [saveNow]);

  return { status, flush };
}
