import type { Config } from './config.ts';

/**
 * Default content & copyright policy shown at sign-up. The operator should
 * review and adapt it (jurisdiction, contact details) before going live.
 */
export function policyText(config: Config): string {
  return `oto-eum — content & copyright policy

1. You may only upload material you have the right to use. 音MAD / YTPMV editing
   often relies on short excerpts; whether a use is permitted (fair use, quotation,
   parody exceptions, licences) depends on your jurisdiction. You are responsible
   for what you upload and share.
2. Uploads are private by default. Making media or a source pack "unlisted" or
   "public" lets other users stream and reuse it inside oto-eum.
3. Not allowed: illegal content, sexual content involving minors, harassment,
   doxxing, malware, or content you know infringes someone else's rights.
4. Copyright holders can report an item with the "Report" button (or by email to
   ${config.copyrightContact}). Include: the work being infringed, the item link
   or ID, your contact details, and a statement that the report is accurate and
   that you are authorised to act. Reported items may be disabled while reviewed.
5. If your item was removed by mistake you may send a counter-notice to
   ${config.copyrightContact}; removed items can be restored.
6. Repeat infringers' accounts will be suspended.
7. We may remove content or accounts that violate this policy. Every moderation
   action is logged.`;
}
