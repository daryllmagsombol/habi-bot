import type { Metadata } from 'next';
import { AppBar } from '../../../components/app-bar';
import { ButtonLink, PageHeader, SkipLink } from '../../../components/ui';
import { isApiConfigured } from '../../../lib/api/config';
import { previewAllowance, previewBots, totalThreadCount } from '../../../lib/preview-data';

const COUNTS = { bots: previewBots.length, threads: totalThreadCount() };

export async function generateMetadata(): Promise<Metadata> {
  return { title: isApiConfigured() ? 'Bot not found' : 'Not in this preview' };
}

export default function BotNotFound() {
  const live = isApiConfigured();

  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />
      <AppBar
        section="bots"
        counts={live ? { bots: 0, threads: 0 } : COUNTS}
        {...(live ? { mode: 'live' as const } : { allowance: previewAllowance })}
      />

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-wide flex-1 px-4 py-10 focus:outline-none sm:px-6 sm:py-14"
      >
        <PageHeader
          title={live ? 'That Bot or thread is not yours.' : 'That Bot or thread is not in this preview.'}
          description={
            live
              ? 'The API did not return this Bot or thread for your session. It may be a typo, or the record may belong to another account.'
              : 'The preview ships four sample bots with fixed conversations. The address may be a typo, or it may point at a bot that only exists once the Bots API is connected.'
          }
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
