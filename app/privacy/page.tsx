import type { Metadata } from "next";
import { ContactLine, LegalList, LegalPage, LegalSection, legalParties } from "@/components/legal/legal-page";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = { title: "Privacy Policy" };
// Names the operator from this deployment's settings, so it is rendered per request, not at build time.
export const dynamic = "force-dynamic";

const strong = "text-foreground";

// Keep this in step with what the app really stores (lib/db/schema.ts) and where it sends it.
export default function PrivacyPage() {
  const { operator, named, email } = legalParties();
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <>
          This policy says what {APP_NAME} keeps about organizers, judges and players on this site, what it is used for, and how to have it
          corrected or removed.{named ? ` This site is run by ${operator}.` : ""}
        </>
      }
    >
      <LegalSection title="1. Who is responsible">
        <p>
          {named ? operator : "The operator of this site"} is responsible for the data on this site. An
          organizer decides which players&apos; names to enter into {APP_NAME}; the site stores them so that the tournament can be run.
        </p>
      </LegalSection>

      <LegalSection title="2. What is kept">
        <LegalList>
          <li>
            <strong className={strong}>Organizers:</strong> your email address, used to sign you in; your tournaments, with their format, players,
            matches and results; your stadiums and rule profiles.
          </li>
          <li>
            <strong className={strong}>Players:</strong> your name and seed as the organizer entered them; your matches, scores and final
            placement, and whether you dropped out; in a tournament with groups, your group, whether you advanced from it and your seed in the
            final stage; a 4-digit
            passcode the organizer hands you. If you turn on notifications, your browser&apos;s
            push subscription. No email address, phone number or account is asked of players.
          </li>
          <li>
            <strong className={strong}>Judges:</strong> the name shown for you on the organizer&apos;s {APP_NAME} Desk, which starts as the kind of browser
            on your tablet and can be changed, and the battles you record.
          </li>
          <li>
            <strong className={strong}>Every device:</strong> the kind of browser it is (for example &ldquo;Chrome on Android&rdquo;), when it
            was last seen or closed, and a sign-in cookie. Wrong passcode attempts are counted for up to an hour, against the player, against
            the player on the device that made them, and against a scrambled form of the network address, to slow down guessing.
          </li>
        </LegalList>
        <p>{APP_NAME} itself shows no advertising and sets no advertising or analytics cookies.</p>
      </LegalSection>

      <LegalSection title="3. What it is used for">
        <LegalList>
          <li>to sign organizers in and keep each tournament to the people it belongs to;</li>
          <li>to run the tournament: the queue, calls to stadiums, scoring, the bracket and the standings;</li>
          <li>to show each player their own matches, and to send them &ldquo;On deck&rdquo; and &ldquo;You&apos;re up&rdquo; notifications when they ask for them;</li>
          <li>to keep the site secure and working.</li>
        </LegalList>
        <p>It is not sold, and it is not used for advertising.</p>
      </LegalSection>

      <LegalSection title="4. Who else handles it">
        <LegalList>
          <li>
            <strong className={strong}>Supabase</strong> stores the database, sends organizers their sign-in emails and carries live updates.
          </li>
          <li>
            <strong className={strong}>The hosting provider</strong> of this site serves its pages.
          </li>
          <li>
            <strong className={strong}>Your browser&apos;s notification service</strong> (run by Apple, Google or Mozilla, depending on your
            device) delivers notifications you turned on.
          </li>
        </LegalList>
        <p>
          A player&apos;s matches are shown only on that player&apos;s own Pass. The board at the venue shows the names of players being called,
          as an announcer would say them, and in a round robin, Swiss or group stage, each player&apos;s wins and losses so far.
        </p>
      </LegalSection>

      <LegalSection title="5. Cookies and what is kept on your device">
        <LegalList>
          <li>a sign-in cookie: one for an organizer, and one per tournament for a player, a judge&apos;s tablet or a board;</li>
          <li>on the Pass sign-in screen, a random name for the device, used only to count its wrong passcodes;</li>
          <li>your choice of light or dark theme;</li>
          <li>on a judge&apos;s tablet, the battles recorded while offline, until they have been sent;</li>
          <li>a saved copy of some pages, so that a pad opens without a connection.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="6. How long it is kept">
        <p>
          Tournament data is kept until it is removed at the request of the organizer or of the person it is about. Wrong passcode attempts are
          dropped within an hour, and a screen&apos;s request to join that nobody approves expires after 15 minutes. An organizer can delete a
          tournament, with everything in it, at any time. Turning notifications off on your Pass removes your push subscription.
        </p>
      </LegalSection>

      <LegalSection title="7. Young players">
        <p>
          Many players are children. {APP_NAME} asks nothing of a player beyond the name their organizer entered, and
          notifications are sent only when a player, or their parent or guardian, turns them on. A parent or guardian can ask the organizer, or{" "}
          {operator}, to see, correct or remove what is kept about their child.
        </p>
      </LegalSection>

      <LegalSection title="8. Your rights">
        <p>
          Under the Philippine Data Privacy Act of 2012 (Republic Act No. 10173) you have the right to be informed about your data, to see it,
          to have it corrected, to object to its use, to have it erased or blocked, and to receive a copy of it. You can also complain to the
          National Privacy Commission.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes to this policy">
        <p>This policy changes when what {APP_NAME} keeps changes. The date at the top shows when it last did.</p>
      </LegalSection>

      <LegalSection title="10. Contact">
        <p>
          To use any of these rights, or to ask about your data: <ContactLine email={email} />
        </p>
      </LegalSection>
    </LegalPage>
  );
}
