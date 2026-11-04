import type { ReactNode } from 'react';
import type { MessageState, MessageVariant } from './types';

export interface MessageBubbleProps {
  readonly variant: MessageVariant;
  readonly name: string;
  readonly at: ReactNode;
  /** The avatar element for this side, typically `<Avatar size="xs" />`. */
  readonly avatar: ReactNode;
  readonly paragraphs: readonly string[];
  readonly state?: MessageState | undefined;
  /** A cite chip or link, rendered under the bubble on the same side. */
  readonly citation?: ReactNode;
  /** A small note under the bubble, e.g. "Local only · not sent". */
  readonly footnote?: ReactNode;
}

/**
 * One transcript turn: the owner on the right in a solid bubble, the Bot on the
 * left in cream. The avatar hides below 640px, where the name above the bubble
 * is enough and the words need the width.
 *
 * Use inside the transcript `<ol>`; the element is an `<li>`.
 */
export function MessageBubble({
  variant,
  name,
  at,
  avatar,
  paragraphs,
  state = 'complete',
  citation,
  footnote,
}: Readonly<MessageBubbleProps>) {
  const isUser = variant === 'user';
  const streaming = state === 'streaming';
  const last = paragraphs.length - 1;

  return (
    <li className={['flex items-start gap-2', isUser ? 'flex-row-reverse' : ''].filter(Boolean).join(' ')}>
      <span className="hidden shrink-0 sm:block">{avatar}</span>

      <div
        className={[
          'flex min-w-0 max-w-full flex-col sm:max-w-[calc(100%-2.25rem)]',
          isUser ? 'items-end' : 'items-start',
        ].join(' ')}
      >
        <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-2xs text-subtle">
          <span className="font-medium text-subtle">{name}</span>
          <span className="u-figures">{at}</span>
        </p>

        <div
          className={[
            'px-3.5 py-2.5 text-sm leading-relaxed [&>p+p]:mt-2.5',
            isUser
              ? 'max-w-[52ch] rounded-lg rounded-tr-xs bg-user-bubble text-on-user-bubble'
              : 'max-w-[56ch] rounded-lg rounded-tl-xs border border-line-soft bg-bubble text-ink',
          ].join(' ')}
        >
          {paragraphs.length === 0 ? (
            streaming ? (
              <p>
                <span aria-hidden="true" className="habi-caret" />
              </p>
            ) : null
          ) : (
            paragraphs.map((paragraph, index) => (
              <p key={index}>
                {paragraph}
                {streaming && index === last ? (
                  <span aria-hidden="true" className="habi-caret" />
                ) : null}
              </p>
            ))
          )}
        </div>

        {citation}
        {footnote}
      </div>
    </li>
  );
}
