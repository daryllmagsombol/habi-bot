import type { Metadata } from 'next';
import { AppBar } from '../../../components/app-bar';
import { ButtonLink } from '../../../components/ui/button';
import { Container } from '../../../components/ui/container';
import { PageHeader } from '../../../components/ui/page-header';
import { SkipLink } from '../../../components/ui/skip-link';

export const metadata: Metadata = {
  title: 'Not in this preview',
};

export default function BotNotFound() {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />
      <AppBar section="bots" backHref="/bots" backLabel="all Bots" showAllowance={false} />

      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        <Container size="narrow" className="py-12 sm:py-16">
          <PageHeader
            title="That Bot or thread is not in this preview."
            description="The preview ships three sample Bots with fixed conversations. The address may be a typo, or it may point at a Bot that only exists once the Bots API is connected."
            actions={
              <>
                <ButtonLink href="/bots">Back to the gallery</ButtonLink>
                <ButtonLink href="/start" variant="secondary">
                  Identity screens
                </ButtonLink>
              </>
            }
          />
        </Container>
      </main>
    </div>
  );
}
