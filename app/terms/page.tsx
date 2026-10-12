import type { Metadata } from "next";
import Link from "next/link";
import { ContactLine, LegalList, LegalPage, LegalSection, legalParties } from "@/components/legal/legal-page";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = { title: "Terms of Service" };
// Names the operator from this deployment's settings, so it is rendered per request, not at build time.
export const dynamic = "force-dynamic";

const link = "font-medium text-foreground underline underline-offset-4";

export default function TermsPage() {
  const { operator, named, email } = legalParties();
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <>
          These terms cover your use of {APP_NAME} on this site. {APP_NAME} is open-source software for running Beyblade X tournaments on top of
          Challonge{named ? `; this site is run by ${operator}` : ""}. By signing in, or by opening a {APP_NAME} Pass, you agree to them.
        </>
      }
    >
      <LegalSection title="1. Who can use it">
        <LegalList>
          <li>
            <strong className="text-foreground">Organizers</strong> sign in with their email. For now, access is limited to select communities.
          </li>
          <li>
            <strong className="text-foreground">Judges and players</strong> use {APP_NAME} through an organizer&apos;s tournament: a judge on an
            approved tablet, a player on their own {APP_NAME} Pass.
          </li>
          <li>If you are under 18, use {APP_NAME} with the permission of a parent or guardian.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="2. Organizer accounts">
        <p>If you sign in as an organizer, you are responsible for:</p>
        <LegalList>
          <li>keeping the email account you sign in with secure, and for what is done under your sign-in;</li>
          <li>the tournaments you import and the results you send;</li>
          <li>having the right to bring your players&apos; names into {APP_NAME} from your Challonge bracket;</li>
          <li>
            telling your players, and the parents or guardians of young players, that your tournament uses {APP_NAME} and where to find the{" "}
            <Link href="/privacy" className={link}>
              Privacy Policy
            </Link>
            .
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="3. Your Challonge account">
        <p>
          You connect {APP_NAME} to Challonge with your own Challonge developer app. {APP_NAME} then acts on your Challonge account as you direct
          it: it imports your tournaments, sends match results and finalizes a tournament when you ask. Challonge&apos;s own terms apply to your
          use of Challonge. Some actions, such as finalizing a tournament, can&apos;t be undone on Challonge.
        </p>
      </LegalSection>

      <LegalSection title="4. Fair use">
        <p>Don&apos;t:</p>
        <LegalList>
          <li>open, or try to open, a tournament, Pass, board or pad that isn&apos;t yours to open, including by guessing passcodes or codes;</li>
          <li>interfere with a tournament, with the site, or with other people&apos;s use of it;</li>
          <li>use the site to break the law, or to harass or harm anyone.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="5. Early access, as it is">
        <p>
          {APP_NAME} is in early access and is provided as it is, without a promise that it will always be available or free of faults. It may
          change, be interrupted or stop. A tournament also depends on things {APP_NAME} doesn&apos;t control: the venue&apos;s internet,
          Challonge, and the notification services of phones and browsers. Keep another way to run your event in case one of them fails.
        </p>
      </LegalSection>

      <LegalSection title="6. Liability">
        <p>
          As far as the law allows, {operator} is not liable for indirect or consequential losses from using {APP_NAME}, including a tournament
          that is delayed, interrupted or scored wrongly. Nothing in these terms limits liability that the law does not allow to be limited.
        </p>
      </LegalSection>

      <LegalSection title="7. Names and trademarks">
        <p>
          {APP_NAME} is not affiliated with or endorsed by Takara Tomy or Challonge. Beyblade X and Challonge are trademarks of their owners.
        </p>
      </LegalSection>

      <LegalSection title="8. Ending your use">
        <p>
          You can stop using {APP_NAME} at any time, and ask for your data to be removed as the{" "}
          <Link href="/privacy" className={link}>
            Privacy Policy
          </Link>{" "}
          describes. Access may be suspended or ended for anyone who breaks these terms.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes to these terms">
        <p>
          These terms may change as {APP_NAME} does. The date at the top shows when they last did. If you keep using {APP_NAME} after a change,
          you accept the new terms.
        </p>
      </LegalSection>

      <LegalSection title="10. Governing law">
        <p>These terms are governed by the laws of the Republic of the Philippines.</p>
      </LegalSection>

      <LegalSection title="11. Contact">
        <p>
          Questions about these terms? <ContactLine email={email} />
        </p>
      </LegalSection>
    </LegalPage>
  );
}
