// Single source of truth for brand, product name, theme colours, and the
// "What's new" notice. Everything else reads from here.
export const config = {
  company: 'Mur Systems',
  product: 'Mur Reviews',
  byline: 'by Mur Systems',
  workerUrl: 'https://m.mursystems123.workers.dev',
  auth: {
    // Email sign-in links need working email delivery, which isn't set up for
    // clients yet. Flip this once it is. Admin accounts are recognised by the
    // server (profiles.role = 'admin'), not by an email list in this bundle.
    signInLinkForEveryone: false,
  },
  whatsNew: {
    // Bump the version to show the notice again to every user.
    version: '2026-11-17',
    message:
      'Mur Reviews has a new look. When you add a customer, we now show their name and the time their text will send.',
  },
  theme: {
    black: '#0c0c0c',
    gold: '#c8a45c',
    ivory: '#f4efe6',
    ink: '#14110d',
  },
} as const;
