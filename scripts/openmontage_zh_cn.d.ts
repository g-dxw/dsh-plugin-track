export type BacklotTranslationContext = 'ui' | 'stage' | 'artifact' | 'metric' | 'enum' | 'review' | 'stage-status' | 'intent' | 'cue' | 'header-chip'
export function translateUiText(value: string, context?: BacklotTranslationContext): string
export function localizeBacklot(doc?: Document): number
export function startBacklotLocalization(doc?: Document): () => void
export function stopBacklotLocalization(doc?: Document): void
