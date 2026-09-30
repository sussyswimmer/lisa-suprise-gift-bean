import { useEffect, useState } from "react";
import { BeanAsset, SpriteAsset } from "../types";

interface BeanSpriteProps {
  asset: BeanAsset;
  className?: string;
}

const BEAN_BOX_PX = 128;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function spriteFramePosition(sprite: SpriteAsset, frame: number) {
  const columns = Math.min(sprite.columns ?? sprite.frames, sprite.frames);
  const rows = Math.ceil(sprite.frames / columns);
  const column = frame % columns;
  const row = Math.floor(frame / columns);
  return {
    backgroundSize: `${columns * 100}% ${rows * 100}%`,
    backgroundPosition: `${columns > 1 ? (column / (columns - 1)) * 100 : 0}% ${rows > 1 ? (row / (rows - 1)) * 100 : 0}%`,
  };
}

function SpriteSheet({
  sprite,
  className,
}: {
  sprite: SpriteAsset;
  className: string;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (sprite.frames < 2 || prefersReducedMotion()) return;
    const intervalId = window.setInterval(() => {
      setFrame((current) =>
        sprite.loop === false
          ? Math.min(current + 1, sprite.frames - 1)
          : (current + 1) % sprite.frames,
      );
    }, 1_000 / sprite.fps);
    return () => window.clearInterval(intervalId);
  }, [sprite]);

  const size = BEAN_BOX_PX * (sprite.scale ?? 1);
  return (
    <div
      className={`${className} is-sprite`}
      data-frame={frame}
      style={{
        backgroundImage: `url("${sprite.src}")`,
        ...spriteFramePosition(sprite, frame),
        ...(sprite.scale && sprite.scale !== 1
          ? {
              position: "absolute",
              bottom: 0,
              left: `calc(50% - ${size / 2}px)`,
              width: size,
              height: size,
            }
          : {}),
      }}
    />
  );
}

/** Shows Bean's art: a still image, or a sprite sheet played frame by frame. */
export default function BeanSprite({
  asset,
  className = "bean-art",
}: BeanSpriteProps) {
  if (typeof asset === "string") {
    return <img className={className} src={asset} alt="" draggable={false} />;
  }
  // A new sheet restarts from its first frame.
  return <SpriteSheet key={asset.src} sprite={asset} className={className} />;
}
