import type { Metadata } from 'next';
import { AppBar } from '../../../components/app-bar';
import { ButtonLink, PageHeader, SkipLink } from '../../../components/ui';
import { previewAllowance, previewBots, totalThreadCount } from '../../../lib/preview-data';

const COUNTS = { bots: previewBots.length, threads: totalThreadCount() };

export const metadata: Metadata = {
  title: 'Not in this preview',
};

export default function BotNotFound() {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />
      <AppBar section="bots" counts={COUNTS} allowance={previewAllowance} />

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-wide flex-1 px-4 py-10 focus:outline-none sm:px-6 sm:py-14"
      >
        <PageHeader
          title="That Bot or thread is not in this preview."
          description="The preview ships four sample bots with fixed conversations. The address may be a typo, or it may point at a bot that only exists once the Bots API is connected."
          actions={
            <>
              <ButtonLink href="/bots">Back to the gallery</ButtonLink>
              <ButtonLink href="/start" variant="secondary">
                Identity screens
              </ButtonLink>
            </>
          }
        />
      </main>
    </div>
  );
}
