import { useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorCode } from '../../../shared/protocol.js';
import type { StatusContent } from '../ui/StatusArea.js';

/** The server's answer to a send, or null when the screen moved on before one came. */
type SendReply = { ok: true } | { ok: false; code: ErrorCode } | null;

/** How long a send can take before the phone shows a weak connection. */
const SLOW_AFTER_MS = 3000;

export interface InstantChoice<T> {
  /** What the guest last tapped, sent or not. */
  choice: T | null;
  choose: (value: T) => void;
  /** Forgets the tap, for an answer that's no longer there. */
  clear: () => void;
  sending: boolean;
  slow: boolean;
  problem: string | null;
}

/**
 * A tap on an answer sends it straight away, and another tap changes it. Each send carries
 * the next number, so the server keeps whichever tap came last even if replies cross.
 */
export function useInstantChoice<T extends string | number>({
  saved,
  send,
  messageFor,
}: {
  /** The answer the server holds. */
  saved: T | null;
  send: (value: T) => Promise<SendReply>;
  messageFor: (code: ErrorCode) => string;
}): InstantChoice<T> {
  const [choice, setChoice] = useState<T | null>(saved);
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const latestTap = useRef(0);
  const savedNow = useRef(saved);
  savedNow.current = saved;
  const sendNow = useRef(send);
  sendNow.current = send;
  const messageNow = useRef(messageFor);
  messageNow.current = messageFor;

  const choose = useCallback((value: T) => {
    const tap = ++latestTap.current;
    setChoice(value);
    setProblem(null);
    setSending(true);
    void (async () => {
      const reply = await sendNow.current(value);
      // A later tap is on its way, and its reply decides what shows.
      if (tap !== latestTap.current) return;
      setSending(false);
      if (!reply || reply.ok || reply.code === 'stale_action') return;
      setProblem(messageNow.current(reply.code));
      setChoice(savedNow.current);
    })();
  }, []);

  const clear = useCallback(() => {
    latestTap.current++;
    setChoice(null);
    setSending(false);
  }, []);

  useEffect(() => {
    if (!sending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [sending]);

  return { choice, choose, clear, sending, slow, problem };
}

/** What shows under the answers: how to answer, that it's sending, or that it counts. */
export function choiceStatus<T>(picked: InstantChoice<T>, saved: T | null): StatusContent {
  if (picked.problem) return { kind: 'error', text: picked.problem };
  if (picked.choice === null) return { kind: 'hint', text: 'Tap one. You can change it until time runs out.' };
  if (picked.sending) return { kind: 'hint', text: picked.slow ? 'Still sending…' : 'Sending…' };
  if (picked.choice === saved) return { kind: 'locked', sub: 'Tap another to change it until time runs out' };
  return { kind: 'hint', text: 'Not sent yet. Tap it again.' };
}
