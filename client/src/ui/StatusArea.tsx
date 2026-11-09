export type StatusContent =
  | { kind: 'empty' }
  | { kind: 'hint'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'locked'; text?: string; sub?: string };

/**
 * A fixed 56px space directly above the main button, always reserved, so a
 * message or a stamp can never push the button somewhere else.
 */
export function StatusArea({ content, id }: { content: StatusContent; id?: string }) {
  if (content.kind === 'locked') {
    return (
      <div className="status" role="status" id={id}>
        <span className="seal" aria-hidden="true">
          済
        </span>
        <span>
          <span className="locked-text">{content.text ?? 'Locked in'}</span>
          <span className="locked-sub">{content.sub ?? 'Change it until time runs out'}</span>
        </span>
      </div>
    );
  }
  const text = content.kind === 'empty' ? '' : content.text;
  return (
    <div
      className={content.kind === 'error' ? 'status error' : 'status'}
      role={content.kind === 'error' ? 'alert' : 'status'}
      id={id}
    >
      {text}
    </div>
  );
}
