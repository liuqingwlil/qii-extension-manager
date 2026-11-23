import './elysia-art.css';

/** Decorative header art. Its layout and clipping stay entirely inside the header. */
export function ElysiaPopupArt() {
  return (
    <div className="elysia-header-art" aria-hidden="true">
      <span className="elysia-art-ring" />
      <span className="elysia-crystal crystal-1" />
      <span className="elysia-crystal crystal-2" />
      <span className="elysia-crystal crystal-3" />
      <img
        className="elysia-portrait"
        src="skins/elysia.png"
        alt=""
        decoding="async"
        draggable={false}
      />
    </div>
  );
}
