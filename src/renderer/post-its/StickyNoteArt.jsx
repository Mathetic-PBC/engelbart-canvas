import stickyNote from '../../../design/assets/yellow-sticky-note.svg';

// Crop the source's export margins without changing its paper, grain, or shadows.
// The outer viewport follows the user's independently resized card.
export default function StickyNoteArt({ className, width, height }) {
  return <svg className={className} width={width} height={height} viewBox="44 40 430 450" preserveAspectRatio="none" fill="none" aria-hidden="true" focusable="false">
    <image href={stickyNote} x="0" y="0" width="512" height="512" />
  </svg>;
}
