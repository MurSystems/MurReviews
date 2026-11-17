// Where replies to a review request end up.
//
// Texts sent through the SMS provider come from a shared or dedicated number,
// so the customer's reply reaches the Worker webhook and appears in the app.
// Texts sent through the owner's own phone (Android gateway) get the reply on
// that phone, so the app replaces the reply list with a note. STOP handling
// still happens in the backend for every mode.
export const OWN_PHONE_REPLY_NOTE =
  'Replies come straight to your phone, since texts are sent from your own number.';

export function repliesReachApp(sendMode: string | null | undefined): boolean {
  return sendMode !== 'android_gateway';
}
