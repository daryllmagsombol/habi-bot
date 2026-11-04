import type { Metadata } from 'next';
import { ButtonLink } from '../components/ui/button';
import { Container } from '../components/ui/container';
import { PageHeader } from '../components/ui/page-header';
import { SiteShell } from '../components/site-shell';

export const metadata: Metadata = {
  title: 'Page not found',
};

export default function NotFound() {
  return (
    <SiteShell footerLeft="Habi · 404" footerRight="Nothing here yet.">
      <Container size="narrow" className="py-12 sm:py-16">
        <PageHeader
          title="There is nothing at this address."
          description="The preview has a landing page, a Bot gallery, three sample Bots, and the identity screens. This address is none of them."
          actions={
            <>
              <ButtonLink href="/bots">Open the Bot gallery</ButtonLink>
              <ButtonLink href="/" variant="secondary">
                Back to the start
              </ButtonLink>
            </>
          }
        />
      </Container>
    </SiteShell>
  );
}
