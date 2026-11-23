"""Generate Qii's transparent, geometric extension icons. Requires Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
DESTINATION = ROOT / "public" / "icons"
SIZES = (16, 32, 48, 128)


def create_icon(size: int) -> Image.Image:
    scale = 8
    canvas = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    pen = ImageDraw.Draw(canvas)

    def rect(bounds: tuple[float, float, float, float], radius: float, color: str) -> None:
        pen.rounded_rectangle(
            tuple(round(coordinate * size * scale) for coordinate in bounds),
            radius=round(radius * size * scale),
            fill=color,
        )

    # The four blocks also read clearly at 16 px. The gap stays transparent.
    rect((0.09, 0.09, 0.45, 0.45), 0.105, "#315E46")
    rect((0.55, 0.09, 0.91, 0.45), 0.105, "#6E947B")
    rect((0.09, 0.55, 0.45, 0.91), 0.105, "#6E947B")
    rect((0.55, 0.55, 0.91, 0.91), 0.105, "#315E46")
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = DESTINATION / f"icon{size}.png"
        create_icon(size).save(path, optimize=True)
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
