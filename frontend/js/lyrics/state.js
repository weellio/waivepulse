// Shared mutable state for the Lyric Helper page.
// All modules read/write S.* so the values stay in sync.
export const S = {
  selectedTone: '',
  PREFERRED_MODEL: 'llama3.1:8b',
};
