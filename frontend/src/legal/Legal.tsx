import { config } from '../config';
import { LogoMark } from '../components/Logo';
import ThemeToggle from '../components/ThemeToggle';
import type { LegalKind } from './routes';

const UPDATED = '17 November 2026';

function DraftNotice() {
  return (
    <p className="legal-draft" role="note">
      <strong>Draft for legal review.</strong> This page is not final and is not
      legal advice. It must be reviewed by a lawyer before clients rely on it.
    </p>
  );
}

function TermsBody() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <DraftNotice />

      <h2>1. About these terms</h2>
      <p>
        Mur Reviews is a service provided by <strong>Mur Systems</strong> (ABN
        22 545 735 809) that helps a business ask its customers for a Google
        review by SMS. In these terms, “we”, “us” and “our” mean Mur Systems,
        and “you” means the business using Mur Reviews and the person accepting
        these terms for that business.
      </p>
      <p>
        By creating or using a Mur Reviews account, you agree to these terms. If
        you do not agree, do not use the service.
      </p>

      <h2>2. The service</h2>
      <p>
        Mur Reviews lets you add customers, send them a text after their visit,
        and see whether they tapped the review link. Messages are sent through a
        phone you connect to the service or through an SMS provider we
        configure. The service also records opt-outs and basic delivery and
        click statistics.
      </p>
      <p>
        We may change, suspend or withdraw features. We do not guarantee that a
        message will be delivered: delivery depends on mobile networks, the
        customer’s handset, and the phone or provider used to send.
      </p>

      <h2>3. Accounts and access</h2>
      <p>
        You are responsible for keeping your login details and any connected
        phone secure, and for everything done through your account. Tell us
        promptly if you think someone else has access.
      </p>

      <h2>4. Your responsibilities</h2>
      <ul>
        <li>
          <strong>Only add real customers.</strong> Add only people who were
          actually your customers and whose details you are entitled to use.
          Do not upload purchased, rented, scraped or guessed lists.
        </li>
        <li>
          <strong>Have a lawful basis and consent where required.</strong> You
          are responsible for complying with the <em>Spam Act 2003</em> (Cth),
          the <em>Privacy Act 1988</em> (Cth) and any other law that applies to
          your messages, including obtaining any consent a customer’s
          circumstances require.
        </li>
        <li>
          <strong>Honour opt-outs.</strong> If a customer replies STOP or taps
          an opt-out link, do not add or contact them again. The service keeps
          a suppression record to help with this.
        </li>
        <li>
          <strong>Keep details accurate.</strong> Make sure your business name,
          Google Place ID and contact details are correct.
        </li>
        <li>
          <strong>Send appropriate content.</strong> Do not use Mur Reviews for
          spam, harassment, discrimination, unlawful, misleading or adult
          content, or anything unrelated to asking for a genuine review.
        </li>
      </ul>

      <h2>5. Message limits and fair use</h2>
      <p>
        Plans, trial caps and daily or monthly message limits apply as shown in
        the app or agreed with you. We may throttle or pause sending to protect
        the service, the phone connection or recipients, or to comply with law.
      </p>

      <h2>6. Fees</h2>
      <p>
        Fees, if any, are set out in your agreement or invoice. Unless stated
        otherwise, fees are payable in Australian dollars and are exclusive of
        GST where GST applies.
      </p>

      <h2>7. Data and privacy</h2>
      <p>
        Our <a href="/privacy">Privacy Policy</a> explains what personal
        information the service holds, why, where it is stored and how to
        request deletion. It forms part of these terms.
      </p>

      <h2>8. Intellectual property</h2>
      <p>
        We own the Mur Reviews software, branding and documentation. You keep
        ownership of your business data and customer data. You give us the
        limited rights needed to host and process that data to provide the
        service.
      </p>

      <h2>9. Suspension and termination</h2>
      <p>
        We may pause or suspend sending, or terminate your access, if you breach
        these terms, fail to pay, create a legal or security risk, or if we are
        required to by law. You may stop using the service at any time. On
        termination, we handle data as described in the Privacy Policy.
      </p>

      <h2>10. Disclaimers and liability</h2>
      <p>
        To the extent permitted by law, the service is provided “as is” and we
        do not warrant uninterrupted or error-free operation. Nothing in these
        terms excludes any guarantee, right or remedy that cannot lawfully be
        excluded, including under the Australian Consumer Law. To the extent
        permitted by law, our total liability arising out of or relating to the
        service is limited to the fees you paid us in the 12 months before the
        event giving rise to the liability.
      </p>

      <h2>11. Changes</h2>
      <p>
        We may update these terms. If a change is material, we will give
        reasonable notice in the app or by email. Continuing to use the service
        after the change takes effect means you accept the updated terms.
      </p>

      <h2>12. Governing law and contact</h2>
      <p>
        These terms are governed by the laws of Victoria, Australia. Questions
        about these terms can be sent to Mur Systems through the contact details
        provided when your account was set up.
      </p>
    </>
  );
}

function PrivacyBody() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <DraftNotice />

      <h2>1. Who we are</h2>
      <p>
        Mur Reviews is operated by <strong>Mur Systems</strong> (ABN 22 545 735
        809), Australia. This policy explains how we handle personal information
        in the Mur Reviews app and when we send review-request texts on behalf
        of a business.
      </p>

      <h2>2. What we hold</h2>
      <ul>
        <li>
          <strong>Business details:</strong> business name, Google Place ID,
          timezone, logo, owner email address, message settings and connected
          phone credentials.
        </li>
        <li>
          <strong>Customer details:</strong> the customer’s first name and
          mobile number, the text we sent, when it was sent, delivery status,
          whether the review link was opened, and any reply (including STOP).
        </li>
        <li>
          <strong>Opt-out records:</strong> the mobile number and the date and
          method of the opt-out, kept so we do not text that number again.
        </li>
        <li>
          <strong>Technical and usage data:</strong> login and security events,
          browser or device information, and limited server logs needed to run
          and protect the service.
        </li>
      </ul>
      <p>
        We do not need customers to create an account, and we do not collect
        payment details from customers.
      </p>

      <h2>3. Why we use it</h2>
      <ul>
        <li>To send the review request or reminder the business asked for.</li>
        <li>To record delivery, link clicks and replies so the business can see results.</li>
        <li>To keep a permanent opt-out list and honour STOP requests.</li>
        <li>To provide support, secure the service, prevent abuse and fix problems.</li>
        <li>To meet our legal and accounting obligations.</li>
      </ul>

      <h2>4. Where it is stored</h2>
      <p>
        Business, customer, message and opt-out records are stored in our
        Supabase database, which is hosted in <strong>Sydney, Australia</strong>{" "}
        (AWS region <code>ap-southeast-2</code>). The app is served through
        Cloudflare’s network, and review counts come from Google’s Places API.
        SMS messages are handed to the business’s connected Android phone or to
        an SMS provider we configure for delivery to the customer’s mobile
        network. Those providers may process data outside Australia.
      </p>

      <h2>5. How long we keep it</h2>
      <p>
        Business and account data is kept while the account is active and for
        up to 30 days after it is closed. Customer and message records are kept
        for up to 24 months so the business can see its results and resolve
        disputes. Opt-out records are kept for as long as needed to keep
        suppressing that number, even after a business closes. Backups may take
        up to 30 days to expire. We may keep records longer where the law
        requires it.
      </p>

      <h2>6. The business’s responsibility</h2>
      <p>
        The business decides which customers to add and is responsible for
        having a lawful basis to text them. A business must only add real
        customers, must not add anyone who has opted out, and must not upload
        purchased, rented, scraped or guessed lists. We process customer details
        on the business’s instructions and take reasonable steps to protect
        them.
      </p>

      <h2>7. Opting out</h2>
      <p>
        A customer can reply <strong>STOP</strong> to any text or tap the
        opt-out link in the message. The number is added to a suppression list
        and no further review requests are sent from that business. The
        business is told about the opt-out in the app. Opt-out records are kept
        for the purpose of honouring the request.
      </p>

      <h2>8. Access, correction and deletion</h2>
      <p>
        You can ask us for a copy of the personal information we hold about you
        or your business, ask us to correct it, or ask us to delete it. Contact
        Mur Systems through the contact details provided when your account was
        set up, or ask the business that texted you to pass on your request. We
        may need to verify who is asking. We aim to respond within 30 days. We
        may retain opt-out suppression records and records we must keep by law
        after a deletion request.
      </p>

      <h2>9. Security</h2>
      <p>
        Access is limited to authorised users and staff. Data is encrypted in
        transit, database access is restricted with row-level security, and
        connected-phone credentials are held server-side and never returned to
        the browser. No system is completely secure, but we take reasonable
        steps to protect the information we hold.
      </p>

      <h2>10. Children</h2>
      <p>
        Mur Reviews is for businesses and is not directed at children. A
        business should not add a customer under 18 unless it has the
        appropriate consent and legal basis.
      </p>

      <h2>11. Complaints</h2>
      <p>
        If you have a privacy concern, contact Mur Systems first so we can try
        to resolve it. If we cannot resolve it, you can contact the Office of
        the Australian Information Commissioner (OAIC) at{" "}
        <a href="https://www.oaic.gov.au" target="_blank" rel="noreferrer">
          oaic.gov.au
        </a>
        .
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update this policy. The “last updated” date above will change,
        and material changes will be notified in the app or by email.
      </p>
    </>
  );
}

export default function Legal({ kind }: { kind: LegalKind }) {
  return (
    <div className="legal">
      <header className="legal-bar">
        <a className="legal-brand" href="/">
          <LogoMark size={34} />
          <strong>{config.product}</strong>
        </a>
        <ThemeToggle />
      </header>
      <main className="page legal-content">
        {kind === 'terms' ? <TermsBody /> : <PrivacyBody />}
        <hr />
        <p className="muted legal-foot">
          Mur Systems · ABN 22 545 735 809 ·{' '}
          <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a>
        </p>
        <p className="muted legal-foot">
          <a href="/">Back to Mur Reviews</a>
        </p>
      </main>
    </div>
  );
}
