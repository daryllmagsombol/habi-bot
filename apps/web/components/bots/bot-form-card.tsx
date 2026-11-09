import type { ReactNode } from 'react';
import { Card, SectionHeader } from '../ui';

export interface BotFormCardProps {
  readonly title: string;
  readonly headingId: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * The card that frames a Bot create or edit form. A route coordinator decides
 * when it is open; the card itself only supplies the surface and heading so the
 * form never invents page chrome.
 */
export function BotFormCard({
  title,
  headingId,
  description,
  children,
  className,
}: Readonly<BotFormCardProps>) {
  return (
    <Card as="section" radius="xl" padding="card" aria-labelledby={headingId} className={className}>
      <SectionHeader as="h2" id={headingId} label={title} />
      {description === undefined ? null : (
        <p className="mt-1.5 text-xs leading-relaxed text-muted">{description}</p>
      )}
      <div className="mt-4">{children}</div>
    </Card>
  );
}
