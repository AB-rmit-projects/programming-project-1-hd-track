/**
 * Product name and description, used by the metadata, landing page and app
 * shell. NEXT_PUBLIC_APP_NAME (inlined at build time) can override the name.
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'SafeCall Incident Review'

export const APP_DESCRIPTION =
  'Review simulated SafeCall pendant connectivity incidents, weigh the evidence and record auditable decisions. All incident data is fictional demonstration data.'
